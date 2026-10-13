"""Geometry-aware fine-tuning for the retained native Menpo39 research model."""

from __future__ import annotations

import datetime
import json
import math
import os
import runpy
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as functional
from torch.utils.data import DataLoader


GEOMETRY = runpy.run_path(
    str(Path(__file__).with_name("benchmark-menpo39-profile-geometry.py")),
    run_name="headup_menpo39_geometry_finetune_helpers",
)
TRAIN = GEOMETRY["TRAIN"]
load_records = TRAIN["load_records"]
MenpoProfileDataset = TRAIN["MenpoProfileDataset"]
MobileNet39Heatmaps = TRAIN["MobileNet39Heatmaps"]
soft_argmax = TRAIN["soft_argmax"]
loss_for = TRAIN["loss_for"]
predict = TRAIN["predict"]
metric_distributions = TRAIN["metric_distributions"]
sha256 = TRAIN["sha256"]
PRIMARY_FACTOR = TRAIN["PRIMARY_FACTOR"]
PERTURBED_FACTOR = TRAIN["PERTURBED_FACTOR"]
CRITICAL = TRAIN["CRITICAL"]
evaluate_geometry = GEOMETRY["evaluate_geometry"]
metric_pass = GEOMETRY["metric_pass"]
ANGLE_METRICS = GEOMETRY["ANGLE_METRICS"]
RATIO_METRICS = GEOMETRY["RATIO_METRICS"]

SEED = 39029
MAX_EPOCHS = 10
GEOMETRY_LOSS_WEIGHT = 25.0
FAILING_V1_METRICS = {
    "softTissueConvexityAngle",
    "nasolabialAngle",
    "mentolabialAngle",
    "softTissueChinProjection",
    "mandibularPlaneInclinationProxy",
}
GEOMETRY_FEATURE_WEIGHTS = {
    "softTissueConvexityAngle": 2.0,
    "eLine": 0.5,
    "nasolabialAngle": 3.0,
    "mentolabialAngle": 3.0,
    "softTissueChinProjection": 2.0,
    "mandibularPlaneInclinationProxy": 2.0,
    "profileVerticalProportion": 0.5,
}


def canonical_batch(points: torch.Tensor, target: torch.Tensor, orientation: torch.Tensor) -> torch.Tensor:
    vertical = target[:, 8] - target[:, 14]
    vertical = vertical / torch.clamp(torch.linalg.vector_norm(vertical, dim=1, keepdim=True), min=1e-5)
    horizontal = torch.stack([vertical[:, 1], -vertical[:, 0]], dim=1)
    direction = torch.where(orientation == 1, 1.0, -1.0).to(points.dtype)
    relative = points - target[:, 14:15]
    x = torch.sum(relative * horizontal[:, None], dim=2) * direction[:, None]
    y = torch.sum(relative * vertical[:, None], dim=2)
    return torch.stack([x, y], dim=2)


def batch_angle(vertex: torch.Tensor, first: torch.Tensor, second: torch.Tensor) -> torch.Tensor:
    left, right = first - vertex, second - vertex
    denominator = torch.clamp(
        torch.linalg.vector_norm(left, dim=1) * torch.linalg.vector_norm(right, dim=1),
        min=1e-5,
    )
    cosine = torch.clamp(torch.sum(left * right, dim=1) / denominator, -0.99999, 0.99999)
    return torch.acos(cosine) / math.pi


def batch_forward_distance(point: torch.Tensor, start: torch.Tensor, end: torch.Tensor) -> torch.Tensor:
    line = end - start
    length = torch.clamp(torch.linalg.vector_norm(line, dim=1, keepdim=True), min=1e-5)
    normal = torch.stack([line[:, 1], -line[:, 0]], dim=1) / length
    normal = torch.where((normal[:, :1] < 0).expand_as(normal), -normal, normal)
    return torch.sum((point - start) * normal, dim=1)


def batch_jaw_inclination(points: torch.Tensor) -> torch.Tensor:
    jaw = points[:, [4, 5, 6, 7, 8]]
    centered = jaw - torch.mean(jaw, dim=1, keepdim=True)
    xx = torch.sum(centered[:, :, 0] ** 2, dim=1)
    xy = torch.sum(centered[:, :, 0] * centered[:, :, 1], dim=1)
    yy = torch.sum(centered[:, :, 1] ** 2, dim=1)
    angle = 0.5 * torch.atan2(2 * xy, xx - yy)
    return torch.atan2(torch.abs(torch.sin(angle)), torch.abs(torch.cos(angle))) / (math.pi / 2)


