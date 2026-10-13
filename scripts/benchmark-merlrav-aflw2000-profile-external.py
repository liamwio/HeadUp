"""Fresh-label profile pressure test for the retained Menpo39 research model.

MERL-RAV annotations stay in the original AFLW coordinate system while the
public 3DDFA transport contains 120x120 AFLW2000 crops.  This runner applies
the exact per-image ROI transform published by 3DDFA.  Only four anatomically
unambiguous points shared by the standard 68-point and native Menpo39 schemas
are gated.  Aggregate results are written; paths, identifiers, coordinates and
per-image predictions are never persisted.
"""

from __future__ import annotations

import datetime
import hashlib
import json
import math
import os
import re
import runpy
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
import torch


TRAIN = runpy.run_path(
    str(Path(__file__).with_name("train-menpo39-profile-landmarks.py")),
    run_name="headup_merlrav_external_helpers",
)
MobileNet39Heatmaps = TRAIN["MobileNet39Heatmaps"]
soft_argmax = TRAIN["soft_argmax"]
original_coordinates = TRAIN["original_coordinates"]
crop_transform = TRAIN["crop_transform"]
transform_points = TRAIN["transform_points"]
distribution = TRAIN["distribution"]
sha256 = TRAIN["sha256"]
IMAGE_SIZE = TRAIN["IMAGE_SIZE"]
PRIMARY_FACTOR = TRAIN["PRIMARY_FACTOR"]
PERTURBED_FACTOR = TRAIN["PERTURBED_FACTOR"]

POSES = ("frontal", "left", "lefthalf", "right", "righthalf")
TRUE_PROFILE_POSES = {"left", "right"}
HALF_PROFILE_POSES = {"lefthalf", "righthalf"}

# Fixed before inference from the published anatomical definitions.  Standard
# 68 point 33 is deliberately excluded from the gate because it cannot
# distinguish Menpo's columella (20) from subnasale (21).
STRICT_MAPPING = {
    "noseTip": {"menpo39": 19, "standard68": 30},
    "upperLip": {"menpo39": 27, "standard68": 51},
    "lowerLip": {"menpo39": 33, "standard68": 57},
    "menton": {"menpo39": 8, "standard68": 8},
}
AMBIGUOUS_NASAL_MAPPING = {
    "standard68Point33ToColumella": {"menpo39": 20, "standard68": 33},
    "standard68Point33ToSubnasale": {"menpo39": 21, "standard68": 33},
}


@dataclass
class Candidate:
    image_path: Path
    pose: str
    publisher_split: str
    points: np.ndarray
    visibility: np.ndarray
    diagonal: float
    strict_visible: int
    visible_in_crop: int
    bbox_area: float
    registration_residual: float
    registration_scale: float
    registration_rotation: float
    annotation_stem: str
    base_stem: str


def parse_pts(path: Path) -> tuple[np.ndarray, np.ndarray]:
    rows: list[tuple[float, float]] = []
    inside = False
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if line == "{":
            inside = True
            continue
        if line == "}":
            break
        if inside and line:
            pieces = line.split()
            if len(pieces) != 2:
                raise RuntimeError("invalid MERL-RAV point row")
            rows.append((float(pieces[0]), float(pieces[1])))
    if len(rows) != 68:
        raise RuntimeError(f"unexpected MERL-RAV point count: {len(rows)}")
    raw = np.asarray(rows, dtype=np.float64)
    self_occluded = np.logical_and(raw[:, 0] == -1.0, raw[:, 1] == -1.0)
    external = np.logical_and(raw[:, 0] < 0.0, raw[:, 1] < 0.0) & ~self_occluded
    unoccluded = np.logical_and(raw[:, 0] > 0.0, raw[:, 1] > 0.0)
    if not np.all(self_occluded | external | unoccluded):
        raise RuntimeError("mixed-sign or zero MERL-RAV coordinate")
    points = np.abs(raw)
    points[self_occluded] = np.nan
    visibility = np.full(68, "self", dtype="<U10")
    visibility[external] = "external"
    visibility[unoccluded] = "visible"
    return points, visibility


def transformed_points(points: np.ndarray, roi: np.ndarray) -> np.ndarray:
    sx, sy, ex, ey = [float(value) for value in roi]
    if ex <= sx or ey <= sy:
        raise RuntimeError("invalid 3DDFA ROI")
    transformed = points.copy()
    transformed[:, 0] = (transformed[:, 0] - sx) / (ex - sx) * 120.0
    transformed[:, 1] = (transformed[:, 1] - sy) / (ey - sy) * 120.0
    return transformed


