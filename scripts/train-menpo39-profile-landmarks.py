"""Train and audit a native 39-point profile landmark research model.

Images are read only from a transient Menpo extraction. The fixed engineering
partition is split again by an independent SHA-256 byte for training and
validation; the existing 450-image cohort remains a development test, not a
fresh confirmatory holdout. No image, path, coordinate, or per-image prediction
is written to the result.
"""

from __future__ import annotations

import datetime
import hashlib
import json
import math
import os
import random
import runpy
import sys
import time
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as functional
from torch.utils.data import DataLoader, Dataset
from torchvision.models import MobileNet_V3_Small_Weights, mobilenet_v3_small


BASE = runpy.run_path(
    str(Path(__file__).with_name("benchmark-spiga-menpo-profile-groundtruth.py")),
    run_name="headup_menpo39_training_helpers",
)
parse_pts = BASE["parse_pts"]
face_box = BASE["face_box"]
split_for = BASE["split_for"]
distribution = BASE["distribution"]
sha256 = BASE["sha256"]

SEED = 39017
IMAGE_SIZE = 224
HEATMAP_SIZE = 56
LANDMARK_COUNT = 39
PRIMARY_FACTOR = 1.45
PERTURBED_FACTOR = 1.25
CRITICAL = {
    "brow_center_proxy": 14,
    "nasal_root_proxy": 17,
    "nose_tip": 19,
    "columella": 20,
    "subnasale": 21,
    "upper_lip": 27,
    "lower_lip": 33,
    "mentolabial_fold": 11,
    "soft_tissue_pogonion": 10,
    "menton": 8,
}
# Historical anchor groups frozen before the source DOCX's section 4.2 table
# was re-read. They are retained for reproducibility, but they are not the
# document's eight P0 profile measurements: they omit mandibular inclination
# and cervicomental angle and incorrectly include two frontal height groups.
LEGACY_MEASUREMENT_ANCHORS = {
    "midface_height_ratio": [14, 21],
    "lower_face_height_ratio": [21, 10],
    "soft_tissue_convexity_angle": [17, 21, 10],
    "e_line": [19, 27, 33, 10],
    "nasolabial_angle": [20, 21, 27],
    "mentolabial_angle": [33, 11, 10],
    "soft_tissue_chin_projection": [17, 21, 10],
    "profile_vertical_proportion": [14, 21, 10, 8],
}


@dataclass(frozen=True)
class Record:
    image_path: Path
    points: np.ndarray
    orientation: str
    split: str
    fold: int


def load_records(menpo_dir: Path) -> tuple[list[Record], dict[int, int]]:
    profile_images: dict[tuple[str, str], Path] = {}
    for image_path in menpo_dir.rglob("*.jpg"):
        parts = {part.lower() for part in image_path.parts}
        orientation = "left" if "left" in parts else "right" if "right" in parts else None
        if "profile" in parts and orientation:
            profile_images[(orientation, image_path.stem)] = image_path
    records: list[Record] = []
    markup_counts: Counter[int] = Counter()
    for pts_path in sorted(menpo_dir.rglob("*.pts")):
        points = parse_pts(pts_path)
        markup_counts[len(points)] += 1
        if len(points) != LANDMARK_COUNT:
            continue
        parts = {part.lower() for part in pts_path.parts}
        orientation = "left" if "left" in parts else "right" if "right" in parts else None
        image_path = profile_images.get((orientation or "", pts_path.stem))
        if image_path is None or orientation is None:
            raise RuntimeError("profile annotation has no matching image")
        digest = hashlib.sha256(f"{orientation}/{image_path.stem}".encode("utf-8")).digest()
        records.append(Record(image_path, points, orientation, split_for(orientation, image_path.stem), digest[1] % 5))
    if len(records) != 2290 or markup_counts[68] != 6655:
        raise RuntimeError(f"unexpected Menpo2D counts; profiles={len(records)}, markups={dict(markup_counts)}")
    return records, dict(markup_counts)


def crop_transform(points: np.ndarray, factor: float, shift_x: float, shift_y: float, angle: float) -> tuple[np.ndarray, np.ndarray]:
    box = face_box(points)
    side = max(float(box[2]), float(box[3])) * factor
    center_x = float(box[0] + box[2] / 2 + shift_x * box[2])
    center_y = float(box[1] + box[3] / 2 + shift_y * box[3])
    scale = (IMAGE_SIZE - 1) / max(side, 1.0)
    matrix = cv2.getRotationMatrix2D((center_x, center_y), angle, scale).astype(np.float64)
    matrix[0, 2] += (IMAGE_SIZE - 1) / 2 - center_x
    matrix[1, 2] += (IMAGE_SIZE - 1) / 2 - center_y
    inverse = cv2.invertAffineTransform(matrix)
    return matrix, inverse


