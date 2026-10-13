"""Engineering-only semantic index calibration for SPIGA on Menpo profiles.

The Menpo targets were frozen from the preceding engineering-only mapping audit:
19 nose tip, 20 nasal base, 27 upper lip, 33 lower lip and 9 chin. This run
selects SPIGA indices only from anatomy-compatible WFLW regions on engineering
images, checks selection stability with five deterministic folds, and reports
the untouched holdout. No identifier or per-image output is written.
"""

from __future__ import annotations

import datetime
import hashlib
import itertools
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
    run_name="headup_spiga_profile_helpers",
)
parse_pts = BASE["parse_pts"]
face_box = BASE["face_box"]
expanded_box = BASE["expanded_box"]
split_for = BASE["split_for"]
distribution = BASE["distribution"]
sha256 = BASE["sha256"]

TARGETS = {
    "nose_tip": 19,
    "nasal_base": 20,
    "upper_lip": 27,
    "lower_lip": 33,
    "chin": 9,
}
POOLS = {
    "nose_tip": list(range(51, 60)),
    "nasal_base": list(range(51, 60)),
    "upper_lip": list(range(76, 96)),
    "lower_lip": list(range(76, 96)),
    "chin": list(range(0, 33)),
}
LABELS = list(TARGETS)


def selection_scores(items: list[dict[str, object]]) -> dict[str, dict[int, float]]:
    scores: dict[str, dict[int, float]] = {}
    for label, target_index in TARGETS.items():
        label_scores: dict[int, float] = {}
        for candidate_index in POOLS[label]:
            squared_errors = []
            for case in items:
                prediction = np.asarray(case["primary"])[candidate_index]
                target = np.asarray(case["groundTruth"])[target_index]
                error = float(np.linalg.norm(prediction - target) / float(case["diagonal"]))
                squared_errors.append(error * error)
            label_scores[candidate_index] = float(np.mean(squared_errors))
        scores[label] = label_scores
    return scores


