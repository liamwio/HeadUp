"""Train high-resolution local refiners on top of the retained Menpo39 V1 model."""

from __future__ import annotations

import datetime
import json
import math
import os
import random
import runpy
import sys
import time
from pathlib import Path

import cv2
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as functional
from torch.utils.data import DataLoader, Dataset


GEOMETRY = runpy.run_path(
    str(Path(__file__).with_name("benchmark-menpo39-profile-geometry.py")),
    run_name="headup_menpo39_local_refiner_helpers",
)
TRAIN = GEOMETRY["TRAIN"]
load_records = TRAIN["load_records"]
MenpoProfileDataset = TRAIN["MenpoProfileDataset"]
MobileNet39Heatmaps = TRAIN["MobileNet39Heatmaps"]
predict = TRAIN["predict"]
metric_distributions = TRAIN["metric_distributions"]
distribution = TRAIN["distribution"]
sha256 = TRAIN["sha256"]
face_box = TRAIN["face_box"]
PRIMARY_FACTOR = TRAIN["PRIMARY_FACTOR"]
PERTURBED_FACTOR = TRAIN["PERTURBED_FACTOR"]
evaluate_geometry = GEOMETRY["evaluate_geometry"]
metric_pass = GEOMETRY["metric_pass"]

SEED = 39041
LOCAL_SIZE = 128
LOCAL_HEATMAP = 32
MAX_EPOCHS = 10
GROUPS = {
    "nasalLabial": {"indices": [17, 19, 20, 21, 27], "minimumFaceDiagonalFactor": 0.30, "boxExpansion": 1.8},
    "mentolabial": {"indices": [33, 11, 10], "minimumFaceDiagonalFactor": 0.24, "boxExpansion": 2.0},
    "mandibularBorder": {"indices": [4, 5, 6, 7, 8], "minimumFaceDiagonalFactor": 0.48, "boxExpansion": 1.5},
}
FAILING_V1_METRICS = {
    "softTissueConvexityAngle",
    "nasolabialAngle",
    "mentolabialAngle",
    "softTissueChinProjection",
    "mandibularPlaneInclinationProxy",
}


def local_transform(global_points: np.ndarray, group: dict[str, object], *, shift_x: float, shift_y: float,
                    scale_factor: float, angle: float) -> tuple[np.ndarray, np.ndarray]:
    indices = group["indices"]
    selected = global_points[indices]
    minimum = np.min(selected, axis=0)
    maximum = np.max(selected, axis=0)
    span = maximum - minimum
    full_box = face_box(global_points)
    diagonal = math.hypot(float(full_box[2]), float(full_box[3]))
    side = max(
        float(np.max(span)) * float(group["boxExpansion"]),
        diagonal * float(group["minimumFaceDiagonalFactor"]),
        8.0,
    ) * scale_factor
    center = (minimum + maximum) / 2
    center[0] += shift_x * side
    center[1] += shift_y * side
    scale = (LOCAL_SIZE - 1) / side
    matrix = cv2.getRotationMatrix2D((float(center[0]), float(center[1])), angle, scale).astype(np.float64)
    matrix[0, 2] += (LOCAL_SIZE - 1) / 2 - center[0]
    matrix[1, 2] += (LOCAL_SIZE - 1) / 2 - center[1]
    return matrix, cv2.invertAffineTransform(matrix)


def transform_points(points: np.ndarray, matrix: np.ndarray) -> np.ndarray:
    homogeneous = np.concatenate([points, np.ones((len(points), 1), dtype=np.float64)], axis=1)
    return homogeneous @ matrix.T


