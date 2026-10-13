"""Train only Menpo39 output channel 8 on MERL-RAV publisher-train profiles.

The retained V1 model is frozen except for the final transposed-convolution
slice that emits native Menpo39 menton point 8.  MERL-RAV publisher testset
images are never used for epoch selection.  The runner writes aggregate-only
metrics and retains a research-only checkpoint only if every predeclared gate
passes.
"""

from __future__ import annotations

import datetime
import hashlib
import json
import math
import os
import random
import runpy
import sys
from pathlib import Path

import cv2
import numpy as np
import torch
import torch.nn.functional as functional
from torch.utils.data import DataLoader, Dataset


BASE = runpy.run_path(
    str(Path(__file__).with_name("benchmark-merlrav-aflw2000-profile-external.py")),
    run_name="headup_merlrav_menton_helpers",
)
TRAIN = BASE["TRAIN"]
Candidate = BASE["Candidate"]
MobileNet39Heatmaps = BASE["MobileNet39Heatmaps"]
load_candidates = BASE["load_candidates"]
infer = BASE["infer"]
summarize = BASE["summarize"]
STRICT_MAPPING = BASE["STRICT_MAPPING"]
PRIMARY_FACTOR = BASE["PRIMARY_FACTOR"]
PERTURBED_FACTOR = BASE["PERTURBED_FACTOR"]
IMAGE_SIZE = BASE["IMAGE_SIZE"]
crop_transform = BASE["crop_transform"]
transform_points = BASE["transform_points"]
soft_argmax = BASE["soft_argmax"]
original_coordinates = BASE["original_coordinates"]
gaussian_heatmaps = TRAIN["gaussian_heatmaps"]
sha256 = TRAIN["sha256"]

SEED = 813_039
MENTON_MENPO_INDEX = 8
MENTON_STANDARD68_INDEX = 8


def usable_points(candidate: Candidate) -> np.ndarray:
    mask = (candidate.visibility != "self") & np.all(
        (candidate.points >= -12.0) & (candidate.points <= 131.0), axis=1
    )
    points = candidate.points[mask]
    if len(points) < 10:
        raise RuntimeError("candidate has fewer than 10 usable points")
    return points


class MentonDataset(Dataset):
    def __init__(self, candidates: list[Candidate], *, augment: bool):
        self.candidates = candidates
        self.augment = augment
        self.epoch = 0

    def set_epoch(self, epoch: int) -> None:
        self.epoch = epoch

    def __len__(self) -> int:
        return len(self.candidates)

    def __getitem__(self, index: int) -> dict[str, torch.Tensor]:
        candidate = self.candidates[index]
        image = cv2.imread(str(candidate.image_path), cv2.IMREAD_COLOR)
        if image is None or image.shape[:2] != (120, 120):
            raise RuntimeError("unexpected AFLW2000 crop")
        if self.augment:
            rng = np.random.default_rng(SEED + self.epoch * 100_003 + index * 997)
            factor = float(rng.uniform(1.25, 1.65))
            shift_x, shift_y = [float(value) for value in rng.uniform(-0.04, 0.04, size=2)]
            angle = float(rng.uniform(-8.0, 8.0))
        else:
            rng = None
            factor, shift_x, shift_y, angle = PRIMARY_FACTOR, 0.0, 0.0, 0.0
        matrix, inverse = crop_transform(usable_points(candidate), factor, shift_x, shift_y, angle)
        crop = cv2.warpAffine(
            image, matrix, (IMAGE_SIZE, IMAGE_SIZE), flags=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_REFLECT_101,
        )
        target_original = candidate.points[[MENTON_STANDARD68_INDEX]]
        target = transform_points(target_original, matrix) / (IMAGE_SIZE - 1)
        if rng is not None:
            if rng.random() < 0.5:
                crop = np.ascontiguousarray(crop[:, ::-1])
                target[:, 0] = 1.0 - target[:, 0]
            alpha = float(rng.uniform(0.85, 1.15))
            beta = float(rng.uniform(-15.0, 15.0))
            crop = cv2.convertScaleAbs(crop, alpha=alpha, beta=beta)
            if rng.random() < 0.15:
                crop = cv2.GaussianBlur(crop, (3, 3), float(rng.uniform(0.3, 1.0)))
        rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
        tensor = torch.from_numpy(rgb.transpose(2, 0, 1))
        mean = torch.tensor([0.485, 0.456, 0.406], dtype=torch.float32)[:, None, None]
        std = torch.tensor([0.229, 0.224, 0.225], dtype=torch.float32)[:, None, None]
        return {
            "image": (tensor - mean) / std,
            "target": torch.from_numpy(target.astype(np.float32)),
            "targetOriginal": torch.from_numpy(target_original.astype(np.float32)),
            "inverse": torch.from_numpy(inverse.astype(np.float32)),
            "diagonal": torch.tensor(candidate.diagonal, dtype=torch.float32),
        }


