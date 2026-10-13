"""Validation-only calibration study for seven native Menpo39 profile metrics."""

from __future__ import annotations

import datetime
import hashlib
import json
import math
import os
import runpy
import sys
from pathlib import Path

import numpy as np
import torch


GEOMETRY = runpy.run_path(
    str(Path(__file__).with_name("benchmark-menpo39-profile-geometry.py")),
    run_name="headup_menpo39_calibration_helpers",
)
TRAIN = GEOMETRY["TRAIN"]
load_records = TRAIN["load_records"]
MenpoProfileDataset = TRAIN["MenpoProfileDataset"]
MobileNet39Heatmaps = TRAIN["MobileNet39Heatmaps"]
predict = TRAIN["predict"]
distribution = TRAIN["distribution"]
sha256 = TRAIN["sha256"]
PRIMARY_FACTOR = TRAIN["PRIMARY_FACTOR"]
PERTURBED_FACTOR = TRAIN["PERTURBED_FACTOR"]
geometry = GEOMETRY["geometry"]
metric_pass = GEOMETRY["metric_pass"]
LANDMARKS = GEOMETRY["LANDMARKS"]
ANGLE_METRICS = GEOMETRY["ANGLE_METRICS"]
RATIO_METRICS = GEOMETRY["RATIO_METRICS"]

CANDIDATES = ("identity", "global_affine", "orientation_affine")
FAILING_V1_METRICS = {
    "softTissueConvexityAngle",
    "nasolabialAngle",
    "mentolabialAngle",
    "softTissueChinProjection",
    "mandibularPlaneInclinationProxy",
}


def as_vector(value: np.ndarray | float) -> np.ndarray:
    return np.asarray(value, dtype=np.float64).reshape(-1)


def collect(data: dict[str, np.ndarray], alternate: dict[str, np.ndarray] | None = None) -> dict[str, dict[str, np.ndarray]]:
    result = {name: {"predicted": [], "target": [], "alternate": [], "orientation": [], "index": []}
              for name in ANGLE_METRICS | RATIO_METRICS}
    for index in range(len(data["predictions"])):
        side = "left" if int(data["orientations"][index]) == 0 else "right"
        gt = data["ground_truths"][index]
        vertical = gt[LANDMARKS["menton"]] - gt[LANDMARKS["brow"]]
        axis = math.atan2(float(vertical[1]), float(vertical[0])) - math.pi / 2
        target = geometry(gt, side, axis)
        predicted = geometry(data["predictions"][index], side, axis)
        other = geometry(alternate["predictions"][index], side, axis) if alternate is not None else None
        if target is None or predicted is None or (alternate is not None and other is None):
            continue
        for name in result:
            result[name]["predicted"].append(as_vector(predicted[name]))
            result[name]["target"].append(as_vector(target[name]))
            if other is not None:
                result[name]["alternate"].append(as_vector(other[name]))
            result[name]["orientation"].append(side)
            result[name]["index"].append(index)
    return {
        name: {
            "predicted": np.vstack(values["predicted"]),
            "target": np.vstack(values["target"]),
            "alternate": np.vstack(values["alternate"]) if values["alternate"] else np.empty((0, 1)),
            "orientation": np.asarray(values["orientation"]),
            "index": np.asarray(values["index"], dtype=np.int64),
        }
        for name, values in result.items()
    }


def identity_coefficients(components: int) -> list[tuple[float, float]]:
    return [(1.0, 0.0) for _ in range(components)]


def fit_component(x: np.ndarray, y: np.ndarray, angular: bool) -> tuple[float, float]:
    if len(x) < 20 or float(np.std(x)) < 1e-8:
        return 1.0, 0.0
    design = np.column_stack([x, np.ones(len(x))])
    slope, intercept = np.linalg.lstsq(design, y, rcond=None)[0]
    slope = float(np.clip(slope, 0.5, 1.5))
    intercept = float(np.clip(intercept, -10.0 if angular else -0.1, 10.0 if angular else 0.1))
    return slope, intercept