class LocalRefinerDataset(Dataset):
    def __init__(self, records: list[object], global_predictions: np.ndarray, group_name: str, *, augment: bool):
        self.records = records
        self.global_predictions = global_predictions
        self.group_name = group_name
        self.group = GROUPS[group_name]
        self.augment = augment
        self.epoch = 0

    def set_epoch(self, epoch: int) -> None:
        self.epoch = epoch

    def __len__(self) -> int:
        return len(self.records)

    def __getitem__(self, index: int) -> dict[str, torch.Tensor]:
        record = self.records[index]
        image = cv2.imread(str(record.image_path), cv2.IMREAD_COLOR)
        if image is None:
            raise RuntimeError("unable to decode Menpo local-refiner image")
        if self.augment:
            group_offset = list(GROUPS).index(self.group_name) * 1_000_003
            rng = np.random.default_rng(SEED + group_offset + self.epoch * 100_003 + index * 997)
            shift_x, shift_y = [float(value) for value in rng.uniform(-0.10, 0.10, size=2)]
            scale_factor = float(rng.uniform(0.85, 1.20))
            angle = float(rng.uniform(-6.0, 6.0))
        else:
            rng = None
            shift_x = shift_y = angle = 0.0
            scale_factor = 1.0
        matrix, inverse = local_transform(
            self.global_predictions[index], self.group,
            shift_x=shift_x, shift_y=shift_y, scale_factor=scale_factor, angle=angle,
        )
        crop = cv2.warpAffine(
            image, matrix, (LOCAL_SIZE, LOCAL_SIZE), flags=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_REFLECT_101,
        )
        target_points = record.points[self.group["indices"]]
        transformed = transform_points(target_points, matrix)
        if rng is not None:
            if rng.random() < 0.5:
                crop = np.ascontiguousarray(crop[:, ::-1])
                transformed[:, 0] = LOCAL_SIZE - 1 - transformed[:, 0]
            crop = cv2.convertScaleAbs(
                crop, alpha=float(rng.uniform(0.85, 1.15)), beta=float(rng.uniform(-14.0, 14.0)),
            )
            if rng.random() < 0.2:
                crop = cv2.GaussianBlur(crop, (3, 3), float(rng.uniform(0.3, 1.0)))
        rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
        tensor = (torch.from_numpy(rgb.transpose(2, 0, 1)) - 0.5) / 0.5
        target = torch.from_numpy((transformed / (LOCAL_SIZE - 1)).astype(np.float32)).clamp(-0.10, 1.10)
        box = face_box(record.points)
        diagonal = max(1.0, math.hypot(float(box[2]), float(box[3])))
        return {
            "image": tensor,
            "target": target,
            "inverse": torch.from_numpy(inverse.astype(np.float32)),
            "groundTruth": torch.from_numpy(target_points.astype(np.float32)),
            "diagonal": torch.tensor(diagonal, dtype=torch.float32),
        }


class LocalHeatmapRefiner(nn.Module):
    def __init__(self, point_count: int):
        super().__init__()
        self.features = nn.Sequential(
            nn.Conv2d(3, 32, 3, 2, 1, bias=False), nn.BatchNorm2d(32), nn.Hardswish(),
            nn.Conv2d(32, 64, 3, 2, 1, bias=False), nn.BatchNorm2d(64), nn.Hardswish(),
            nn.Conv2d(64, 128, 3, 2, 1, bias=False), nn.BatchNorm2d(128), nn.Hardswish(),
            nn.Conv2d(128, 128, 3, 1, 1, groups=128, bias=False), nn.BatchNorm2d(128), nn.Hardswish(),
            nn.Conv2d(128, 128, 1, bias=False), nn.BatchNorm2d(128), nn.Hardswish(),
        )
        self.head = nn.Sequential(
            nn.ConvTranspose2d(128, 64, 4, 2, 1, bias=False), nn.BatchNorm2d(64), nn.Hardswish(),
            nn.Conv2d(64, point_count, 1),
        )

    def forward(self, image: torch.Tensor) -> torch.Tensor:
        return self.head(self.features(image))


def local_soft_argmax(heatmaps: torch.Tensor) -> torch.Tensor:
    batch, points, height, width = heatmaps.shape
    probability = functional.softmax(heatmaps.reshape(batch, points, -1) * 12.0, dim=-1)
    y_grid, x_grid = torch.meshgrid(
        torch.linspace(0, 1, height, device=heatmaps.device),
        torch.linspace(0, 1, width, device=heatmaps.device), indexing="ij",
    )
    x = torch.sum(probability * x_grid.reshape(1, 1, -1), dim=-1)
    y = torch.sum(probability * y_grid.reshape(1, 1, -1), dim=-1)
    return torch.stack([x, y], dim=-1)


def local_gaussian(target: torch.Tensor, sigma: float = 1.2) -> torch.Tensor:
    y_grid, x_grid = torch.meshgrid(
        torch.arange(LOCAL_HEATMAP, device=target.device, dtype=torch.float32),
        torch.arange(LOCAL_HEATMAP, device=target.device, dtype=torch.float32), indexing="ij",
    )
    x = target[..., 0, None, None] * (LOCAL_HEATMAP - 1)
    y = target[..., 1, None, None] * (LOCAL_HEATMAP - 1)
    return torch.exp(-((x_grid - x) ** 2 + (y_grid - y) ** 2) / (2 * sigma * sigma))


