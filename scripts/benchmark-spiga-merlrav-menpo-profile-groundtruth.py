"""Fixed-semantic SPIGA-MERL-RAV audit on all Menpo 39-point profiles.

MERL-RAV uses the standard 68-point schema and was trained on manually labeled
full-range head poses. The five candidate indices and Menpo targets are fixed
before inference; no index is selected from the reused development holdout.
Only aggregate results are written.
"""

from __future__ import annotations

import datetime
import hashlib
import json
import math
import os
import runpy
import sys
import time
from collections import Counter
from pathlib import Path

import cv2
import numpy as np
import torch


BASE = runpy.run_path(
    str(Path(__file__).with_name("benchmark-spiga-menpo-profile-groundtruth.py")),
    run_name="headup_spiga_merlrav_helpers",
)
parse_pts = BASE["parse_pts"]
face_box = BASE["face_box"]
expanded_box = BASE["expanded_box"]
split_for = BASE["split_for"]
distribution = BASE["distribution"]
sha256 = BASE["sha256"]

LABELS = ["nose_tip", "nasal_base", "upper_lip", "lower_lip", "chin"]
SPIGA_INDICES = {"nose_tip": 30, "nasal_base": 33, "upper_lip": 51, "lower_lip": 57, "chin": 8}
MENPO_TARGETS = {"nose_tip": 19, "nasal_base": 20, "upper_lip": 27, "lower_lip": 33, "chin": 9}


