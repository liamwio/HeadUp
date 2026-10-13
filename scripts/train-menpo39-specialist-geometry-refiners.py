"""Train separate direction and projection specialists with tail-aware geometry losses."""

from __future__ import annotations

import math
import runpy
from pathlib import Path

import torch
import torch.nn.functional as functional


BASE = runpy.run_path(
    str(Path(__file__).with_name("train-menpo39-multiscale-local-refiners.py")),
    run_name="headup_menpo39_specialist_geometry_base",
)
BaseDataset = BASE["MultiScaleDataset"]
base_local_loss = BASE["local_loss"]

DIRECTION_INDICES = [4, 5, 6, 7, 8, 10, 11, 14, 33]
PROJECTION_INDICES = [8, 10, 11, 14, 17, 19, 20, 21, 27, 33]
SPECIALIST_CONFIG = {
    "directionExpert": {
        "indices": DIRECTION_INDICES,
        "inputSize": 256,
        "minimumFaceDiagonalFactor": 0.95,
        "boxExpansion": 1.60,
        "augmentShiftLimit": 0.04,
        "augmentScaleRange": [0.90, 1.12],
        "augmentAngleLimit": 8.0,
    },
    "projectionExpert": {
        "indices": PROJECTION_INDICES,
        "inputSize": 256,
        "minimumFaceDiagonalFactor": 1.10,
        "boxExpansion": 1.45,
        "augmentShiftLimit": 0.04,
        "augmentScaleRange": [0.90, 1.12],
        "augmentAngleLimit": 8.0,
    },
}
ANGLE_SCALE = math.radians(3.0)
RATIO_SCALE = 0.03
GEOMETRY_WEIGHT = 0.20
TAIL_FRACTION = 0.25
EXPERIMENT_SEED = 39103
EXPERIMENT_ARCHITECTURE = "Menpo39SpecialistGeometryRefiners-v8"
EXPERIMENT_POLICY = "HEADUP-MENPO39-SPECIALIST-GEOMETRY-REFINERS-1.0"
EXPERIMENT_LOSS_DESCRIPTION = (
    "heatmap plus point coordinates plus 0.20x specialist geometry loss; equal mean and worst-25-percent "
    "sample terms; angles scaled by 3 degrees and ratios by 0.03"
)


class V1NormalizedSpecialistDataset(BaseDataset):
    def __getitem__(self, index: int) -> dict[str, torch.Tensor]:
        sample = super().__getitem__(index)
        rgb = sample["image"] * 0.5 + 0.5
        mean = torch.tensor([0.485, 0.456, 0.406], dtype=torch.float32)[:, None, None]
        std = torch.tensor([0.229, 0.224, 0.225], dtype=torch.float32)[:, None, None]
        sample["image"] = (rgb - mean) / std
        return sample


def at(points: torch.Tensor, position: dict[int, int], global_index: int) -> torch.Tensor:
    return points[:, position[global_index]]


def canonicalize(points: torch.Tensor, target: torch.Tensor, position: dict[int, int]) -> torch.Tensor:
    brow = at(target, position, 14)
    menton = at(target, position, 8)
    vertical = menton - brow
    vertical = vertical / torch.linalg.vector_norm(vertical, dim=-1, keepdim=True).clamp_min(1e-4)
    horizontal = torch.stack([vertical[:, 1], -vertical[:, 0]], dim=-1)
    relative = points - brow[:, None, :]
    return torch.stack([
        torch.sum(relative * horizontal[:, None, :], dim=-1),
        torch.sum(relative * vertical[:, None, :], dim=-1),
    ], dim=-1)


def angle_at(points: torch.Tensor, position: dict[int, int], vertex: int, first: int, second: int) -> torch.Tensor:
    center = at(points, position, vertex)
    left = at(points, position, first) - center
    right = at(points, position, second) - center
    cross = left[:, 0] * right[:, 1] - left[:, 1] * right[:, 0]
    dot = torch.sum(left * right, dim=-1)
    return torch.atan2(torch.abs(cross), dot)


def signed_line_distance(points: torch.Tensor, position: dict[int, int], point: int, start: int, end: int) -> torch.Tensor:
    value = at(points, position, point)
    origin = at(points, position, start)
    line = at(points, position, end) - origin
    normal = torch.stack([line[:, 1], -line[:, 0]], dim=-1)
    normal = normal / torch.linalg.vector_norm(normal, dim=-1, keepdim=True).clamp_min(1e-4)
    return torch.sum((value - origin) * normal, dim=-1)


