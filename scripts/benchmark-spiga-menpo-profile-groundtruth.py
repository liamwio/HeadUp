"""Aggregate-only SPIGA-WFLW audit on all Menpo 39-point profiles.

The official model, weights and preprocessing are used unchanged. The official
CUDA-only wrapper is redirected to CPU by making its two ``.cuda()`` calls no-ops.
Candidate-to-ground-truth mappings are learned only on the deterministic
engineering split and frozen before holdout scoring. No image identifiers,
coordinates, crops or individual predictions are retained.
"""

from __future__ import annotations

import datetime
import hashlib
import json
import math
import os
import sys
import time
from collections import Counter
from pathlib import Path

import cv2
import numpy as np
import torch


CANDIDATE_INDICES = [54, 57, 79, 85, 16]
CANDIDATE_LABELS = ["nose_tip", "nasal_base", "upper_lip", "lower_lip", "chin"]


def parse_pts(path: Path) -> np.ndarray:
    lines = path.read_text(encoding="utf-8", errors="strict").splitlines()
    count_line = next((line for line in lines if line.strip().startswith("n_points")), None)
    if count_line is None:
        raise RuntimeError("PTS file is missing n_points")
    expected = int(count_line.split(":", 1)[1].strip())
    start, end = lines.index("{") + 1, lines.index("}")
    points = np.asarray(
        [[float(value) - 1 for value in line.split()] for line in lines[start:end] if line.strip()],
        dtype=np.float64,
    )
    if points.shape != (expected, 2):
        raise RuntimeError(f"PTS point count mismatch: {points.shape} vs {expected}")
    return points


def face_box(points: np.ndarray) -> np.ndarray:
    minimum, maximum = points.min(axis=0), points.max(axis=0)
    size = maximum - minimum
    return np.asarray([minimum[0], minimum[1], size[0], size[1]], dtype=np.float64)


def expanded_box(box: np.ndarray, image_shape: tuple[int, ...], factor: float) -> list[float]:
    height, width = image_shape[:2]
    x, y, box_width, box_height = [float(value) for value in box]
    center_x, center_y = x + box_width / 2, y + box_height / 2
    expanded_width, expanded_height = box_width * factor, box_height * factor
    x0 = max(0.0, center_x - expanded_width / 2)
    y0 = max(0.0, center_y - expanded_height / 2)
    x1 = min(float(width), center_x + expanded_width / 2)
    y1 = min(float(height), center_y + expanded_height / 2)
    return [x0, y0, x1 - x0, y1 - y0]


def split_for(orientation: str, stem: str) -> str:
    key = f"{orientation}/{stem}"
    return "engineering" if hashlib.sha256(key.encode("utf-8")).digest()[0] < 205 else "holdout"


def percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    return round(float(np.quantile(np.asarray(values, dtype=np.float64), fraction)), 4)


