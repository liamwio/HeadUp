"""Audit seven source-specified profile measurements from the retained Menpo39 model.

The eighth P0 measurement, cervicomental angle, is deliberately unavailable:
Menpo's 39-point profile markup contains no anterior-neck tangent. Only aggregate
errors are written; images, paths, coordinates and per-image predictions remain
inside the transient runner and are deleted on exit.
"""

from __future__ import annotations

import datetime
import json
import math
import os
import runpy
import sys
from collections import Counter
from pathlib import Path

import numpy as np
import torch


TRAIN = runpy.run_path(
    str(Path(__file__).with_name("train-menpo39-profile-landmarks.py")),
    run_name="headup_menpo39_geometry_helpers",
)
load_records = TRAIN["load_records"]
MenpoProfileDataset = TRAIN["MenpoProfileDataset"]
MobileNet39Heatmaps = TRAIN["MobileNet39Heatmaps"]
predict = TRAIN["predict"]
distribution = TRAIN["distribution"]
sha256 = TRAIN["sha256"]
PRIMARY_FACTOR = TRAIN["PRIMARY_FACTOR"]
PERTURBED_FACTOR = TRAIN["PERTURBED_FACTOR"]

LANDMARKS = {
    "brow": 14,
    "nasal_root": 17,
    "nose_tip": 19,
    "columella": 20,
    "subnasale": 21,
    "upper_lip": 27,
    "lower_lip": 33,
    "mentolabial_fold": 11,
    "pogonion": 10,
    "menton": 8,
}
JAW_INDICES = [4, 5, 6, 7, 8]
ANGLE_METRICS = {
    "softTissueConvexityAngle",
    "nasolabialAngle",
    "mentolabialAngle",
    "mandibularPlaneInclinationProxy",
}
RATIO_METRICS = {
    "eLine",
    "softTissueChinProjection",
    "profileVerticalProportion",
}


def canonical(points: np.ndarray, orientation: str, axis_radians: float) -> np.ndarray:
    horizontal = np.array([math.cos(axis_radians), math.sin(axis_radians)])
    vertical = np.array([-math.sin(axis_radians), math.cos(axis_radians)])
    direction = 1.0 if orientation == "right" else -1.0
    return np.column_stack([direction * (points @ horizontal), points @ vertical])


def angle_at(vertex: np.ndarray, first: np.ndarray, second: np.ndarray) -> float | None:
    left, right = first - vertex, second - vertex
    denominator = float(np.linalg.norm(left) * np.linalg.norm(right))
    if denominator <= 1e-8:
        return None
    cosine = float(np.clip(np.dot(left, right) / denominator, -1.0, 1.0))
    return math.degrees(math.acos(cosine))


def forward_distance(point: np.ndarray, start: np.ndarray, end: np.ndarray) -> float | None:
    line = end - start
    length = float(np.linalg.norm(line))
    if length <= 1e-8:
        return None
    normal = np.array([line[1], -line[0]]) / length
    if normal[0] < 0:
        normal *= -1
    if normal[0] <= 1e-4:
        return None
    return float(np.dot(point - start, normal))


def fitted_inclination(points: np.ndarray) -> float | None:
    centered = points - np.mean(points, axis=0)
    covariance = centered.T @ centered
    if float(np.trace(covariance)) <= 1e-8:
        return None
    values, vectors = np.linalg.eigh(covariance)
    direction = vectors[:, int(np.argmax(values))]
    return math.degrees(math.atan2(abs(float(direction[1])), abs(float(direction[0]))))