def transform_points(points: np.ndarray, matrix: np.ndarray) -> np.ndarray:
    homogeneous = np.concatenate([points, np.ones((len(points), 1), dtype=np.float64)], axis=1)
    return homogeneous @ matrix.T


class MenpoProfileDataset(Dataset):
    def __init__(self, records: list[Record], *, augment: bool, factor: float = PRIMARY_FACTOR):
        self.records = records
        self.augment = augment
        self.factor = factor
        self.epoch = 0

    def set_epoch(self, epoch: int) -> None:
        self.epoch = epoch

    def __len__(self) -> int:
        return len(self.records)

    def __getitem__(self, index: int) -> dict[str, torch.Tensor]:
        record = self.records[index]
        image = cv2.imread(str(record.image_path), cv2.IMREAD_COLOR)
        if image is None:
            raise RuntimeError("unable to decode Menpo image")
        if self.augment:
            rng = np.random.default_rng(SEED + self.epoch * 100_003 + index * 997)
            factor = float(rng.uniform(1.30, 1.60))
            shift_x, shift_y = [float(value) for value in rng.uniform(-0.04, 0.04, size=2)]
            angle = float(rng.uniform(-10.0, 10.0))
        else:
            rng = None
            factor, shift_x, shift_y, angle = self.factor, 0.0, 0.0, 0.0
        matrix, inverse = crop_transform(record.points, factor, shift_x, shift_y, angle)
        crop = cv2.warpAffine(
            image,
            matrix,
            (IMAGE_SIZE, IMAGE_SIZE),
            flags=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_REFLECT_101,
        )
        transformed = transform_points(record.points, matrix)
        encoded_orientation = 0 if record.orientation == "left" else 1
        if rng is not None:
            if rng.random() < 0.5:
                crop = np.ascontiguousarray(crop[:, ::-1])
                transformed[:, 0] = IMAGE_SIZE - 1 - transformed[:, 0]
                encoded_orientation = 1 - encoded_orientation
            alpha = float(rng.uniform(0.82, 1.18))
            beta = float(rng.uniform(-18.0, 18.0))
            crop = cv2.convertScaleAbs(crop, alpha=alpha, beta=beta)
            if rng.random() < 0.7:
                hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV).astype(np.float32)
                hsv[..., 1] *= float(rng.uniform(0.78, 1.22))
                hsv[..., 1] = np.clip(hsv[..., 1], 0, 255)
                crop = cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2BGR)
            if rng.random() < 0.18:
                crop = cv2.GaussianBlur(crop, (3, 3), float(rng.uniform(0.3, 1.2)))
            if rng.random() < 0.18:
                noise = rng.normal(0, float(rng.uniform(1.0, 5.0)), crop.shape)
                crop = np.clip(crop.astype(np.float32) + noise, 0, 255).astype(np.uint8)
        rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
        tensor = torch.from_numpy(rgb.transpose(2, 0, 1))
        mean = torch.tensor([0.485, 0.456, 0.406], dtype=torch.float32)[:, None, None]
        std = torch.tensor([0.229, 0.224, 0.225], dtype=torch.float32)[:, None, None]
        tensor = (tensor - mean) / std
        target = torch.from_numpy((transformed / (IMAGE_SIZE - 1)).astype(np.float32)).clamp(-0.05, 1.05)
        diagonal = max(1.0, math.hypot(float(face_box(record.points)[2]), float(face_box(record.points)[3])))
        return {
            "image": tensor,
            "target": target,
            "inverse": torch.from_numpy(inverse.astype(np.float32)),
            "ground_truth": torch.from_numpy(record.points.astype(np.float32)),
            "diagonal": torch.tensor(diagonal, dtype=torch.float32),
            "orientation": torch.tensor(encoded_orientation, dtype=torch.int64),
        }


