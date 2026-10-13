"""Audit the menton coordinate contract across MERL, 3DDFA and Menpo39 V1.

Each evaluated landmark is excluded from its own similarity registration so a
point-specific disagreement cannot be hidden by the registration fit.  The
three published coordinate layers are compared on the same transient image;
only aggregate distributions and an attribution decision are retained.
"""

from __future__ import annotations

import datetime
import json
import math
import os
import re
import runpy
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
import torch


BASE = runpy.run_path(
    str(Path(__file__).with_name("benchmark-merlrav-aflw2000-profile-external.py")),
    run_name="headup_merlrav_menton_contract_helpers",
)
MobileNet39Heatmaps = BASE["MobileNet39Heatmaps"]
load_candidates = BASE["load_candidates"]
parse_pts = BASE["parse_pts"]
similarity_register = BASE["similarity_register"]
transformed_points = BASE["transformed_points"]
bbox_stats = BASE["bbox_stats"]
infer = BASE["infer"]
distribution = BASE["distribution"]
sha256 = BASE["sha256"]
STRICT_MAPPING = BASE["STRICT_MAPPING"]
PRIMARY_FACTOR = BASE["PRIMARY_FACTOR"]
TRUE_PROFILE_POSES = BASE["TRUE_PROFILE_POSES"]


def locate_labels(labels_root: Path) -> dict[tuple[str, str, str], Path]:
    located = {}
    for path in labels_root.rglob("*.pts"):
        match = re.search(
            r"merl_rav_labels[\\/](frontal|left|lefthalf|right|righthalf)[\\/]"
            r"(trainset|testset)[\\/]labels[\\/](image\d+(?:_\d+)?)\.pts$",
            str(path),
            flags=re.IGNORECASE,
        )
        if not match:
            raise RuntimeError("unexpected MERL label path")
        located[(match.group(1).lower(), match.group(2).lower(), match.group(3))] = path
    return located


def leave_one_out_point(
    raw_points: np.ndarray,
    visibility: np.ndarray,
    reference_points: np.ndarray,
    roi: np.ndarray,
    excluded_index: int,
) -> np.ndarray:
    registration = visibility == "visible"
    registration[excluded_index] = False
    if int(registration.sum()) < 10:
        raise RuntimeError("insufficient leave-one-out registration anchors")
    rotation, scale, _angle, translation = similarity_register(
        raw_points[registration], reference_points[registration]
    )
    registered = raw_points.copy()
    locatable = visibility != "self"
    registered[locatable] = scale * registered[locatable] @ rotation + translation
    return transformed_points(registered, roi)[excluded_index]


def rounded(values: list[float]) -> dict[str, float | None]:
    return distribution(values) if values else {
        "min": None, "p05": None, "median": None, "mean": None, "p95": None, "max": None,
    }


def empty_bucket() -> dict[str, list[float]]:
    return {
        "merlAllAnchorToReferenceNme": [],
        "merlLeaveOneOutToReferenceNme": [],
        "modelToMerlAllAnchorNme": [],
        "modelToMerlLeaveOneOutNme": [],
        "modelToReferenceNme": [],
        "registrationInclusionShiftNme": [],
        "leaveOneOutForwardOffsetNme": [],
        "leaveOneOutVerticalOffsetNme": [],
        "modelToReferenceForwardOffsetNme": [],
        "modelToReferenceVerticalOffsetNme": [],
        "modelToMerlLeaveOneOutForwardOffsetNme": [],
        "modelToMerlLeaveOneOutVerticalOffsetNme": [],
    }


def summarize(bucket: dict[str, list[float]]) -> dict[str, object]:
    return {
        "valid": len(bucket["merlLeaveOneOutToReferenceNme"]),
        **{name: rounded(values) for name, values in bucket.items()},
    }


def point_gate(summary: dict[str, object], field: str) -> bool:
    values = summary[field]
    return summary["valid"] >= 50 and values["median"] <= 0.03 and values["p95"] <= 0.08


