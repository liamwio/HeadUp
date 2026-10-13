"""Train one V1-initialized 14-point refiner with native-profile geometry supervision."""

from __future__ import annotations

import math
import runpy
from pathlib import Path

import torch
import torch.nn.functional as functional


BASE = runpy.run_path(
    str(Path(__file__).with_name("train-menpo39-multiscale-local-refiners.py")),
    run_name="headup_menpo39_joint_geometry_base",
)
BaseDataset = BASE["MultiScaleDataset"]
base_local_loss = BASE["local_loss"]

JOINT_INDICES = [4, 5, 6, 7, 8, 10, 11, 14, 17, 19, 20, 21, 27, 33]
JOINT_CONFIG = {
    "jointGeometry": {
        "indices": JOINT_INDICES,
        "inputSize": 256,
        "minimumFaceDiagonalFactor": 1.15,
        "boxExpansion": 1.45,
        "augmentShiftLimit": 0.04,
        "augmentScaleRange": [0.90, 1.12],
        "augmentAngleLimit": 8.0,
    },
}
POSITION = {global_index: local_index for local_index, global_index in enumerate(JOINT_INDICES)}
ANGLE_SCALE = math.radians(3.0)
RATIO_SCALE = 0.03
GEOMETRY_WEIGHT = 0.25


class V1NormalizedJointDataset(BaseDataset):
    def __getitem__(self, index: int) -> dict[str, torch.Tensor]:
        sample = super().__getitem__(index)
        rgb = sample["image"] * 0.5 + 0.5
        mean = torch.tensor([0.485, 0.456, 0.406], dtype=torch.float32)[:, None, None]
        std = torch.tensor([0.229, 0.224, 0.225], dtype=torch.float32)[:, None, None]
        sample["image"] = (rgb - mean) / std
        return sample


def at(points: torch.Tensor, global_index: int) -> torch.Tensor:
    return points[:, POSITION[global_index]]


def canonicalize(points: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
    brow = at(target, 14)
    menton = at(target, 8)
    vertical = menton - brow
    vertical = vertical / torch.linalg.vector_norm(vertical, dim=-1, keepdim=True).clamp_min(1e-4)
    horizontal = torch.stack([vertical[:, 1], -vertical[:, 0]], dim=-1)
    relative = points - brow[:, None, :]
    return torch.stack([
        torch.sum(relative * horizontal[:, None, :], dim=-1),
        torch.sum(relative * vertical[:, None, :], dim=-1),
    ], dim=-1)


def angle_at(points: torch.Tensor, vertex_index: int, first_index: int, second_index: int) -> torch.Tensor:
    vertex = at(points, vertex_index)
    left = at(points, first_index) - vertex
    right = at(points, second_index) - vertex
    cross = left[:, 0] * right[:, 1] - left[:, 1] * right[:, 0]
    dot = torch.sum(left * right, dim=-1)
    return torch.atan2(torch.abs(cross), dot)


def signed_line_distance(points: torch.Tensor, point_index: int, start_index: int, end_index: int) -> torch.Tensor:
    point = at(points, point_index)
    start = at(points, start_index)
    line = at(points, end_index) - start
    normal = torch.stack([line[:, 1], -line[:, 0]], dim=-1)
    normal = normal / torch.linalg.vector_norm(normal, dim=-1, keepdim=True).clamp_min(1e-4)
    return torch.sum((point - start) * normal, dim=-1)


def jaw_inclination(points: torch.Tensor) -> torch.Tensor:
    jaw = points[:, [POSITION[index] for index in [4, 5, 6, 7, 8]]]
    centered = jaw - torch.mean(jaw, dim=1, keepdim=True)
    xx = torch.sum(centered[:, :, 0] ** 2, dim=1)
    xy = torch.sum(centered[:, :, 0] * centered[:, :, 1], dim=1)
    yy = torch.sum(centered[:, :, 1] ** 2, dim=1)
    angle = 0.5 * torch.atan2(2.0 * xy, xx - yy)
    return torch.atan2(torch.abs(torch.sin(angle)), torch.abs(torch.cos(angle)))


def geometry_vector(points: torch.Tensor, target_for_axis: torch.Tensor) -> torch.Tensor:
    value = canonicalize(points, target_for_axis)
    brow = at(value, 14)
    menton = at(value, 8)
    subnasale = at(value, 21)
    pogonion = at(value, 10)
    face_height = torch.abs(menton[:, 1] - brow[:, 1]).clamp_min(1e-4)
    midface = subnasale[:, 1] - brow[:, 1]
    lower = pogonion[:, 1] - subnasale[:, 1]
    vertical_total = (midface + lower).clamp_min(1e-4)
    return torch.stack([
        angle_at(value, 21, 17, 10),
        angle_at(value, 21, 20, 27),
        angle_at(value, 11, 33, 10),
        jaw_inclination(value),
        signed_line_distance(value, 27, 19, 10) / face_height,
        signed_line_distance(value, 33, 19, 10) / face_height,
        signed_line_distance(value, 10, 17, 21) / face_height,
        midface / vertical_total,
        lower / vertical_total,
    ], dim=-1)


def joint_geometry_loss(logits: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
    coordinate_loss = base_local_loss(logits, target)
    predicted = BASE["soft_argmax"](logits)
    predicted_geometry = geometry_vector(predicted, target)
    target_geometry = geometry_vector(target, target)
    scales = torch.tensor(
        [ANGLE_SCALE, ANGLE_SCALE, ANGLE_SCALE, ANGLE_SCALE,
         RATIO_SCALE, RATIO_SCALE, RATIO_SCALE, RATIO_SCALE, RATIO_SCALE],
        device=target.device, dtype=target.dtype,
    )
    geometry = functional.smooth_l1_loss(
        predicted_geometry / scales,
        target_geometry / scales,
    )
    return coordinate_loss + GEOMETRY_WEIGHT * geometry


def main() -> None:
    globals_for_base = BASE["main"].__globals__
    globals_for_base["CONFIG"] = JOINT_CONFIG
    globals_for_base["MultiScaleDataset"] = V1NormalizedJointDataset
    globals_for_base["local_loss"] = joint_geometry_loss
    globals_for_base["SEED"] = 39091
    globals_for_base["ARCHITECTURE"] = "Menpo39JointGeometryRefiner-v7"
    globals_for_base["POLICY_VERSION"] = "HEADUP-MENPO39-JOINT-GEOMETRY-REFINER-1.0"
    globals_for_base["NORMALIZATION_DESCRIPTION"] = (
        "RGB ImageNet mean [0.485,0.456,0.406] / std [0.229,0.224,0.225], matching retained V1"
    )
    globals_for_base["LOSS_DESCRIPTION"] = (
        "heatmap plus point coordinates plus 0.25x native seven-metric geometry loss; "
        "angles scaled by 3 degrees and ratios by 0.03"
    )
    BASE["main"]()


if __name__ == "__main__":
    main()
