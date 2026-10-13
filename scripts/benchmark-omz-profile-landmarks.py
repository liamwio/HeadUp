"""Aggregate-only audit of OMZ facial-landmarks-35-adas-0002 on London profiles.

The script never writes crops, overlays, landmark coordinates, filenames, or
subject identifiers. It emits only cohort-level distributions to the supplied
JSON path. Model/runtime cleanup is owned by the Node wrapper.
"""

from __future__ import annotations

import hashlib
import json
import math
import sys
from collections import defaultdict
from pathlib import Path

import cv2
import numpy as np
import openvino as ov


PROFILE_VIEWS = {"left_profile", "right_profile"}
MIRROR_SWAP = {
    0: 3, 1: 2, 2: 1, 3: 0,
    6: 7, 7: 6, 8: 9, 9: 8,
    12: 17, 13: 16, 14: 15, 15: 14, 16: 13, 17: 12,
    **{index: 52 - index for index in range(18, 35)},
}
SILHOUETTE_POINTS = (4, 5, 10, 11, 26)


def percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    return round(float(np.quantile(np.asarray(values, dtype=np.float64), fraction)), 4)


def distribution(values: list[float]) -> dict[str, float | None]:
    return {
        "min": percentile(values, 0),
        "p05": percentile(values, 0.05),
        "median": percentile(values, 0.5),
        "p95": percentile(values, 0.95),
        "max": percentile(values, 1),
    }


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def expanded_crop(image: np.ndarray, box: np.ndarray, factor: float) -> tuple[np.ndarray, tuple[float, float, float, float]]:
    height, width = image.shape[:2]
    x, y, w, h = [float(value) for value in box[:4]]
    cx, cy = x + w / 2, y + h / 2
    side_w, side_h = w * factor, h * factor
    x0, y0 = max(0, cx - side_w / 2), max(0, cy - side_h / 2)
    x1, y1 = min(width, cx + side_w / 2), min(height, cy + side_h / 2)
    ix0, iy0, ix1, iy1 = int(math.floor(x0)), int(math.floor(y0)), int(math.ceil(x1)), int(math.ceil(y1))
    return image[iy0:iy1, ix0:ix1], (float(ix0), float(iy0), float(ix1 - ix0), float(iy1 - iy0))


def infer_landmarks(compiled: ov.CompiledModel, crop: np.ndarray, crop_box: tuple[float, float, float, float]) -> np.ndarray:
    resized = cv2.resize(crop, (60, 60), interpolation=cv2.INTER_LINEAR)
    tensor = resized.astype(np.float32).transpose(2, 0, 1)[None]
    output = np.asarray(compiled([tensor])[compiled.output(0)]).reshape(35, 2)
    x, y, width, height = crop_box
    mapped = output.copy()
    mapped[:, 0] = x + mapped[:, 0] * width
    mapped[:, 1] = y + mapped[:, 1] * height
    return mapped


def foreground_mask(image: np.ndarray) -> np.ndarray:
    height, width = image.shape[:2]
    patch = max(12, min(height, width) // 18)
    corners = np.concatenate([
        image[:patch, :patch].reshape(-1, 3), image[:patch, width - patch:].reshape(-1, 3),
        image[height - patch:, :patch].reshape(-1, 3), image[height - patch:, width - patch:].reshape(-1, 3),
    ], axis=0).astype(np.float32)
    background = np.median(corners, axis=0)
    distance = np.linalg.norm(image.astype(np.float32) - background[None, None, :], axis=2)
    mask = (distance >= 24).astype(np.uint8)
    kernel = np.ones((5, 5), dtype=np.uint8)
    return cv2.morphologyEx(cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel), cv2.MORPH_CLOSE, kernel)


def forward_silhouette_error(mask: np.ndarray, point: np.ndarray, view: str, face_box: np.ndarray) -> float | None:
    height, width = mask.shape
    x, y = float(point[0]), float(point[1])
    yi = int(round(y))
    if yi < 0 or yi >= height:
        return None
    x0 = max(0, int(math.floor(float(face_box[0]) - 0.15 * float(face_box[2]))))
    x1 = min(width, int(math.ceil(float(face_box[0] + face_box[2] * 1.15))))
    candidates: list[int] = []
    for row in range(max(0, yi - 3), min(height, yi + 4)):
        xs = np.flatnonzero(mask[row, x0:x1]) + x0
        if xs.size:
            candidates.append(int(xs.min() if view == "left_profile" else xs.max()))
    if not candidates:
        return None
    boundary = float(np.median(candidates))
    return abs(x - boundary) / max(1.0, float(face_box[2]))