def main() -> None:
    if len(sys.argv) != 9:
        raise SystemExit(
            "usage: audit.py IMAGE_DIR CROP_LIST ROI_NPY REFERENCE_NPY LABELS_ROOT V1_MODEL RESULT_JSON SOURCE_JSON"
        )
    image_dir, crop_list_path, roi_path, reference_path, labels_root, model_path, result_path, source_path = map(
        Path, sys.argv[1:]
    )
    source = json.loads(source_path.read_text(encoding="utf-8"))
    torch.set_num_threads(min(8, os.cpu_count() or 1))
    torch.set_num_interop_threads(1)

    candidates, eligibility = load_candidates(
        image_dir, crop_list_path, roi_path, reference_path, labels_root
    )
    names = [line.strip() for line in crop_list_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    index_by_stem = {Path(name).stem: index for index, name in enumerate(names)}
    rois = np.load(roi_path, allow_pickle=False)
    references = np.load(reference_path, allow_pickle=False)
    label_paths = locate_labels(labels_root)

    checkpoint = torch.load(model_path, map_location="cpu", weights_only=False)
    if checkpoint.get("landmarkCount") != 39 or checkpoint.get("researchOnly") is not True:
        raise RuntimeError("unexpected Menpo39 V1 checkpoint")
    model = MobileNet39Heatmaps(pretrained=False)
    model.load_state_dict(checkpoint["stateDict"])
    model.eval()

    overall = {name: empty_bucket() for name in STRICT_MAPPING}
    by_pose = {
        pose: {name: empty_bucket() for name in STRICT_MAPPING} for pose in ("left", "right")
    }
    by_split = {
        split: {name: empty_bucket() for name in STRICT_MAPPING} for split in ("trainset", "testset")
    }
    true_profile_images = 0
    evaluated_per_point = defaultdict(int)
    for candidate in candidates:
        if candidate.pose not in TRUE_PROFILE_POSES:
            continue
        image_index = index_by_stem[candidate.base_stem]
        reference_original = references[image_index].T.astype(np.float64)
        reference_crop = transformed_points(reference_original, rois[image_index])
        label_path = label_paths[(candidate.pose, candidate.publisher_split, candidate.annotation_stem)]
        raw_points, visibility = parse_pts(label_path)
        prediction = infer(model, candidate, PRIMARY_FACTOR)
        reference_diagonal, _ = bbox_stats(reference_crop)
        normalization = max(candidate.diagonal, reference_diagonal, 1.0)
        facing_sign = float(np.sign(reference_crop[30, 0] - reference_crop[8, 0]))
        if facing_sign == 0.0:
            facing_sign = 1.0 if candidate.pose == "right" else -1.0
        any_evaluated = False
        for name, mapping in STRICT_MAPPING.items():
            standard_index = mapping["standard68"]
            model_index = mapping["menpo39"]
            if visibility[standard_index] != "visible":
                continue
            merl_all = candidate.points[standard_index]
            reference = reference_crop[standard_index]
            if not np.all((merl_all >= 0.0) & (merl_all <= 119.0)):
                continue
            if not np.all((reference >= -12.0) & (reference <= 131.0)):
                continue
            merl_loo = leave_one_out_point(
                raw_points, visibility, reference_original, rois[image_index], standard_index
            )
            predicted = prediction[model_index]
            delta = merl_loo - reference
            model_reference_delta = predicted - reference
            model_merl_delta = predicted - merl_loo
            values = {
                "merlAllAnchorToReferenceNme": float(np.linalg.norm(merl_all - reference) / normalization),
                "merlLeaveOneOutToReferenceNme": float(np.linalg.norm(delta) / normalization),
                "modelToMerlAllAnchorNme": float(np.linalg.norm(predicted - merl_all) / normalization),
                "modelToMerlLeaveOneOutNme": float(np.linalg.norm(predicted - merl_loo) / normalization),
                "modelToReferenceNme": float(np.linalg.norm(predicted - reference) / normalization),
                "registrationInclusionShiftNme": float(np.linalg.norm(merl_all - merl_loo) / normalization),
                "leaveOneOutForwardOffsetNme": float(delta[0] * facing_sign / normalization),
                "leaveOneOutVerticalOffsetNme": float(delta[1] / normalization),
                "modelToReferenceForwardOffsetNme": float(
                    model_reference_delta[0] * facing_sign / normalization
                ),
                "modelToReferenceVerticalOffsetNme": float(model_reference_delta[1] / normalization),
                "modelToMerlLeaveOneOutForwardOffsetNme": float(
                    model_merl_delta[0] * facing_sign / normalization
                ),
                "modelToMerlLeaveOneOutVerticalOffsetNme": float(model_merl_delta[1] / normalization),
            }
            for bucket in (overall[name], by_pose[candidate.pose][name], by_split[candidate.publisher_split][name]):
                for metric, value in values.items():
                    bucket[metric].append(value)
            evaluated_per_point[name] += 1
            any_evaluated = True
        if any_evaluated:
            true_profile_images += 1

    overall_summary = {name: summarize(bucket) for name, bucket in overall.items()}
    pose_summary = {
        pose: {name: summarize(bucket) for name, bucket in points.items()}
        for pose, points in by_pose.items()
    }
    split_summary = {
        split: {name: summarize(bucket) for name, bucket in points.items()}
        for split, points in by_split.items()
    }
    menton = overall_summary["menton"]
    target_contract_pass = point_gate(menton, "merlLeaveOneOutToReferenceNme")
    model_reference_pass = point_gate(menton, "modelToReferenceNme")
    model_merl_pass = point_gate(menton, "modelToMerlLeaveOneOutNme")
    negative_controls_pass = all(
        point_gate(overall_summary[name], "merlLeaveOneOutToReferenceNme")
        for name in ("noseTip", "upperLip", "lowerLip")
    )
    if not target_contract_pass and model_reference_pass:
        attribution = "merl_to_3ddfa_menton_coordinate_contract_conflict"
    elif target_contract_pass and not model_reference_pass:
        attribution = "menpo39_model_domain_shift"
    elif not target_contract_pass and not model_reference_pass:
        attribution = "mixed_target_contract_and_model_domain_shift"
    else:
        attribution = "no_menton_conflict_reproduced"
    gates = {
        "atLeast300TrueProfileImages": true_profile_images >= 300,
        "publisherTestHasAtLeast50MentonCases": split_summary["testset"]["menton"]["valid"] >= 50,
        "negativeControlSharedPointsMeet3And8PercentTargetAgreement": negative_controls_pass,
        "mentonLeaveOneOutTargetAgreementMeets3And8Percent": target_contract_pass,
        "v1MentonTo3DDFAReferenceMeets3And8Percent": model_reference_pass,
        "v1MentonToMERLLeaveOneOutMeets3And8Percent": model_merl_pass,
        "mentonRegistrationInclusionShiftMedianAtMost1Percent": (
            menton["registrationInclusionShiftNme"]["median"] <= 0.01
        ),
    }
    result = {
        "testedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "policyVersion": "HEADUP-MERLRAV-MENTON-COORDINATE-CONTRACT-1.0",
        "source": source,
        "sourceHashes": {
            "roiSha256": sha256(roi_path),
            "registrationReferenceSha256": sha256(reference_path),
            "v1ModelSha256": sha256(model_path),
        },
        "eligibility": eligibility,
        "protocol": {
            "evaluatedPoses": ["left", "right"],
            "registration": "positive-determinant similarity fit using visible MERL points, with the evaluated point excluded from its own fit",
            "normalization": "maximum of visible MERL and full 3DDFA-reference face-box diagonals in the shared 120x120 crop",
            "signedForward": "positive means MERL leave-one-out target lies farther toward the face-facing direction than the 3DDFA reference",
            "signedVertical": "positive means MERL leave-one-out target lies lower in image coordinates than the 3DDFA reference",
            "modelSignedOffsets": "same axes; positive forward is toward the face-facing direction and positive vertical is lower in image coordinates",
            "predictionRole": "retained Menpo39 V1 is diagnostic only; no training, mapping search or threshold selection",
            "referenceLimitation": "3DDFA reannotated 68 points are fitted/reannotated transport coordinates, not an independent manual clinical gold standard",
        },
        "sample": {
            "trueProfileImages": true_profile_images,
            "validByPoint": dict(evaluated_per_point),
        },
        "overall": overall_summary,
        "byPose": pose_summary,
        "byPublisherSplit": split_summary,
        "predeclaredDiagnosticGates": gates,
        "attribution": {
            "decision": attribution,
            "targetContractPass": target_contract_pass,
            "modelReferencePass": model_reference_pass,
            "modelMerlPass": model_merl_pass,
            "negativeControlsPass": negative_controls_pass,
            "interpretation": (
                "Attribution is diagnostic. A failed MERL-vs-3DDFA leave-one-out target agreement with a passing V1-vs-3DDFA comparison localizes the conflict before model training."
            ),
        },
        "v14FrozenContract": {
            "singleSourceMentonTrainingAllowed": False,
            "existingMerl3ddfaOrMenpoTargetMayBeSoleCanonicalTruth": False,
            "evaluatedPointMayParticipateInCoordinateRegistration": False,
            "eachSourceMustHaveSeparateValidationGate": True,
            "combinedAverageMayOverrideSourceFailure": False,
            "newConsensusManualCanonicalTruthRequired": True,
            "minimumCanonicalDevelopmentImages": 120,
            "minimumFreshSubjectDisjointHoldoutImages": 60,
            "minimumPerDirectionInFreshHoldout": 30,
            "dualAnnotationAndAdjudicationRequired": True,
            "freshHoldoutStillRequiredAfterDevelopment": True,
        },
        "releaseEligible": False,
        "retention": {
            "imagesRetained": False,
            "annotationsRetained": False,
            "identifiersRetained": False,
            "individualCoordinatesRetained": False,
            "individualPredictionsRetained": False,
            "aggregateOnlyResult": True,
        },
    }
    result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "trueProfileImages": true_profile_images,
        "gates": gates,
        "attribution": result["attribution"],
        "menton": menton,
        "negativeControls": {
            name: overall_summary[name]["merlLeaveOneOutToReferenceNme"]
            for name in ("noseTip", "upperLip", "lowerLip")
        },
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
