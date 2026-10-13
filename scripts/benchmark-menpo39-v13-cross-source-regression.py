"""Cross-source regression audit for the MERL-RAV menton-only V13 checkpoint.

The fixed Menpo profile development cohort is historical development evidence,
not a fresh holdout.  It is used once here without tuning to check whether the
MERL-RAV correction changes any non-menton output or materially regresses the
native 39-point/geometry contract.  Only aggregate metrics are written.
"""

from __future__ import annotations

import datetime
import json
import math
import os
import runpy
import sys
from pathlib import Path

import numpy as np
import torch


TRAIN = runpy.run_path(
    str(Path(__file__).with_name("train-menpo39-profile-landmarks.py")),
    run_name="headup_menpo39_v13_cross_source_training_helpers",
)
GEOMETRY = runpy.run_path(
    str(Path(__file__).with_name("benchmark-menpo39-profile-geometry.py")),
    run_name="headup_menpo39_v13_cross_source_geometry_helpers",
)

load_records = TRAIN["load_records"]
MenpoProfileDataset = TRAIN["MenpoProfileDataset"]
MobileNet39Heatmaps = TRAIN["MobileNet39Heatmaps"]
predict = TRAIN["predict"]
metric_distributions = TRAIN["metric_distributions"]
distribution = TRAIN["distribution"]
sha256 = TRAIN["sha256"]
PRIMARY_FACTOR = TRAIN["PRIMARY_FACTOR"]
PERTURBED_FACTOR = TRAIN["PERTURBED_FACTOR"]
CRITICAL = TRAIN["CRITICAL"]
LANDMARK_COUNT = TRAIN["LANDMARK_COUNT"]
evaluate_geometry = GEOMETRY["evaluate_geometry"]

MENTON_INDEX = 8
FINAL_WEIGHT = "head.9.weight"
FINAL_BIAS = "head.9.bias"


def load_model(checkpoint_path: Path) -> tuple[torch.nn.Module, dict[str, object]]:
    checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
    if checkpoint.get("landmarkCount") != LANDMARK_COUNT or checkpoint.get("researchOnly") is not True:
        raise RuntimeError(f"unexpected checkpoint contract: {checkpoint_path.name}")
    model = MobileNet39Heatmaps(pretrained=False)
    model.load_state_dict(checkpoint["stateDict"])
    model.eval()
    return model, checkpoint


def state_isolation(baseline: dict[str, object], candidate: dict[str, object]) -> dict[str, object]:
    baseline_state = baseline["stateDict"]
    candidate_state = candidate["stateDict"]
    if set(baseline_state) != set(candidate_state):
        raise RuntimeError("checkpoint state keys differ")
    changed = []
    maximum_non_menton_change = 0.0
    for name in baseline_state:
        left, right = baseline_state[name], candidate_state[name]
        if left.shape != right.shape:
            raise RuntimeError(f"checkpoint tensor shape differs: {name}")
        if torch.equal(left, right):
            continue
        changed.append(name)
        difference = (left - right).abs()
        if name == FINAL_WEIGHT:
            mask = torch.ones_like(difference, dtype=torch.bool)
            mask[:, MENTON_INDEX, :, :] = False
            if mask.any():
                maximum_non_menton_change = max(
                    maximum_non_menton_change, float(difference[mask].max())
                )
        elif name == FINAL_BIAS:
            mask = torch.ones_like(difference, dtype=torch.bool)
            mask[MENTON_INDEX] = False
            if mask.any():
                maximum_non_menton_change = max(
                    maximum_non_menton_change, float(difference[mask].max())
                )
        else:
            maximum_non_menton_change = max(maximum_non_menton_change, float(difference.max()))
    allowed = {FINAL_WEIGHT, FINAL_BIAS}
    return {
        "changedStateTensors": changed,
        "expectedChangedStateTensors": sorted(allowed),
        "maximumAbsoluteNonMentonParameterChange": maximum_non_menton_change,
        "onlyFinalMentonSliceChanged": set(changed).issubset(allowed)
        and bool(changed)
        and maximum_non_menton_change == 0.0,
    }


def prediction_change(baseline: dict[str, np.ndarray], candidate: dict[str, np.ndarray]) -> dict[str, object]:
    if not np.array_equal(baseline["ground_truths"], candidate["ground_truths"]):
        raise RuntimeError("prediction cohorts differ")
    non_menton = [index for index in range(LANDMARK_COUNT) if index != MENTON_INDEX]
    non_menton_delta = np.abs(
        baseline["predictions"][:, non_menton] - candidate["predictions"][:, non_menton]
    )
    menton_delta = np.linalg.norm(
        baseline["predictions"][:, MENTON_INDEX] - candidate["predictions"][:, MENTON_INDEX], axis=1
    ) / baseline["diagonals"]
    return {
        "maximumAbsoluteNonMentonCoordinateChangePixels": float(non_menton_delta.max()),
        "nonMentonPredictionsBitwiseIdentical": bool(
            np.array_equal(
                baseline["predictions"][:, non_menton], candidate["predictions"][:, non_menton]
            )
        ),
        "mentonPredictionShiftNme": distribution(menton_delta.tolist()),
    }