def canonicalize(points: np.ndarray, view: str) -> np.ndarray:
    result = points.copy()
    if view == "left_profile":
        center_x = float(np.mean(result[:, 0]))
        result[:, 0] = 2 * center_x - result[:, 0]
        result = result[[MIRROR_SWAP.get(index, index) for index in range(35)]]
    return result


def similarity_rms(first: np.ndarray, second: np.ndarray) -> float:
    first_centered = first - first.mean(axis=0)
    second_centered = second - second.mean(axis=0)
    first_norm = float(np.linalg.norm(first_centered))
    second_norm = float(np.linalg.norm(second_centered))
    if first_norm <= 1e-8 or second_norm <= 1e-8:
        return float("inf")
    first_unit, second_unit = first_centered / first_norm, second_centered / second_norm
    u, _, vt = np.linalg.svd(first_unit.T @ second_unit)
    rotation = u @ vt
    aligned = first_unit @ rotation
    return float(np.sqrt(np.mean(np.sum((aligned - second_unit) ** 2, axis=1))))


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
        resized = cv2.resize(image, (640, 640), interpolation=cv2.INTER_AREA)
        _, detections = detector.detect(resized)
        if detections is None or len(detections) == 0:
            cases.append({"view": record["view"], "partition": record["partition"], "detected": False})
            continue
        detection = max(detections, key=lambda item: float(item[-1])).astype(np.float64)
        detection[[0, 2, 4, 6, 8, 10, 12]] *= width / 640
        detection[[1, 3, 5, 7, 9, 11, 13]] *= height / 640
        crop, crop_box = expanded_crop(image, detection, 1.0)
        expanded, expanded_box = expanded_crop(image, detection, 1.25)
        points = infer_landmarks(compiled, crop, crop_box)
        expanded_points = infer_landmarks(compiled, expanded, expanded_box)
        finite = bool(np.isfinite(points).all() and np.isfinite(expanded_points).all())
        normalized = (points - np.asarray(crop_box[:2])) / np.asarray(crop_box[2:])
        loose_bounds = bool(((normalized >= -0.25) & (normalized <= 1.25)).all())
        center_x = float(np.median(points[:, 0]))
        nose_expected_side = bool(points[4, 0] < center_x if record["view"] == "left_profile" else points[4, 0] > center_x)
        face_diagonal = math.hypot(float(detection[2]), float(detection[3]))
        crop_sensitivity = float(np.median(np.linalg.norm(points - expanded_points, axis=1)) / max(1.0, face_diagonal))
        mask = foreground_mask(image)
        silhouette_errors = [forward_silhouette_error(mask, points[index], record["view"], detection) for index in SILHOUETTE_POINTS]
        cases.append({
            "view": record["view"], "partition": record["partition"], "detected": True,
            "finite": finite, "looseBounds": loose_bounds, "noseExpectedSide": nose_expected_side,
            "cropSensitivity": crop_sensitivity,
            "silhouetteErrors": [value for value in silhouette_errors if value is not None],
            "subject": record["pseudonymousSubjectId"],
            "points": canonicalize(points, record["view"]),
        })

    def summarize(items: list[dict[str, object]]) -> dict[str, object]:
        detected = [item for item in items if item.get("detected")]
        silhouette = [float(value) for item in detected for value in item.get("silhouetteErrors", [])]
        return {
            "images": len(items), "detected": len(detected),
            "finite": sum(bool(item.get("finite")) for item in detected),
            "allPointsWithinLooseCropBounds": sum(bool(item.get("looseBounds")) for item in detected),
            "noseTipOnExpectedForwardSide": sum(bool(item.get("noseExpectedSide")) for item in detected),
            "cropSensitivityMedianPointShiftOverFaceDiagonal": distribution([float(item["cropSensitivity"]) for item in detected]),
            "forwardSilhouetteAbsoluteXErrorOverFaceWidth": distribution(silhouette),
            "forwardSilhouetteObservations": len(silhouette),
        }

    paired = defaultdict(dict)
    for item in cases:
        if item.get("detected"):
            paired[str(item["subject"])][str(item["view"])] = item
    all_rms: list[float] = []
    silhouette_rms: list[float] = []
    partition_pairs: dict[str, list[float]] = defaultdict(list)
    for views in paired.values():
        if set(views) != PROFILE_VIEWS:
            continue
        left, right = views["left_profile"], views["right_profile"]
        all_value = similarity_rms(np.asarray(left["points"]), np.asarray(right["points"]))
        silhouette_value = similarity_rms(np.asarray(left["points"])[list(SILHOUETTE_POINTS)], np.asarray(right["points"])[list(SILHOUETTE_POINTS)])
        all_rms.append(all_value)
        silhouette_rms.append(silhouette_value)
        partition_pairs[str(left["partition"])].append(all_value)

    public_cases = [{key: value for key, value in item.items() if key not in {"subject", "points"}} for item in cases]
    by_view = {view: summarize([item for item in public_cases if item["view"] == view]) for view in sorted(PROFILE_VIEWS)}
    by_partition = {partition: summarize([item for item in public_cases if item["partition"] == partition]) for partition in sorted({str(item["partition"]) for item in public_cases})}
    overall = summarize(public_cases)
    detected_count = int(overall["detected"])
    silhouette_p95 = overall["forwardSilhouetteAbsoluteXErrorOverFaceWidth"]["p95"]
    crop_p95 = overall["cropSensitivityMedianPointShiftOverFaceDiagonal"]["p95"]
    gates = {
        "detectionAtLeast95Percent": detected_count / len(cases) >= 0.95,
        "finiteAtLeast99PercentOfDetected": int(overall["finite"]) / max(1, detected_count) >= 0.99,
        "looseBoundsAtLeast95PercentOfDetected": int(overall["allPointsWithinLooseCropBounds"]) / max(1, detected_count) >= 0.95,
        "noseDirectionAtLeast90PercentOfDetected": int(overall["noseTipOnExpectedForwardSide"]) / max(1, detected_count) >= 0.90,
        "silhouetteP95AtMost8PercentFaceWidth": silhouette_p95 is not None and float(silhouette_p95) <= 0.08,
        "cropSensitivityP95AtMost5PercentFaceDiagonal": crop_p95 is not None and float(crop_p95) <= 0.05,
    }
    result = {
        "testedAt": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
        "policyVersion": "HEADUP-OMZ-PROFILE-LANDMARK-AUDIT-1.0",
        "model": {
            "name": "facial-landmarks-35-adas-0002", "source": "Open Model Zoo 2023.0 FP32",
            "license": "Apache-2.0", "xmlSha256": sha256(model_xml), "binSha256": sha256(model_bin),
            "input": "1x3x60x60 BGR float32", "output": "35 normalized 2D landmarks",
        },
        "dataset": {"name": "Face Research Lab London Set", "subjects": 102, "profileImages": len(cases), "views": ["left_profile", "right_profile"]},
        "overall": overall, "byView": by_view, "byPartition": by_partition,
        "leftRightMirrorConsistency": {
            "completeSubjectPairs": len(all_rms),
            "all35SimilarityAlignedRms": distribution(all_rms),
            "fiveSilhouettePointsSimilarityAlignedRms": distribution(silhouette_rms),
            "all35ByPartition": {partition: distribution(values) for partition, values in sorted(partition_pairs.items())},
        },
        "predeclaredCandidateGates": gates,
        "candidatePassesAllGates": all(gates.values()),
        "interpretation": "Passing is necessary, not sufficient: the corpus has no manual profile-landmark ground truth. Failure of any gate rejects production integration; passing requires a separate annotated holdout before integration.",
        "retention": {"sourceImagesModified": False, "cropsOrOverlaysWritten": False, "individualPredictionsRetained": False, "identifiersRetained": False, "aggregateOnly": True},
    }
    Path(result_path).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"resultPath": str(result_path), "overall": overall, "leftRightMirrorConsistency": result["leftRightMirrorConsistency"], "gates": gates, "passes": result["candidatePassesAllGates"]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