def main() -> None:
    if len(sys.argv) != 6:
        raise SystemExit("usage: benchmark.py REPO WEIGHT MENPO_DIR RESULT_JSON COMMIT")
    repo, weight, menpo_dir, result_path = map(Path, sys.argv[1:5])
    commit = sys.argv[5]
    sys.path.insert(0, str(repo))
    torch.Tensor.cuda = lambda self, device=None, non_blocking=False: self  # type: ignore[method-assign]
    torch.nn.Module.cuda = lambda self, device=None: self  # type: ignore[method-assign]

    from spiga.inference.config import ModelConfig
    from spiga.inference.framework import SPIGAFramework

    profile_images: dict[tuple[str, str], Path] = {}
    for image_path in menpo_dir.rglob("*.jpg"):
        parts = {part.lower() for part in image_path.parts}
        orientation = "left" if "left" in parts else "right" if "right" in parts else None
        if "profile" in parts and orientation:
            profile_images[(orientation, image_path.stem)] = image_path

    profiles: list[tuple[Path, np.ndarray, str]] = []
    markup_counts: Counter[int] = Counter()
    for pts_path in sorted(menpo_dir.rglob("*.pts")):
        points = parse_pts(pts_path)
        markup_counts[len(points)] += 1
        if len(points) != 39:
            continue
        parts = {part.lower() for part in pts_path.parts}
        orientation = "left" if "left" in parts else "right" if "right" in parts else None
        image_path = profile_images.get((orientation or "", pts_path.stem))
        if image_path is None or orientation is None:
            raise RuntimeError("profile annotation has no matching image")
        profiles.append((image_path, points, orientation))
    if len(profiles) != 2290 or markup_counts[68] != 6655:
        raise RuntimeError(f"unexpected Menpo2D counts; profiles={len(profiles)}, markups={dict(markup_counts)}")

    config = ModelConfig("merlrav", load_model_url=False)
    config.model_weights_path = str(weight.parent)
    config.model_weights = weight.name
    load_started = time.perf_counter()
    framework = SPIGAFramework(config, gpus=[0])
    model_load_seconds = time.perf_counter() - load_started

    cases: list[dict[str, object]] = []
    inference_started = time.perf_counter()
    inference_durations: list[float] = []
    candidate_indices = [SPIGA_INDICES[label] for label in LABELS]
    for index, (image_path, ground_truth, orientation) in enumerate(profiles):
        image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
        if image is None:
            raise RuntimeError("unable to decode Menpo image")
        box = face_box(ground_truth)
        partition = split_for(orientation, image_path.stem)
        boxes = [expanded_box(box, image.shape, 1.0)]
        if partition == "holdout":
            boxes.append(expanded_box(box, image.shape, 1.25))
        case_started = time.perf_counter()
        with torch.inference_mode():
            features = framework.inference(image, boxes)
        inference_durations.append(time.perf_counter() - case_started)
        landmarks = np.asarray(features.get("landmarks"), dtype=np.float64)
        if landmarks.shape != (len(boxes), 68, 2) or not np.isfinite(landmarks).all():
            raise RuntimeError(f"invalid SPIGA-MERL-RAV output shape {landmarks.shape}")
        selected = landmarks[0, candidate_indices]
        nearest = np.argmin(
            np.linalg.norm(selected[:, None, :] - ground_truth[None, :, :], axis=2), axis=1
        )
        cases.append({
            "partition": partition,
            "orientation": orientation,
            "groundTruth": ground_truth,
            "selected": selected,
            "perturbed": landmarks[1, candidate_indices] if len(boxes) == 2 else None,
            "nearest": nearest,
            "diagonal": max(1.0, math.hypot(float(box[2]), float(box[3]))),
        })
        if (index + 1) % 100 == 0:
            elapsed = time.perf_counter() - inference_started
            print(
                f"Processed {index + 1}/{len(profiles)} in {elapsed:.1f}s "
                f"({elapsed / (index + 1):.3f}s/image)",
                file=sys.stderr,
                flush=True,
            )

    engineering = [case for case in cases if case["partition"] == "engineering"]
    holdout = [case for case in cases if case["partition"] == "holdout"]
    nearest_modes: dict[str, dict[str, int]] = {}
    nearest_stability: dict[str, dict[str, float]] = {}
    for orientation in ("left", "right"):
        oriented = [case for case in engineering if case["orientation"] == orientation]
        nearest_modes[orientation] = {}
        nearest_stability[orientation] = {}
        for local_index, label in enumerate(LABELS):
            counts = Counter(int(case["nearest"][local_index]) for case in oriented)
            mode, count = counts.most_common(1)[0]
            nearest_modes[orientation][label] = mode
            nearest_stability[orientation][label] = count / len(oriented)

    def evaluate(items: list[dict[str, object]]) -> tuple[list[float], dict[str, list[float]]]:
        image_rms: list[float] = []
        per_point: dict[str, list[float]] = {label: [] for label in LABELS}
        for case in items:
            ground_truth = np.asarray(case["groundTruth"])
            selected = np.asarray(case["selected"])
            normalized = []
            for local_index, label in enumerate(LABELS):
                error = float(
                    np.linalg.norm(selected[local_index] - ground_truth[MENPO_TARGETS[label]])
                    / float(case["diagonal"])
                )
                per_point[label].append(error)
                normalized.append(error)
            image_rms.append(float(np.sqrt(np.mean(np.square(normalized)))))
        return image_rms, per_point

    engineering_errors, _ = evaluate(engineering)
    holdout_errors, holdout_points = evaluate(holdout)
    orientation_results: dict[str, dict[str, object]] = {}
    for orientation in ("left", "right"):
        oriented = [case for case in holdout if case["orientation"] == orientation]
        rms, points = evaluate(oriented)
        orientation_results[orientation] = {
            "images": len(oriented),
            "mappedPointRmsNme": distribution(rms),
            "perPointNme": {label: distribution(values) for label, values in points.items()},
        }

    crop_sensitivity: list[float] = []
    direction_correct: dict[str, list[bool]] = {"left": [], "right": []}
    for case in holdout:
        primary = np.asarray(case["selected"])
        perturbed = np.asarray(case["perturbed"])
        crop_sensitivity.append(
            float(np.median(np.linalg.norm(primary - perturbed, axis=1)) / float(case["diagonal"]))
        )
        ground_truth = np.asarray(case["groundTruth"])
        predicted_sign = np.sign(float(primary[0, 0] - primary[4, 0]))
        target_sign = np.sign(
            float(ground_truth[MENPO_TARGETS["nose_tip"], 0] - ground_truth[MENPO_TARGETS["chin"], 0])
        )
        orientation = str(case["orientation"])
        direction_correct[orientation].append(bool(predicted_sign != 0 and predicted_sign == target_sign))

    holdout_distribution = distribution(holdout_errors)
    point_distributions = {label: distribution(values) for label, values in holdout_points.items()}
    crop_distribution = distribution(crop_sensitivity)
    direction_accuracy = {
        orientation: sum(values) / len(values) for orientation, values in direction_correct.items()
    }
    all_directions = [value for values in direction_correct.values() for value in values]
    minimum_mapping_stability = min(
        value for values in nearest_stability.values() for value in values.values()
    )
    fixed_targets_are_modes = all(
        nearest_modes[orientation][label] == MENPO_TARGETS[label]
        for orientation in ("left", "right") for label in LABELS
    )
    gates = {
        "fixedSemanticTargetsAreEngineeringNearestPointModes": fixed_targets_are_modes,
        "everyFixedSemanticMappingStableOnAtLeast60PercentEngineering": minimum_mapping_stability >= 0.60,
        "holdoutMedianRmsNmeAtMost3Percent": holdout_distribution["median"] <= 0.03,
        "holdoutP95RmsNmeAtMost8Percent": holdout_distribution["p95"] <= 0.08,
        "everyCriticalPointMedianNmeAtMost3Percent": all(value["median"] <= 0.03 for value in point_distributions.values()),
        "everyCriticalPointP95NmeAtMost8Percent": all(value["p95"] <= 0.08 for value in point_distributions.values()),
        "holdoutExpandedBoxSensitivityP95AtMost5Percent": crop_distribution["p95"] <= 0.05,
        "eachOrientationDirectionAccuracyAtLeast95Percent": all(value >= 0.95 for value in direction_accuracy.values()),
    }
    elapsed = time.perf_counter() - inference_started
    duration_distribution = distribution(inference_durations)
    suspension_suspected = bool(max(inference_durations) > 5.0)
    active_durations = [value for value in inference_durations if value <= 5.0]
    result = {
        "testedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "policyVersion": "HEADUP-SPIGA-MERLRAV-MENPO-PROFILE-GROUNDTRUTH-1.0",
        "source": {
            "name": "Menpo2D fixed official archive, annotated training profiles",
            "profileImages": len(profiles),
            "profileLandmarks": 39,
            "license": "non-commercial research only",
            "archiveSha256": os.environ.get("HEADUP_MENPO_ARCHIVE_SHA256"),
        },
        "partition": {
            "method": "Same frozen SHA-256 partition as preceding audits",
            "engineering": len(engineering),
            "holdout": len(holdout),
            "engineeringByOrientation": dict(Counter(str(case["orientation"]) for case in engineering)),
            "holdoutByOrientation": dict(Counter(str(case["orientation"]) for case in holdout)),
        },
        "model": {
            "name": "SPIGA MERL-RAV",
            "officialRepository": "https://github.com/andresprados/SPIGA",
            "repositoryCommit": commit,
            "license": "BSD-3-Clause",
            "weightsSha256": sha256(weight),
            "outputLandmarks": 68,
            "fixedSpigaIndices": SPIGA_INDICES,
            "fixedMenpoTargets": MENPO_TARGETS,
            "indexSelection": "Standard 68-point semantics fixed before this run; no candidate scan",
            "execution": "Official network, weights and preprocessing; official CUDA calls redirected to CPU only",
        },
        "officialCapabilityContext": {
            "trainingDataset": "MERL-RAV reannotation of AFLW, full-range poses with 68 manual landmarks and visibility labels",
            "repositoryReportedProfileNmeBBoxPercent": 1.191,
            "repositoryReportedProfileP95Percent": 2.042,
            "note": "Official in-domain metrics are provenance context, not counted as HeadUp validation",
        },
        "evaluation": {
            "primaryBox": "exact ground-truth 39-point bounding box",
            "holdoutPerturbation": "same-center box expanded to 1.25x and clipped to image bounds",
            "normalization": "RMS point error divided by diagonal of ground-truth landmark bounding box",
            "holdoutReuseWarning": "The same 450-image cohort was already summarized in prior SPIGA audits. This is development evidence, not a fresh confirmatory holdout.",
        },
        "engineeringNearestMenpoModesByOrientation": nearest_modes,
        "engineeringNearestModeStabilityByOrientation": {
            orientation: {label: round(value, 4) for label, value in values.items()}
            for orientation, values in nearest_stability.items()
        },
        "engineeringMappedPointRmsNme": distribution(engineering_errors),
        "holdoutMappedPointRmsNme": holdout_distribution,
        "holdoutPerPointNme": point_distributions,
        "holdoutByOrientation": orientation_results,
        "holdoutExpandedBoxSensitivity": crop_distribution,
        "holdoutProfileDirection": {
            "definition": "sign of nose-tip minus chin x-coordinate compared with ground truth",
            "accuracy": round(sum(all_directions) / len(all_directions), 4),
            "correct": sum(all_directions),
            "total": len(all_directions),
            "accuracyByOrientation": {
                orientation: round(value, 4) for orientation, value in direction_accuracy.items()
            },
        },
        "runtime": {
            "device": "CPU",
            "modelLoadSeconds": round(model_load_seconds, 3),
            "rawWallSeconds": round(elapsed, 3),
            "perImageWallSeconds": duration_distribution,
            "suspensionSuspected": suspension_suspected,
            "activeSecondsExcludingImagesOver5Seconds": round(sum(active_durations), 3),
            "activeImages": len(active_durations),
            "timingValidForPerformanceDecision": not suspension_suspected,
        },
        "predeclaredGates": gates,
        "passesAllGates": all(gates.values()),
        "productionDecision": "candidate_only" if all(gates.values()) else "reject",
        "postRunSemanticAudit": {
            "status": "legacy_five_point_protocol_not_requirement_complete",
            "officialMenpoDiagram": "The published diagram is one-based while PTS arrays are zero-based.",
            "chinFinding": "The product requires soft-tissue pogonion. The legacy Menpo target 9 is not the most anterior chin point; zero-based target 10 is the diagram's anterior soft-tissue chin point.",
            "nasalFinding": "The legacy target 20 is the lower columella point. The distinct subnasale/nasal-base junction required by the product is zero-based target 21.",
            "coverageFinding": "Five standard 68-point anchors do not directly cover the product's eight profile metrics, notably distinct subnasale and mentolabial-fold landmarks.",
            "consequence": "Numeric distributions remain valid for the legacy targets but must not be presented as definitive subnasale or soft-tissue-pogonion accuracy. The candidate remains non-production because requirement coverage is incomplete."
        },
        "interpretation": "This is a diagnostic of a legacy five-point cross-schema mapping, not complete validation of the required profile metrics. The reused holdout and non-commercial/research-oriented training data also prevent a production claim.",
        "retention": {
            "imagesRetained": False,
            "annotationsRetained": False,
            "archiveRetained": False,
            "individualPredictionsRetained": False,
            "identifiersRetained": False,
            "aggregateOnly": True,
        },
    }
    result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "resultPath": str(result_path),
        "nearestModes": nearest_modes,
        "mappingStability": result["engineeringNearestModeStabilityByOrientation"],
        "holdout": holdout_distribution,
        "perPoint": point_distributions,
        "byOrientation": orientation_results,
        "cropSensitivity": crop_distribution,
        "direction": result["holdoutProfileDirection"],
        "gates": gates,
        "passes": result["passesAllGates"],
        "runtime": result["runtime"],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