def geometry(points: np.ndarray, orientation: str, axis_radians: float) -> dict[str, np.ndarray | float] | None:
    value = canonical(points, orientation, axis_radians)
    at = lambda label: value[LANDMARKS[label]]
    brow, root, tip = at("brow"), at("nasal_root"), at("nose_tip")
    columella, subnasale = at("columella"), at("subnasale")
    upper, lower, fold = at("upper_lip"), at("lower_lip"), at("mentolabial_fold")
    pogonion, menton = at("pogonion"), at("menton")
    face_height = abs(float(menton[1] - brow[1]))
    if face_height <= 1e-8:
        return None
    minimum = face_height * 0.005
    segments = [(root, subnasale), (subnasale, pogonion), (tip, pogonion),
                (columella, subnasale), (subnasale, upper), (lower, fold), (fold, pogonion)]
    if any(float(np.linalg.norm(left - right)) < minimum for left, right in segments):
        return None
    midface = float(subnasale[1] - brow[1])
    lower_face = float(pogonion[1] - subnasale[1])
    if midface <= minimum or lower_face <= minimum:
        return None
    convexity = angle_at(subnasale, root, pogonion)
    nasolabial = angle_at(subnasale, columella, upper)
    mentolabial = angle_at(fold, lower, pogonion)
    upper_eline = forward_distance(upper, tip, pogonion)
    lower_eline = forward_distance(lower, tip, pogonion)
    chin = forward_distance(pogonion, root, subnasale)
    jaw = fitted_inclination(value[JAW_INDICES])
    scalars = [convexity, nasolabial, mentolabial, upper_eline, lower_eline, chin, jaw]
    if any(item is None or not math.isfinite(item) for item in scalars):
        return None
    total = midface + lower_face
    return {
        "softTissueConvexityAngle": float(convexity),
        "eLine": np.array([float(upper_eline) / face_height, float(lower_eline) / face_height]),
        "nasolabialAngle": float(nasolabial),
        "mentolabialAngle": float(mentolabial),
        "softTissueChinProjection": float(chin) / face_height,
        "mandibularPlaneInclinationProxy": float(jaw),
        "profileVerticalProportion": np.array([midface / total, lower_face / total]),
    }


def metric_error(predicted: np.ndarray | float, target: np.ndarray | float) -> float:
    if isinstance(predicted, np.ndarray):
        return float(np.max(np.abs(predicted - target)))
    return abs(float(predicted) - float(target))


def evaluate_geometry(primary: dict[str, np.ndarray], perturbed: dict[str, np.ndarray] | None = None) -> dict[str, object]:
    errors = {name: [] for name in ANGLE_METRICS | RATIO_METRICS}
    crop = {name: [] for name in ANGLE_METRICS | RATIO_METRICS}
    valid = Counter()
    orientation_counts = Counter()
    by_orientation_errors = {
        side: {name: [] for name in ANGLE_METRICS | RATIO_METRICS}
        for side in ("left", "right")
    }
    total = len(primary["predictions"])
    for index in range(total):
        side = "left" if int(primary["orientations"][index]) == 0 else "right"
        orientation_counts[side] += 1
        gt = primary["ground_truths"][index]
        vertical = gt[LANDMARKS["menton"]] - gt[LANDMARKS["brow"]]
        axis = math.atan2(float(vertical[1]), float(vertical[0])) - math.pi / 2
        target = geometry(gt, side, axis)
        predicted = geometry(primary["predictions"][index], side, axis)
        alternate = geometry(perturbed["predictions"][index], side, axis) if perturbed is not None else None
        if target is None or predicted is None:
            continue
        for name in errors:
            error = metric_error(predicted[name], target[name])
            errors[name].append(error)
            by_orientation_errors[side][name].append(error)
            valid[name] += 1
            if alternate is not None:
                crop[name].append(metric_error(predicted[name], alternate[name]))
    return {
        "images": total,
        "byOrientation": dict(orientation_counts),
        "metrics": {
            name: {
                "unit": "degrees" if name in ANGLE_METRICS else "absolute_ratio",
                "valid": valid[name],
                "validRate": round(valid[name] / total, 4),
                "absoluteError": distribution(errors[name]),
                "cropSensitivity": distribution(crop[name]) if crop[name] else None,
                "byOrientationAbsoluteError": {
                    side: distribution(values[name]) for side, values in by_orientation_errors.items()
                },
            }
            for name in errors
        },
    }


def metric_pass(metric: dict[str, object], include_crop: bool) -> bool:
    error = metric["absoluteError"]
    angular = metric["unit"] == "degrees"
    passed = metric["validRate"] >= 0.95
    passed = passed and error["median"] <= (3.0 if angular else 0.03)
    passed = passed and error["p95"] <= (8.0 if angular else 0.08)
    passed = passed and all(
        values["median"] <= (3.0 if angular else 0.03)
        and values["p95"] <= (8.0 if angular else 0.08)
        for values in metric["byOrientationAbsoluteError"].values()
    )
    if include_crop:
        crop = metric["cropSensitivity"]
        passed = passed and crop["p95"] <= (5.0 if angular else 0.05)
    return passed