def geometry_features(points: torch.Tensor, target: torch.Tensor, orientation: torch.Tensor) -> dict[str, torch.Tensor]:
    value = canonical_batch(points, target, orientation)
    face_height = torch.clamp(torch.abs(value[:, 8, 1] - value[:, 14, 1]), min=1e-4)
    midface = value[:, 21, 1] - value[:, 14, 1]
    lower = value[:, 10, 1] - value[:, 21, 1]
    total = torch.clamp(midface + lower, min=1e-4)
    return {
        "softTissueConvexityAngle": batch_angle(value[:, 21], value[:, 17], value[:, 10]),
        "eLine": torch.stack([
            batch_forward_distance(value[:, 27], value[:, 19], value[:, 10]) / face_height,
            batch_forward_distance(value[:, 33], value[:, 19], value[:, 10]) / face_height,
        ], dim=1),
        "nasolabialAngle": batch_angle(value[:, 21], value[:, 20], value[:, 27]),
        "mentolabialAngle": batch_angle(value[:, 11], value[:, 33], value[:, 10]),
        "softTissueChinProjection": batch_forward_distance(value[:, 10], value[:, 17], value[:, 21]) / face_height,
        "mandibularPlaneInclinationProxy": batch_jaw_inclination(value),
        "profileVerticalProportion": torch.stack([midface / total, lower / total], dim=1),
    }


def differentiable_geometry_loss(predicted: torch.Tensor, target: torch.Tensor, orientation: torch.Tensor) -> tuple[torch.Tensor, dict[str, float]]:
    predicted_features = geometry_features(predicted, target, orientation)
    target_features = geometry_features(target, target, orientation)
    losses = {
        name: functional.smooth_l1_loss(predicted_features[name], target_features[name])
        for name in predicted_features
    }
    denominator = sum(GEOMETRY_FEATURE_WEIGHTS.values())
    combined = sum(losses[name] * GEOMETRY_FEATURE_WEIGHTS[name] for name in losses) / denominator
    return combined, {name: float(value.detach()) for name, value in losses.items()}


def selection_score(geometry_result: dict[str, object], coordinate_result: dict[str, object]) -> tuple[float, float, float, float]:
    normalized = []
    failures = 0
    for name, metric in geometry_result["metrics"].items():
        angular = metric["unit"] == "degrees"
        median_scale, p95_scale = (3.0, 8.0) if angular else (0.03, 0.08)
        values = [metric["absoluteError"]["median"] / median_scale, metric["absoluteError"]["p95"] / p95_scale]
        normalized.extend(values)
        if not metric_pass(metric, False):
            failures += 1
    return (
        float(failures),
        float(max(normalized)),
        float(np.mean(normalized)),
        float(coordinate_result["fullMarkupRmsNme"]["median"]),
    )


def coordinate_gates(metrics: dict[str, object]) -> dict[str, bool]:
    full = metrics["fullMarkupRmsNme"]
    critical = metrics["criticalPointNme"]
    return {
        "fullMarkupMedianAtMost3Percent": full["median"] <= 0.03,
        "fullMarkupP95AtMost8Percent": full["p95"] <= 0.08,
        "eachCriticalMedianAtMost3Percent": all(value["median"] <= 0.03 for value in critical.values()),
        "eachCriticalP95AtMost8Percent": all(value["p95"] <= 0.08 for value in critical.values()),
    }