class MobileNet39Heatmaps(nn.Module):
    def __init__(self, pretrained: bool):
        super().__init__()
        weights = MobileNet_V3_Small_Weights.IMAGENET1K_V1 if pretrained else None
        backbone = mobilenet_v3_small(weights=weights)
        self.features = backbone.features
        self.head = nn.Sequential(
            nn.Conv2d(576, 256, 1, bias=False),
            nn.BatchNorm2d(256),
            nn.Hardswish(),
            nn.ConvTranspose2d(256, 128, 4, 2, 1, bias=False),
            nn.BatchNorm2d(128),
            nn.Hardswish(),
            nn.ConvTranspose2d(128, 64, 4, 2, 1, bias=False),
            nn.BatchNorm2d(64),
            nn.Hardswish(),
            nn.ConvTranspose2d(64, LANDMARK_COUNT, 4, 2, 1),
        )

    def forward(self, image: torch.Tensor) -> torch.Tensor:
        return self.head(self.features(image))


def soft_argmax(heatmaps: torch.Tensor) -> torch.Tensor:
    batch, points, height, width = heatmaps.shape
    probability = functional.softmax(heatmaps.reshape(batch, points, -1) * 10.0, dim=-1)
    y_grid, x_grid = torch.meshgrid(
        torch.linspace(0, 1, height, device=heatmaps.device),
        torch.linspace(0, 1, width, device=heatmaps.device),
        indexing="ij",
    )
    x = torch.sum(probability * x_grid.reshape(1, 1, -1), dim=-1)
    y = torch.sum(probability * y_grid.reshape(1, 1, -1), dim=-1)
    return torch.stack([x, y], dim=-1)


def gaussian_heatmaps(target: torch.Tensor, sigma: float = 1.5) -> torch.Tensor:
    y_grid, x_grid = torch.meshgrid(
        torch.arange(HEATMAP_SIZE, device=target.device, dtype=torch.float32),
        torch.arange(HEATMAP_SIZE, device=target.device, dtype=torch.float32),
        indexing="ij",
    )
    center_x = target[..., 0, None, None] * (HEATMAP_SIZE - 1)
    center_y = target[..., 1, None, None] * (HEATMAP_SIZE - 1)
    return torch.exp(-((x_grid - center_x) ** 2 + (y_grid - center_y) ** 2) / (2 * sigma * sigma))


def loss_for(logits: torch.Tensor, target: torch.Tensor, point_weights: torch.Tensor) -> torch.Tensor:
    targets = gaussian_heatmaps(target)
    heatmap_error = (torch.sigmoid(logits) - targets) ** 2
    heatmap_loss = torch.mean(heatmap_error * point_weights[None, :, None, None])
    coordinates = soft_argmax(logits)
    coordinate_error = functional.smooth_l1_loss(coordinates, target, reduction="none").mean(dim=-1)
    coordinate_loss = torch.mean(coordinate_error * point_weights[None, :])
    return 100.0 * heatmap_loss + 8.0 * coordinate_loss


def original_coordinates(normalized: torch.Tensor, inverse: torch.Tensor) -> torch.Tensor:
    pixels = normalized * (IMAGE_SIZE - 1)
    ones = torch.ones((*pixels.shape[:-1], 1), device=pixels.device)
    homogeneous = torch.cat([pixels, ones], dim=-1)
    return torch.einsum("bpi,bji->bpj", homogeneous, inverse)


def predict(model: nn.Module, dataset: Dataset, batch_size: int = 24) -> dict[str, np.ndarray]:
    loader = DataLoader(dataset, batch_size=batch_size, shuffle=False, num_workers=0)
    predictions, ground_truths, diagonals, orientations = [], [], [], []
    model.eval()
    with torch.inference_mode():
        for batch in loader:
            logits = model(batch["image"])
            normalized = soft_argmax(logits)
            predictions.append(original_coordinates(normalized, batch["inverse"]).cpu().numpy())
            ground_truths.append(batch["ground_truth"].numpy())
            diagonals.append(batch["diagonal"].numpy())
            orientations.append(batch["orientation"].numpy())
    return {
        "predictions": np.concatenate(predictions),
        "ground_truths": np.concatenate(ground_truths),
        "diagonals": np.concatenate(diagonals),
        "orientations": np.concatenate(orientations),
    }


def metric_distributions(data: dict[str, np.ndarray]) -> dict[str, object]:
    normalized = np.linalg.norm(data["predictions"] - data["ground_truths"], axis=2) / data["diagonals"][:, None]
    image_rms = np.sqrt(np.mean(normalized ** 2, axis=1))
    critical = {label: distribution(normalized[:, index].tolist()) for label, index in CRITICAL.items()}
    measurement = {
        name: distribution(np.sqrt(np.mean(normalized[:, indices] ** 2, axis=1)).tolist())
        for name, indices in LEGACY_MEASUREMENT_ANCHORS.items()
    }
    return {
        "fullMarkupRmsNme": distribution(image_rms.tolist()),
        "criticalPointNme": critical,
        "measurementAnchorRmsNme": measurement,
        "allPointNme": {str(index): distribution(normalized[:, index].tolist()) for index in range(LANDMARK_COUNT)},
    }


