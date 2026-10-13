"""Run the official MediaPipe Hair Segmenter through LiteRT for research benchmarks.

The caller supplies the model and one image. The script emits aggregate mask
statistics only; it never writes the source image or the predicted mask.
"""

import json
import sys

import numpy as np
from PIL import Image
from ai_edge_litert.interpreter import Interpreter


def percentile(values: np.ndarray, fraction: float) -> float:
    return float(np.quantile(values, fraction))


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: run-hair-segmenter-litert.py MODEL.tflite IMAGE")

    model_path, image_path = sys.argv[1:3]
    rgb = np.asarray(
        Image.open(image_path).convert("RGB").resize((512, 512), Image.Resampling.BILINEAR),
        dtype=np.float32,
    )

    # The model metadata specifies mean=0 and std=255. The fourth channel is
    # opaque alpha, matching the model's RGBA input contract.
    rgba = np.concatenate(
        [rgb / 255.0, np.ones((512, 512, 1), dtype=np.float32)], axis=-1
    )

    interpreter = Interpreter(model_path=model_path, num_threads=1)
    interpreter.allocate_tensors()
    input_details = interpreter.get_input_details()[0]
    output_details = interpreter.get_output_details()[0]
    if tuple(input_details["shape"]) != (1, 512, 512, 4):
        raise RuntimeError(f"unexpected model input shape: {input_details['shape']}")
    if tuple(output_details["shape"]) != (1, 512, 512, 2):
        raise RuntimeError(f"unexpected model output shape: {output_details['shape']}")

    interpreter.set_tensor(input_details["index"], rgba[None])
    interpreter.invoke()
    logits = interpreter.get_tensor(output_details["index"])[0]
    shifted = logits - logits.max(axis=-1, keepdims=True)
    exponentials = np.exp(shifted)
    hair_confidence = exponentials[..., 1] / exponentials.sum(axis=-1)
    hair_mask = hair_confidence >= 0.5

    coordinates = np.argwhere(hair_mask)
    if coordinates.size:
        y_min, x_min = coordinates.min(axis=0)
        y_max, x_max = coordinates.max(axis=0)
        centroid_y, centroid_x = coordinates.mean(axis=0)
        bounding_box = {
            "xMin": float(x_min / 512),
            "yMin": float(y_min / 512),
            "xMax": float((x_max + 1) / 512),
            "yMax": float((y_max + 1) / 512),
        }
        centroid = {"x": float(centroid_x / 511), "y": float(centroid_y / 511)}
    else:
        bounding_box = None
        centroid = None

    result = {
        "hairPixelFraction": float(hair_mask.mean()),
        "upperHalfHairFraction": float(hair_mask[:256].mean()),
        "centerUpperHairFraction": float(hair_mask[:307, 102:410].mean()),
        "hairConfidenceMean": float(hair_confidence.mean()),
        "hairConfidenceP95": percentile(hair_confidence, 0.95),
        "hairBoundingBox": bounding_box,
        "hairCentroid": centroid,
    }
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    main()
