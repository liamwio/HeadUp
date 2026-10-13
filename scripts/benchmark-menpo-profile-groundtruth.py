"""Best-case landmark audit against Menpo's manually corrected 39-point profiles.

Candidate-to-ground-truth point mappings are selected only on the deterministic
engineering split and frozen before reporting holdout error. No filenames,
coordinates, images, or per-image predictions are written to the result.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import runpy
import sys
from collections import Counter
from pathlib import Path

import cv2
import numpy as np
import openvino as ov


HELPERS35 = runpy.run_path(str(Path(__file__).with_name("benchmark-omz-profile-landmarks.py")), run_name="headup_profile35_helpers")
HELPERS98 = runpy.run_path(str(Path(__file__).with_name("benchmark-omz-profile-landmarks98.py")), run_name="headup_profile98_helpers")
expanded_crop = HELPERS35["expanded_crop"]
infer35 = HELPERS35["infer_landmarks"]
infer98 = HELPERS98["infer"]
distribution = HELPERS35["distribution"]
sha256 = HELPERS35["sha256"]
CANDIDATES = {
    "omz35": {"indices": [4, 5, 10, 11, 26], "labels": ["nose_tip", "nasal_septum", "upper_lip", "lower_lip", "chin"]},
    "omz98": {"indices": [54, 79, 85, 16], "labels": ["nose_tip", "upper_lip", "lower_lip", "chin"]},
}


def parse_pts(path: Path) -> np.ndarray:
    lines = path.read_text(encoding="utf-8", errors="strict").splitlines()
    count_line = next((line for line in lines if line.strip().startswith("n_points")), None)
    if count_line is None:
        raise RuntimeError("PTS file is missing n_points")
    expected = int(count_line.split(":", 1)[1].strip())
    start, end = lines.index("{") + 1, lines.index("}")
    points = np.asarray([[float(value) - 1 for value in line.split()] for line in lines[start:end] if line.strip()], dtype=np.float32)
    if points.shape != (expected, 2):
        raise RuntimeError(f"PTS point count mismatch: {points.shape} vs {expected}")
    return points


def face_box(points: np.ndarray) -> np.ndarray:
    minimum, maximum = points.min(axis=0), points.max(axis=0)
    size = maximum - minimum
    return np.asarray([minimum[0], minimum[1], size[0], size[1]], dtype=np.float64)


def split_for(stem: str) -> str:
    return "engineering" if hashlib.sha256(stem.encode("utf-8")).digest()[0] < 205 else "holdout"


def main() -> None:
    if len(sys.argv) != 7:
        raise SystemExit("usage: benchmark.py MENPO_DIR MODEL35_XML MODEL35_BIN MODEL98_XML MODEL98_BIN RESULT_JSON")
    menpo_dir, model35_xml, model35_bin, model98_xml, model98_bin, result_path = map(Path, sys.argv[1:])
    profile_images: dict[tuple[str, str], Path] = {}
    for image_path in menpo_dir.rglob("*.jpg"):
        parts = {part.lower() for part in image_path.parts}
        orientation = "left" if "left" in parts else "right" if "right" in parts else None
        if "profile" in parts and orientation:
            profile_images[(orientation, image_path.stem)] = image_path
    profiles: list[tuple[Path, np.ndarray, str]] = []
    markup_counts: Counter[int] = Counter()
    for pts_path in sorted(menpo_dir.rglob("*.pts")):
        points = parse_pts(pts_path)
        markup_counts[len(points)] += 1
        if len(points) == 39:
            parts = {part.lower() for part in pts_path.parts}
            orientation = "left" if "left" in parts else "right" if "right" in parts else None
            image_path = profile_images.get((orientation or "", pts_path.stem))
            if image_path is None:
                raise RuntimeError("profile annotation has no matching image")
            profiles.append((image_path, points, orientation))
    if len(profiles) != 2290 or markup_counts[68] != 6655:
        raise RuntimeError(f"unexpected Menpo2D annotation counts; profiles={len(profiles)}, markups={dict(markup_counts)}")

    core = ov.Core()
    compiled35 = core.compile_model(core.read_model(model=str(model35_xml), weights=str(model35_bin)), "CPU")
    compiled98 = core.compile_model(core.read_model(model=str(model98_xml), weights=str(model98_bin)), "CPU")
    cases: list[dict[str, object]] = []
    for index, (image_path, ground_truth, orientation) in enumerate(profiles):
        image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
        if image is None:
            raise RuntimeError("unable to decode Menpo image")
        box = face_box(ground_truth)
        primary_crop, primary_box = expanded_crop(image, box, 1.25)
        perturbed_crop, perturbed_box = expanded_crop(image, box, 1.0)
        points35 = infer35(compiled35, primary_crop, primary_box)
        points35_perturbed = infer35(compiled35, perturbed_crop, perturbed_box)
        points98, _ = infer98(compiled98, primary_crop, primary_box)
        points98_perturbed, _ = infer98(compiled98, perturbed_crop, perturbed_box)
        diagonal = max(1.0, math.hypot(float(box[2]), float(box[3])))
        case: dict[str, object] = {"partition": split_for(f"{orientation}/{image_path.stem}"), "orientation": orientation, "groundTruth": ground_truth, "diagonal": diagonal}
        for name, points, perturbed in [("omz35", points35, points35_perturbed), ("omz98", points98, points98_perturbed)]:
            indices = CANDIDATES[name]["indices"]
            selected = points[indices]
            nearest = np.argmin(np.linalg.norm(selected[:, None, :] - ground_truth[None, :, :], axis=2), axis=1)
            case[name] = {
                "selected": selected,
                "nearest": nearest,
                "cropSensitivity": float(np.median(np.linalg.norm(selected - perturbed[indices], axis=1)) / diagonal),
            }
        cases.append(case)
        if (index + 1) % 250 == 0:
            print(f"Processed {index + 1}/{len(profiles)}", file=sys.stderr, flush=True)

    results: dict[str, object] = {}
    for name, definition in CANDIDATES.items():
        engineering = [case for case in cases if case["partition"] == "engineering"]
        holdout = [case for case in cases if case["partition"] == "holdout"]
        mappings: dict[str, list[int]] = {}
        mapping_stability: dict[str, list[float]] = {}
        for orientation in ("left", "right"):
            oriented = [case for case in engineering if case["orientation"] == orientation]
            mappings[orientation] = []
            mapping_stability[orientation] = []
            for local_index in range(len(definition["indices"])):
                counts = Counter(int(case[name]["nearest"][local_index]) for case in oriented)
                mapped_index, count = counts.most_common(1)[0]
                mappings[orientation].append(mapped_index)
                mapping_stability[orientation].append(count / len(oriented))

        def errors(items: list[dict[str, object]]) -> tuple[list[float], list[list[float]]]:
            image_rms: list[float] = []
            point_errors: list[list[float]] = [[] for _ in definition["indices"]]
            for case in items:
                predicted = np.asarray(case[name]["selected"])
                target = np.asarray(case["groundTruth"])[mappings[str(case["orientation"])]]
                normalized = np.linalg.norm(predicted - target, axis=1) / float(case["diagonal"])
                image_rms.append(float(np.sqrt(np.mean(normalized ** 2))))
                for point_index, value in enumerate(normalized):
                    point_errors[point_index].append(float(value))
            return image_rms, point_errors

        engineering_errors, _ = errors(engineering)
        holdout_errors, holdout_point_errors = errors(holdout)
        crop_sensitivity = [float(case[name]["cropSensitivity"]) for case in holdout]
        mapping_unique = all(len(set(values)) == len(values) for values in mappings.values())
        holdout_p95 = distribution(holdout_errors)["p95"]
        crop_p95 = distribution(crop_sensitivity)["p95"]
        gates = {
            "mappedGroundTruthIndicesAreUnique": mapping_unique,
            "everySemanticMappingStableOnAtLeast70PercentEngineering": min(value for values in mapping_stability.values() for value in values) >= 0.70,
            "holdoutMedianNmeAtMost3PercentBoundingBoxDiagonal": distribution(holdout_errors)["median"] <= 0.03,
            "holdoutP95NmeAtMost8PercentBoundingBoxDiagonal": holdout_p95 <= 0.08,
            "holdoutCropSensitivityP95AtMost5PercentBoundingBoxDiagonal": crop_p95 <= 0.05,
        }
        results[name] = {
            "candidatePointLabels": definition["labels"],
            "candidatePointIndices": definition["indices"],
            "engineeringImages": len(engineering), "holdoutImages": len(holdout),
            "engineeringSelectedGroundTruthIndicesByOrientation": mappings,
            "engineeringMappingStabilityByOrientation": {orientation: [round(value, 4) for value in values] for orientation, values in mapping_stability.items()},
            "engineeringMappedPointRmsNme": distribution(engineering_errors),
            "holdoutMappedPointRmsNme": distribution(holdout_errors),
            "holdoutPerPointNme": {label: distribution(values) for label, values in zip(definition["labels"], holdout_point_errors)},
            "holdoutCropSensitivity": distribution(crop_sensitivity),
            "predeclaredGates": gates, "passesAllGates": all(gates.values()),
        }

    result = {
        "testedAt": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
        "policyVersion": "HEADUP-MENPO-PROFILE-GROUNDTRUTH-1.0",
        "source": {
            "name": "Menpo2D fixed official archive, annotated training profiles", "profileImages": len(profiles),
            "profileLandmarks": 39, "annotation": "semi-automatic followed by manual correction",
            "license": "non-commercial research only", "archiveSha256": os.environ.get("HEADUP_MENPO_ARCHIVE_SHA256"),
        },
        "partition": {"method": "SHA-256 of source basename; first byte <205 is engineering", "engineering": sum(case["partition"] == "engineering" for case in cases), "holdout": sum(case["partition"] == "holdout" for case in cases)},
        "normalization": "RMS point error divided by diagonal of ground-truth landmark bounding box, matching Menpo reporting convention",
        "evaluation": "Best-case ground-truth crop. Candidate-to-39-point mappings selected only on engineering images, then frozen for holdout.",
        "models": {
            "omz35": {"xmlSha256": sha256(model35_xml), "binSha256": sha256(model35_bin)},
            "omz98": {"xmlSha256": sha256(model98_xml), "binSha256": sha256(model98_bin)},
        },
        "candidates": results,
        "candidatePassesForProduction": any(bool(value["passesAllGates"]) for value in results.values()),
        "interpretation": "This benchmark can reject a candidate. Passing would still require an identity-isolated product-camera holdout and anatomically matched profile landmarks before integration.",
        "retention": {"imagesRetained": False, "annotationsRetained": False, "archiveRetained": False, "individualPredictionsRetained": False, "identifiersRetained": False, "aggregateOnly": True},
    }
    Path(result_path).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"resultPath": str(result_path), "partition": result["partition"], "candidates": results, "passes": result["candidatePassesForProduction"]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
