"""One-image CPU compatibility and timing probe for the unmodified SPIGA model."""

from __future__ import annotations

import json
import math
import sys
import time
from pathlib import Path

import cv2
import numpy as np
import torch


def main() -> None:
    if len(sys.argv) != 5:
        raise SystemExit("usage: probe-spiga-cpu.py REPO WEIGHT IMAGE YUNET")
    repo, weight, image_path, yunet_path = map(Path, sys.argv[1:])
    sys.path.insert(0, str(repo))

    # The official inference wrapper only exposes CUDA. Redirect its two .cuda()
    # calls to CPU without changing model tensors, layers, weights or preprocessing.
    torch.Tensor.cuda = lambda self, device=None, non_blocking=False: self  # type: ignore[method-assign]
    torch.nn.Module.cuda = lambda self, device=None: self  # type: ignore[method-assign]

    from spiga.inference.config import ModelConfig
    from spiga.inference.framework import SPIGAFramework

    image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError("unable to decode probe image")
    height, width = image.shape[:2]
    detector = cv2.FaceDetectorYN.create(str(yunet_path), "", (width, height), 0.6, 0.3, 5000)
    _, faces = detector.detect(image)
    if faces is None or len(faces) == 0:
        raise RuntimeError("YuNet did not detect the probe profile")
    face = max(faces, key=lambda row: float(row[-1]))
    bbox = [float(value) for value in face[:4]]

    config = ModelConfig("wflw", load_model_url=False)
    config.model_weights_path = str(weight.parent)
    config.model_weights = weight.name
    started = time.perf_counter()
    framework = SPIGAFramework(config, gpus=[0])
    load_seconds = time.perf_counter() - started
    started = time.perf_counter()
    features = framework.inference(image, [bbox])
    inference_seconds = time.perf_counter() - started
    landmarks = np.asarray(features.get("landmarks"), dtype=np.float64)
    headpose = np.asarray(features.get("headpose"), dtype=np.float64)
    finite = bool(landmarks.shape == (1, 98, 2) and np.isfinite(landmarks).all())
    print(json.dumps({
        "modelLoadSeconds": round(load_seconds, 3),
        "inferenceSeconds": round(inference_seconds, 3),
        "landmarkShape": list(landmarks.shape),
        "finiteLandmarks": finite,
        "headposeShape": list(headpose.shape),
        "finiteHeadpose": bool(headpose.size and all(math.isfinite(float(value)) for value in headpose.flat)),
        "yunetScore": round(float(face[-1]), 6),
    }, indent=2))
    if not finite:
        raise RuntimeError("SPIGA CPU probe did not return 98 finite landmarks")


if __name__ == "__main__":
    main()
