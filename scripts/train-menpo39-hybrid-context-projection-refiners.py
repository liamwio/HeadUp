"""Combine the V7 joint-context expert with the V8 tail-aware projection expert."""

from __future__ import annotations

import runpy
from pathlib import Path

import torch


V7 = runpy.run_path(
    str(Path(__file__).with_name("train-menpo39-joint-geometry-refiner.py")),
    run_name="headup_menpo39_hybrid_v7",
)
V8 = runpy.run_path(
    str(Path(__file__).with_name("train-menpo39-specialist-geometry-refiners.py")),
    run_name="headup_menpo39_hybrid_v8",
)
BASE = V7["BASE"]
BaseDataset = BASE["MultiScaleDataset"]

JOINT_INDICES = V7["JOINT_INDICES"]
PROJECTION_INDICES = V8["PROJECTION_INDICES"]
HYBRID_CONFIG = {
    "jointContext": {
        "indices": JOINT_INDICES,
        "inputSize": 256,
        "minimumFaceDiagonalFactor": 1.15,
        "boxExpansion": 1.45,
        "augmentShiftLimit": 0.04,
        "augmentScaleRange": [0.90, 1.12],
        "augmentAngleLimit": 8.0,
    },
    "projectionExpert": dict(V8["SPECIALIST_CONFIG"]["projectionExpert"]),
}
EXPERIMENT_CONFIG = HYBRID_CONFIG
EXPERIMENT_BLEND_CONTROLS = None
EXPERIMENT_ARCHITECTURE = "Menpo39HybridContextProjectionRefiners-v10"
EXPERIMENT_POLICY = "HEADUP-MENPO39-HYBRID-CONTEXT-PROJECTION-REFINERS-1.0"
EXPERIMENT_DESCRIPTION = (
    "joint context: heatmap+coordinates+0.25x mean native-seven geometry; projection: "
    "heatmap+coordinates+0.20x equal mean and worst-25-percent projection geometry; "
    "angles scaled by 3 degrees and ratios by 0.03"
)


class V1NormalizedHybridDataset(BaseDataset):
    def __getitem__(self, index: int) -> dict[str, torch.Tensor]:
        sample = super().__getitem__(index)
        rgb = sample["image"] * 0.5 + 0.5
        mean = torch.tensor([0.485, 0.456, 0.406], dtype=torch.float32)[:, None, None]
        std = torch.tensor([0.229, 0.224, 0.225], dtype=torch.float32)[:, None, None]
        sample["image"] = (rgb - mean) / std
        return sample


def hybrid_loss(logits: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
    if logits.shape[1] == len(JOINT_INDICES):
        return V7["joint_geometry_loss"](logits, target)
    if logits.shape[1] == len(PROJECTION_INDICES):
        coordinate = V8["base_local_loss"](logits, target)
        predicted = V8["BASE"]["soft_argmax"](logits)
        predicted_geometry = V8["projection_vector"](predicted, target)
        target_geometry = V8["projection_vector"](target, target)
        scales = torch.tensor(
            [V8["ANGLE_SCALE"], V8["ANGLE_SCALE"],
             V8["RATIO_SCALE"], V8["RATIO_SCALE"], V8["RATIO_SCALE"],
             V8["RATIO_SCALE"], V8["RATIO_SCALE"]],
            device=target.device, dtype=target.dtype,
        )
        geometry = V8["tail_aware_loss"](predicted_geometry, target_geometry, scales)
        return coordinate + 0.20 * geometry
    raise RuntimeError("unexpected hybrid expert output channel count")


def main() -> None:
    globals_for_base = BASE["main"].__globals__
    globals_for_base["CONFIG"] = EXPERIMENT_CONFIG
    globals_for_base["BLEND_CONTROLS"] = EXPERIMENT_BLEND_CONTROLS
    globals_for_base["MultiScaleDataset"] = V1NormalizedHybridDataset
    globals_for_base["local_loss"] = hybrid_loss
    # Reuse the V7 seed so the first (joint-context) expert is a direct reproducibility control.
    globals_for_base["SEED"] = 39091
    globals_for_base["ARCHITECTURE"] = EXPERIMENT_ARCHITECTURE
    globals_for_base["POLICY_VERSION"] = EXPERIMENT_POLICY
    globals_for_base["NORMALIZATION_DESCRIPTION"] = (
        "RGB ImageNet mean [0.485,0.456,0.406] / std [0.229,0.224,0.225], matching retained V1"
    )
    globals_for_base["LOSS_DESCRIPTION"] = EXPERIMENT_DESCRIPTION
    BASE["main"]()


if __name__ == "__main__":
    main()
