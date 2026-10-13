"""Run V8 specialists with mean-only direction loss and tail-aware projection loss."""

from __future__ import annotations

import runpy
from pathlib import Path

import torch
import torch.nn.functional as functional


V8 = runpy.run_path(
    str(Path(__file__).with_name("train-menpo39-specialist-geometry-refiners.py")),
    run_name="headup_menpo39_asymmetric_specialist_base",
)


def asymmetric_specialist_loss(logits: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
    coordinate = V8["base_local_loss"](logits, target)
    predicted = V8["BASE"]["soft_argmax"](logits)
    if logits.shape[1] == len(V8["DIRECTION_INDICES"]):
        predicted_geometry = V8["direction_vector"](predicted, target)
        target_geometry = V8["direction_vector"](target, target)
        scales = torch.tensor(
            [V8["ANGLE_SCALE"], V8["ANGLE_SCALE"]],
            device=target.device, dtype=target.dtype,
        )
        geometry = functional.smooth_l1_loss(
            predicted_geometry / scales,
            target_geometry / scales,
        )
        return coordinate + 0.25 * geometry
    if logits.shape[1] == len(V8["PROJECTION_INDICES"]):
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
    raise RuntimeError("unexpected asymmetric specialist output channel count")


def main() -> None:
    globals_for_v8 = V8["main"].__globals__
    globals_for_v8["specialist_loss"] = asymmetric_specialist_loss
    globals_for_v8["EXPERIMENT_SEED"] = 39103
    globals_for_v8["EXPERIMENT_ARCHITECTURE"] = "Menpo39AsymmetricSpecialistRefiners-v9"
    globals_for_v8["EXPERIMENT_POLICY"] = "HEADUP-MENPO39-ASYMMETRIC-SPECIALIST-REFINERS-1.0"
    globals_for_v8["EXPERIMENT_LOSS_DESCRIPTION"] = (
        "direction: heatmap+coordinates+0.25x mean geometry; projection: heatmap+coordinates+0.20x equal mean "
        "and worst-25-percent geometry; angles scaled by 3 degrees and ratios by 0.03"
    )
    V8["main"]()


if __name__ == "__main__":
    main()