def select_indices(items: list[dict[str, object]]) -> dict[str, int]:
    scores = selection_scores(items)

    def best_pair(first: str, second: str) -> tuple[int, int]:
        candidates = (
            (scores[first][first_index] + scores[second][second_index], first_index, second_index)
            for first_index, second_index in itertools.product(POOLS[first], POOLS[second])
            if first_index != second_index
        )
        _, first_index, second_index = min(candidates)
        return first_index, second_index

    nose_tip, nasal_base = best_pair("nose_tip", "nasal_base")
    upper_lip, lower_lip = best_pair("upper_lip", "lower_lip")
    chin = min((score, index) for index, score in scores["chin"].items())[1]
    return {
        "nose_tip": nose_tip,
        "nasal_base": nasal_base,
        "upper_lip": upper_lip,
        "lower_lip": lower_lip,
        "chin": chin,
    }


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

    profiles: list[tuple[Path, np.ndarray, str, int]] = []
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
        fold_key = f"{orientation}/{image_path.stem}".encode("utf-8")
        fold = hashlib.sha256(fold_key).digest()[1] % 5
        profiles.append((image_path, points, orientation, fold))
    if len(profiles) != 2290 or markup_counts[68] != 6655:
        raise RuntimeError(f"unexpected Menpo2D counts; profiles={len(profiles)}, markups={dict(markup_counts)}")

    config = ModelConfig("wflw", load_model_url=False)
    config.model_weights_path = str(weight.parent)
    config.model_weights = weight.name
    load_started = time.perf_counter()
    framework = SPIGAFramework(config, gpus=[0])
    model_load_seconds = time.perf_counter() - load_started

    cases: list[dict[str, object]] = []
    inference_started = time.perf_counter()
    for index, (image_path, ground_truth, orientation, fold) in enumerate(profiles):
        image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
        if image is None:
            raise RuntimeError("unable to decode Menpo image")
        box = face_box(ground_truth)
        partition = split_for(orientation, image_path.stem)
        boxes = [expanded_box(box, image.shape, 1.0)]
        if partition == "holdout":
            boxes.append(expanded_box(box, image.shape, 1.25))
        with torch.inference_mode():
            features = framework.inference(image, boxes)
        landmarks = np.asarray(features.get("landmarks"), dtype=np.float64)
        if landmarks.shape != (len(boxes), 98, 2) or not np.isfinite(landmarks).all():
            raise RuntimeError(f"invalid SPIGA output shape {landmarks.shape}")
        cases.append({
            "partition": partition,
            "orientation": orientation,
            "fold": fold,
            "groundTruth": ground_truth,
            "primary": landmarks[0],
            "perturbed": landmarks[1] if len(boxes) == 2 else None,
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
    selected: dict[str, dict[str, int]] = {}
    fold_stability: dict[str, dict[str, float]] = {}
    fold_selections: dict[str, list[dict[str, int]]] = {}
    for orientation in ("left", "right"):
        oriented = [case for case in engineering if case["orientation"] == orientation]
        selected[orientation] = select_indices(oriented)
        fold_selections[orientation] = []
        for held_fold in range(5):
            training = [case for case in oriented if case["fold"] != held_fold]
            fold_selections[orientation].append(select_indices(training))
        fold_stability[orientation] = {
            label: sum(choice[label] == selected[orientation][label] for choice in fold_selections[orientation]) / 5
            for label in LABELS
        }

    def evaluate(items: list[dict[str, object]]) -> tuple[list[float], dict[str, list[float]]]:
        image_rms: list[float] = []
        per_point: dict[str, list[float]] = {label: [] for label in LABELS}
        for case in items:
            orientation = str(case["orientation"])
            normalized = []
            for label in LABELS:
                prediction = np.asarray(case["primary"])[selected[orientation][label]]
                target = np.asarray(case["groundTruth"])[TARGETS[label]]
                error = float(np.linalg.norm(prediction - target) / float(case["diagonal"]))
                normalized.append(error)
                per_point[label].append(error)
            image_rms.append(float(np.sqrt(np.mean(np.square(normalized)))))
        return image_rms, per_point

    engineering_errors, _ = evaluate(engineering)
    holdout_errors, holdout_points = evaluate(holdout)
    crop_sensitivity: list[float] = []
    direction_correct: dict[str, list[bool]] = {"left": [], "right": []}
    for case in holdout:
        orientation = str(case["orientation"])
        indices = [selected[orientation][label] for label in LABELS]
        primary = np.asarray(case["primary"])[indices]
        perturbed = np.asarray(case["perturbed"])[indices]
        crop_sensitivity.append(
            float(np.median(np.linalg.norm(primary - perturbed, axis=1)) / float(case["diagonal"]))
        )
        predicted_sign = np.sign(float(primary[0, 0] - primary[4, 0]))
        ground_truth = np.asarray(case["groundTruth"])
        target_sign = np.sign(float(ground_truth[TARGETS["nose_tip"], 0] - ground_truth[TARGETS["chin"], 0]))
        direction_correct[orientation].append(bool(predicted_sign != 0 and predicted_sign == target_sign))

    holdout_distribution = distribution(holdout_errors)
    crop_distribution = distribution(crop_sensitivity)
    point_distributions = {label: distribution(values) for label, values in holdout_points.items()}
    direction_accuracy = {
        orientation: sum(values) / len(values) for orientation, values in direction_correct.items()
    }
    all_directions = [value for values in direction_correct.values() for value in values]
    minimum_fold_stability = min(value for values in fold_stability.values() for value in values.values())
    distinct_within_regions = all(
        choices["nose_tip"] != choices["nasal_base"] and choices["upper_lip"] != choices["lower_lip"]
        for choices in selected.values()
    )
    gates = {
        "selectedIndicesAreDistinctWithinNoseAndLipRegions": distinct_within_regions,
        "everySelectedIndexRepeatsInAtLeastFourOfFiveEngineeringFolds": minimum_fold_stability >= 0.80,
        "holdoutMedianRmsNmeAtMost3Percent": holdout_distribution["median"] <= 0.03,
        "holdoutP95RmsNmeAtMost8Percent": holdout_distribution["p95"] <= 0.08,
        "everyCriticalPointMedianNmeAtMost3Percent": all(value["median"] <= 0.03 for value in point_distributions.values()),
        "everyCriticalPointP95NmeAtMost8Percent": all(value["p95"] <= 0.08 for value in point_distributions.values()),
        "holdoutExpandedBoxSensitivityP95AtMost5Percent": crop_distribution["p95"] <= 0.05,
        "eachOrientationDirectionAccuracyAtLeast95Percent": all(value >= 0.95 for value in direction_accuracy.values()),
    }
    elapsed = time.perf_counter() - inference_started
    result = {
        "testedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "policyVersion": "HEADUP-SPIGA-MENPO-PROFILE-SEMANTIC-CALIBRATION-1.0",
        "source": {
            "name": "Menpo2D fixed official archive, annotated training profiles",
            "profileImages": len(profiles),
            "profileLandmarks": 39,
            "license": "non-commercial research only",
            "archiveSha256": os.environ.get("HEADUP_MENPO_ARCHIVE_SHA256"),
        },
        "partition": {
            "method": "Same frozen SHA-256 partition as preceding audit",
            "engineering": len(engineering),
            "holdout": len(holdout),
            "engineeringByOrientation": dict(Counter(str(case["orientation"]) for case in engineering)),
            "holdoutByOrientation": dict(Counter(str(case["orientation"]) for case in holdout)),
        },
        "model": {
            "name": "SPIGA WFLW",
            "officialRepository": "https://github.com/andresprados/SPIGA",
            "repositoryCommit": commit,
            "license": "BSD-3-Clause",
            "weightsSha256": sha256(weight),
            "execution": "Official network, weights and preprocessing; official CUDA calls redirected to CPU only",
        },
        "calibration": {
            "fixedMenpoTargetIndices": TARGETS,
            "targetProvenance": "Frozen from the prior engineering-only nearest-point mapping; no per-image holdout prediction was used for index selection",
            "candidatePools": {
                "nose": "WFLW 51..59",
                "mouth": "WFLW 76..95",
                "chin": "WFLW contour 0..32",
            },
            "objective": "Minimum engineering mean squared normalized point error, with unique nose pair and lip pair",
            "selectedSpigaIndicesByOrientation": selected,
            "fiveFoldSelectionStabilityByOrientation": {
                orientation: {label: round(value, 4) for label, value in values.items()}
                for orientation, values in fold_stability.items()
            },
            "foldSelectionsByOrientation": fold_selections,
        },
        "evaluation": {
            "primaryBox": "exact ground-truth 39-point bounding box",
            "holdoutPerturbation": "same-center box expanded to 1.25x and clipped to image bounds",
            "normalization": "RMS point error divided by diagonal of ground-truth landmark bounding box",
            "holdoutReuseWarning": "The same 450-image cohort was already summarized in the baseline audit. This is development evidence, not a fresh confirmatory holdout.",
        },
        "engineeringMappedPointRmsNme": distribution(engineering_errors),
        "holdoutMappedPointRmsNme": holdout_distribution,
        "holdoutPerPointNme": point_distributions,
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
            "totalInferenceSeconds": round(elapsed, 3),
            "meanSecondsPerImage": round(elapsed / len(profiles), 4),
        },
        "predeclaredGates": gates,
        "passesAllGates": all(gates.values()),
        "productionDecision": "candidate_only" if all(gates.values()) else "reject",
        "interpretation": "This engineering-only adapter calibration cannot replace product-camera identity-isolated retakes or establish a craniofacial diagnosis.",
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
        "selected": selected,
        "foldStability": result["calibration"]["fiveFoldSelectionStabilityByOrientation"],
        "holdout": holdout_distribution,
        "perPoint": point_distributions,
        "cropSensitivity": crop_distribution,
        "direction": result["holdoutProfileDirection"],
        "gates": gates,
        "passes": result["passesAllGates"],
        "runtime": result["runtime"],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