def local_loss(logits: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
    heatmap = torch.mean((torch.sigmoid(logits) - local_gaussian(target)) ** 2)
    coordinate = functional.smooth_l1_loss(local_soft_argmax(logits), target)
    return 100.0 * heatmap + 12.0 * coordinate


def original_coordinates(normalized: torch.Tensor, inverse: torch.Tensor) -> torch.Tensor:
    pixels = normalized * (LOCAL_SIZE - 1)
    homogeneous = torch.cat([pixels, torch.ones((*pixels.shape[:-1], 1), device=pixels.device)], dim=-1)
    return torch.einsum("bpi,bji->bpj", homogeneous, inverse)


def local_predict(model: nn.Module, dataset: Dataset, batch_size: int = 48) -> dict[str, np.ndarray]:
    loader = DataLoader(dataset, batch_size=batch_size, shuffle=False, num_workers=0)
    predictions, ground_truths, diagonals = [], [], []
    model.eval()
    with torch.inference_mode():
        for batch in loader:
            predicted = original_coordinates(local_soft_argmax(model(batch["image"])), batch["inverse"])
            predictions.append(predicted.numpy())
            ground_truths.append(batch["groundTruth"].numpy())
            diagonals.append(batch["diagonal"].numpy())
    return {
        "predictions": np.concatenate(predictions),
        "groundTruths": np.concatenate(ground_truths),
        "diagonals": np.concatenate(diagonals),
    }


def local_metrics(data: dict[str, np.ndarray]) -> dict[str, object]:
    normalized = np.linalg.norm(data["predictions"] - data["groundTruths"], axis=2) / data["diagonals"][:, None]
    image_rms = np.sqrt(np.mean(normalized ** 2, axis=1))
    return {
        "imageRmsNme": distribution(image_rms.tolist()),
        "pointNme": {str(index): distribution(normalized[:, index].tolist()) for index in range(normalized.shape[1])},
    }


def refine(models: dict[str, nn.Module], records: list[object], baseline: dict[str, np.ndarray]) -> tuple[dict[str, np.ndarray], dict[str, object]]:
    refined = {key: value.copy() for key, value in baseline.items()}
    group_metrics = {}
    for name, specification in GROUPS.items():
        dataset = LocalRefinerDataset(records, baseline["predictions"], name, augment=False)
        local = local_predict(models[name], dataset)
        refined["predictions"][:, specification["indices"]] = local["predictions"]
        group_metrics[name] = local_metrics(local)
    return refined, group_metrics


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
    if len(sys.argv) != 7:
        raise SystemExit("usage: local.py MENPO_DIR V1_MODEL CHECKPOINT_DIR V3_MODEL RESULT_JSON MODEL_TMP")
    menpo_dir, v1_path, checkpoint_dir, v3_path, result_path, model_tmp = map(Path, sys.argv[1:])
    random.seed(SEED)
    np.random.seed(SEED)
    torch.manual_seed(SEED)
    torch.set_num_threads(min(8, os.cpu_count() or 1))
    torch.set_num_interop_threads(1)
    checkpoint_dir.mkdir(parents=True, exist_ok=True)
    records, markup_counts = load_records(menpo_dir)
    engineering = [record for record in records if record.split == "engineering"]
    training_records = [record for record in engineering if record.fold != 4]
    validation_records = [record for record in engineering if record.fold == 4]
    development_records = [record for record in records if record.split == "holdout"]
    source_checkpoint = torch.load(v1_path, map_location="cpu", weights_only=False)
    global_model = MobileNet39Heatmaps(pretrained=False)
    global_model.load_state_dict(source_checkpoint["stateDict"])
    training_global = predict(global_model, MenpoProfileDataset(training_records, augment=False, factor=PRIMARY_FACTOR))
    validation_global = predict(global_model, MenpoProfileDataset(validation_records, augment=False, factor=PRIMARY_FACTOR))
    development_global = predict(global_model, MenpoProfileDataset(development_records, augment=False, factor=PRIMARY_FACTOR))
    development_perturbed_global = predict(global_model, MenpoProfileDataset(development_records, augment=False, factor=PERTURBED_FACTOR))
    baseline_geometry = evaluate_geometry(development_global, development_perturbed_global)
    del global_model

    models: dict[str, nn.Module] = {}
    curves = {}
    training_started = time.perf_counter()
    for group_index, (name, specification) in enumerate(GROUPS.items()):
        training_dataset = LocalRefinerDataset(training_records, training_global["predictions"], name, augment=True)
        validation_dataset = LocalRefinerDataset(validation_records, validation_global["predictions"], name, augment=False)
        model = LocalHeatmapRefiner(len(specification["indices"]))
        optimizer = torch.optim.AdamW(model.parameters(), lr=5e-4, weight_decay=1e-4)
        best_score = (float("inf"), float("inf"))
        best_epoch, patience = 0, 0
        curve = []
        checkpoint_path = checkpoint_dir / f"{name}.pth"
        for epoch in range(1, MAX_EPOCHS + 1):
            training_dataset.set_epoch(epoch)
            generator = torch.Generator().manual_seed(SEED + group_index * 1000 + epoch)
            loader = DataLoader(training_dataset, batch_size=32, shuffle=True, generator=generator, num_workers=0)
            model.train()
            losses = []
            epoch_started = time.perf_counter()
            for batch in loader:
                optimizer.zero_grad(set_to_none=True)
                loss = local_loss(model(batch["image"]), batch["target"])
                loss.backward()
                torch.nn.utils.clip_grad_norm_(model.parameters(), 5.0)
                optimizer.step()
                losses.append(float(loss.detach()))
            validation_local = local_predict(model, validation_dataset)
            validation_metrics = local_metrics(validation_local)
            score = (validation_metrics["imageRmsNme"]["median"], validation_metrics["imageRmsNme"]["p95"])
            row = {
                "epoch": epoch,
                "loss": round(float(np.mean(losses)), 6),
                "validationMedianRmsNme": score[0],
                "validationP95RmsNme": score[1],
                "seconds": round(time.perf_counter() - epoch_started, 3),
            }
            curve.append(row)
            print(
                f"{name} epoch {epoch}/{MAX_EPOCHS}: loss={row['loss']:.5f}, "
                f"median={score[0]:.4f}, p95={score[1]:.4f}", file=sys.stderr, flush=True,
            )
            if score < best_score:
                best_score, best_epoch, patience = score, epoch, 0
                torch.save(model.state_dict(), checkpoint_path)
            else:
                patience += 1
            if epoch >= 6 and patience >= 3:
                break
        model.load_state_dict(torch.load(checkpoint_path, map_location="cpu", weights_only=True))
        models[name] = model
        curves[name] = {"bestEpoch": best_epoch, "curve": curve}

    refined_validation, validation_local_metrics = refine(models, validation_records, validation_global)
    refined_development, development_local_metrics = refine(models, development_records, development_global)
    refined_perturbed, perturbed_local_metrics = refine(models, development_records, development_perturbed_global)
    validation_geometry = evaluate_geometry(refined_validation)
    candidate_geometry = evaluate_geometry(refined_development, refined_perturbed)
    candidate_coordinate = metric_distributions(refined_development)
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
    pareto = (
        improved_failing >= 4 and no_failing_regression and preserves_v1_passes
        and all(coordinate_checks.values())
        and seven_checks["developmentMedianNoMoreThan25PercentWorseThanValidation"]
    )
    promoted = seven_pass or pareto
    model_sha = None
    if promoted:
        payload = {
            "architecture": "Menpo39LocalRefiners-v3",
            "researchOnly": True,
            "parentSha256": sha256(v1_path),
            "inputSize": LOCAL_SIZE,
            "heatmapSize": LOCAL_HEATMAP,
            "groups": GROUPS,
            "stateDicts": {name: model.state_dict() for name, model in models.items()},
        }
        torch.save(payload, model_tmp)
        v3_path.parent.mkdir(parents=True, exist_ok=True)
        v3_path.write_bytes(model_tmp.read_bytes())
        model_sha = sha256(v3_path)
    result = {
        "testedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "policyVersion": "HEADUP-MENPO39-LOCAL-REFINERS-1.0",
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
        "architecture": {
            "parentModelSha256": sha256(v1_path),
            "localInput": [3, LOCAL_SIZE, LOCAL_SIZE],
            "localHeatmap": [LOCAL_HEATMAP, LOCAL_HEATMAP],
            "groups": GROUPS,
            "roiSource": "V1 predictions on original-resolution source image",
        },
        "training": {
            "seed": SEED,
            "optimizer": "AdamW 5e-4 per independent local branch",
            "selection": "lowest validation local-group RMS NME median; P95 tie-break",
            "groups": curves,
            "rawWallSeconds": round(time.perf_counter() - training_started, 3),
        },
        "baselineDevelopment": baseline_geometry,
        "candidateValidation": validation_geometry,
        "candidateDevelopment": candidate_geometry,
        "candidateCoordinateDevelopment": candidate_coordinate,
        "validationLocalPointMetrics": validation_local_metrics,
        "developmentLocalPointMetrics": development_local_metrics,
        "perturbedLocalPointMetrics": perturbed_local_metrics,
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
        "candidateSha256": model_sha,
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
        "improvements": improvements,
        "sevenGates": seven_checks,
        "paretoGates": result["paretoPromotionGates"],
        "promoted": promoted,
        "candidateSha256": model_sha,
        "candidateDevelopment": candidate_geometry["metrics"],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
