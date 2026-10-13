"""Aggregate-only 90-degree profile audit for OMZ's 98-point HRNet model."""

from __future__ import annotations

import json
import math
import runpy
import sys
from pathlib import Path

import cv2
import numpy as np
import openvino as ov


HELPERS = runpy.run_path(str(Path(__file__).with_name("benchmark-omz-profile-landmarks.py")), run_name="headup_profile_helpers")
expanded_crop = HELPERS["expanded_crop"]
foreground_mask = HELPERS["foreground_mask"]
forward_silhouette_error = HELPERS["forward_silhouette_error"]
distribution = HELPERS["distribution"]
sha256 = HELPERS["sha256"]
PROFILE_VIEWS = {"left_profile", "right_profile"}
# WFLW-style convention: nose tip, upper/lower outer-lip midpoints, chin.
SILHOUETTE_POINTS = (54, 79, 85, 16)


def infer(compiled: ov.CompiledModel, crop: np.ndarray, crop_box: tuple[float, float, float, float]) -> tuple[np.ndarray, np.ndarray]:
    resized = cv2.resize(crop, (64, 64), interpolation=cv2.INTER_LINEAR)
    tensor = resized.astype(np.float32).transpose(2, 0, 1)[None]
    heatmaps = np.asarray(compiled([tensor])[compiled.output(0)]).reshape(98, 16, 16)
    points = np.empty((98, 2), dtype=np.float32)
    confidences = np.empty(98, dtype=np.float32)
    for index, heatmap in enumerate(heatmaps):
        flat_index = int(np.argmax(heatmap))
        row, column = divmod(flat_index, 16)
        points[index] = ((column + 0.5) / 16, (row + 0.5) / 16)
        confidences[index] = float(heatmap[row, column])
    x, y, width, height = crop_box
    points[:, 0] = x + points[:, 0] * width
    points[:, 1] = y + points[:, 1] * height
    return points, confidences


