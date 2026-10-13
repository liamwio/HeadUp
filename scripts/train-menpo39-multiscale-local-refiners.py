"""Train V1-initialized multi-scale local refiners with validation-only blending."""

from __future__ import annotations

import datetime
import itertools
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
import torch.nn.functional as functional
from torch.utils.data import DataLoader, Dataset


V4 = runpy.run_path(
    str(Path(__file__).with_name("train-menpo39-pretrained-local-refiners.py")),
    run_name="headup_menpo39_multiscale_helpers",
)
LOCAL = V4["LOCAL"]
TRAIN = V4["TRAIN"]
GEOMETRY = V4["GEOMETRY"]
V1InitializedLocalRefiner = V4["V1InitializedLocalRefiner"]
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
transform_points = LOCAL["transform_points"]
coordinate_gates = LOCAL["coordinate_gates"]
FAILING_V1_METRICS = LOCAL["FAILING_V1_METRICS"]

SEED = 39067
MAX_EPOCHS = 8
ARCHITECTURE = "Menpo39MultiscaleLocalRefiners-v5"
POLICY_VERSION = "HEADUP-MENPO39-MULTISCALE-LOCAL-REFINERS-1.0"
NORMALIZATION_DESCRIPTION = "legacy local RGB (x-0.5)/0.5; retained for V5 reproducibility"
LOSS_DESCRIPTION = "heatmap MSE plus smooth-L1 point coordinates"
ALPHAS = (0.0, 0.25, 0.5, 0.75, 1.0)
BLEND_CONTROLS = None
CONFIG = {
    "nasalLabial": {
        "indices": [17, 19, 20, 21, 27], "inputSize": 128,
        "minimumFaceDiagonalFactor": 0.30, "boxExpansion": 1.8,
    },
    "mentolabial": {
        "indices": [33, 11, 10], "inputSize": 128,
        "minimumFaceDiagonalFactor": 0.24, "boxExpansion": 2.0,
    },
    "mandibularBorder": {
        "indices": [4, 5, 6, 7, 8], "inputSize": 256,
        "minimumFaceDiagonalFactor": 0.90, "boxExpansion": 2.0,
    },
}
PRESERVED_METRICS = ("eLine", "profileVerticalProportion")


def roi_transform(global_points: np.ndarray, config: dict[str, object], *, shift_x: float,
                  shift_y: float, scale_factor: float, angle: float) -> tuple[np.ndarray, np.ndarray]:
    selected = global_points[config["indices"]]
    minimum = np.min(selected, axis=0)
    maximum = np.max(selected, axis=0)
    span = maximum - minimum
    full_box = face_box(global_points)
    diagonal = math.hypot(float(full_box[2]), float(full_box[3]))
    side = max(
        float(np.max(span)) * float(config["boxExpansion"]),
        diagonal * float(config["minimumFaceDiagonalFactor"]),
        8.0,
    ) * scale_factor
    center = (minimum + maximum) / 2
    center[0] += shift_x * side
    center[1] += shift_y * side
    size = int(config["inputSize"])
    scale = (size - 1) / side
    matrix = cv2.getRotationMatrix2D((float(center[0]), float(center[1])), angle, scale).astype(np.float64)
    matrix[0, 2] += (size - 1) / 2 - center[0]
    matrix[1, 2] += (size - 1) / 2 - center[1]
    return matrix, cv2.invertAffineTransform(matrix)