def menton_crop(primary: dict[str, np.ndarray], perturbed: dict[str, np.ndarray]) -> dict[str, float]:
    displacement = np.linalg.norm(
        primary["predictions"][:, MENTON_INDEX] - perturbed["predictions"][:, MENTON_INDEX], axis=1
    ) / primary["diagonals"]
    return distribution(displacement.tolist())


def direction(data: dict[str, np.ndarray]) -> dict[str, dict[str, object]]:
    result = {}
    for side, encoded in (("left", 0), ("right", 1)):
        mask = data["orientations"] == encoded
        predicted_sign = np.sign(
            data["predictions"][mask, CRITICAL["nose_tip"], 0]
            - data["predictions"][mask, CRITICAL["soft_tissue_pogonion"], 0]
        )
        target_sign = np.sign(
            data["ground_truths"][mask, CRITICAL["nose_tip"], 0]
            - data["ground_truths"][mask, CRITICAL["soft_tissue_pogonion"], 0]
        )
        correct = predicted_sign == target_sign
        result[side] = {
            "correct": int(correct.sum()),
            "total": int(len(correct)),
            "accuracy": round(float(np.mean(correct)), 4),
        }
    return result


def at_most_relative(candidate: float, baseline: float, ratio: float) -> bool:
    return candidate <= max(baseline * ratio, 1e-12)


def geometry_no_material_regression(
    baseline: dict[str, object], candidate: dict[str, object], ratio: float
) -> tuple[bool, dict[str, object]]:
    comparison = {}
    passed = True
    for name, baseline_metric in baseline["metrics"].items():
        candidate_metric = candidate["metrics"][name]
        checks = {
            "validRateNotReduced": candidate_metric["validRate"] >= baseline_metric["validRate"],
            "medianNoMoreThan10PercentWorse": at_most_relative(
                candidate_metric["absoluteError"]["median"],
                baseline_metric["absoluteError"]["median"],
                ratio,
            ),
            "p95NoMoreThan10PercentWorse": at_most_relative(
                candidate_metric["absoluteError"]["p95"],
                baseline_metric["absoluteError"]["p95"],
                ratio,
            ),
        }
        comparison[name] = {
            "unit": baseline_metric["unit"],
            "baseline": baseline_metric["absoluteError"],
            "candidate": candidate_metric["absoluteError"],
            "checks": checks,
        }
        passed = passed and all(checks.values())
    return passed, comparison