def evaluate_training_split(model: nn.Module, dataset: Dataset) -> tuple[float, float]:
    metrics = metric_distributions(predict(model, dataset))
    full = metrics["fullMarkupRmsNme"]
    return float(full["median"]), float(full["p95"])


def main() -> None:
    if len(sys.argv) != 5:
        raise SystemExit("usage: train.py MENPO_DIR RESULT_JSON CHECKPOINT_TMP RESEARCH_MODEL")
    menpo_dir, result_path, checkpoint_path, research_model_path = map(Path, sys.argv[1:])
    random.seed(SEED)
    np.random.seed(SEED)
    torch.manual_seed(SEED)
    torch.set_num_threads(min(8, os.cpu_count() or 1))
    torch.set_num_interop_threads(1)

    records, markup_counts = load_records(menpo_dir)
    engineering = [record for record in records if record.split == "engineering"]
    development_test = [record for record in records if record.split == "holdout"]
    train_records = [record for record in engineering if record.fold != 4]
    validation_records = [record for record in engineering if record.fold == 4]
    if min(len(train_records), len(validation_records), len(development_test)) < 300:
        raise RuntimeError("unexpected split size")

    training = MenpoProfileDataset(train_records, augment=True)
    validation = MenpoProfileDataset(validation_records, augment=False)
    point_weights = torch.ones(LANDMARK_COUNT, dtype=torch.float32)
    for index in CRITICAL.values():
        point_weights[index] = 2.0

    model = MobileNet39Heatmaps(pretrained=True)
    for parameter in model.features.parameters():
        parameter.requires_grad = False
    optimizer = torch.optim.AdamW(model.head.parameters(), lr=1e-3, weight_decay=1e-4)
    training_curve: list[dict[str, object]] = []
    best_score = (float("inf"), float("inf"))
    best_epoch = 0
    patience = 0
    training_started = time.perf_counter()
    max_epochs = 16
    for epoch in range(1, max_epochs + 1):
        if epoch == 3:
            for parameter in model.features.parameters():
                parameter.requires_grad = True
            optimizer = torch.optim.AdamW([
                {"params": model.features.parameters(), "lr": 2e-4},
                {"params": model.head.parameters(), "lr": 8e-4},
            ], weight_decay=1e-4)
        training.set_epoch(epoch)
        generator = torch.Generator().manual_seed(SEED + epoch)
        loader = DataLoader(training, batch_size=16, shuffle=True, generator=generator, num_workers=0)
        model.train()
        losses = []
        epoch_started = time.perf_counter()
        for batch in loader:
            optimizer.zero_grad(set_to_none=True)
            logits = model(batch["image"])
            loss = loss_for(logits, batch["target"], point_weights)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 5.0)
            optimizer.step()
            losses.append(float(loss.detach()))
        validation_median, validation_p95 = evaluate_training_split(model, validation)
        epoch_seconds = time.perf_counter() - epoch_started
        training_curve.append({
            "epoch": epoch,
            "trainingLoss": round(float(np.mean(losses)), 6),
            "validationMedianRmsNme": validation_median,
            "validationP95RmsNme": validation_p95,
            "seconds": round(epoch_seconds, 3),
            "backboneFrozen": epoch < 3,
        })
        print(
            f"Epoch {epoch}/{max_epochs}: loss={np.mean(losses):.5f}, "
            f"val median={validation_median:.4f}, p95={validation_p95:.4f}, {epoch_seconds:.1f}s",
            file=sys.stderr,
            flush=True,
        )
        score = (validation_median, validation_p95)
        if score < best_score:
            best_score, best_epoch, patience = score, epoch, 0
            torch.save(model.state_dict(), checkpoint_path)
        else:
            patience += 1
        if epoch >= 8 and patience >= 4:
            break

    model.load_state_dict(torch.load(checkpoint_path, map_location="cpu", weights_only=True))
    validation_data = predict(model, validation)
    test_primary = predict(model, MenpoProfileDataset(development_test, augment=False, factor=PRIMARY_FACTOR))
    test_perturbed = predict(model, MenpoProfileDataset(development_test, augment=False, factor=PERTURBED_FACTOR))
    validation_metrics = metric_distributions(validation_data)
    test_metrics = metric_distributions(test_primary)

    by_orientation: dict[str, object] = {}
    for orientation, encoded in (("left", 0), ("right", 1)):
        mask = test_primary["orientations"] == encoded
        subset = {key: value[mask] for key, value in test_primary.items()}
        by_orientation[orientation] = {"images": int(mask.sum()), **metric_distributions(subset)}

    critical_indices = list(CRITICAL.values())
    displacement = np.median(
        np.linalg.norm(
            test_primary["predictions"][:, critical_indices] - test_perturbed["predictions"][:, critical_indices],
            axis=2,
        ),
        axis=1,
    ) / test_primary["diagonals"]
    direction: dict[str, dict[str, object]] = {}
    all_correct = []
    for orientation, encoded in (("left", 0), ("right", 1)):
        mask = test_primary["orientations"] == encoded
        predicted_sign = np.sign(
            test_primary["predictions"][mask, CRITICAL["nose_tip"], 0]
            - test_primary["predictions"][mask, CRITICAL["soft_tissue_pogonion"], 0]
        )
        target_sign = np.sign(
            test_primary["ground_truths"][mask, CRITICAL["nose_tip"], 0]
            - test_primary["ground_truths"][mask, CRITICAL["soft_tissue_pogonion"], 0]
        )
        correct = predicted_sign == target_sign
        all_correct.extend(correct.tolist())
        direction[orientation] = {
            "correct": int(correct.sum()),
            "total": int(len(correct)),
            "accuracy": round(float(np.mean(correct)), 4),
        }

    critical_metrics = test_metrics["criticalPointNme"]
    measurement_metrics = test_metrics["measurementAnchorRmsNme"]
    full_metrics = test_metrics["fullMarkupRmsNme"]
    crop_metrics = distribution(displacement.tolist())
    validation_full = validation_metrics["fullMarkupRmsNme"]
    gates = {
        "developmentTestHasAtLeast400Images": len(development_test) >= 400,
        "fullMarkupMedianRmsNmeAtMost3Percent": full_metrics["median"] <= 0.03,
        "fullMarkupP95RmsNmeAtMost8Percent": full_metrics["p95"] <= 0.08,
        "everyCriticalPointMedianNmeAtMost3Percent": all(value["median"] <= 0.03 for value in critical_metrics.values()),
        "everyCriticalPointP95NmeAtMost8Percent": all(value["p95"] <= 0.08 for value in critical_metrics.values()),
        "everyMeasurementAnchorMedianRmsNmeAtMost3Percent": all(value["median"] <= 0.03 for value in measurement_metrics.values()),
        "everyMeasurementAnchorP95RmsNmeAtMost8Percent": all(value["p95"] <= 0.08 for value in measurement_metrics.values()),
        "cropSensitivityP95AtMost5Percent": crop_metrics["p95"] <= 0.05,
        "eachOrientationDirectionAccuracyAtLeast95Percent": all(value["accuracy"] >= 0.95 for value in direction.values()),
        "developmentMedianNoMoreThan25PercentWorseThanValidation": full_metrics["median"] <= validation_full["median"] * 1.25,
    }
    offline_pass = all(gates.values())

    pretrained_path = Path(torch.hub.get_dir()) / "checkpoints" / "mobilenet_v3_small-047dcff4.pth"
    pretrained_sha = sha256(pretrained_path) if pretrained_path.exists() else None
    model_retained = False
    model_sha = None
    if offline_pass:
        research_model_path.parent.mkdir(parents=True, exist_ok=True)
        torch.save({
            "architecture": "MobileNet39Heatmaps-v1",
            "landmarkCount": LANDMARK_COUNT,
            "imageSize": IMAGE_SIZE,
            "primaryCropFactor": PRIMARY_FACTOR,
            "stateDict": model.state_dict(),
            "researchOnly": True,
            "trainingData": "Menpo2D non-commercial research engineering partition",
        }, research_model_path)
        model_sha = sha256(research_model_path)
        model_retained = True

    result = {
        "testedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "policyVersion": "HEADUP-MENPO39-NATIVE-PROFILE-TRAINING-1.0",
        "source": {
            "name": "Menpo2D fixed official archive, 39-point profile training data",
            "archiveSha256": os.environ.get("HEADUP_MENPO_ARCHIVE_SHA256"),
            "profileImages": len(records),
            "markupCounts": markup_counts,
            "license": "non-commercial research only",
        },
        "partition": {
            "method": "Existing SHA-256 byte 0 engineering/development split; byte 1 modulo 5 selects validation fold 4",
            "training": len(train_records),
            "validation": len(validation_records),
            "developmentTest": len(development_test),
            "trainingByOrientation": dict(Counter(record.orientation for record in train_records)),
            "validationByOrientation": dict(Counter(record.orientation for record in validation_records)),
            "developmentByOrientation": dict(Counter(record.orientation for record in development_test)),
            "identityIsolation": "Unavailable in source metadata; filename/path isolation only",
            "developmentReuseWarning": "The 450-image cohort has been summarized in prior candidate audits and is not a fresh confirmatory holdout",
        },
        "model": {
            "architecture": "ImageNet-pretrained MobileNetV3-Small plus 7-to-56 heatmap decoder",
            "input": [3, IMAGE_SIZE, IMAGE_SIZE],
            "output": [LANDMARK_COUNT, HEATMAP_SIZE, HEATMAP_SIZE],
            "coordinateDecoder": "soft-argmax",
            "pretrainedWeights": "torchvision MobileNet_V3_Small_Weights.IMAGENET1K_V1",
            "pretrainedSha256": pretrained_sha,
            "criticalPointWeight": 2.0,
            "otherPointWeight": 1.0,
            "bestEpoch": best_epoch,
            "epochsRun": len(training_curve),
            "researchModelRetained": model_retained,
            "researchModelSha256": model_sha,
            "productionPackaged": False,
        },
        "training": {
            "seed": SEED,
            "optimizer": "AdamW; head-only epochs 1-2, full fine-tune from epoch 3",
            "augmentation": "scale 1.30-1.60, center +/-4%, rotation +/-10deg, mirror, brightness/contrast, saturation, blur, Gaussian noise",
            "selection": "lowest validation median full-39 RMS NME; P95 tie-break",
            "curve": training_curve,
            "rawWallSeconds": round(time.perf_counter() - training_started, 3),
        },
        "contract": {
            "landmarkCount": LANDMARK_COUNT,
            "criticalZeroBasedIndices": CRITICAL,
            "legacyMeasurementAnchorGroups": LEGACY_MEASUREMENT_ANCHORS,
            "legacyScopeWarning": "These eight anchor groups are not the source DOCX's eight P0 profile measurements",
            "sourceProfileMeasurements": [
                "softTissueConvexityAngle", "eLine", "nasolabialAngle", "mentolabialAngle",
                "softTissueChinProjection", "mandibularPlaneInclinationProxy",
                "cervicomentalAngle", "profileVerticalProportion",
            ],
            "native39MissingRequirement": "cervicomentalAngle requires an external neck tangent",
            "primaryCropFactor": PRIMARY_FACTOR,
            "perturbedCropFactor": PERTURBED_FACTOR,
        },
        "validation": validation_metrics,
        "developmentTest": test_metrics,
        "developmentTestByOrientation": by_orientation,
        "cropSensitivity": crop_metrics,
        "profileDirection": {
            "definition": "sign of native nose-tip 19 minus soft-tissue-pogonion 10 x-coordinate",
            "accuracy": round(float(np.mean(all_correct)), 4),
            "byOrientation": direction,
        },
        "predeclaredOfflineGates": gates,
        "passesOfflineDevelopmentGates": offline_pass,
        "offlineGateScope": "39-point coordinate localization and legacy anchor groups only; not the eight source profile measurements",
        "passesFullEightMetricContract": False,
        "releaseGates": {
            "allEightSourceProfileMetrics": False,
            "freshConfirmatoryHoldout": False,
            "identityIsolatedProductCameraRetakes": False,
            "commercialTrainingDataRights": False,
        },
        "releaseEligible": False,
        "interpretation": "Offline landmark-candidate evidence only. Geometry must be audited against the eight source measurements; Menpo39 cannot provide the neck tangent required for cervicomental angle.",
        "retention": {
            "imagesRetained": False,
            "annotationsRetained": False,
            "archiveRetained": False,
            "individualPredictionsRetained": False,
            "identifiersRetained": False,
            "aggregateOnlyResult": True,
            "researchModelRetainedOnlyIfOfflineGatesPass": True,
        },
    }
    result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "resultPath": str(result_path),
        "split": result["partition"],
        "bestEpoch": best_epoch,
        "validation": validation_full,
        "development": full_metrics,
        "critical": critical_metrics,
        "measurements": measurement_metrics,
        "cropSensitivity": crop_metrics,
        "direction": result["profileDirection"],
        "gates": gates,
        "offlinePass": offline_pass,
        "modelRetained": model_retained,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
