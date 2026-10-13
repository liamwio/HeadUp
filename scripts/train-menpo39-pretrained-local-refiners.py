"""Fine-tune local refiners initialized from the complete retained V1 network."""

from __future__ import annotations

import datetime
import json
import os
import random
import runpy
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import DataLoader


LOCAL = runpy.run_path(
    str(Path(__file__).with_name("train-menpo39-local-refiners.py")),
    run_name="headup_menpo39_pretrained_local_helpers",
)
TRAIN = LOCAL["TRAIN"]
GEOMETRY = LOCAL["GEOMETRY"]
load_records = TRAIN["load_records"]
MenpoProfileDataset = TRAIN["MenpoProfileDataset"]
MobileNet39Heatmaps = TRAIN["MobileNet39Heatmaps"]
predict = TRAIN["predict"]
metric_distributions = TRAIN["metric_distributions"]
sha256 = TRAIN["sha256"]
PRIMARY_FACTOR = TRAIN["PRIMARY_FACTOR"]
PERTURBED_FACTOR = TRAIN["PERTURBED_FACTOR"]
evaluate_geometry = GEOMETRY["evaluate_geometry"]
metric_pass = GEOMETRY["metric_pass"]
GROUPS = LOCAL["GROUPS"]
LOCAL_SIZE = LOCAL["LOCAL_SIZE"]
LOCAL_HEATMAP = LOCAL["LOCAL_HEATMAP"]
LocalRefinerDataset = LOCAL["LocalRefinerDataset"]
local_loss = LOCAL["local_loss"]
local_predict = LOCAL["local_predict"]
local_metrics = LOCAL["local_metrics"]
refine = LOCAL["refine"]
coordinate_gates = LOCAL["coordinate_gates"]
FAILING_V1_METRICS = LOCAL["FAILING_V1_METRICS"]

SEED = 39053
MAX_EPOCHS = 8


class V1InitializedLocalRefiner(nn.Module):
    def __init__(self, source_state: dict[str, torch.Tensor], indices: list[int]):
        super().__init__()
        source = MobileNet39Heatmaps(pretrained=False)
        source.load_state_dict(source_state)
        self.features = source.features
        self.head = nn.Sequential(
            nn.Conv2d(576, 256, 1, bias=False), nn.BatchNorm2d(256), nn.Hardswish(),
            nn.ConvTranspose2d(256, 128, 4, 2, 1, bias=False), nn.BatchNorm2d(128), nn.Hardswish(),
            nn.ConvTranspose2d(128, 64, 4, 2, 1, bias=False), nn.BatchNorm2d(64), nn.Hardswish(),
            nn.ConvTranspose2d(64, len(indices), 4, 2, 1),
        )
        for target_index in range(9):
            self.head[target_index].load_state_dict(source.head[target_index].state_dict())
        with torch.no_grad():
            self.head[9].weight.copy_(source.head[9].weight[:, indices])
            self.head[9].bias.copy_(source.head[9].bias[indices])

    def forward(self, image: torch.Tensor) -> torch.Tensor:
        return self.head(self.features(image))