def main() -> None:
    if len(sys.argv) != 6:
        raise SystemExit("usage: finetune.py MENPO_DIR V1_MODEL CHECKPOINT_TMP V2_MODEL RESULT_JSON")
    menpo_dir, v1_path, checkpoint_path, v2_path, result_path = map(Path, sys.argv[1:])
    torch.manual_seed(SEED)
    np.random.seed(SEED)
    torch.set_num_threads(min(8, os.cpu_count() or 1))
    torch.set_num_interop_threads(1)
    records, markup_counts = load_records(menpo_dir)
    engineering = [record for record in records if record.split == "engineering"]
    training_records = [record for record in engineering if record.fold != 4]
    validation_records = [record for record in engineering if record.fold == 4]
    development_records = [record for record in records if record.split == "holdout"]
    training = MenpoProfileDataset(training_records, augment=True)
    validation_dataset = MenpoProfileDataset(validation_records, augment=False, factor=PRIMARY_FACTOR)
    development_primary_dataset = MenpoProfileDataset(development_records, augment=False, factor=PRIMARY_FACTOR)
    development_perturbed_dataset = MenpoProfileDataset(development_records, augment=False, factor=PERTURBED_FACTOR)

    source_checkpoint = torch.load(v1_path, map_location="cpu", weights_only=False)
    baseline_model = MobileNet39Heatmaps(pretrained=False)
    baseline_model.load_state_dict(source_checkpoint["stateDict"])
    baseline_primary = predict(baseline_model, development_primary_dataset)
    baseline_perturbed = predict(baseline_model, development_perturbed_dataset)
    baseline_geometry = evaluate_geometry(baseline_primary, baseline_perturbed)
    del baseline_model, baseline_primary, baseline_perturbed

    model = MobileNet39Heatmaps(pretrained=False)
    model.load_state_dict(source_checkpoint["stateDict"])
    point_weights = torch.ones(39, dtype=torch.float32)
    for index in CRITICAL.values():
        point_weights[index] = 2.0
    optimizer = torch.optim.AdamW([
        {"params": model.features.parameters(), "lr": 5e-5},
        {"params": model.head.parameters(), "lr": 2e-4},
    ], weight_decay=1e-4)
    curve = []
    best_score = (float("inf"),) * 4
    best_epoch = 0
    patience = 0
    started = time.perf_counter()
    for epoch in range(1, MAX_EPOCHS + 1):
        training.set_epoch(epoch)
        generator = torch.Generator().manual_seed(SEED + epoch)
        loader = DataLoader(training, batch_size=16, shuffle=True, generator=generator, num_workers=0)
        model.train()
        total_losses, point_losses, geometry_losses = [], [], []
        feature_sums = {name: [] for name in GEOMETRY_FEATURE_WEIGHTS}
        epoch_started = time.perf_counter()
        for batch in loader:
            optimizer.zero_grad(set_to_none=True)
            logits = model(batch["image"])
            coordinate_loss = loss_for(logits, batch["target"], point_weights)
            predicted = soft_argmax(logits)
            geometry_loss, feature_losses = differentiable_geometry_loss(predicted, batch["target"], batch["orientation"])
            loss = coordinate_loss + GEOMETRY_LOSS_WEIGHT * geometry_loss
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 5.0)
            optimizer.step()
            total_losses.append(float(loss.detach()))
            point_losses.append(float(coordinate_loss.detach()))
            geometry_losses.append(float(geometry_loss.detach()))
            for name, value in feature_losses.items():
                feature_sums[name].append(value)
        validation_predictions = predict(model, validation_dataset)
        validation_coordinate = metric_distributions(validation_predictions)
        validation_geometry = evaluate_geometry(validation_predictions)
        score = selection_score(validation_geometry, validation_coordinate)
        row = {
            "epoch": epoch,
            "totalLoss": round(float(np.mean(total_losses)), 6),
            "pointLoss": round(float(np.mean(point_losses)), 6),
            "geometryLoss": round(float(np.mean(geometry_losses)), 6),
            "featureLoss": {name: round(float(np.mean(values)), 7) for name, values in feature_sums.items()},
            "validationSelectionScore": [round(value, 6) for value in score],
            "validationFullMarkupMedian": validation_coordinate["fullMarkupRmsNme"]["median"],
            "seconds": round(time.perf_counter() - epoch_started, 3),
        }
        curve.append(row)
        print(
            f"Epoch {epoch}/{MAX_EPOCHS}: total={row['totalLoss']:.5f}, geom={row['geometryLoss']:.6f}, "
            f"failed={int(score[0])}, worst={score[1]:.3f}, full={row['validationFullMarkupMedian']:.4f}",
            file=sys.stderr,
            flush=True,
        )
        if score < best_score:
            best_score, best_epoch, patience = score, epoch, 0
            torch.save(model.state_dict(), checkpoint_path)
        else:
            patience += 1
        if epoch >= 6 and patience >= 3:
            break

    model.load_state_dict(torch.load(checkpoint_path, map_location="cpu", weights_only=True))
    validation_predictions = predict(model, validation_dataset)
    candidate_primary = predict(model, development_primary_dataset)
    candidate_perturbed = predict(model, development_perturbed_dataset)
    validation_geometry = evaluate_geometry(validation_predictions)
    candidate_geometry = evaluate_geometry(candidate_primary, candidate_perturbed)
    candidate_coordinate = metric_distributions(candidate_primary)
    coordinate_checks = coordinate_gates(candidate_coordinate)
    seven_checks = {
        "allSevenMetricsMeetDevelopmentErrorAndCropThresholds": all(
            metric_pass(metric, True) for metric in candidate_geometry["metrics"].values()
        ),
        "developmentMedianNoMoreThan25PercentWorseThanValidation": all(
            candidate_geometry["metrics"][name]["absoluteError"]["median"]
            <= max(validation_geometry["metrics"][name]["absoluteError"]["median"] * 1.25, 1e-6)
            for name in candidate_geometry["metrics"]
        ),
        **coordinate_checks,
    }
    seven_pass = all(seven_checks.values())
    improvements = {}
    for name in candidate_geometry["metrics"]:
        baseline = baseline_geometry["metrics"][name]["absoluteError"]["median"]
        candidate = candidate_geometry["metrics"][name]["absoluteError"]["median"]
        improvements[name] = round((baseline - candidate) / max(baseline, 1e-8), 4)
    improved_failing = sum(improvements[name] >= 0.10 for name in FAILING_V1_METRICS)
    no_failing_regression = all(improvements[name] >= -0.10 for name in FAILING_V1_METRICS)
    preserves_v1_passes = all(
        metric_pass(candidate_geometry["metrics"][name], True)
        for name in ("eLine", "profileVerticalProportion")
    )
    pareto_promotion = (
        improved_failing >= 4
        and no_failing_regression
        and preserves_v1_passes
        and all(coordinate_checks.values())
        and seven_checks["developmentMedianNoMoreThan25PercentWorseThanValidation"]
    )
    promoted = seven_pass or pareto_promotion
    model_sha = None
    if promoted:
        v2_path.parent.mkdir(parents=True, exist_ok=True)
        torch.save({
            "architecture": "MobileNet39Heatmaps-geometry-v2",
            "landmarkCount": 39,
            "imageSize": 224,
            "primaryCropFactor": PRIMARY_FACTOR,
            "stateDict": model.state_dict(),
            "researchOnly": True,
            "trainingData": "Menpo2D non-commercial research engineering partition",
            "parentSha256": sha256(v1_path),
            "geometryLossWeight": GEOMETRY_LOSS_WEIGHT,
        }, v2_path)
        model_sha = sha256(v2_path)

    result = {
        "testedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "policyVersion": "HEADUP-MENPO39-GEOMETRY-FINETUNE-1.0",
        "source": {
            "archiveSha256": os.environ.get("HEADUP_MENPO_ARCHIVE_SHA256"),
            "profileImages": len(records),
            "markupCounts": markup_counts,
            "license": "non-commercial research only",
        },
        "partition": {
            "training": len(training_records),
            "validation": len(validation_records),
            "development": len(development_records),
            "developmentReuseWarning": "Reused development evidence; not a fresh confirmatory holdout",
            "identityIsolation": "unavailable in source metadata",
        },
        "model": {
            "parentSha256": sha256(v1_path),
            "bestEpoch": best_epoch,
            "epochsRun": len(curve),
            "promoted": promoted,
            "candidateSha256": model_sha,
            "productionPackaged": False,
        },
        "training": {
            "seed": SEED,
            "optimizer": "AdamW features 5e-5, head 2e-4",
            "geometryLossWeight": GEOMETRY_LOSS_WEIGHT,
            "geometryFeatureWeights": GEOMETRY_FEATURE_WEIGHTS,
            "selection": "fewest failed validation geometry metrics, then worst and mean normalized error, then full-markup median",
            "curve": curve,
            "rawWallSeconds": round(time.perf_counter() - started, 3),
        },
        "baselineDevelopment": baseline_geometry,
        "candidateValidation": validation_geometry,
        "candidateDevelopment": candidate_geometry,
        "candidateCoordinateDevelopment": candidate_coordinate,
        "medianRelativeImprovementVsV1": improvements,
        "sevenMetricGates": seven_checks,
        "passesSevenNativeMetricDevelopmentGates": seven_pass,
        "paretoPromotionGates": {
            "atLeastFourOfFiveFailingMetricsImproveMedianBy10Percent": improved_failing >= 4,
            "improvedFailingMetricCount": improved_failing,
            "noFailingMetricMedianRegressesMoreThan10Percent": no_failing_regression,
            "preservesELineAndVerticalProportion": preserves_v1_passes,
            "coordinateGatesPass": all(coordinate_checks.values()),
        },
        "candidatePromoted": promoted,
        "passesFullEightMetricContract": False,
        "releaseEligible": False,
        "retention": {
            "imagesRetained": False,
            "annotationsRetained": False,
            "individualPredictionsRetained": False,
            "identifiersRetained": False,
            "candidateRetainedOnlyIfPromotionGatesPass": True,
        },
    }
    result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "resultPath": str(result_path),
        "bestEpoch": best_epoch,
        "improvements": improvements,
        "sevenGates": seven_checks,
        "paretoGates": result["paretoPromotionGates"],
        "promoted": promoted,
        "candidateSha256": model_sha,
        "candidateDevelopment": candidate_geometry["metrics"],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