def similarity_register(source: np.ndarray, target: np.ndarray) -> tuple[np.ndarray, float, float, np.ndarray]:
    """Positive-determinant similarity registration; reflection is forbidden."""
    source_centered = source - np.mean(source, axis=0)
    target_centered = target - np.mean(target, axis=0)
    u, singular, vt = np.linalg.svd(source_centered.T @ target_centered)
    rotation = u @ vt
    if float(np.linalg.det(rotation)) < 0.0:
        u[:, -1] *= -1.0
        rotation = u @ vt
    denominator = float(np.sum(np.square(source_centered)))
    if denominator <= 1e-8:
        raise RuntimeError("degenerate coordinate registration")
    scale = float(np.sum(singular) / denominator)
    translation = np.mean(target, axis=0) - scale * np.mean(source, axis=0) @ rotation
    angle = math.degrees(math.atan2(float(rotation[0, 1]), float(rotation[0, 0])))
    return rotation, scale, angle, translation


def bbox_stats(points: np.ndarray) -> tuple[float, float]:
    minimum = np.nanmin(points, axis=0)
    maximum = np.nanmax(points, axis=0)
    width, height = maximum - minimum
    return max(1.0, math.hypot(float(width), float(height))), max(0.0, float(width * height))


def load_candidates(
    image_dir: Path, crop_list_path: Path, roi_path: Path, reference_path: Path, labels_root: Path
) -> tuple[list[Candidate], dict[str, object]]:
    names = [line.strip() for line in crop_list_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    if len(names) != 2_000 or len(set(names)) != 2_000:
        raise RuntimeError("unexpected AFLW2000 crop list")
    rois = np.load(roi_path, allow_pickle=False)
    if rois.shape != (2_000, 4) or rois.dtype != np.float32:
        raise RuntimeError(f"unexpected 3DDFA ROI tensor: {rois.shape}, {rois.dtype}")
    reference = np.load(reference_path, allow_pickle=False)
    if reference.shape != (2_000, 2, 68) or reference.dtype != np.float32:
        raise RuntimeError(f"unexpected 3DDFA reference tensor: {reference.shape}, {reference.dtype}")
    index_by_stem = {Path(name).stem: index for index, name in enumerate(names)}
    missing_images = [name for name in names if not (image_dir / name).is_file()]
    if missing_images:
        raise RuntimeError(f"AFLW2000 crops missing: {len(missing_images)}")

    overlap = Counter()
    exclusions = Counter()
    visibility_counts = Counter()
    registration_by_pose: dict[str, list[float]] = defaultdict(list)
    registration_scales: list[float] = []
    registration_rotations: list[float] = []
    candidates: list[Candidate] = []
    for path in sorted(labels_root.rglob("*.pts")):
        match = re.search(
            r"merl_rav_labels[\\/](frontal|left|lefthalf|right|righthalf)[\\/]"
            r"(trainset|testset)[\\/]labels[\\/](image\d+)(?:_\d+)?\.pts$",
            str(path),
            flags=re.IGNORECASE,
        )
        if not match:
            raise RuntimeError("unexpected MERL-RAV label path")
        pose, split, base_stem = match.group(1).lower(), match.group(2).lower(), match.group(3)
        overlap[(pose, split, "labels")] += 1
        if base_stem not in index_by_stem:
            continue
        overlap[(pose, split, "overlap")] += 1
        points, visibility = parse_pts(path)
        image_index = index_by_stem[base_stem]
        reference_points = reference[image_index].T.astype(np.float64)
        visible_for_registration = visibility == "visible"
        if int(visible_for_registration.sum()) < 10:
            exclusions["fewerThan10VisibleLandmarksForRegistration"] += 1
            continue
        rotation, scale, angle, translation = similarity_register(
            points[visible_for_registration], reference_points[visible_for_registration]
        )
        registered = points.copy()
        locatable = visibility != "self"
        registered[locatable] = scale * registered[locatable] @ rotation + translation
        reference_diagonal, _ = bbox_stats(reference_points)
        registration_residual = float(np.median(np.linalg.norm(
            registered[visible_for_registration] - reference_points[visible_for_registration], axis=1
        )) / reference_diagonal)
        registration_by_pose[pose].append(registration_residual)
        registration_scales.append(scale)
        registration_rotations.append(angle)
        # This is a coordinate-frame sanity gate, not an accuracy threshold.
        # It is independent of the Menpo39 model prediction.
        if registration_residual > 0.05:
            exclusions["similarityRegistrationMedianResidualAbove5Percent"] += 1
            continue
        points = transformed_points(registered, rois[image_index])
        visibility_counts.update(visibility.tolist())
        visible_mask = visibility == "visible"
        in_crop = visible_mask & np.all((points >= 0.0) & (points <= 119.0), axis=1)
        strict_indices = [item["standard68"] for item in STRICT_MAPPING.values()]
        strict_visible = sum(bool(in_crop[index]) for index in strict_indices)
        if int(in_crop.sum()) < 10:
            exclusions["fewerThan10VisibleLandmarksInsideCrop"] += 1
            continue
        if strict_visible < 3:
            exclusions["fewerThan3StrictAnchorsVisibleInsideCrop"] += 1
            continue
        diagonal, area = bbox_stats(points[in_crop])
        if diagonal < 20.0:
            exclusions["visibleFaceDiagonalBelow20Pixels"] += 1
            continue
        candidates.append(Candidate(
            image_path=image_dir / f"{base_stem}.jpg",
            pose=pose,
            publisher_split=split,
            points=points,
            visibility=visibility,
            diagonal=diagonal,
            strict_visible=strict_visible,
            visible_in_crop=int(in_crop.sum()),
            bbox_area=area,
            registration_residual=registration_residual,
            registration_scale=scale,
            registration_rotation=angle,
            annotation_stem=path.stem,
            base_stem=base_stem,
        ))

    # AFLW2000 publishes one crop per base image.  For the rare multi-face
    # labels, match the crop using ground-truth coverage only, never prediction.
    grouped: dict[str, list[Candidate]] = defaultdict(list)
    for candidate in candidates:
        grouped[candidate.base_stem].append(candidate)
    selected: list[Candidate] = []
    multiple_eligible = 0
    for items in grouped.values():
        if len(items) > 1:
            multiple_eligible += 1
        selected.append(max(
            items,
            key=lambda item: (
                -item.registration_residual,
                item.strict_visible,
                item.visible_in_crop,
                item.bbox_area,
                hashlib.sha256(item.annotation_stem.encode("utf-8")).digest(),
            ),
        ))
    selected.sort(key=lambda item: hashlib.sha256(item.annotation_stem.encode("utf-8")).digest())
    audit = {
        "aflw2000CropImages": len(names),
        "merlLabels": sum(value for key, value in overlap.items() if key[2] == "labels"),
        "overlapLabels": sum(value for key, value in overlap.items() if key[2] == "overlap"),
        "eligibleBeforeOneFaceMatching": len(candidates),
        "selectedUniqueCrops": len(selected),
        "baseImagesWithMultipleEligibleLabels": multiple_eligible,
        "exclusions": dict(exclusions),
        "visibilityAcrossOverlap": dict(visibility_counts),
        "similarityRegistration": {
            "definition": (
                "positive-determinant scale/rotation/translation fit from visible MERL 68 points to the same-name "
                "3DDFA reannotated 68-point frame; no reflection and no model prediction"
            ),
            "maximumMedianResidualForCoordinatePairing": 0.05,
            "medianResidualByPose": {
                pose: rounded_distribution(values) for pose, values in registration_by_pose.items()
            },
            "scale": rounded_distribution(registration_scales),
            "rotationDegrees": rounded_distribution(registration_rotations),
        },
        "overlapByPoseAndPublisherSplit": {
            pose: {
                split: {
                    "labels": overlap[(pose, split, "labels")],
                    "overlap": overlap[(pose, split, "overlap")],
                }
                for split in ("trainset", "testset")
            }
            for pose in POSES
        },
        "eligibleByPose": dict(Counter(item.pose for item in selected)),
        "eligibleByPublisherSplit": dict(Counter(item.publisher_split for item in selected)),
    }
    return selected, audit


def input_tensor(image: np.ndarray, points: np.ndarray, factor: float) -> tuple[torch.Tensor, np.ndarray]:
    matrix, inverse = crop_transform(points, factor, 0.0, 0.0, 0.0)
    crop = cv2.warpAffine(
        image, matrix, (IMAGE_SIZE, IMAGE_SIZE), flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_REFLECT_101,
    )
    rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
    tensor = torch.from_numpy(rgb.transpose(2, 0, 1))
    mean = torch.tensor([0.485, 0.456, 0.406], dtype=torch.float32)[:, None, None]
    std = torch.tensor([0.229, 0.224, 0.225], dtype=torch.float32)[:, None, None]
    return (tensor - mean) / std, inverse.astype(np.float32)


def infer(model: torch.nn.Module, candidate: Candidate, factor: float) -> np.ndarray:
    image = cv2.imread(str(candidate.image_path), cv2.IMREAD_COLOR)
    if image is None or image.shape[:2] != (120, 120):
        raise RuntimeError("unexpected AFLW2000 crop image")
    usable = candidate.points[
        (candidate.visibility != "self")
        & np.all((candidate.points >= -12.0) & (candidate.points <= 131.0), axis=1)
    ]
    if len(usable) < 10:
        raise RuntimeError("candidate lost usable crop landmarks")
    tensor, inverse = input_tensor(image, usable, factor)
    with torch.inference_mode():
        normalized = soft_argmax(model(tensor[None]))
        prediction = original_coordinates(normalized, torch.from_numpy(inverse[None]))
    return prediction[0].cpu().numpy().astype(np.float64)


def percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    return float(np.quantile(np.asarray(values, dtype=np.float64), fraction, method="nearest"))


def rounded_distribution(values: list[float]) -> dict[str, float | None]:
    if not values:
        return {key: None for key in ("min", "p05", "median", "mean", "p95", "max")}
    return distribution(values)


def summarize(cases: list[dict[str, object]]) -> dict[str, object]:
    image_rms = [float(case["rms"]) for case in cases]
    point_values: dict[str, list[float]] = {name: [] for name in STRICT_MAPPING}
    ambiguous: dict[str, list[float]] = {name: [] for name in AMBIGUOUS_NASAL_MAPPING}
    crop = []
    directions: dict[str, list[bool]] = {"left": [], "right": []}
    for case in cases:
        for name, value in case["points"].items():
            point_values[name].append(float(value))
        for name, value in case["ambiguous"].items():
            ambiguous[name].append(float(value))
        crop.append(float(case["cropSensitivity"]))
        if case["directionCorrect"] is not None and case["pose"] in directions:
            directions[str(case["pose"])].append(bool(case["directionCorrect"]))
    return {
        "images": len(cases),
        "mappedPointRmsNme": rounded_distribution(image_rms),
        "perPointNme": {
            name: {"valid": len(values), "distribution": rounded_distribution(values)}
            for name, values in point_values.items()
        },
        "ambiguousNasalPointDiagnostic": {
            name: {"valid": len(values), "distribution": rounded_distribution(values)}
            for name, values in ambiguous.items()
        },
        "cropSensitivityMedianStrictPointNme": rounded_distribution(crop),
        "direction": {
            pose: {
                "correct": sum(values),
                "total": len(values),
                "accuracy": round(sum(values) / len(values), 4) if values else None,
            }
            for pose, values in directions.items()
        },
    }


def main() -> None:
    if len(sys.argv) != 9:
        raise SystemExit(
            "usage: benchmark.py IMAGE_DIR CROP_LIST ROI_NPY REFERENCE_NPY LABELS_ROOT MODEL RESULT_JSON SOURCE_JSON"
        )
    image_dir, crop_list, roi_path, reference_path, labels_root, model_path, result_path, source_json = map(Path, sys.argv[1:])
    source = json.loads(source_json.read_text(encoding="utf-8"))
    torch.set_num_threads(min(8, os.cpu_count() or 1))
    torch.set_num_interop_threads(1)
    candidates, overlap_audit = load_candidates(image_dir, crop_list, roi_path, reference_path, labels_root)
    checkpoint = torch.load(model_path, map_location="cpu", weights_only=False)
    if checkpoint.get("landmarkCount") != 39 or checkpoint.get("researchOnly") is not True:
        raise RuntimeError("unexpected retained research checkpoint")
    model = MobileNet39Heatmaps(pretrained=False)
    model.load_state_dict(checkpoint["stateDict"])
    model.eval()

    evaluated: list[dict[str, object]] = []
    for index, candidate in enumerate(candidates):
        primary = infer(model, candidate, PRIMARY_FACTOR)
        perturbed = infer(model, candidate, PERTURBED_FACTOR)
        strict_errors: dict[str, float] = {}
        strict_crop: list[float] = []
        for name, mapping in STRICT_MAPPING.items():
            gt_index, predicted_index = mapping["standard68"], mapping["menpo39"]
            truth = candidate.points[gt_index]
            if candidate.visibility[gt_index] != "visible" or not np.all((truth >= 0.0) & (truth <= 119.0)):
                continue
            strict_errors[name] = float(np.linalg.norm(primary[predicted_index] - truth) / candidate.diagonal)
            strict_crop.append(float(np.linalg.norm(primary[predicted_index] - perturbed[predicted_index]) / candidate.diagonal))
        if len(strict_errors) < 3:
            continue
        ambiguous_errors: dict[str, float] = {}
        for name, mapping in AMBIGUOUS_NASAL_MAPPING.items():
            gt_index, predicted_index = mapping["standard68"], mapping["menpo39"]
            truth = candidate.points[gt_index]
            if candidate.visibility[gt_index] == "visible" and np.all((truth >= 0.0) & (truth <= 119.0)):
                ambiguous_errors[name] = float(np.linalg.norm(primary[predicted_index] - truth) / candidate.diagonal)
        direction = None
        if "noseTip" in strict_errors and "menton" in strict_errors:
            predicted_sign = np.sign(primary[19, 0] - primary[8, 0])
            target_sign = np.sign(candidate.points[30, 0] - candidate.points[8, 0])
            direction = bool(predicted_sign != 0 and predicted_sign == target_sign)
        evaluated.append({
            "pose": candidate.pose,
            "publisherSplit": candidate.publisher_split,
            "points": strict_errors,
            "ambiguous": ambiguous_errors,
            "rms": float(np.sqrt(np.mean(np.square(list(strict_errors.values()))))),
            "cropSensitivity": float(np.median(strict_crop)),
            "directionCorrect": direction,
        })
        if (index + 1) % 100 == 0:
            print(f"Processed {index + 1}/{len(candidates)} aggregate-only cases", file=sys.stderr, flush=True)

    true_profile = [case for case in evaluated if case["pose"] in TRUE_PROFILE_POSES]
    half_profile = [case for case in evaluated if case["pose"] in HALF_PROFILE_POSES]
    frontal = [case for case in evaluated if case["pose"] == "frontal"]
    true_summary = summarize(true_profile)
    per_pose = {pose: summarize([case for case in evaluated if case["pose"] == pose]) for pose in POSES}
    per_split = {
        split: summarize([case for case in true_profile if case["publisherSplit"] == split])
        for split in ("trainset", "testset")
    }
    primary = true_summary["mappedPointRmsNme"]
    per_point = true_summary["perPointNme"]
    direction = true_summary["direction"]
    gates = {
        "atLeast100EligibleTrueProfileImages": len(true_profile) >= 100,
        "trueProfileMedianMappedRmsNmeAtMost3Percent": primary["median"] is not None and primary["median"] <= 0.03,
        "trueProfileP95MappedRmsNmeAtMost8Percent": primary["p95"] is not None and primary["p95"] <= 0.08,
        "everyStrictPointMedianNmeAtMost3Percent": all(
            item["valid"] >= 100 and item["distribution"]["median"] <= 0.03 for item in per_point.values()
        ),
        "everyStrictPointP95NmeAtMost8Percent": all(
            item["valid"] >= 100 and item["distribution"]["p95"] <= 0.08 for item in per_point.values()
        ),
        "trueProfileCropSensitivityP95AtMost5Percent": (
            true_summary["cropSensitivityMedianStrictPointNme"]["p95"] is not None
            and true_summary["cropSensitivityMedianStrictPointNme"]["p95"] <= 0.05
        ),
        "eachTrueProfileDirectionAccuracyAtLeast95Percent": all(
            direction[pose]["total"] >= 30 and direction[pose]["accuracy"] >= 0.95
            for pose in ("left", "right")
        ),
    }
    coordinate_gate_pass = all(gates.values())
    result = {
        "testedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "policyVersion": "HEADUP-MERLRAV-AFLW2000-MENPO39-EXTERNAL-1.1",
        "source": source,
        "coordinateSystem": {
            "image": "3DDFA author-published 120x120 AFLW2000-3D crop",
            "annotation": "MERL-RAV professional manual labels in original AFLW coordinates",
            "transform": "x_crop=(x_original-sx)/(ex-sx)*120 and y equivalent, using the exact per-image 3DDFA ROI tensor",
            "roiSha256": sha256(roi_path),
            "registrationReferenceSha256": sha256(reference_path),
            "roiShape": [2000, 4],
            "registrationReferenceShape": [2000, 2, 68],
            "coordinateRegistration": (
                "MERL distributes labels against AFLW image variants whose pixel frames differ from the 3DDFA "
                "AFLW2000 crop source. Each face is therefore similarity-registered to the same-name published "
                "3DDFA 68-point frame before the exact ROI transform is applied."
            ),
        },
        "correctionLineage": {
            "invalidDirectCoordinateAttempt": {
                "status": "superseded_coordinate_pairing_failure_not_algorithm_result",
                "reason": (
                    "Same-name MERL and 3DDFA images use different pixel frames. Directly applying the 3DDFA ROI "
                    "to MERL coordinates produced an invalid 119-image profile subset."
                ),
                "observedMappedRmsMedian": 0.3439,
                "observedMappedRmsP95": 0.6916,
                "observedDirectionAccuracy": {"left": 0.6829, "right": 0.675},
                "consequence": "Never counted as model accuracy; replaced by prediction-independent coordinate registration.",
            },
        },
        "overlapAndEligibility": overlap_audit,
        "model": {
            "name": "retained Menpo39 MobileNetV3-Small research candidate V1",
            "architecture": checkpoint.get("architecture"),
            "sha256": sha256(model_path),
            "trainingData": checkpoint.get("trainingData"),
            "researchOnly": True,
        },
        "predeclaredMapping": {
            "strictFourPointMapping": STRICT_MAPPING,
            "ambiguousNasalDiagnosticOnly": AMBIGUOUS_NASAL_MAPPING,
            "reasonStandard68Point33ExcludedFromGate": (
                "Standard 68 point 33 cannot independently identify Menpo columella 20 and subnasale 21."
            ),
            "selection": "Anatomical definitions fixed before inference; no coordinate or candidate-index search.",
        },
        "evaluation": {
            "trueProfileDefinition": "MERL-RAV left or right partition",
            "halfProfileDefinition": "MERL-RAV lefthalf or righthalf partition",
            "primaryNormalization": "point distance divided by diagonal of visible in-crop MERL landmark box",
            "primaryVisibility": "unoccluded landmarks only; external occlusion and self-occlusion excluded",
            "minimumCaseCoverage": "at least 10 visible in-crop landmarks and at least 3/4 strict anchors",
            "oneFaceMatching": "ground-truth crop coverage only; predictions never used",
            "coordinateRegistration": (
                "Best-case per-face similarity registration from manual visible 68-point labels to the author-published "
                "AFLW2000 coordinate frame; registration residual must be at most 5%."
            ),
            "cropFactors": {"primary": PRIMARY_FACTOR, "perturbed": PERTURBED_FACTOR},
            "noTuning": True,
            "freshness": (
                "The AFLW2000 pixels were previously used for pose diagnostics, but MERL-RAV manual geometry labels "
                "were not used to train, select, calibrate or tune this Menpo39 model."
            ),
            "bestCaseWarning": (
                "Per-face ground-truth registration isolates landmark localization and cannot validate detection, "
                "full-image cropping, or product capture behavior."
            ),
        },
        "evaluated": {
            "all": len(evaluated),
            "trueProfile": len(true_profile),
            "halfProfile": len(half_profile),
            "frontalContext": len(frontal),
        },
        "trueProfile": true_summary,
        "trueProfileByPublisherSplit": per_split,
        "byPose": per_pose,
        "predeclaredGates": gates,
        "passesSharedAnchorCoordinateGates": coordinate_gate_pass,
        "productionDecision": "research_support_only" if coordinate_gate_pass else "reject",
        "requirementCoverage": {
            "strictSharedPoints": 4,
            "requiredNativeProfilePoints": 10,
            "requiredSourceMeasurements": 8,
            "measurementsValidatedByThisRun": 0,
            "neckTangentAvailable": False,
            "v12Evaluated": False,
            "productionProfileCandidateValidated": False,
            "limitation": (
                "Even a coordinate-gate pass would support only four shared anchors. It cannot validate distinct "
                "columella/subnasale, mentolabial fold, soft-tissue pogonion, jaw contour, neck tangent, any of the "
                "eight requested measurements, or the unretained V12 experiment."
            ),
        },
        "retention": {
            "imagesRetained": False,
            "annotationsRetained": False,
            "archivesRetained": False,
            "individualPredictionsRetained": False,
            "identifiersRetained": False,
            "aggregateOnly": True,
        },
    }
    result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "resultPath": str(result_path),
        "overlap": overlap_audit,
        "evaluated": result["evaluated"],
        "trueProfile": true_summary,
        "gates": gates,
        "passes": coordinate_gate_pass,
        "decision": result["productionDecision"],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
