"""Run the V5 design with the V1 ImageNet input normalization restored."""

from __future__ import annotations

import runpy
from pathlib import Path

import torch


BASE = runpy.run_path(
    str(Path(__file__).with_name("train-menpo39-multiscale-local-refiners.py")),
    run_name="headup_menpo39_normalized_multiscale_base",
)
BaseDataset = BASE["MultiScaleDataset"]


class V1NormalizedMultiScaleDataset(BaseDataset):
    """Preserve the V5 sample contract while matching the retained V1 input distribution."""

    def __getitem__(self, index: int) -> dict[str, torch.Tensor]:
        sample = super().__getitem__(index)
        rgb = sample["image"] * 0.5 + 0.5
        mean = torch.tensor([0.485, 0.456, 0.406], dtype=torch.float32)[:, None, None]
        std = torch.tensor([0.229, 0.224, 0.225], dtype=torch.float32)[:, None, None]
        sample["image"] = (rgb - mean) / std
        return sample


def main() -> None:
    globals_for_base = BASE["main"].__globals__
    globals_for_base["MultiScaleDataset"] = V1NormalizedMultiScaleDataset
    globals_for_base["SEED"] = 39079
    globals_for_base["ARCHITECTURE"] = "Menpo39NormalizedMultiscaleLocalRefiners-v6"
    globals_for_base["POLICY_VERSION"] = "HEADUP-MENPO39-NORMALIZED-MULTISCALE-REFINERS-1.0"
    globals_for_base["NORMALIZATION_DESCRIPTION"] = (
        "RGB ImageNet mean [0.485,0.456,0.406] / std [0.229,0.224,0.225], matching retained V1"
    )
    BASE["main"]()


if __name__ == "__main__":
    main()