def fit_model(kind: str, predicted: np.ndarray, target: np.ndarray, orientations: np.ndarray, angular: bool) -> dict[str, object]:
    components = predicted.shape[1]
    if kind == "identity":
        return {"type": kind, "global": identity_coefficients(components)}
    global_coefficients = [fit_component(predicted[:, item], target[:, item], angular) for item in range(components)]
    model: dict[str, object] = {"type": kind, "global": global_coefficients}
    if kind == "orientation_affine":
        model["byOrientation"] = {
            side: [
                fit_component(predicted[orientations == side, item], target[orientations == side, item], angular)
                for item in range(components)
            ]
            for side in ("left", "right")
        }
    return model


def apply_model(model: dict[str, object], values: np.ndarray, orientations: np.ndarray) -> np.ndarray:
    calibrated = np.empty_like(values)
    global_coefficients = model["global"]
    for index in range(len(values)):
        coefficients = global_coefficients
        if model["type"] == "orientation_affine":
            coefficients = model["byOrientation"][str(orientations[index])]
        for component, (slope, intercept) in enumerate(coefficients):
            calibrated[index, component] = values[index, component] * slope + intercept
    return calibrated


def absolute_error(predicted: np.ndarray, target: np.ndarray) -> np.ndarray:
    return np.max(np.abs(predicted - target), axis=1)


def normalized_score(errors: np.ndarray, angular: bool) -> float:
    median_limit, p95_limit = (3.0, 8.0) if angular else (0.03, 0.08)
    return float(max(np.median(errors) / median_limit, np.quantile(errors, 0.95) / p95_limit)
                 + 0.25 * np.mean(errors) / median_limit)


def select_calibrator(values: dict[str, np.ndarray], folds: np.ndarray, angular: bool) -> tuple[dict[str, object], dict[str, float]]:
    predicted, target, orientations = values["predicted"], values["target"], values["orientation"]
    scores = {}
    for kind in CANDIDATES:
        calibrated = np.empty_like(predicted)
        for fold in range(5):
            training = folds != fold
            held_out = folds == fold
            model = fit_model(kind, predicted[training], target[training], orientations[training], angular)
            calibrated[held_out] = apply_model(model, predicted[held_out], orientations[held_out])
        scores[kind] = normalized_score(absolute_error(calibrated, target), angular)
    best = min(scores, key=scores.get)
    if best != "identity" and scores[best] > scores["identity"] * 0.98:
        best = "identity"
    return fit_model(best, predicted, target, orientations, angular), {key: round(value, 6) for key, value in scores.items()}


def evaluate(values: dict[str, dict[str, np.ndarray]], models: dict[str, dict[str, object]], total_images: int) -> dict[str, object]:
    metrics = {}
    for name, data in values.items():
        calibrated = apply_model(models[name], data["predicted"], data["orientation"])
        errors = absolute_error(calibrated, data["target"])
        crop = None
        if len(data["alternate"]):
            alternate = apply_model(models[name], data["alternate"], data["orientation"])
            crop = absolute_error(calibrated, alternate)
        metrics[name] = {
            "unit": "degrees" if name in ANGLE_METRICS else "absolute_ratio",
            "valid": len(errors),
            "validRate": round(len(errors) / total_images, 4),
            "absoluteError": distribution(errors.tolist()),
            "cropSensitivity": distribution(crop.tolist()) if crop is not None else None,
            "byOrientationAbsoluteError": {
                side: distribution(errors[data["orientation"] == side].tolist()) for side in ("left", "right")
            },
        }
    return {"images": total_images, "metrics": metrics}


def serializable_model(model: dict[str, object]) -> dict[str, object]:
    return {
        key: [[round(float(slope), 8), round(float(intercept), 8)] for slope, intercept in value]
        if key == "global"
        else {
            side: [[round(float(slope), 8), round(float(intercept), 8)] for slope, intercept in coefficients]
            for side, coefficients in value.items()
        } if key == "byOrientation" else value
        for key, value in model.items()
    }