def main() -> None:
    if len(sys.argv) != 7:
        raise SystemExit("usage: benchmark.py MANIFEST DB_DIR MODEL_XML MODEL_BIN YUNET_ONNX RESULT_JSON")
    manifest_path, db_dir, model_xml, model_bin, yunet_path, result_path = map(Path, sys.argv[1:])
    records = [json.loads(line) for line in manifest_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    records = [record for record in records if record["view"] in PROFILE_VIEWS]
    if len(records) != 204:
        raise RuntimeError(f"expected 204 profile images, found {len(records)}")

    core = ov.Core()
    compiled = core.compile_model(core.read_model(model=str(model_xml), weights=str(model_bin)), "CPU")
    detector = cv2.FaceDetectorYN.create(str(yunet_path), "", (640, 640), 0.6, 0.3, 5000)
    cases: list[dict[str, object]] = []
    for record in records:
        image = cv2.imread(str(db_dir / record["relativePath"]), cv2.IMREAD_COLOR)
        if image is None:
            raise RuntimeError("unable to decode a manifest image")
        height, width = image.shape[:2]
        detector.setInputSize((640, 640))
        _, detections = detector.detect(cv2.resize(image, (640, 640), interpolation=cv2.INTER_AREA))
        if detections is None or len(detections) == 0:
            cases.append({"view": record["view"], "partition": record["partition"], "detected": False})
            continue
        detection = max(detections, key=lambda item: float(item[-1])).astype(np.float64)
        detection[[0, 2, 4, 6, 8, 10, 12]] *= width / 640
        detection[[1, 3, 5, 7, 9, 11, 13]] *= height / 640
        crop, crop_box = expanded_crop(image, detection, 1.0)
        expanded, expanded_box = expanded_crop(image, detection, 1.25)
        points, confidence = infer(compiled, crop, crop_box)
        expanded_points, _ = infer(compiled, expanded, expanded_box)
        face_diagonal = math.hypot(float(detection[2]), float(detection[3]))
        crop_sensitivity = float(np.median(np.linalg.norm(points - expanded_points, axis=1)) / max(1.0, face_diagonal))
        center_x = float(np.median(points[:, 0]))
        nose_expected_side = bool(points[54, 0] < center_x if record["view"] == "left_profile" else points[54, 0] > center_x)
        mask = foreground_mask(image)
        silhouette_errors = [forward_silhouette_error(mask, points[index], record["view"], detection) for index in SILHOUETTE_POINTS]
        cases.append({
            "view": record["view"], "partition": record["partition"], "detected": True,
            "finite": bool(np.isfinite(points).all()), "noseExpectedSide": nose_expected_side,
            "cropSensitivity": crop_sensitivity, "heatmapMaximumMedian": float(np.median(confidence)),
            "silhouetteErrors": [value for value in silhouette_errors if value is not None],
        })

    def summarize(items: list[dict[str, object]]) -> dict[str, object]:
        detected = [item for item in items if item.get("detected")]
        return {
            "images": len(items), "detected": len(detected), "finite": sum(bool(item.get("finite")) for item in detected),
            "noseTipOnExpectedForwardSide": sum(bool(item.get("noseExpectedSide")) for item in detected),
            "cropSensitivityMedianPointShiftOverFaceDiagonal": distribution([float(item["cropSensitivity"]) for item in detected]),
            "forwardSilhouetteAbsoluteXErrorOverFaceWidth": distribution([float(value) for item in detected for value in item.get("silhouetteErrors", [])]),
            "heatmapMaximumMedian": distribution([float(item["heatmapMaximumMedian"]) for item in detected]),
        }

    overall = summarize(cases)
    detected_count = int(overall["detected"])
    silhouette_p95 = overall["forwardSilhouetteAbsoluteXErrorOverFaceWidth"]["p95"]
    crop_p95 = overall["cropSensitivityMedianPointShiftOverFaceDiagonal"]["p95"]
    gates = {
        "detectionAtLeast95Percent": detected_count / len(cases) >= 0.95,
        "finiteAtLeast99PercentOfDetected": int(overall["finite"]) / max(1, detected_count) >= 0.99,
        "noseDirectionAtLeast90PercentOfDetected": int(overall["noseTipOnExpectedForwardSide"]) / max(1, detected_count) >= 0.90,
        "silhouetteP95AtMost8PercentFaceWidth": silhouette_p95 is not None and float(silhouette_p95) <= 0.08,
        "cropSensitivityP95AtMost5PercentFaceDiagonal": crop_p95 is not None and float(crop_p95) <= 0.05,
    }
    result = {
        "testedAt": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
        "policyVersion": "HEADUP-OMZ-PROFILE-LANDMARK98-AUDIT-1.0",
        "model": {
            "name": "facial-landmarks-98-detection-0001", "source": "Open Model Zoo 2023.0 FP32", "license": "Apache-2.0",
            "xmlSha256": sha256(model_xml), "binSha256": sha256(model_bin),
            "input": "1x3x64x64 BGR float32", "output": "98x16x16 landmark heatmaps",
        },
        "dataset": {"name": "Face Research Lab London Set", "subjects": 102, "profileImages": len(cases)},
        "overall": overall,
        "byView": {view: summarize([item for item in cases if item["view"] == view]) for view in sorted(PROFILE_VIEWS)},
        "byPartition": {partition: summarize([item for item in cases if item["partition"] == partition]) for partition in sorted({str(item["partition"]) for item in cases})},
        "predeclaredCandidateGates": gates, "candidatePassesAllGates": all(gates.values()),
        "interpretation": "Passing is necessary, not sufficient because no manual profile-landmark ground truth is available. Any failed gate rejects production integration.",
        "retention": {"sourceImagesModified": False, "cropsOrOverlaysWritten": False, "individualPredictionsRetained": False, "identifiersRetained": False, "aggregateOnly": True},
    }
    Path(result_path).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"resultPath": str(result_path), "overall": overall, "gates": gates, "passes": result["candidatePassesAllGates"]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