def distribution(values: list[float]) -> dict[str, float | None]:
    return {
        "min": percentile(values, 0),
        "p05": percentile(values, 0.05),
        "median": percentile(values, 0.5),
        "p95": percentile(values, 0.95),
        "max": percentile(values, 1),
    }


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    if len(sys.argv) != 6:
        raise SystemExit("usage: benchmark.py REPO WEIGHT MENPO_DIR RESULT_JSON COMMIT")
    repo, weight, menpo_dir, result_path = map(Path, sys.argv[1:5])
    commit = sys.argv[5]
    sys.path.insert(0, str(repo))

    # The official inference class exposes CUDA only. These no-ops preserve the
    # official tensors, network, state dict and pre/post-processing on CPU.
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

    config = ModelConfig("wflw", load_model_url=False)
    config.model_weights_path = str(weight.parent)
    config.model_weights = weight.name
    load_started = time.perf_counter()
    framework = SPIGAFramework(config, gpus=[0])
    model_load_seconds = time.perf_counter() - load_started

    cases: list[dict[str, object]] = []
    inference_started = time.perf_counter()
    for index, (image_path, ground_truth, orientation) in enumerate(profiles):
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
        selected = landmarks[0, CANDIDATE_INDICES]
        nearest = np.argmin(
            np.linalg.norm(selected[:, None, :] - ground_truth[None, :, :], axis=2), axis=1
        )
        diagonal = max(1.0, math.hypot(float(box[2]), float(box[3])))
        crop_sensitivity = None
        if len(boxes) == 2:
            perturbed = landmarks[1, CANDIDATE_INDICES]
            crop_sensitivity = float(np.median(np.linalg.norm(selected - perturbed, axis=1)) / diagonal)
        cases.append({
            "partition": partition,
            "orientation": orientation,
            "groundTruth": ground_truth,
            "selected": selected,
            "nearest": nearest,
            "diagonal": diagonal,
            "cropSensitivity": crop_sensitivity,
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
    mappings: dict[str, list[int]] = {}
    mapping_stability: dict[str, list[float]] = {}
    for orientation in ("left", "right"):
        oriented = [case for case in engineering if case["orientation"] == orientation]
        mappings[orientation] = []
        mapping_stability[orientation] = []
        for local_index in range(len(CANDIDATE_INDICES)):
            counts = Counter(int(case["nearest"][local_index]) for case in oriented)
            mapped_index, count = counts.most_common(1)[0]
            mappings[orientation].append(mapped_index)
            mapping_stability[orientation].append(count / len(oriented))

    def errors(items: list[dict[str, object]]) -> tuple[list[float], list[list[float]]]:
        image_rms: list[float] = []
        point_errors: list[list[float]] = [[] for _ in CANDIDATE_INDICES]
        for case in items:
            predicted = np.asarray(case["selected"])
            target = np.asarray(case["groundTruth"])[mappings[str(case["orientation"])]]
            normalized = np.linalg.norm(predicted - target, axis=1) / float(case["diagonal"])
            image_rms.append(float(np.sqrt(np.mean(normalized ** 2))))
            for point_index, value in enumerate(normalized):
                point_errors[point_index].append(float(value))
        return image_rms, point_errors

    engineering_errors, _ = errors(engineering)
    holdout_errors, holdout_point_errors = errors(holdout)
    crop_sensitivity = [float(case["cropSensitivity"]) for case in holdout]

    direction_correct: list[bool] = []
    direction_by_orientation: dict[str, list[bool]] = {"left": [], "right": []}
    for case in holdout:
        orientation = str(case["orientation"])
        predicted = np.asarray(case["selected"])
        ground_truth = np.asarray(case["groundTruth"])
        mapped_nose = mappings[orientation][0]
        predicted_sign = np.sign(float(predicted[0, 0] - np.median(predicted[:, 0])))
        ground_truth_sign = np.sign(float(ground_truth[mapped_nose, 0] - np.median(ground_truth[:, 0])))
        correct = bool(predicted_sign != 0 and predicted_sign == ground_truth_sign)
        direction_correct.append(correct)
        direction_by_orientation[orientation].append(correct)

    mapping_unique = all(len(set(values)) == len(values) for values in mappings.values())
    minimum_stability = min(value for values in mapping_stability.values() for value in values)
    holdout_distribution = distribution(holdout_errors)
    crop_distribution = distribution(crop_sensitivity)
    direction_accuracy = sum(direction_correct) / len(direction_correct)
    gates = {
        "mappedGroundTruthIndicesAreUnique": mapping_unique,
        "everySemanticMappingStableOnAtLeast60PercentEngineering": minimum_stability >= 0.60,
        "holdoutMedianNmeAtMost3PercentBoundingBoxDiagonal": holdout_distribution["median"] <= 0.03,
        "holdoutP95NmeAtMost8PercentBoundingBoxDiagonal": holdout_distribution["p95"] <= 0.08,
        "holdoutExpandedBoxSensitivityP95AtMost5PercentBoundingBoxDiagonal": crop_distribution["p95"] <= 0.05,
        "holdoutProfileDirectionAccuracyAtLeast95Percent": direction_accuracy >= 0.95,
    }
    elapsed = time.perf_counter() - inference_started
    result = {
        "testedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "policyVersion": "HEADUP-SPIGA-MENPO-PROFILE-GROUNDTRUTH-1.0",
        "source": {
            "name": "Menpo2D fixed official archive, annotated training profiles",
            "profileImages": len(profiles),
            "profileLandmarks": 39,
            "annotation": "semi-automatic followed by manual correction",
            "license": "non-commercial research only",
            "archiveSha256": os.environ.get("HEADUP_MENPO_ARCHIVE_SHA256"),
        },
        "partition": {
            "method": "SHA-256 of orientation/source basename; first byte <205 is engineering",
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
            "candidatePointIndices": CANDIDATE_INDICES,
            "candidatePointLabels": CANDIDATE_LABELS,
            "execution": "Official network, weights and preprocessing; official CUDA calls redirected to CPU only",
        },
        "evaluation": {
            "primaryBox": "exact ground-truth 39-point bounding box",
            "holdoutPerturbation": "same-center box expanded to 1.25x and clipped to image bounds",
            "normalization": "RMS point error divided by diagonal of ground-truth landmark bounding box",
            "mapping": "Nearest 39-point index mode selected independently by orientation on engineering images, then frozen",
        },
        "engineeringSelectedGroundTruthIndicesByOrientation": mappings,
        "engineeringMappingStabilityByOrientation": {
            orientation: [round(value, 4) for value in values]
            for orientation, values in mapping_stability.items()
        },
        "engineeringMappedPointRmsNme": distribution(engineering_errors),
        "holdoutMappedPointRmsNme": holdout_distribution,
        "holdoutPerPointNme": {
            label: distribution(values) for label, values in zip(CANDIDATE_LABELS, holdout_point_errors)
        },
        "holdoutExpandedBoxSensitivity": crop_distribution,
        "holdoutProfileDirection": {
            "accuracy": round(direction_accuracy, 4),
            "correct": sum(direction_correct),
            "total": len(direction_correct),
            "accuracyByOrientation": {
                orientation: round(sum(values) / len(values), 4)
                for orientation, values in direction_by_orientation.items()
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
        "interpretation": "Passing would identify a side-profile landmark candidate, not validate craniofacial diagnosis. Product-camera identity-isolated retakes remain required before release.",
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
        "partition": result["partition"],
        "mappings": mappings,
        "mappingStability": result["engineeringMappingStabilityByOrientation"],
        "holdout": holdout_distribution,
        "cropSensitivity": crop_distribution,
        "direction": result["holdoutProfileDirection"],
        "gates": gates,
        "passes": result["passesAllGates"],
        "runtime": result["runtime"],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