def main() -> None:
    if len(sys.argv) != 4:
        raise SystemExit("usage: benchmark.py MENPO_DIR RESEARCH_MODEL RESULT_JSON")
    menpo_dir, model_path, result_path = map(Path, sys.argv[1:])
    torch.set_num_threads(min(8, os.cpu_count() or 1))
    torch.set_num_interop_threads(1)
    records, markup_counts = load_records(menpo_dir)
    validation_records = [record for record in records if record.split == "engineering" and record.fold == 4]
    development_records = [record for record in records if record.split == "holdout"]
    checkpoint = torch.load(model_path, map_location="cpu", weights_only=False)
    if checkpoint.get("landmarkCount") != 39 or checkpoint.get("researchOnly") is not True:
        raise RuntimeError("unexpected research checkpoint contract")
    model = MobileNet39Heatmaps(pretrained=False)
    model.load_state_dict(checkpoint["stateDict"])
    validation_primary = predict(model, MenpoProfileDataset(validation_records, augment=False, factor=PRIMARY_FACTOR))
    development_primary = predict(model, MenpoProfileDataset(development_records, augment=False, factor=PRIMARY_FACTOR))
    development_perturbed = predict(model, MenpoProfileDataset(development_records, augment=False, factor=PERTURBED_FACTOR))
    validation = evaluate_geometry(validation_primary)
    development = evaluate_geometry(development_primary, development_perturbed)
    gates = {
        "developmentHasAtLeast400Images": len(development_records) >= 400,
        "eachNativeMetricValidRateAtLeast95Percent": all(
            metric["validRate"] >= 0.95 for metric in development["metrics"].values()
        ),
        "eachNativeMetricMeetsErrorAndCropThresholdsInBothOrientations": all(
            metric_pass(metric, True) for metric in development["metrics"].values()
        ),
        "developmentDoesNotExceedValidationMedianByMoreThan25Percent": all(
            development["metrics"][name]["absoluteError"]["median"]
            <= max(validation["metrics"][name]["absoluteError"]["median"] * 1.25, 1e-6)
            for name in development["metrics"]
        ),
    }
    seven_native_pass = all(gates.values())
    result = {
        "testedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "policyVersion": "HEADUP-MENPO39-PROFILE-GEOMETRY-1.0",
        "source": {
            "archiveSha256": os.environ.get("HEADUP_MENPO_ARCHIVE_SHA256"),
            "profileImages": len(records),
            "markupCounts": markup_counts,
            "license": "non-commercial research only",
        },
        "model": {
            "pathRole": "retained research-only checkpoint; path not recorded",
            "sha256": sha256(model_path),
            "architecture": checkpoint.get("architecture"),
        },
        "protocol": {
            "normalization": "ground-truth brow-to-menton axis and projected face height; best-case landmark isolation",
            "primaryCropFactor": PRIMARY_FACTOR,
            "perturbedCropFactor": PERTURBED_FACTOR,
            "angularThresholdsDegrees": {"median": 3.0, "p95": 8.0, "cropP95": 5.0},
            "ratioThresholds": {"median": 0.03, "p95": 0.08, "cropP95": 0.05},
            "validRateMinimum": 0.95,
            "nativeMetricCount": 7,
            "sourceMetricCount": 8,
            "cervicomentalAngle": "not computable: native Menpo39 has no neck tangent",
        },
        "partition": {
            "validation": len(validation_records),
            "development": len(development_records),
            "developmentReuseWarning": "The 450-image cohort is reused development evidence, not a fresh confirmatory holdout",
            "identityIsolation": "unavailable in source metadata",
        },
        "validation": validation,
        "development": development,
        "predeclaredSevenNativeMetricGates": gates,
        "passesSevenNativeMetricDevelopmentGates": seven_native_pass,
        "passesFullEightMetricContract": False,
        "releaseEligible": False,
        "interpretation": "Seven native geometry metrics are an offline development audit only. Cervicomental angle, fresh product-camera confirmation and commercial data rights remain absent.",
        "retention": {
            "imagesRetained": False,
            "annotationsRetained": False,
            "individualPredictionsRetained": False,
            "identifiersRetained": False,
            "aggregateOnlyResult": True,
        },
    }
    result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "resultPath": str(result_path),
        "gates": gates,
        "sevenNativePass": seven_native_pass,
        "fullEightPass": False,
        "development": development["metrics"],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