def main() -> None:
    if len(sys.argv) != 6:
        raise SystemExit("usage: calibration.py MENPO_DIR MODEL RESULT_JSON CONFIG_JSON CONFIG_TMP")
    menpo_dir, model_path, result_path, config_path, config_tmp = map(Path, sys.argv[1:])
    torch.set_num_threads(min(8, os.cpu_count() or 1))
    torch.set_num_interop_threads(1)
    records, markup_counts = load_records(menpo_dir)
    validation_records = [record for record in records if record.split == "engineering" and record.fold == 4]
    development_records = [record for record in records if record.split == "holdout"]
    checkpoint = torch.load(model_path, map_location="cpu", weights_only=False)
    model = MobileNet39Heatmaps(pretrained=False)
    model.load_state_dict(checkpoint["stateDict"])
    validation_predictions = predict(model, MenpoProfileDataset(validation_records, augment=False, factor=PRIMARY_FACTOR))
    development_primary = predict(model, MenpoProfileDataset(development_records, augment=False, factor=PRIMARY_FACTOR))
    development_perturbed = predict(model, MenpoProfileDataset(development_records, augment=False, factor=PERTURBED_FACTOR))
    validation_values = collect(validation_predictions)
    development_values = collect(development_primary, development_perturbed)
    validation_folds = np.asarray([
        hashlib.sha256(f"{record.orientation}/{record.image_path.stem}".encode("utf-8")).digest()[2] % 5
        for record in validation_records
    ], dtype=np.int64)
    models, cv_scores = {}, {}
    for name, values in validation_values.items():
        metric_folds = validation_folds[values["index"]]
        models[name], cv_scores[name] = select_calibrator(values, metric_folds, name in ANGLE_METRICS)
    identity_models = {
        name: fit_model("identity", values["predicted"], values["target"], values["orientation"], name in ANGLE_METRICS)
        for name, values in validation_values.items()
    }
    baseline_development = evaluate(development_values, identity_models, len(development_records))
    calibrated_development = evaluate(development_values, models, len(development_records))
    cross_validated_validation = {}
    for name, values in validation_values.items():
        folds = validation_folds[values["index"]]
        calibrated = np.empty_like(values["predicted"])
        kind = models[name]["type"]
        for fold in range(5):
            training, held_out = folds != fold, folds == fold
            fold_model = fit_model(kind, values["predicted"][training], values["target"][training], values["orientation"][training], name in ANGLE_METRICS)
            calibrated[held_out] = apply_model(fold_model, values["predicted"][held_out], values["orientation"][held_out])
        errors = absolute_error(calibrated, values["target"])
        cross_validated_validation[name] = {
            "unit": "degrees" if name in ANGLE_METRICS else "absolute_ratio",
            "valid": len(errors),
            "validRate": round(len(errors) / len(validation_records), 4),
            "absoluteError": distribution(errors.tolist()),
            "cropSensitivity": None,
            "byOrientationAbsoluteError": {
                side: distribution(errors[values["orientation"] == side].tolist()) for side in ("left", "right")
            },
        }
    improvements = {}
    for name in calibrated_development["metrics"]:
        baseline = baseline_development["metrics"][name]["absoluteError"]["median"]
        calibrated = calibrated_development["metrics"][name]["absoluteError"]["median"]
        improvements[name] = round((baseline - calibrated) / max(baseline, 1e-8), 4)
    seven_gates = {
        "allSevenCalibratedMetricsMeetDevelopmentErrorAndCropThresholds": all(
            metric_pass(metric, True) for metric in calibrated_development["metrics"].values()
        ),
        "developmentMedianNoMoreThan25PercentWorseThanCrossValidatedValidation": all(
            calibrated_development["metrics"][name]["absoluteError"]["median"]
            <= max(cross_validated_validation[name]["absoluteError"]["median"] * 1.25, 1e-6)
            for name in calibrated_development["metrics"]
        ),
    }
    seven_pass = all(seven_gates.values())
    improved_failing = sum(improvements[name] >= 0.10 for name in FAILING_V1_METRICS)
    no_failing_regression = all(improvements[name] >= -0.10 for name in FAILING_V1_METRICS)
    preserves_v1_passes = all(
        metric_pass(calibrated_development["metrics"][name], True)
        for name in ("eLine", "profileVerticalProportion")
    )
    pareto = (
        improved_failing >= 4 and no_failing_regression and preserves_v1_passes
        and seven_gates["developmentMedianNoMoreThan25PercentWorseThanCrossValidatedValidation"]
    )
    promoted = seven_pass or pareto
    serialized = {name: serializable_model(value) for name, value in models.items()}
    config_sha = None
    if promoted:
        config_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "policyVersion": "HEADUP-MENPO39-PROFILE-CALIBRATION-1.0",
            "researchOnly": True,
            "parentModelSha256": sha256(model_path),
            "models": serialized,
        }
        config_tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        config_path.write_bytes(config_tmp.read_bytes())
        config_sha = sha256(config_path)
    result = {
        "testedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "policyVersion": "HEADUP-MENPO39-PROFILE-CALIBRATION-STUDY-1.0",
        "source": {
            "archiveSha256": os.environ.get("HEADUP_MENPO_ARCHIVE_SHA256"),
            "profileImages": len(records),
            "markupCounts": markup_counts,
            "license": "non-commercial research only",
        },
        "model": {"sha256": sha256(model_path), "productionPackaged": False},
        "partition": {
            "calibrationSelection": len(validation_records),
            "blindDevelopmentAudit": len(development_records),
            "selectionFolds": {str(fold): int(np.sum(validation_folds == fold)) for fold in range(5)},
            "developmentReuseWarning": "Reused development evidence; not a fresh confirmatory holdout",
            "identityIsolation": "unavailable in source metadata",
        },
        "protocol": {
            "candidateTypes": list(CANDIDATES),
            "selection": "five-fold validation normalized median/P95 score; non-identity requires at least 2% CV improvement",
            "slopeBounds": [0.5, 1.5],
            "angularInterceptBoundsDegrees": [-10.0, 10.0],
            "ratioInterceptBounds": [-0.1, 0.1],
            "developmentUsedForSelection": False,
        },
        "selectedCalibrators": serialized,
        "crossValidationScores": cv_scores,
        "crossValidatedValidation": cross_validated_validation,
        "baselineDevelopment": baseline_development,
        "calibratedDevelopment": calibrated_development,
        "medianRelativeImprovementVsIdentity": improvements,
        "sevenMetricGates": seven_gates,
        "passesSevenNativeMetricDevelopmentGates": seven_pass,
        "paretoPromotionGates": {
            "atLeastFourOfFiveFailingMetricsImproveMedianBy10Percent": improved_failing >= 4,
            "improvedFailingMetricCount": improved_failing,
            "noFailingMetricMedianRegressesMoreThan10Percent": no_failing_regression,
            "preservesELineAndVerticalProportion": preserves_v1_passes,
        },
        "calibratorPromoted": promoted,
        "calibratorSha256": config_sha,
        "passesFullEightMetricContract": False,
        "releaseEligible": False,
        "retention": {
            "imagesRetained": False,
            "annotationsRetained": False,
            "individualPredictionsRetained": False,
            "identifiersRetained": False,
            "calibratorRetainedOnlyIfPromotionGatesPass": True,
        },
    }
    result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "resultPath": str(result_path),
        "selectedTypes": {name: value["type"] for name, value in models.items()},
        "improvements": improvements,
        "sevenGates": seven_gates,
        "paretoGates": result["paretoPromotionGates"],
        "promoted": promoted,
        "configSha256": config_sha,
        "calibratedDevelopment": calibrated_development["metrics"],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