class MultiScaleDataset(Dataset):
    def __init__(self, records: list[object], global_predictions: np.ndarray, group_name: str, *, augment: bool):
        self.records = records
        self.global_predictions = global_predictions
        self.group_name = group_name
        self.config = CONFIG[group_name]
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
            raise RuntimeError("unable to decode Menpo multi-scale image")
        if self.augment:
            group_offset = list(CONFIG).index(self.group_name) * 1_000_003
            rng = np.random.default_rng(SEED + group_offset + self.epoch * 100_003 + index * 997)
            default_shift_limit = 0.06 if self.group_name == "mandibularBorder" else 0.10
            shift_limit = float(self.config.get("augmentShiftLimit", default_shift_limit))
            shift_x, shift_y = [float(value) for value in rng.uniform(-shift_limit, shift_limit, size=2)]
            default_scale = (0.90, 1.12) if self.group_name == "mandibularBorder" else (0.85, 1.20)
            scale_range = self.config.get("augmentScaleRange", default_scale)
            scale_factor = float(rng.uniform(float(scale_range[0]), float(scale_range[1])))
            angle_limit = float(self.config.get("augmentAngleLimit", 6.0))
            angle = float(rng.uniform(-angle_limit, angle_limit))
        else:
            rng = None
            shift_x = shift_y = angle = 0.0
            scale_factor = 1.0
        matrix, inverse = roi_transform(
            self.global_predictions[index], self.config,
            shift_x=shift_x, shift_y=shift_y, scale_factor=scale_factor, angle=angle,
        )
        size = int(self.config["inputSize"])
        crop = cv2.warpAffine(
            image, matrix, (size, size), flags=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_REFLECT_101,
        )
        target_points = record.points[self.config["indices"]]
        transformed = transform_points(target_points, matrix)
        if rng is not None:
            if rng.random() < 0.5:
                crop = np.ascontiguousarray(crop[:, ::-1])
                transformed[:, 0] = size - 1 - transformed[:, 0]
            crop = cv2.convertScaleAbs(
                crop, alpha=float(rng.uniform(0.85, 1.15)), beta=float(rng.uniform(-14.0, 14.0)),
            )
            if rng.random() < 0.2:
                crop = cv2.GaussianBlur(crop, (3, 3), float(rng.uniform(0.3, 1.0)))
        rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
        tensor = (torch.from_numpy(rgb.transpose(2, 0, 1)) - 0.5) / 0.5
        target = torch.from_numpy((transformed / (size - 1)).astype(np.float32)).clamp(-0.10, 1.10)
        box = face_box(record.points)
        diagonal = max(1.0, math.hypot(float(box[2]), float(box[3])))
        return {
            "image": tensor,
            "target": target,
            "inverse": torch.from_numpy(inverse.astype(np.float32)),
            "groundTruth": torch.from_numpy(target_points.astype(np.float32)),
            "diagonal": torch.tensor(diagonal, dtype=torch.float32),
        }


def soft_argmax(heatmaps: torch.Tensor) -> torch.Tensor:
    batch, points, height, width = heatmaps.shape
    probability = functional.softmax(heatmaps.reshape(batch, points, -1) * 12.0, dim=-1)
    y_grid, x_grid = torch.meshgrid(
        torch.linspace(0, 1, height, device=heatmaps.device),
        torch.linspace(0, 1, width, device=heatmaps.device), indexing="ij",
    )
    x = torch.sum(probability * x_grid.reshape(1, 1, -1), dim=-1)
    y = torch.sum(probability * y_grid.reshape(1, 1, -1), dim=-1)
    return torch.stack([x, y], dim=-1)


def gaussian_heatmaps(target: torch.Tensor, size: int, sigma: float) -> torch.Tensor:
    y_grid, x_grid = torch.meshgrid(
        torch.arange(size, device=target.device, dtype=torch.float32),
        torch.arange(size, device=target.device, dtype=torch.float32), indexing="ij",
    )
    x = target[..., 0, None, None] * (size - 1)
    y = target[..., 1, None, None] * (size - 1)
    return torch.exp(-((x_grid - x) ** 2 + (y_grid - y) ** 2) / (2 * sigma * sigma))