def jaw_inclination(points: torch.Tensor, position: dict[int, int]) -> torch.Tensor:
    jaw = points[:, [position[index] for index in [4, 5, 6, 7, 8]]]
    centered = jaw - torch.mean(jaw, dim=1, keepdim=True)
    xx = torch.sum(centered[:, :, 0] ** 2, dim=1)
    xy = torch.sum(centered[:, :, 0] * centered[:, :, 1], dim=1)
    yy = torch.sum(centered[:, :, 1] ** 2, dim=1)
    angle = 0.5 * torch.atan2(2.0 * xy, xx - yy)
    return torch.atan2(torch.abs(torch.sin(angle)), torch.abs(torch.cos(angle)))


def direction_vector(points: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
    position = {index: offset for offset, index in enumerate(DIRECTION_INDICES)}
    value = canonicalize(points, target, position)
    return torch.stack([
        angle_at(value, position, 11, 33, 10),
        jaw_inclination(value, position),
    ], dim=-1)


def projection_vector(points: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
    position = {index: offset for offset, index in enumerate(PROJECTION_INDICES)}
    value = canonicalize(points, target, position)
    brow = at(value, position, 14)
    menton = at(value, position, 8)
    subnasale = at(value, position, 21)
    pogonion = at(value, position, 10)
    face_height = torch.abs(menton[:, 1] - brow[:, 1]).clamp_min(1e-4)
    midface = subnasale[:, 1] - brow[:, 1]
    lower = pogonion[:, 1] - subnasale[:, 1]
    vertical_total = (midface + lower).clamp_min(1e-4)
    return torch.stack([
        angle_at(value, position, 21, 17, 10),
        angle_at(value, position, 21, 20, 27),
        signed_line_distance(value, position, 10, 17, 21) / face_height,
        signed_line_distance(value, position, 27, 19, 10) / face_height,
        signed_line_distance(value, position, 33, 19, 10) / face_height,
        midface / vertical_total,
        lower / vertical_total,
    ], dim=-1)


def tail_aware_loss(predicted: torch.Tensor, target: torch.Tensor, scales: torch.Tensor) -> torch.Tensor:
    element = functional.smooth_l1_loss(predicted / scales, target / scales, reduction="none")
    per_sample = torch.mean(element, dim=-1)
    tail_count = max(1, int(math.ceil(len(per_sample) * TAIL_FRACTION)))
    tail = torch.topk(per_sample, tail_count, largest=True).values
    return 0.5 * torch.mean(per_sample) + 0.5 * torch.mean(tail)


def specialist_loss(logits: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
    coordinate = base_local_loss(logits, target)
    predicted = BASE["soft_argmax"](logits)
    if logits.shape[1] == len(DIRECTION_INDICES):
        predicted_geometry = direction_vector(predicted, target)
        target_geometry = direction_vector(target, target)
        scales = torch.tensor([ANGLE_SCALE, ANGLE_SCALE], device=target.device, dtype=target.dtype)
    elif logits.shape[1] == len(PROJECTION_INDICES):
        predicted_geometry = projection_vector(predicted, target)
        target_geometry = projection_vector(target, target)
        scales = torch.tensor(
            [ANGLE_SCALE, ANGLE_SCALE, RATIO_SCALE, RATIO_SCALE, RATIO_SCALE, RATIO_SCALE, RATIO_SCALE],
            device=target.device, dtype=target.dtype,
        )
    else:
        raise RuntimeError("unexpected specialist output channel count")
    geometry = tail_aware_loss(predicted_geometry, target_geometry, scales)
    return coordinate + GEOMETRY_WEIGHT * geometry


def main() -> None:
    globals_for_base = BASE["main"].__globals__
    globals_for_base["CONFIG"] = SPECIALIST_CONFIG
    globals_for_base["MultiScaleDataset"] = V1NormalizedSpecialistDataset
    globals_for_base["local_loss"] = specialist_loss
    globals_for_base["SEED"] = EXPERIMENT_SEED
    globals_for_base["ARCHITECTURE"] = EXPERIMENT_ARCHITECTURE
    globals_for_base["POLICY_VERSION"] = EXPERIMENT_POLICY
    globals_for_base["NORMALIZATION_DESCRIPTION"] = (
        "RGB ImageNet mean [0.485,0.456,0.406] / std [0.229,0.224,0.225], matching retained V1"
    )
    globals_for_base["LOSS_DESCRIPTION"] = EXPERIMENT_LOSS_DESCRIPTION
    BASE["main"]()


if __name__ == "__main__":
    main()