def menton_loss(logits: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
    target_heatmap = gaussian_heatmaps(target)
    heatmap = torch.mean((torch.sigmoid(logits) - target_heatmap) ** 2)
    coordinate = functional.smooth_l1_loss(soft_argmax(logits), target)
    return 100.0 * heatmap + 8.0 * coordinate


def validation_distribution(model: torch.nn.Module, candidates: list[Candidate]) -> dict[str, float]:
    loader = DataLoader(MentonDataset(candidates, augment=False), batch_size=24, shuffle=False, num_workers=0)
    values: list[float] = []
    model.eval()
    with torch.inference_mode():
        for batch in loader:
            logits = model(batch["image"])[:, MENTON_MENPO_INDEX:MENTON_MENPO_INDEX + 1]
            normalized = soft_argmax(logits)
            prediction = original_coordinates(normalized, batch["inverse"])
            distance = torch.linalg.vector_norm(prediction[:, 0] - batch["targetOriginal"][:, 0], dim=1)
            values.extend((distance / batch["diagonal"]).cpu().tolist())
    array = np.asarray(values, dtype=np.float64)
    return {
        "median": round(float(np.quantile(array, 0.5, method="nearest")), 4),
        "p95": round(float(np.quantile(array, 0.95, method="nearest")), 4),
    }


def evaluate_shared_points(model: torch.nn.Module, candidates: list[Candidate]) -> dict[str, object]:
    cases: list[dict[str, object]] = []
    for candidate in candidates:
        primary = infer(model, candidate, PRIMARY_FACTOR)
        perturbed = infer(model, candidate, PERTURBED_FACTOR)
        errors: dict[str, float] = {}
        crop: list[float] = []
        for name, mapping in STRICT_MAPPING.items():
            truth_index, prediction_index = mapping["standard68"], mapping["menpo39"]
            truth = candidate.points[truth_index]
            if candidate.visibility[truth_index] != "visible" or not np.all((truth >= 0.0) & (truth <= 119.0)):
                continue
            errors[name] = float(np.linalg.norm(primary[prediction_index] - truth) / candidate.diagonal)
            crop.append(float(np.linalg.norm(primary[prediction_index] - perturbed[prediction_index]) / candidate.diagonal))
        if len(errors) < 3:
            continue
        direction = None
        if "noseTip" in errors and "menton" in errors:
            predicted_sign = np.sign(primary[19, 0] - primary[8, 0])
            target_sign = np.sign(candidate.points[30, 0] - candidate.points[8, 0])
            direction = bool(predicted_sign != 0 and predicted_sign == target_sign)
        cases.append({
            "pose": candidate.pose,
            "publisherSplit": candidate.publisher_split,
            "points": errors,
            "ambiguous": {},
            "rms": float(np.sqrt(np.mean(np.square(list(errors.values()))))),
            "cropSensitivity": float(np.median(crop)),
            "directionCorrect": direction,
        })
    return summarize(cases)


def state_change_audit(before: dict[str, torch.Tensor], after: dict[str, torch.Tensor]) -> dict[str, object]:
    maximum_non_menton = 0.0
    changed_tensors: list[str] = []
    for name, original in before.items():
        updated = after[name]
        difference = torch.abs(updated - original)
        if float(torch.max(difference)) > 0.0:
            changed_tensors.append(name)
        if name == "head.9.weight":
            # ConvTranspose2d layout is [input_channels, output_channels, kH, kW].
            copy = difference.clone()
            copy[:, MENTON_MENPO_INDEX] = 0
            maximum_non_menton = max(maximum_non_menton, float(torch.max(copy)))
        elif name == "head.9.bias":
            copy = difference.clone()
            copy[MENTON_MENPO_INDEX] = 0
            maximum_non_menton = max(maximum_non_menton, float(torch.max(copy)))
        else:
            maximum_non_menton = max(maximum_non_menton, float(torch.max(difference)))
    return {
        "changedStateTensors": changed_tensors,
        "expectedChangedStateTensors": ["head.9.weight", "head.9.bias"],
        "maximumAbsoluteNonMentonParameterChange": maximum_non_menton,
        "onlyFinalMentonSliceChanged": maximum_non_menton == 0.0 and set(changed_tensors).issubset({"head.9.weight", "head.9.bias"}),
    }


def improvement(before: float, after: float) -> float:
    return round((before - after) / max(before, 1e-8), 4)


def main() -> None:
    if len(sys.argv) != 11:
        raise SystemExit(
            "usage: train.py IMAGE_DIR CROP_LIST ROI_NPY REFERENCE_NPY LABELS_ROOT V1_MODEL "
            "BEST_TMP RESEARCH_MODEL RESULT_JSON SOURCE_JSON"
        )
    (
        image_dir, crop_list, roi_path, reference_path, labels_root, v1_path,
        best_path, research_path, result_path, source_path,
    ) = map(Path, sys.argv[1:])
    source = json.loads(source_path.read_text(encoding="utf-8"))
    random.seed(SEED)
    np.random.seed(SEED)
    torch.manual_seed(SEED)
    torch.set_num_threads(min(8, os.cpu_count() or 1))
    torch.set_num_interop_threads(1)

    candidates, source_audit = load_candidates(image_dir, crop_list, roi_path, reference_path, labels_root)
    eligible = [
        candidate for candidate in candidates
        if candidate.pose in {"left", "right"}
        and candidate.visibility[MENTON_STANDARD68_INDEX] == "visible"
        and np.all((candidate.points[MENTON_STANDARD68_INDEX] >= 0.0) & (candidate.points[MENTON_STANDARD68_INDEX] <= 119.0))
    ]
    publisher_train = [candidate for candidate in eligible if candidate.publisher_split == "trainset"]
    publisher_test = [candidate for candidate in eligible if candidate.publisher_split == "testset"]
    train: list[Candidate] = []
    validation: list[Candidate] = []
    for candidate in publisher_train:
        digest = hashlib.sha256(candidate.annotation_stem.encode("utf-8")).digest()
        (validation if digest[0] % 5 == 4 else train).append(candidate)
    if len(train) < 180 or len(validation) < 35 or len(publisher_test) < 50:
        raise RuntimeError(
            f"insufficient isolated profiles: train={len(train)}, validation={len(validation)}, test={len(publisher_test)}"
        )

    checkpoint = torch.load(v1_path, map_location="cpu", weights_only=False)
    if checkpoint.get("landmarkCount") != 39 or checkpoint.get("researchOnly") is not True:
        raise RuntimeError("unexpected retained V1 checkpoint")
    model = MobileNet39Heatmaps(pretrained=False)
    model.load_state_dict(checkpoint["stateDict"])
    initial_state = {name: value.detach().clone() for name, value in model.state_dict().items()}
    baseline_validation = validation_distribution(model, validation)

    for parameter in model.parameters():
        parameter.requires_grad = False
    final_layer = model.head[-1]
    final_layer.weight.requires_grad = True
    final_layer.bias.requires_grad = True
    optimizer = torch.optim.Adam([final_layer.weight, final_layer.bias], lr=1e-3)
    training_dataset = MentonDataset(train, augment=True)
    curve: list[dict[str, object]] = []
    best_score = (float("inf"), float("inf"))
    best_epoch = 0
    patience = 0
    maximum_epochs = 30
    for epoch in range(1, maximum_epochs + 1):
        training_dataset.set_epoch(epoch)
        generator = torch.Generator().manual_seed(SEED + epoch)
        loader = DataLoader(training_dataset, batch_size=16, shuffle=True, generator=generator, num_workers=0)
        model.eval()  # Freeze every BatchNorm running statistic.
        losses: list[float] = []
        for batch in loader:
            optimizer.zero_grad(set_to_none=True)
            logits = model(batch["image"])[:, MENTON_MENPO_INDEX:MENTON_MENPO_INDEX + 1]
            loss = menton_loss(logits, batch["target"])
            loss.backward()
            optimizer.step()
            losses.append(float(loss.detach()))
        validation_metrics = validation_distribution(model, validation)
        score = (validation_metrics["median"], validation_metrics["p95"])
        curve.append({
            "epoch": epoch,
            "trainingLoss": round(float(np.mean(losses)), 6),
            "validationMentonNme": validation_metrics,
        })
        print(
            f"Epoch {epoch}/{maximum_epochs}: loss={np.mean(losses):.5f}, "
            f"val={score[0]:.4f}/{score[1]:.4f}", file=sys.stderr, flush=True,
        )
        if score < best_score:
            best_score, best_epoch, patience = score, epoch, 0
            torch.save(model.state_dict(), best_path)
        else:
            patience += 1
        if epoch >= 10 and patience >= 6:
            break
    model.load_state_dict(torch.load(best_path, map_location="cpu", weights_only=True))

    baseline_model = MobileNet39Heatmaps(pretrained=False)
    baseline_model.load_state_dict(checkpoint["stateDict"])
    baseline_test = evaluate_shared_points(baseline_model, publisher_test)
    candidate_test = evaluate_shared_points(model, publisher_test)
    change_audit = state_change_audit(initial_state, model.state_dict())
    baseline_menton = baseline_test["perPointNme"]["menton"]["distribution"]
    candidate_menton = candidate_test["perPointNme"]["menton"]["distribution"]
    candidate_rms = candidate_test["mappedPointRmsNme"]
    candidate_crop = candidate_test["cropSensitivityMedianStrictPointNme"]
    candidate_direction = candidate_test["direction"]
    gates = {
        "publisherTrainHasAtLeast180Profiles": len(train) >= 180,
        "publisherTestHasAtLeast50Profiles": len(publisher_test) >= 50,
        "onlyFinalMentonOutputSliceChanged": change_audit["onlyFinalMentonSliceChanged"],
        "publisherTestMentonMedianImprovesAtLeast30Percent": improvement(
            baseline_menton["median"], candidate_menton["median"]
        ) >= 0.30,
        "publisherTestMentonP95ImprovesAtLeast20Percent": improvement(
            baseline_menton["p95"], candidate_menton["p95"]
        ) >= 0.20,
        "publisherTestMentonMedianNmeAtMost3Percent": candidate_menton["median"] <= 0.03,
        "publisherTestMentonP95NmeAtMost8Percent": candidate_menton["p95"] <= 0.08,
        "publisherTestFourPointMedianRmsNmeAtMost3Percent": candidate_rms["median"] <= 0.03,
        "publisherTestFourPointP95RmsNmeAtMost8Percent": candidate_rms["p95"] <= 0.08,
        "publisherTestCropSensitivityP95AtMost5Percent": candidate_crop["p95"] <= 0.05,
        "publisherTestEachDirectionAccuracyAtLeast95Percent": all(
            candidate_direction[pose]["total"] >= 25 and candidate_direction[pose]["accuracy"] >= 0.95
            for pose in ("left", "right")
        ),
    }
    passes = all(gates.values())
    retained = False
    retained_sha = None
    if passes:
        research_path.parent.mkdir(parents=True, exist_ok=True)
        torch.save({
            "architecture": "MobileNet39Heatmaps-v13-menton-channel",
            "landmarkCount": 39,
            "updatedMenpoIndices": [MENTON_MENPO_INDEX],
            "stateDict": model.state_dict(),
            "researchOnly": True,
            "commercialUseAllowed": False,
            "trainingData": "MERL-RAV publisher trainset overlap with author-published AFLW2000 crops",
            "sourceV1Sha256": sha256(v1_path),
        }, research_path)
        retained_sha = sha256(research_path)
        retained = True
    elif research_path.exists():
        research_path.unlink()

    result = {
        "testedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "policyVersion": "HEADUP-MERLRAV-MENTON-CHANNEL-V13-1.0",
        "source": source,
        "sourceEligibilityAudit": source_audit,
        "partition": {
            "publisherTrainEligible": len(publisher_train),
            "training": len(train),
            "validation": len(validation),
            "publisherTestBlind": len(publisher_test),
            "validationRule": "SHA-256(annotation stem) byte 0 modulo 5 equals 4; publisher test never used for selection",
            "identityLimitation": "MERL-RAV/AFLW2000 exposes no reliable subject identifiers; image-disjoint, not proven subject-disjoint",
        },
        "experiment": {
            "name": "V13 final-layer menton channel specialization",
            "sourceCheckpointSha256": sha256(v1_path),
            "updatedMenpoIndices": [MENTON_MENPO_INDEX],
            "frozenParameters": "all except final ConvTranspose2d output slice 8",
            "batchNormMode": "eval throughout training; running statistics frozen",
            "selection": "minimum validation menton median NME, then P95; publisher test blind",
            "bestEpoch": best_epoch,
            "baselineValidationMentonNme": baseline_validation,
            "bestValidationMentonNme": {"median": best_score[0], "p95": best_score[1]},
            "trainingCurve": curve,
        },
        "stateIsolationAudit": change_audit,
        "publisherTest": {
            "baseline": baseline_test,
            "candidate": candidate_test,
            "mentonImprovement": {
                "median": improvement(baseline_menton["median"], candidate_menton["median"]),
                "p95": improvement(baseline_menton["p95"], candidate_menton["p95"]),
            },
        },
        "predeclaredGates": gates,
        "passesAllResearchGates": passes,
        "researchCheckpoint": {
            "retained": retained,
            "sha256": retained_sha,
            "pathRecorded": False,
            "commercialUseAllowed": False,
        },
        "productionDecision": "research_candidate_only" if passes else "reject",
        "limitations": [
            "Only one of ten native profile landmarks is adapted and only four shared points are externally audited.",
            "Per-face ground-truth similarity registration makes this a best-case localization test, not detection or capture validation.",
            "MERL-RAV/AFLW2000 research data cannot authorize a commercial production model.",
            "No neck tangent, complete eight-measurement truth, reliable subject-disjoint split, or phone retake evidence is available.",
        ],
        "retention": {
            "imagesRetained": False,
            "annotationsRetained": False,
            "archivesRetained": False,
            "identifiersRetained": False,
            "individualPredictionsRetained": False,
            "aggregateOnly": True,
        },
    }
    result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "partition": result["partition"],
        "bestEpoch": best_epoch,
        "baselineMenton": baseline_menton,
        "candidateMenton": candidate_menton,
        "candidateRms": candidate_rms,
        "candidateCrop": candidate_crop,
        "candidateDirection": candidate_direction,
        "stateAudit": change_audit,
        "gates": gates,
        "passes": passes,
        "checkpointRetained": retained,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
