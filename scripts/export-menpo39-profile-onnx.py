from __future__ import annotations

import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch
import torch.nn as nn
import torch.nn.functional as functional
from torchvision.models import mobilenet_v3_small

LANDMARK_COUNT = 39
IMAGE_SIZE = 224
HEATMAP_SIZE = 56


class MobileNet39Heatmaps(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        backbone = mobilenet_v3_small(weights=None)
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


class CoordinateModel(nn.Module):
    def __init__(self, heatmap_model: MobileNet39Heatmaps) -> None:
        super().__init__()
        self.heatmap_model = heatmap_model
        y_grid, x_grid = torch.meshgrid(
            torch.linspace(0, 1, HEATMAP_SIZE),
            torch.linspace(0, 1, HEATMAP_SIZE),
            indexing="ij",
        )
        self.register_buffer("x_grid", x_grid.reshape(1, 1, -1))
        self.register_buffer("y_grid", y_grid.reshape(1, 1, -1))

    def forward(self, image: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        heatmaps = self.heatmap_model(image)
        probability = functional.softmax(heatmaps.reshape(image.shape[0], LANDMARK_COUNT, -1) * 10.0, dim=-1)
        x = torch.sum(probability * self.x_grid, dim=-1)
        y = torch.sum(probability * self.y_grid, dim=-1)
        return torch.stack([x, y], dim=-1), torch.amax(probability, dim=-1)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    if len(sys.argv) != 5:
        raise SystemExit("usage: export.py CHECKPOINT OUTPUT_ONNX MANIFEST_JSON RESULT_JSON")
    checkpoint, output, manifest_path, result_path = map(Path, sys.argv[1:])
    if not checkpoint.is_file():
        raise RuntimeError(f"checkpoint missing: {checkpoint}")
    output.parent.mkdir(parents=True, exist_ok=True)

    heatmap_model = MobileNet39Heatmaps()
    checkpoint_payload = torch.load(checkpoint, map_location="cpu", weights_only=True)
    state_dict = checkpoint_payload["stateDict"] if "stateDict" in checkpoint_payload else checkpoint_payload
    heatmap_model.load_state_dict(state_dict, strict=True)
    model = CoordinateModel(heatmap_model).eval()
    torch.manual_seed(39017)
    example = torch.randn(1, 3, IMAGE_SIZE, IMAGE_SIZE, dtype=torch.float32)
    with torch.inference_mode():
        torch_coordinates, torch_confidence = [value.cpu().numpy() for value in model(example)]

    torch.onnx.export(
        model,
        (example,),
        str(output),
        input_names=["input"],
        output_names=["coordinates", "confidence"],
        opset_version=17,
        do_constant_folding=True,
        dynamo=False,
        external_data=False,
    )
    graph = onnx.load(str(output))
    onnx.checker.check_model(graph)
    session = ort.InferenceSession(str(output), providers=["CPUExecutionProvider"])
    ort_coordinates, ort_confidence = session.run(["coordinates", "confidence"], {"input": example.numpy()})
    maximum_difference = float(np.max(np.abs(torch_coordinates - ort_coordinates)))
    mean_difference = float(np.mean(np.abs(torch_coordinates - ort_coordinates)))
    confidence_maximum_difference = float(np.max(np.abs(torch_confidence - ort_confidence)))
    if maximum_difference > 1e-4 or confidence_maximum_difference > 1e-4:
        raise RuntimeError(f"ONNX parity failed: coordinate {maximum_difference}, confidence {confidence_maximum_difference}")
    if tuple(ort_coordinates.shape) != (1, LANDMARK_COUNT, 2):
        raise RuntimeError(f"unexpected output shape: {ort_coordinates.shape}")

    manifest = {
        "policyVersion": "HEADUP-MENPO39-ONNX-1.0",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "model": {
            "path": "models/menpo39-profile-v1.onnx",
            "sha256": sha256(output),
            "bytes": output.stat().st_size,
            "architecture": "MobileNetV3-Small + 39 heatmaps + temperature-10 soft-argmax",
            "input": {"name": "input", "shape": [1, 3, 224, 224], "dtype": "float32", "color": "RGB"},
            "output": {"coordinates": {"name": "coordinates", "shape": [1, 39, 2], "range": "normalized crop coordinates"}, "confidence": {"name": "confidence", "shape": [1, 39], "range": "softmax peak 0..1"}},
            "normalization": {"mean": [0.485, 0.456, 0.406], "std": [0.229, 0.224, 0.225]},
            "opset": 17,
        },
        "sourceCheckpoint": {"sha256": sha256(checkpoint), "retainedOutsidePublicAssets": True},
        "cropContract": {"inputSize": 224, "status": "requires_yunet_to_menpo_calibration"},
        "limitations": [
            "The model predicts native Menpo39 visible soft-tissue landmarks.",
            "Browser packaging does not itself validate geometry or external-source generalization.",
            "Neck landmarks are absent, so cervicomental angle remains unavailable.",
        ],
    }
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    result = {
        "testedAt": datetime.now(timezone.utc).isoformat(),
        "policyVersion": "HEADUP-MENPO39-ONNX-EXPORT-1.0",
        "passes": True,
        "checkpointLoadedStrictly": True,
        "checkpointContainer": "stateDict" if "stateDict" in checkpoint_payload else "bare",
        "onnxCheckerPassed": True,
        "inputShape": [1, 3, 224, 224],
        "outputShape": list(ort_coordinates.shape),
        "parity": {"maximumAbsoluteCoordinateDifference": maximum_difference, "meanAbsoluteCoordinateDifference": mean_difference, "maximumAbsoluteConfidenceDifference": confidence_maximum_difference, "threshold": 1e-4},
        "model": manifest["model"],
    }
    result_path.parent.mkdir(parents=True, exist_ok=True)
    result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