def main() -> None:
    if len(sys.argv) != 5:
        raise SystemExit("usage: benchmark.py MENPO_DIR BASELINE_MODEL V13_MODEL RESULT_JSON")
    menpo_dir, baseline_path, candidate_path, result_path = map(Path, sys.argv[1:])
    torch.set_num_threads(min(8, os.cpu_count() or 1))
    torch.set_num_interop_threads(1)

    records, markup_counts = load_records(menpo_dir)
    development_records = [record for record in records if record.split == "holdout"]
    baseline_model, baseline_checkpoint = load_model(baseline_path)
    candidate_model, candidate_checkpoint = load_model(candidate_path)
    state_audit = state_isolation(baseline_checkpoint, candidate_checkpoint)

    primary_dataset = MenpoProfileDataset(development_records, augment=False, factor=PRIMARY_FACTOR)
    perturbed_dataset = MenpoProfileDataset(development_records, augment=False, factor=PERTURBED_FACTOR)
    baseline_primary = predict(baseline_model, primary_dataset)
    baseline_perturbed = predict(baseline_model, perturbed_dataset)
    candidate_primary = predict(candidate_model, primary_dataset)
    candidate_perturbed = predict(candidate_model, perturbed_dataset)

    baseline_native = metric_distributions(baseline_primary)
    candidate_native = metric_distributions(candidate_primary)
    baseline_geometry = evaluate_geometry(baseline_primary, baseline_perturbed)
    candidate_geometry = evaluate_geometry(candidate_primary, candidate_perturbed)
    geometry_pass, geometry_comparison = geometry_no_material_regression(
        baseline_geometry, candidate_geometry, 1.10
    )
    inference_audit = prediction_change(baseline_primary, candidate_primary)
    baseline_crop = menton_crop(baseline_primary, baseline_perturbed)
    candidate_crop = menton_crop(candidate_primary, candidate_perturbed)
    candidate_direction = direction(candidate_primary)

    baseline_menton = baseline_native["criticalPointNme"]["menton"]
    candidate_menton = candidate_native["criticalPointNme"]["menton"]
    baseline_full = baseline_native["fullMarkupRmsNme"]
    candidate_full = candidate_native["fullMarkupRmsNme"]
    gates = {
        "developmentHasAtLeast400Images": len(development_records) >= 400,
        "onlyFinalMentonParameterSliceChanged": state_audit["onlyFinalMentonSliceChanged"],
        "other38PointPredictionsBitwiseIdentical": inference_audit["nonMentonPredictionsBitwiseIdentical"],
        "menpoMentonMedianNoMoreThan5PercentWorse": at_most_relative(
            candidate_menton["median"], baseline_menton["median"], 1.05
        ),
        "menpoMentonP95NoMoreThan5PercentWorse": at_most_relative(
            candidate_menton["p95"], baseline_menton["p95"], 1.05
        ),
        "menpoMentonMedianNmeAtMost3Percent": candidate_menton["median"] <= 0.03,
        "menpoMentonP95NmeAtMost8Percent": candidate_menton["p95"] <= 0.08,
        "full39MedianRmsNoMoreThan2PercentWorse": at_most_relative(
            candidate_full["median"], baseline_full["median"], 1.02
        ),
        "full39P95RmsNoMoreThan2PercentWorse": at_most_relative(
            candidate_full["p95"], baseline_full["p95"], 1.02
        ),
        "eachSevenNativeGeometryMedianAndP95NoMoreThan10PercentWorse": geometry_pass,
        "candidateMentonCropSensitivityP95AtMost5Percent": candidate_crop["p95"] <= 0.05,
        "candidateEachDirectionAccuracyAtLeast95Percent": all(
            value["total"] >= 100 and value["accuracy"] >= 0.95
            for value in candidate_direction.values()
        ),
    }
    passes = all(gates.values())
    baseline_sha256 = sha256(baseline_path)
    candidate_sha256 = sha256(candidate_path)
    checkpoint_deleted = False
    if not passes and candidate_path.exists():
        candidate_path.unlink()
        checkpoint_deleted = True
    result = {
        "testedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "policyVersion": "HEADUP-MENPO39-V13-CROSS-SOURCE-REGRESSION-1.0",
        "source": {
            "archiveSha256": os.environ.get("HEADUP_MENPO_ARCHIVE_SHA256"),
            "profileImages": len(records),
            "markupCounts": markup_counts,
            "license": "non-commercial research only",
        },
        "partition": {
            "development": len(development_records),
            "reuseWarning": "historical 450-image development cohort; used only for one-shot cross-source regression, never for V13 training or selection",
            "identityIsolation": "unavailable in source metadata",
        },
        "models": {
            "baselineSha256": baseline_sha256,
            "candidateSha256": candidate_sha256,
            "pathsRecorded": False,
            "commercialUseAllowed": False,
        },
        "protocol": {
            "primaryCropFactor": PRIMARY_FACTOR,
            "perturbedCropFactor": PERTURBED_FACTOR,
            "normalization": "Menpo 39-point face-box diagonal for coordinates; source geometry protocol for seven native metrics",
            "noTuningOrSelection": True,
            "crossSourceRole": "regression evidence, not fresh confirmatory accuracy",
        },
        "stateIsolationAudit": state_audit,
        "inferenceIsolationAudit": inference_audit,
        "nativeCoordinates": {
            "baseline": {
                "fullMarkupRmsNme": baseline_full,
                "mentonNme": baseline_menton,
                "mentonCropSensitivity": baseline_crop,
            },
            "candidate": {
                "fullMarkupRmsNme": candidate_full,
                "mentonNme": candidate_menton,
                "mentonCropSensitivity": candidate_crop,
                "direction": candidate_direction,
            },
        },
        "sevenNativeGeometryComparison": geometry_comparison,
        "predeclaredGates": gates,
        "passesCrossSourceRegressionGates": passes,
        "researchCheckpointRecommendation": "retain" if passes else "delete_or_redesign",
        "checkpointDisposition": {
            "retainedAfterAudit": candidate_path.exists(),
            "deletedAfterCrossSourceFailure": checkpoint_deleted,
            "reason": "all predeclared cross-source gates passed" if passes else "native Menpo menton, full-markup, geometry and crop regression gates failed",
        },
        "releaseEligible": False,
        "limitations": [
            "The Menpo 450-image cohort is reused historical development evidence, not a fresh holdout.",
            "Source metadata does not support reliable identity-disjoint verification.",
            "Menpo39 has no neck tangent; the complete eight-measurement contract remains untestable.",
            "Research-only data cannot authorize a commercial production model.",
            "Ground-truth crops isolate landmark regression and do not test detection or phone capture.",
        ],
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
        "development": len(development_records),
        "baselineMenton": baseline_menton,
        "candidateMenton": candidate_menton,
        "baselineFull": baseline_full,
        "candidateFull": candidate_full,
        "candidateCrop": candidate_crop,
        "direction": candidate_direction,
        "gates": gates,
        "passes": passes,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