def local_loss(logits: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
    heatmap_size = int(logits.shape[-1])
    sigma = 1.2 * heatmap_size / 32
    heatmap = torch.mean((torch.sigmoid(logits) - gaussian_heatmaps(target, heatmap_size, sigma)) ** 2)
    coordinate = functional.smooth_l1_loss(soft_argmax(logits), target)
    return 100.0 * heatmap + 12.0 * coordinate


def original_coordinates(normalized: torch.Tensor, inverse: torch.Tensor, input_size: int) -> torch.Tensor:
    pixels = normalized * (input_size - 1)
    homogeneous = torch.cat([pixels, torch.ones((*pixels.shape[:-1], 1), device=pixels.device)], dim=-1)
    return torch.einsum("bpi,bji->bpj", homogeneous, inverse)


def local_predict(model: torch.nn.Module, dataset: MultiScaleDataset, batch_size: int) -> dict[str, np.ndarray]:
    loader = DataLoader(dataset, batch_size=batch_size, shuffle=False, num_workers=0)
    predictions, ground_truths, diagonals = [], [], []
    model.eval()
    with torch.inference_mode():
        for batch in loader:
            normalized = soft_argmax(model(batch["image"]))
            predicted = original_coordinates(normalized, batch["inverse"], int(dataset.config["inputSize"]))
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


def active_blend_controls() -> dict[str, dict[str, object]]:
    if BLEND_CONTROLS is not None:
        return BLEND_CONTROLS
    return {
        name: {
            "sourceGroup": name,
            "writeIndices": list(config.get("writeIndices", config["indices"])),
        }
        for name, config in CONFIG.items()
    }


def blend(base: dict[str, np.ndarray], locals_by_group: dict[str, dict[str, np.ndarray]],
          alphas: dict[str, float]) -> dict[str, np.ndarray]:
    output = {key: value.copy() for key, value in base.items()}
    for control_name, control in active_blend_controls().items():
        alpha = alphas[control_name]
        if alpha <= 0:
            continue
        source_group = str(control["sourceGroup"])
        if source_group not in CONFIG or source_group not in locals_by_group:
            raise RuntimeError(f"invalid {control_name} source group")
        training_indices = list(CONFIG[source_group]["indices"])
        write_indices = list(control.get("writeIndices", CONFIG[source_group].get("writeIndices", training_indices)))
        if not write_indices or len(set(write_indices)) != len(write_indices):
            raise RuntimeError(f"invalid {control_name} write indices")
        if any(index not in training_indices for index in write_indices):
            raise RuntimeError(f"{control_name} write index was not trained")
        local_positions = [training_indices.index(index) for index in write_indices]
        output["predictions"][:, write_indices] = (
            (1.0 - alpha) * output["predictions"][:, write_indices]
            + alpha * locals_by_group[source_group]["predictions"][:, local_positions]
        )
    return output


def normalized_metric_score(metric: dict[str, object]) -> float:
    angular = metric["unit"] == "degrees"
    median_limit, p95_limit, crop_limit = (3.0, 8.0, 5.0) if angular else (0.03, 0.08, 0.05)
    error = metric["absoluteError"]
    orientations = metric["byOrientationAbsoluteError"].values()
    orientation_score = np.mean([
        values["median"] / median_limit + 0.5 * values["p95"] / p95_limit
        for values in orientations
    ])
    return float(
        error["median"] / median_limit
        + 0.5 * error["p95"] / p95_limit
        + 0.5 * metric["cropSensitivity"]["p95"] / crop_limit
        + 0.25 * orientation_score
    )


def selection_score(geometry: dict[str, object]) -> float:
    return float(sum(normalized_metric_score(geometry["metrics"][name]) for name in FAILING_V1_METRICS))


def validation_safe(geometry: dict[str, object], coordinates: dict[str, object],
                    baseline_coordinates: dict[str, object]) -> bool:
    preserves = all(metric_pass(geometry["metrics"][name], True) for name in PRESERVED_METRICS)
    full = coordinates["fullMarkupRmsNme"]
    baseline = baseline_coordinates["fullMarkupRmsNme"]
    coordinate_safe = full["median"] <= baseline["median"] * 1.05 and full["p95"] <= baseline["p95"] * 1.10
    return preserves and coordinate_safe


def select_alphas(validation_primary: dict[str, np.ndarray], validation_perturbed: dict[str, np.ndarray],
                  validation_locals: dict[str, dict[str, np.ndarray]],
                  validation_perturbed_locals: dict[str, dict[str, np.ndarray]]) -> dict[str, object]:
    baseline_geometry = evaluate_geometry(validation_primary, validation_perturbed)
    baseline_coordinates = metric_distributions(validation_primary)
    baseline_score = selection_score(baseline_geometry)
    best = None
    eligible_count = 0
    controls = active_blend_controls()
    for values in itertools.product(ALPHAS, repeat=len(controls)):
        alphas = dict(zip(controls, values))
        primary = blend(validation_primary, validation_locals, alphas)
        perturbed = blend(validation_perturbed, validation_perturbed_locals, alphas)
        geometry = evaluate_geometry(primary, perturbed)
        coordinates = metric_distributions(primary)
        safe = validation_safe(geometry, coordinates, baseline_coordinates)
        if safe:
            eligible_count += 1
            score = selection_score(geometry)
            key = (score, sum(values), values)
            if best is None or key < best["key"]:
                best = {"key": key, "alphas": alphas, "geometry": geometry, "coordinates": coordinates}
    minimum_improvement = 0.02
    if best is None or (baseline_score - best["key"][0]) / max(baseline_score, 1e-8) < minimum_improvement:
        selected = {name: 0.0 for name in controls}
        selected_geometry = baseline_geometry
        selected_coordinates = baseline_coordinates
        selected_score = baseline_score
        fallback = True
    else:
        selected = best["alphas"]
        selected_geometry = best["geometry"]
        selected_coordinates = best["coordinates"]
        selected_score = best["key"][0]
        fallback = False
    return {
        "alphas": selected,
        "baselineScore": round(baseline_score, 6),
        "selectedScore": round(selected_score, 6),
        "relativeImprovement": round((baseline_score - selected_score) / max(baseline_score, 1e-8), 4),
        "eligibleCombinationCount": eligible_count,
        "combinationCount": len(ALPHAS) ** len(controls),
        "fellBackToV1": fallback,
        "geometry": selected_geometry,
        "coordinates": selected_coordinates,
    }


def main() -> None:
    if len(sys.argv) != 7:
        raise SystemExit("usage: multiscale.py MENPO_DIR V1_MODEL CHECKPOINT_DIR V5_MODEL RESULT_JSON MODEL_TMP")
    menpo_dir, v1_path, checkpoint_dir, v5_path, result_path, model_tmp = map(Path, sys.argv[1:])
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
    global_data = {
        "training": predict(global_model, MenpoProfileDataset(training_records, augment=False, factor=PRIMARY_FACTOR)),
        "validation": predict(global_model, MenpoProfileDataset(validation_records, augment=False, factor=PRIMARY_FACTOR)),
        "validationPerturbed": predict(global_model, MenpoProfileDataset(validation_records, augment=False, factor=PERTURBED_FACTOR)),
        "development": predict(global_model, MenpoProfileDataset(development_records, augment=False, factor=PRIMARY_FACTOR)),
        "developmentPerturbed": predict(global_model, MenpoProfileDataset(development_records, augment=False, factor=PERTURBED_FACTOR)),
    }
    baseline_development = evaluate_geometry(global_data["development"], global_data["developmentPerturbed"])
    del global_model

    models: dict[str, torch.nn.Module] = {}
    curves = {}
    started = time.perf_counter()
    for group_index, (name, config) in enumerate(CONFIG.items()):
        training_dataset = MultiScaleDataset(training_records, global_data["training"]["predictions"], name, augment=True)
        validation_dataset = MultiScaleDataset(validation_records, global_data["validation"]["predictions"], name, augment=False)
        model = V1InitializedLocalRefiner(source_checkpoint["stateDict"], config["indices"])
        expected_heatmap = int(config["inputSize"]) // 4
        with torch.inference_mode():
            actual_heatmap = int(model(torch.zeros(1, 3, int(config["inputSize"]), int(config["inputSize"]))).shape[-1])
        if actual_heatmap != expected_heatmap:
            raise RuntimeError(f"unexpected {name} heatmap size {actual_heatmap}")
        for parameter in model.features.parameters():
            parameter.requires_grad = False
        optimizer = torch.optim.AdamW(model.head.parameters(), lr=1e-4, weight_decay=1e-4)
        best_score = (float("inf"), float("inf"))
        best_epoch, patience = 0, 0
        curve = []
        checkpoint_path = checkpoint_dir / f"{name}.pth"
        batch_size = 12 if int(config["inputSize"]) == 256 else 24
        for epoch in range(1, MAX_EPOCHS + 1):
            if epoch == 2:
                for parameter in model.features.parameters():
                    parameter.requires_grad = True
                optimizer = torch.optim.AdamW([
                    {"params": model.features.parameters(), "lr": 2e-5},
                    {"params": model.head.parameters(), "lr": 1e-4},
                ], weight_decay=1e-4)
            training_dataset.set_epoch(epoch)
            generator = torch.Generator().manual_seed(SEED + group_index * 1000 + epoch)
            loader = DataLoader(training_dataset, batch_size=batch_size, shuffle=True, generator=generator, num_workers=0)
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
            validation_local = local_predict(model, validation_dataset, batch_size)
            validation_metrics = local_metrics(validation_local)
            score = (validation_metrics["imageRmsNme"]["median"], validation_metrics["imageRmsNme"]["p95"])
            row = {
                "epoch": epoch, "loss": round(float(np.mean(losses)), 6),
                "validationMedianRmsNme": score[0], "validationP95RmsNme": score[1],
                "backboneFrozen": epoch == 1, "seconds": round(time.perf_counter() - epoch_started, 3),
            }
            curve.append(row)
            print(
                f"{name} multiscale epoch {epoch}/{MAX_EPOCHS}: loss={row['loss']:.5f}, "
                f"median={score[0]:.4f}, p95={score[1]:.4f}", file=sys.stderr, flush=True,
            )
            if score < best_score:
                best_score, best_epoch, patience = score, epoch, 0
                torch.save(model.state_dict(), checkpoint_path)
            else:
                patience += 1
            if epoch >= 5 and patience >= 2:
                break
        model.load_state_dict(torch.load(checkpoint_path, map_location="cpu", weights_only=True))
        models[name] = model
        curves[name] = {"bestEpoch": best_epoch, "curve": curve}

    local_outputs: dict[str, dict[str, dict[str, np.ndarray]]] = {}
    local_metric_outputs: dict[str, dict[str, object]] = {}
    record_sets = {
        "validation": validation_records,
        "validationPerturbed": validation_records,
        "development": development_records,
        "developmentPerturbed": development_records,
    }
    for split, split_records in record_sets.items():
        local_outputs[split] = {}
        local_metric_outputs[split] = {}
        for name, config in CONFIG.items():
            dataset = MultiScaleDataset(split_records, global_data[split]["predictions"], name, augment=False)
            output = local_predict(models[name], dataset, 12 if int(config["inputSize"]) == 256 else 24)
            local_outputs[split][name] = output
            local_metric_outputs[split][name] = local_metrics(output)

    selection = select_alphas(
        global_data["validation"], global_data["validationPerturbed"],
        local_outputs["validation"], local_outputs["validationPerturbed"],
    )
    selected_alphas = selection["alphas"]
    candidate_development_data = blend(global_data["development"], local_outputs["development"], selected_alphas)
    candidate_perturbed_data = blend(
        global_data["developmentPerturbed"], local_outputs["developmentPerturbed"], selected_alphas,
    )
    candidate_development = evaluate_geometry(candidate_development_data, candidate_perturbed_data)
    candidate_coordinates = metric_distributions(candidate_development_data)
    coordinate_checks = coordinate_gates(candidate_coordinates)
    seven_checks = {
        "allSevenMetricsMeetDevelopmentErrorAndCropThresholds": all(
            metric_pass(metric, True) for metric in candidate_development["metrics"].values()
        ),
        "developmentMedianNoMoreThan25PercentWorseThanValidation": all(
            candidate_development["metrics"][name]["absoluteError"]["median"]
            <= max(selection["geometry"]["metrics"][name]["absoluteError"]["median"] * 1.25, 1e-6)
            for name in candidate_development["metrics"]
        ),
        **coordinate_checks,
    }
    seven_pass = all(seven_checks.values())
    improvements = {}
    for name in candidate_development["metrics"]:
        baseline = baseline_development["metrics"][name]["absoluteError"]["median"]
        candidate = candidate_development["metrics"][name]["absoluteError"]["median"]
        improvements[name] = round((baseline - candidate) / max(baseline, 1e-8), 4)
    improved_failing = sum(improvements[name] >= 0.10 for name in FAILING_V1_METRICS)
    no_failing_regression = all(improvements[name] >= -0.10 for name in FAILING_V1_METRICS)
    preserves_v1_passes = all(metric_pass(candidate_development["metrics"][name], True) for name in PRESERVED_METRICS)
    pareto = (
        improved_failing >= 4 and no_failing_regression and preserves_v1_passes
        and all(coordinate_checks.values())
        and seven_checks["developmentMedianNoMoreThan25PercentWorseThanValidation"]
    )
    promoted = seven_pass or pareto
    retained_for_research = promoted or os.environ.get("HEADUP_RETAIN_RESEARCH_CANDIDATE") == "1"
    model_sha = None
    if retained_for_research:
        payload = {
            "architecture": ARCHITECTURE, "researchOnly": True,
            "parentSha256": sha256(v1_path), "config": CONFIG,
            "blendControls": active_blend_controls(), "alphas": selected_alphas,
            "loss": LOSS_DESCRIPTION,
            "stateDicts": {name: model.state_dict() for name, model in models.items()},
        }
        torch.save(payload, model_tmp)
        v5_path.parent.mkdir(parents=True, exist_ok=True)
        v5_path.write_bytes(model_tmp.read_bytes())
        model_sha = sha256(v5_path)
    result = {
        "testedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "policyVersion": POLICY_VERSION,
        "source": {
            "archiveSha256": os.environ.get("HEADUP_MENPO_ARCHIVE_SHA256"),
            "profileImages": len(records), "markupCounts": markup_counts,
            "license": "non-commercial research only",
        },
        "partition": {
            "training": len(training_records), "validation": len(validation_records),
            "development": len(development_records),
            "developmentReuseWarning": "Reused development evidence; not a fresh confirmatory holdout",
            "identityIsolation": "unavailable in source metadata",
        },
        "architecture": {
            "parentModelSha256": sha256(v1_path), "config": CONFIG,
            "blendControls": active_blend_controls(),
            "initialization": "complete V1 features, decoder and selected output channels at dynamic input scale",
            "normalization": NORMALIZATION_DESCRIPTION,
            "roiSource": "V1 predictions on original-resolution source image",
        },
        "training": {
            "seed": SEED, "maximumEpochs": MAX_EPOCHS,
            "optimizer": "epoch 1 frozen features/head 1e-4; epoch 2+ features 2e-5 and head 1e-4",
            "loss": LOSS_DESCRIPTION,
            "selection": "lowest validation local-group RMS NME median; P95 tie-break",
            "groups": curves, "rawWallSeconds": round(time.perf_counter() - started, 3),
        },
        "blendSelection": {
            "partition": "validation only", "alphasTestedPerControl": ALPHAS,
            "minimumRelativeObjectiveImprovement": 0.02,
            "safety": "preserve E-Line and vertical metric gates; full-coordinate median <=105% and P95 <=110% of V1",
            "selectedAlphas": selected_alphas, "baselineScore": selection["baselineScore"],
            "selectedScore": selection["selectedScore"], "relativeImprovement": selection["relativeImprovement"],
            "eligibleCombinationCount": selection["eligibleCombinationCount"],
            "combinationCount": selection["combinationCount"], "fellBackToV1": selection["fellBackToV1"],
        },
        "baselineDevelopment": baseline_development,
        "candidateValidation": selection["geometry"],
        "candidateValidationCoordinates": selection["coordinates"],
        "candidateDevelopment": candidate_development,
        "candidateCoordinateDevelopment": candidate_coordinates,
        "validationLocalPointMetrics": local_metric_outputs["validation"],
        "developmentLocalPointMetrics": local_metric_outputs["development"],
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
        "candidatePromoted": promoted, "candidateRetainedForResearch": retained_for_research, "candidateSha256": model_sha,
        "passesFullEightMetricContract": False, "releaseEligible": False,
        "retention": {
            "imagesRetained": False, "annotationsRetained": False,
            "individualPredictionsRetained": False, "identifiersRetained": False,
            "candidateRetainedOnlyIfPromotionGatesPass": not retained_for_research,
        },
    }
    result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "resultPath": str(result_path), "selectedAlphas": selected_alphas,
        "validationRelativeImprovement": selection["relativeImprovement"],
        "improvements": improvements, "sevenGates": seven_checks,
        "paretoGates": result["paretoPromotionGates"], "promoted": promoted,
        "candidateSha256": model_sha,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