def main() -> None:
    if len(sys.argv) != 7:
        raise SystemExit("usage: pretrained-local.py MENPO_DIR V1_MODEL CHECKPOINT_DIR V4_MODEL RESULT_JSON MODEL_TMP")
    menpo_dir, v1_path, checkpoint_dir, v4_path, result_path, model_tmp = map(Path, sys.argv[1:])
    random.seed(SEED)
    np.random.seed(SEED)
    torch.manual_seed(SEED)
    torch.set_num_threads(min(8, os.cpu_count() or 1))
    torch.set_num_interop_threads(1)
    checkpoint_dir.mkdir(parents=True, exist_ok=True)
    records, markup_counts = load_records(menpo_dir)
    engineering = [record for record in records if record.split == "engineering"]
    training_records = [record for record in engineering if record.fold != 4]
    validation_records = [record for record in engineering if record.fold == 4]
    development_records = [record for record in records if record.split == "holdout"]
    source_checkpoint = torch.load(v1_path, map_location="cpu", weights_only=False)
    global_model = MobileNet39Heatmaps(pretrained=False)
    global_model.load_state_dict(source_checkpoint["stateDict"])
    training_global = predict(global_model, MenpoProfileDataset(training_records, augment=False, factor=PRIMARY_FACTOR))
    validation_global = predict(global_model, MenpoProfileDataset(validation_records, augment=False, factor=PRIMARY_FACTOR))
    development_global = predict(global_model, MenpoProfileDataset(development_records, augment=False, factor=PRIMARY_FACTOR))
    development_perturbed_global = predict(global_model, MenpoProfileDataset(development_records, augment=False, factor=PERTURBED_FACTOR))
    baseline_geometry = evaluate_geometry(development_global, development_perturbed_global)
    del global_model

    models: dict[str, nn.Module] = {}
    curves = {}
    training_started = time.perf_counter()
    for group_index, (name, specification) in enumerate(GROUPS.items()):
        training_dataset = LocalRefinerDataset(training_records, training_global["predictions"], name, augment=True)
        validation_dataset = LocalRefinerDataset(validation_records, validation_global["predictions"], name, augment=False)
        model = V1InitializedLocalRefiner(source_checkpoint["stateDict"], specification["indices"])
        for parameter in model.features.parameters():
            parameter.requires_grad = False
        optimizer = torch.optim.AdamW(model.head.parameters(), lr=1e-4, weight_decay=1e-4)
        best_score = (float("inf"), float("inf"))
        best_epoch, patience = 0, 0
        curve = []
        checkpoint_path = checkpoint_dir / f"{name}.pth"
        for epoch in range(1, MAX_EPOCHS + 1):
            if epoch == 2:
                for parameter in model.features.parameters():
                    parameter.requires_grad = True
                optimizer = torch.optim.AdamW([
                    {"params": model.features.parameters(), "lr": 2e-5},
                    {"params": model.head.parameters(), "lr": 1e-4},
                ], weight_decay=1e-4)
            training_dataset.set_epoch(epoch)
            generator = torch.Generator().manual_seed(SEED + group_index * 1000 + epoch)
            loader = DataLoader(training_dataset, batch_size=24, shuffle=True, generator=generator, num_workers=0)
            model.train()
            losses = []
            epoch_started = time.perf_counter()
            for batch in loader:
                optimizer.zero_grad(set_to_none=True)
                loss = local_loss(model(batch["image"]), batch["target"])
                loss.backward()
                torch.nn.utils.clip_grad_norm_(model.parameters(), 5.0)
                optimizer.step()
                losses.append(float(loss.detach()))
            validation_local = local_predict(model, validation_dataset)
            validation_metrics = local_metrics(validation_local)
            score = (validation_metrics["imageRmsNme"]["median"], validation_metrics["imageRmsNme"]["p95"])
            row = {
                "epoch": epoch,
                "loss": round(float(np.mean(losses)), 6),
                "validationMedianRmsNme": score[0],
                "validationP95RmsNme": score[1],
                "backboneFrozen": epoch == 1,
                "seconds": round(time.perf_counter() - epoch_started, 3),
            }
            curve.append(row)
            print(
                f"{name} pretrained epoch {epoch}/{MAX_EPOCHS}: loss={row['loss']:.5f}, "
                f"median={score[0]:.4f}, p95={score[1]:.4f}", file=sys.stderr, flush=True,
            )
            if score < best_score:
                best_score, best_epoch, patience = score, epoch, 0
                torch.save(model.state_dict(), checkpoint_path)
            else:
                patience += 1
            if epoch >= 5 and patience >= 2:
                break
        model.load_state_dict(torch.load(checkpoint_path, map_location="cpu", weights_only=True))
        models[name] = model
        curves[name] = {"bestEpoch": best_epoch, "curve": curve}

    refined_validation, validation_local_metrics = refine(models, validation_records, validation_global)
    refined_development, development_local_metrics = refine(models, development_records, development_global)
    refined_perturbed, perturbed_local_metrics = refine(models, development_records, development_perturbed_global)
    validation_geometry = evaluate_geometry(refined_validation)
    candidate_geometry = evaluate_geometry(refined_development, refined_perturbed)
    candidate_coordinate = metric_distributions(refined_development)
    coordinate_checks = coordinate_gates(candidate_coordinate)
    seven_checks = {
        "allSevenMetricsMeetDevelopmentErrorAndCropThresholds": all(
            metric_pass(metric, True) for metric in candidate_geometry["metrics"].values()
        ),
        "developmentMedianNoMoreThan25PercentWorseThanValidation": all(
            candidate_geometry["metrics"][name]["absoluteError"]["median"]
            <= max(validation_geometry["metrics"][name]["absoluteError"]["median"] * 1.25, 1e-6)
            for name in candidate_geometry["metrics"]
        ),
        **coordinate_checks,
    }
    seven_pass = all(seven_checks.values())
    improvements = {}
    for name in candidate_geometry["metrics"]:
        baseline = baseline_geometry["metrics"][name]["absoluteError"]["median"]
        candidate = candidate_geometry["metrics"][name]["absoluteError"]["median"]
        improvements[name] = round((baseline - candidate) / max(baseline, 1e-8), 4)
    improved_failing = sum(improvements[name] >= 0.10 for name in FAILING_V1_METRICS)
    no_failing_regression = all(improvements[name] >= -0.10 for name in FAILING_V1_METRICS)
    preserves_v1_passes = all(
        metric_pass(candidate_geometry["metrics"][name], True)
        for name in ("eLine", "profileVerticalProportion")
    )
    pareto = (
        improved_failing >= 4 and no_failing_regression and preserves_v1_passes
        and all(coordinate_checks.values())
        and seven_checks["developmentMedianNoMoreThan25PercentWorseThanValidation"]
    )
    promoted = seven_pass or pareto
    model_sha = None
    if promoted:
        payload = {
            "architecture": "Menpo39V1InitializedLocalRefiners-v4",
            "researchOnly": True,
            "parentSha256": sha256(v1_path),
            "inputSize": LOCAL_SIZE,
            "heatmapSize": LOCAL_HEATMAP,
            "groups": GROUPS,
            "stateDicts": {name: model.state_dict() for name, model in models.items()},
        }
        torch.save(payload, model_tmp)
        v4_path.parent.mkdir(parents=True, exist_ok=True)
        v4_path.write_bytes(model_tmp.read_bytes())
        model_sha = sha256(v4_path)
    result = {
        "testedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "policyVersion": "HEADUP-MENPO39-PRETRAINED-LOCAL-REFINERS-1.0",
        "source": {
            "archiveSha256": os.environ.get("HEADUP_MENPO_ARCHIVE_SHA256"),
            "profileImages": len(records),
            "markupCounts": markup_counts,
            "license": "non-commercial research only",
        },
        "partition": {
            "training": len(training_records), "validation": len(validation_records), "development": len(development_records),
            "developmentReuseWarning": "Reused development evidence; not a fresh confirmatory holdout",
            "identityIsolation": "unavailable in source metadata",
        },
        "architecture": {
            "parentModelSha256": sha256(v1_path),
            "initialization": "complete V1 MobileNet features, decoder and selected output channels",
            "localInput": [3, LOCAL_SIZE, LOCAL_SIZE],
            "localHeatmap": [LOCAL_HEATMAP, LOCAL_HEATMAP],
            "groups": GROUPS,
            "roiSource": "V1 predictions on original-resolution source image",
        },
        "training": {
            "seed": SEED,
            "optimizer": "epoch 1 frozen features/head 1e-4; epoch 2+ features 2e-5 and head 1e-4",
            "selection": "lowest validation local-group RMS NME median; P95 tie-break",
            "groups": curves,
            "rawWallSeconds": round(time.perf_counter() - training_started, 3),
        },
        "baselineDevelopment": baseline_geometry,
        "candidateValidation": validation_geometry,
        "candidateDevelopment": candidate_geometry,
        "candidateCoordinateDevelopment": candidate_coordinate,
        "validationLocalPointMetrics": validation_local_metrics,
        "developmentLocalPointMetrics": development_local_metrics,
        "perturbedLocalPointMetrics": perturbed_local_metrics,
        "medianRelativeImprovementVsV1": improvements,
        "sevenMetricGates": seven_checks,
        "passesSevenNativeMetricDevelopmentGates": seven_pass,
        "paretoPromotionGates": {
            "atLeastFourOfFiveFailingMetricsImproveMedianBy10Percent": improved_failing >= 4,
            "improvedFailingMetricCount": improved_failing,
            "noFailingMetricMedianRegressesMoreThan10Percent": no_failing_regression,
            "preservesELineAndVerticalProportion": preserves_v1_passes,
            "coordinateGatesPass": all(coordinate_checks.values()),
        },
        "candidatePromoted": promoted,
        "candidateSha256": model_sha,
        "passesFullEightMetricContract": False,
        "releaseEligible": False,
        "retention": {
            "imagesRetained": False, "annotationsRetained": False,
            "individualPredictionsRetained": False, "identifiersRetained": False,
            "candidateRetainedOnlyIfPromotionGatesPass": True,
        },
    }
    result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "resultPath": str(result_path), "improvements": improvements,
        "sevenGates": seven_checks, "paretoGates": result["paretoPromotionGates"],
        "promoted": promoted, "candidateSha256": model_sha,
        "candidateDevelopment": candidate_geometry["metrics"],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
