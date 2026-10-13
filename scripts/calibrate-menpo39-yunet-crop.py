from __future__ import annotations

import hashlib
import json
import math
import sys
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort

IMAGE_SIZE = 224
LANDMARK_COUNT = 39
TRAINING_FACTOR = 1.45
CRITICAL = {"brow": 14, "nasal_root": 17, "nose_tip": 19, "columella": 20, "subnasale": 21, "upper_lip": 27, "lower_lip": 33, "fold": 11, "pogonion": 10, "menton": 8}


def parse_pts(path: Path) -> np.ndarray:
    lines = path.read_text(encoding="utf-8", errors="strict").splitlines()
    count = int(next(line for line in lines if line.strip().startswith("n_points")).split(":", 1)[1])
    start, end = lines.index("{") + 1, lines.index("}")
    points = np.asarray([[float(value) - 1 for value in line.split()] for line in lines[start:end] if line.strip()], dtype=np.float64)
    if points.shape != (count, 2):
        raise RuntimeError("PTS count mismatch")
    return points


def face_box(points: np.ndarray) -> np.ndarray:
    minimum, maximum = points.min(axis=0), points.max(axis=0)
    return np.asarray([minimum[0], minimum[1], *(maximum - minimum)], dtype=np.float64)


def split_for(orientation: str, stem: str) -> str:
    return "engineering" if hashlib.sha256(f"{orientation}/{stem}".encode()).digest()[0] < 205 else "holdout"


def distribution(values: list[float]) -> dict[str, float | None]:
    if not values:
        return {key: None for key in ["min", "p05", "median", "p95", "max"]}
    data = np.asarray(values, dtype=np.float64)
    return {key: round(float(np.quantile(data, fraction)), 6) for key, fraction in [("min", 0), ("p05", .05), ("median", .5), ("p95", .95), ("max", 1)]}


def detect(detector:ort.InferenceSession,image:np.ndarray)->tuple[np.ndarray|None,float]:
    original_height,original_width=image.shape[:2];scale=320/max(original_width,original_height);scaled_width=max(1,round(original_width*scale));scaled_height=max(1,round(original_height*scale));width=math.ceil(scaled_width/32)*32;height=math.ceil(scaled_height/32)*32;padded=np.zeros((height,width,3),dtype=np.uint8);padded[:scaled_height,:scaled_width]=cv2.resize(image,(scaled_width,scaled_height),interpolation=cv2.INTER_LINEAR);tensor=padded.astype(np.float32).transpose(2,0,1)[None];outputs=detector.run(None,{detector.get_inputs()[0].name:tensor});values={output.name:value for output,value in zip(detector.get_outputs(),outputs)};primary=None
    for stride in [8,16,32]:
        classifications=values[f'cls_{stride}'].reshape(-1);objectness=values[f'obj_{stride}'].reshape(-1);boxes=values[f'bbox_{stride}'].reshape(-1,4);columns=width//stride
        for index in range(len(classifications)):
            score=math.sqrt(float(np.clip(classifications[index],0,1))*float(np.clip(objectness[index],0,1)))
            if primary is not None and score<=primary[0]:continue
            row=index//columns;column=index%columns;box_width=math.exp(float(boxes[index,2]))*stride;box_height=math.exp(float(boxes[index,3]))*stride;center_x=(column+float(boxes[index,0]))*stride;center_y=(row+float(boxes[index,1]))*stride;primary=(score,np.asarray([(center_x-box_width/2)/scale,(center_y-box_height/2)/scale,box_width/scale,box_height/scale],dtype=np.float64))
    return(None,0.)if primary is None else(primary[1],primary[0])


def crop_matrix(box: np.ndarray, factor: float, shift_x: float, shift_y: float) -> tuple[np.ndarray, np.ndarray]:
    x, y, width, height = [float(value) for value in box]
    detector_side = max(width, height)
    side = max(1.0, detector_side * factor)
    center_x = x + width / 2 + shift_x * detector_side
    center_y = y + height / 2 + shift_y * detector_side
    scale = (IMAGE_SIZE - 1) / side
    matrix = cv2.getRotationMatrix2D((center_x, center_y), 0, scale).astype(np.float64)
    matrix[0, 2] += (IMAGE_SIZE - 1) / 2 - center_x
    matrix[1, 2] += (IMAGE_SIZE - 1) / 2 - center_y
    return matrix, cv2.invertAffineTransform(matrix)

def detector_features(box:np.ndarray,score:float,image_shape:tuple[int,...])->np.ndarray:
    height,width=image_shape[:2];x,y,box_width,box_height=box;return np.asarray([math.log(max(box_width,1)/max(box_height,1)),score,(box_width*box_height)/(width*height),(x+box_width/2)/width,(y+box_height/2)/height],dtype=np.float64)
def fit_crop_linear(x:np.ndarray,y:np.ndarray,alpha:float=1.0):
    mean=x.mean(0);std=np.maximum(x.std(0),1e-6);z=(x-mean)/std;design=np.column_stack([z,np.ones(len(z))]);eye=np.eye(design.shape[1]);eye[-1,-1]=0;coef=np.linalg.solve(design.T@design+alpha*eye,design.T@y)
    for _ in range(3):
        residual=np.sqrt(np.mean((design@coef-y)**2,axis=1));scale=max(np.median(residual)*1.4826,1e-5);weights=np.minimum(1,1.5*scale/np.maximum(residual,1e-8));root=np.sqrt(weights);weighted=design*root[:,None];coef=np.linalg.solve(weighted.T@weighted+alpha*eye,weighted.T@(y*root[:,None]))
    return{'mean':mean,'std':std,'coef':coef}
def apply_crop_model(model:dict[str,object],features:np.ndarray)->np.ndarray:
    if model['type']=='constant':return np.asarray(model['values'],dtype=np.float64)
    return((features-np.asarray(model['mean']))/np.asarray(model['std']))@np.asarray(model['coef'])[:-1]+np.asarray(model['coef'])[-1]


def tensor_for(image: np.ndarray, matrix: np.ndarray) -> np.ndarray:
    crop = cv2.warpAffine(image, matrix, (IMAGE_SIZE, IMAGE_SIZE), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT_101)
    rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
    mean = np.asarray([0.485, 0.456, 0.406], dtype=np.float32)[:, None, None]
    std = np.asarray([0.229, 0.224, 0.225], dtype=np.float32)[:, None, None]
    return ((rgb.transpose(2, 0, 1) - mean) / std)[None]


def restore(normalized: np.ndarray, inverse: np.ndarray) -> np.ndarray:
    pixels = normalized * (IMAGE_SIZE - 1)
    homogeneous = np.concatenate([pixels, np.ones((len(pixels), 1), dtype=np.float64)], axis=1)
    return homogeneous @ inverse.T

def geometry_vector(points:np.ndarray,orientation:str)->np.ndarray|None:
    direction=1 if orientation=='right' else-1;vertical_axis=points[8]-points[14];angle=math.atan2(float(vertical_axis[1]),float(vertical_axis[0]))-math.pi/2;horizontal=np.asarray([math.cos(angle),math.sin(angle)]);vertical=np.asarray([-math.sin(angle),math.cos(angle)]);value=np.column_stack([direction*(points@horizontal),points@vertical]);at=lambda i:value[i]
    def angle_at(vertex,first,second):
        a,b=first-vertex,second-vertex;den=np.linalg.norm(a)*np.linalg.norm(b)
        return None if den<=1e-8 else math.degrees(math.acos(float(np.clip(np.dot(a,b)/den,-1,1))))
    def line_distance(point,start,end):
        line=end-start;length=np.linalg.norm(line)
        if length<=1e-8:return None
        normal=np.asarray([line[1],-line[0]])/length
        if normal[0]<0:normal*=-1
        return float(np.dot(point-start,normal))
    height=abs(float(at(8)[1]-at(14)[1]));mid=float(at(21)[1]-at(14)[1]);lower=float(at(10)[1]-at(21)[1])
    if height<=1e-8 or mid<=0 or lower<=0:return None
    jaw=value[[4,5,6,7,8]];centered=jaw-jaw.mean(0);_,vectors=np.linalg.eigh(centered.T@centered);axis_vector=vectors[:,-1];jaw_angle=math.degrees(math.atan2(abs(float(axis_vector[1])),abs(float(axis_vector[0]))))
    values=[angle_at(at(21),at(17),at(10)),line_distance(at(27),at(19),at(10))/height,line_distance(at(33),at(19),at(10))/height,angle_at(at(21),at(20),at(27)),angle_at(at(11),at(33),at(10)),line_distance(at(10),at(17),at(21))/height,jaw_angle,mid/(mid+lower),lower/(mid+lower)]
    if any(item is None or not math.isfinite(item)for item in values):return None
    vector=np.asarray(values,dtype=np.float64)
    for position,scale in {0:180,3:180,4:180,6:90}.items():vector[position]/=scale
    return vector


def main() -> None:
    if len(sys.argv) != 7:
        raise SystemExit("usage: calibrate.py MENPO_DIR ONNX_MODEL GEOMETRY_MODEL YUNET_MODEL RESULT_JSON MANIFEST_JSON")
    menpo_dir, model_path, geometry_model_path, yunet_path, result_path, manifest_path = map(Path, sys.argv[1:])
    images: dict[tuple[str, str], Path] = {}
    for path in menpo_dir.rglob("*.jpg"):
        parts = {part.lower() for part in path.parts}
        orientation = "left" if "left" in parts else "right" if "right" in parts else None
        if "profile" in parts and orientation:
            images[(orientation, path.stem)] = path
    records = []
    markup_counts: Counter[int] = Counter()
    for pts_path in sorted(menpo_dir.rglob("*.pts")):
        points = parse_pts(pts_path)
        markup_counts[len(points)] += 1
        if len(points) != LANDMARK_COUNT:
            continue
        parts = {part.lower() for part in pts_path.parts}
        orientation = "left" if "left" in parts else "right" if "right" in parts else None
        image_path = images.get((orientation or "", pts_path.stem))
        if orientation is None or image_path is None:
            raise RuntimeError("profile annotation has no image")
        records.append((image_path, points, orientation, split_for(orientation, image_path.stem)))
    if len(records) != 2290 or markup_counts[68] != 6655:
        raise RuntimeError(f"unexpected Menpo counts: profiles={len(records)}, markups={dict(markup_counts)}")

    detector = ort.InferenceSession(str(yunet_path),providers=["CPUExecutionProvider"])
    mapping: dict[str, list[list[float]]] = {"left": [], "right": []}
    detection_counts = Counter()
    for image_path, points, orientation, split in records:
        image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
        box, score = detect(detector, image)
        detection_counts[(split, orientation, "detected" if box is not None else "missed")] += 1
        if split != "engineering" or box is None or score < .5:
            continue
        gt = face_box(points)
        detector_side = max(box[2], box[3])
        gt_center = gt[:2] + gt[2:] / 2
        detector_center = box[:2] + box[2:] / 2
        mapping[orientation].append({"target":[max(gt[2], gt[3]) * TRAINING_FACTOR / detector_side,(gt_center[0] - detector_center[0]) / detector_side,(gt_center[1] - detector_center[1]) / detector_side],"features":detector_features(box,score,image.shape),"fold":hashlib.sha256(f'{orientation}/{image_path.stem}'.encode()).digest()[2]%5})
    if sum(len(values) for values in mapping.values()) < 500 or min(len(values) for values in mapping.values()) < 100:
        raise RuntimeError(f"too few calibration detections: { {key:len(value) for key,value in mapping.items()} }")
    crop_by_orientation = {}
    for orientation, values in mapping.items():
        x=np.vstack([value['features']for value in values]);y=np.vstack([value['target']for value in values]);folds=np.asarray([value['fold']for value in values]);constant=np.median(y,axis=0);constant_cv=np.sqrt(np.mean((y-constant)**2,axis=1));linear_cv=np.empty(len(y))
        for fold in range(5):
            train=folds!=fold;test=folds==fold;model=fit_crop_linear(x[train],y[train]);prediction=np.vstack([apply_crop_model({'type':'linear',**model},row)for row in x[test]]);linear_cv[test]=np.sqrt(np.mean((prediction-y[test])**2,axis=1))
        use_linear=np.median(linear_cv)<np.median(constant_cv)*.98
        if use_linear:
            model=fit_crop_linear(x,y);crop_by_orientation[orientation]={"type":"linear","mean":model['mean'].tolist(),"std":model['std'].tolist(),"coef":model['coef'].tolist(),"calibrationSamples":len(values),"cvMedianTargetRms":float(np.median(linear_cv)),"constantCvMedianTargetRms":float(np.median(constant_cv))}
        else:
            factor,shift_x,shift_y=constant.tolist();crop_by_orientation[orientation]={"type":"constant","values":constant.tolist(),"factor":factor,"shiftX":shift_x,"shiftY":shift_y,"calibrationSamples":len(values),"cvMedianTargetRms":float(np.median(constant_cv)),"linearCvMedianTargetRms":float(np.median(linear_cv))}

    session = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
    geometry_session=ort.InferenceSession(str(geometry_model_path),providers=["CPUExecutionProvider"])
    cases: list[dict[str, object]] = []
    inference_ms: list[float] = []
    for image_path, ground_truth, orientation, split in records:
        image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
        box, score = detect(detector, image)
        if box is None:
            cases.append({"split": split, "orientation": orientation, "rejection": "yunet_no_face"})
            continue
        params=apply_crop_model(crop_by_orientation[orientation],detector_features(box,score,image.shape));matrix, inverse = crop_matrix(box,float(params[0]),float(params[1]),float(params[2]))
        started = time.perf_counter()
        tensor=tensor_for(image,matrix);normalized, confidence = session.run(["coordinates", "confidence"], {"input":tensor});direct_geometry=geometry_session.run(["geometry"],{"input":tensor})[0][0]
        inference_ms.append((time.perf_counter() - started) * 1000)
        prediction = restore(normalized[0], inverse)
        diagonal = max(1.0, math.hypot(*face_box(ground_truth)[2:]))
        point_nme = np.linalg.norm(prediction - ground_truth, axis=1) / diagonal
        rms = float(np.sqrt(np.mean(point_nme ** 2)))
        predicted_sign = np.sign(prediction[19, 0] - prediction[10, 0])
        target_sign = np.sign(ground_truth[19, 0] - ground_truth[10, 0])
        landmark_geometry=geometry_vector(prediction,orientation);scales=np.asarray([3/180,.03,.03,3/180,3/180,.03,3/90,.03,.03]);disagreement=float(np.max(np.abs(landmark_geometry-direct_geometry)/scales))if landmark_geometry is not None else float('inf')
        cases.append({
            "split": split,
            "orientation": orientation,
            "yunetScore": score,
            "confidenceP10": float(np.quantile(confidence[0], .1)),
            "confidenceMedian": float(np.median(confidence[0])),
            "rms": rms,
            "pointNme": point_nme,
            "directionCorrect": bool(predicted_sign == target_sign),
            "geometryDisagreement":disagreement,
        })

    def accepted_for(source: list[dict[str, object]], confidence_threshold: float, yunet_threshold: float,max_disagreement:float=float('inf')) -> list[dict[str, object]]:
        return [case for case in source if "rms" in case and float(case["yunetScore"]) >= yunet_threshold and float(case["confidenceP10"]) >= confidence_threshold and float(case["geometryDisagreement"])<=max_disagreement and bool(case["directionCorrect"])]

    def summarize(source: list[dict[str, object]]) -> dict[str, object]:
        nmes = [float(case["rms"]) for case in source]
        critical = {name: distribution([float(np.asarray(case["pointNme"])[index]) for case in source]) for name, index in CRITICAL.items()}
        return {
            "fullMarkupRmsNme": distribution(nmes),
            "criticalPointNme": critical,
            "byOrientation": {orientation: distribution([float(case["rms"]) for case in source if case["orientation"] == orientation]) for orientation in ["left", "right"]},
            "directionAccuracyBeforeGuardrail": sum(bool(case.get("directionCorrect")) for case in source) / max(1, len(source)),
        }

    engineering_all = [case for case in cases if case["split"] == "engineering" and "rms" in case]
    score_thresholds=[.5,.6,.7,.75,.8,.825,.85,.875,.9]
    engineering_score_sweep={}
    selected_yunet_threshold=.85;selected_disagreement=float('inf');best_accepted=-1
    for score_threshold in score_thresholds:
        eligible=accepted_for(engineering_all,0,score_threshold);disagreements=np.asarray([float(case["geometryDisagreement"])for case in eligible]);rows=[]
        for reject_fraction in [0,.02,.05,.08,.1,.15]:
            guard=float(np.quantile(disagreements,1-reject_fraction))if reject_fraction else float('inf');accepted=accepted_for(engineering_all,0,score_threshold,guard);summary=summarize(accepted);full=summary["fullMarkupRmsNme"];critical=summary["criticalPointNme"];meets=len(accepted)>=1000 and full["median"]<=.03 and full["p95"]<=.08 and all(value["median"]<=.03 and value["p95"]<=.08 for value in critical.values());rows.append({"rejectFraction":reject_fraction,"maximumGeometryDisagreement":guard if math.isfinite(guard)else None,"accepted":len(accepted),"meetsCoordinateGates":meets,"fullMarkupRmsNme":full,"mentonNme":critical["menton"]})
            if meets and len(accepted)>best_accepted:selected_yunet_threshold=score_threshold;selected_disagreement=guard;best_accepted=len(accepted)
        engineering_score_sweep[str(score_threshold)]={"eligibleBeforeConsistency":len(eligible),"rows":rows}
    engineering_candidates=[case for case in engineering_all if float(case["yunetScore"])>=selected_yunet_threshold]
    engineering_total=len(engineering_candidates)
    confidence_values = np.asarray([float(case["confidenceP10"]) for case in engineering_candidates])
    thresholds = sorted(set([0.0] + [float(np.quantile(confidence_values, q)) for q in np.linspace(0, .25, 51)]))
    selected_threshold = 0.0
    engineering_selection: dict[str, object] | None = None
    for threshold in thresholds:
        accepted = accepted_for(engineering_candidates, threshold, selected_yunet_threshold,selected_disagreement)
        summary = summarize(accepted)
        full = summary["fullMarkupRmsNme"]
        critical = summary["criticalPointNme"]
        meets = len(accepted) / engineering_total >= .9 and full["median"] <= .03 and full["p95"] <= .08 \
            and all(value["median"] <= .03 and value["p95"] <= .08 for value in critical.values())
        if meets:
            selected_threshold = threshold
            engineering_selection = {"accepted": len(accepted), "coverage": len(accepted) / engineering_total, **summary}
            break
    if engineering_selection is None:
        selected_threshold = float(np.quantile(confidence_values, .1))
        accepted = accepted_for(engineering_candidates, selected_threshold, selected_yunet_threshold,selected_disagreement)
        engineering_selection = {"accepted": len(accepted), "coverage": len(accepted) / engineering_total, **summarize(accepted)}

    holdout_total = sum(1 for case in cases if case["split"] == "holdout")
    holdout_candidates = [case for case in cases if case["split"] == "holdout" and "rms" in case]
    holdout_product_eligible = len([case for case in holdout_candidates if float(case["yunetScore"])>=selected_yunet_threshold])
    accepted_holdout = accepted_for(holdout_candidates, selected_threshold, selected_yunet_threshold,selected_disagreement)
    holdout_summary = summarize(accepted_holdout)
    rejected = Counter()
    for case in [case for case in cases if case["split"] == "holdout"]:
        if "rms" not in case:
            rejected[str(case.get("rejection", "unknown"))] += 1
        elif float(case["yunetScore"])<selected_yunet_threshold:
            rejected["yunet_score_below_frozen_threshold"] += 1
        elif not bool(case["directionCorrect"]):
            rejected["profile_direction_conflict"] += 1
        elif float(case["geometryDisagreement"])>selected_disagreement:
            rejected["geometry_models_disagree"]+=1
        elif float(case["confidenceP10"]) < selected_threshold:
            rejected["landmark_confidence_below_frozen_threshold"] += 1

    evaluated = len(accepted_holdout)
    full = holdout_summary["fullMarkupRmsNme"]
    critical = holdout_summary["criticalPointNme"]
    direction_pool=[case for case in holdout_candidates if float(case["yunetScore"])>=selected_yunet_threshold]
    direction_accuracy = sum(bool(case["directionCorrect"]) for case in direction_pool) / max(1, len(direction_pool))

    conditional_gates = {
        "engineeringCalibrationDetectionsAtLeast500": sum(len(values) for values in mapping.values()) >= 500,
        "eachOrientationCalibrationDetectionsAtLeast100": min(len(values) for values in mapping.values()) >= 100,
        "holdoutEvaluatedAtLeast280": evaluated >= 280,
        "acceptedCoverageOfProductEligibleAtLeast88Percent": evaluated / max(1, holdout_product_eligible) >= .88,
        "holdoutMedianRmsNmeAtMost3Percent": full["median"] is not None and full["median"] <= .03,
        "holdoutP95RmsNmeAtMost8Percent": full["p95"] is not None and full["p95"] <= .08,
        "eachCriticalMedianAtMost3Percent": all(value["median"] is not None and value["median"] <= .03 for value in critical.values()),
        "eachCriticalP95AtMost8Percent": all(value["p95"] is not None and value["p95"] <= .08 for value in critical.values()),
        "directionAccuracyAtLeast95Percent": direction_accuracy >= .95,
    }
    coverage_gates = {"productGateAcceptsAtLeast85PercentOfBroadMenpoHoldout": holdout_product_eligible / holdout_total >= .85}
    result = {
        "testedAt": datetime.now(timezone.utc).isoformat(),
        "policyVersion": "HEADUP-MENPO39-YUNET-CROP-CALIBRATION-1.0",
        "source": {"dataset": "Menpo 2D challenge trainset", "profiles": 2290, "imagesRetained": False},
        "partition": {"engineering": sum(1 for *_, split in records if split == "engineering"), "holdout": holdout_total},
        "detectionCounts": {"|".join(key): value for key, value in detection_counts.items()},
        "crop": {"byOrientation": crop_by_orientation, "inputSize": IMAGE_SIZE, "trainingGroundTruthFactor": TRAINING_FACTOR, "minimumYuNetScore": selected_yunet_threshold, "minimumConfidenceP10": selected_threshold,"maximumGeometryDisagreement":selected_disagreement if math.isfinite(selected_disagreement)else None},
        "engineeringYuNetThresholdSweep":engineering_score_sweep,
        "engineeringSelection": engineering_selection,
        "holdout": {"evaluated": evaluated, "coverageOfAllBroadImages": evaluated / holdout_total, "productEligible": holdout_product_eligible, "productEligibleCoverage": holdout_product_eligible / holdout_total, "acceptedCoverageOfProductEligible": evaluated / max(1, holdout_product_eligible), "rejected": dict(rejected), **holdout_summary, "directionAccuracy": direction_accuracy, "inferenceMs": distribution(inference_ms)},
        "conditionalModelGates": conditional_gates,
        "broadCoverageGates": coverage_gates,
        "passesConditionalModelGates": all(conditional_gates.values()),
        "passesAllProductGates": all(conditional_gates.values()) and all(coverage_gates.values()),
        "retention": {"archiveDeleted": True, "imagesDeletedAfterRun": True, "perImagePredictionsRetained": False},
    }
    result_path.parent.mkdir(parents=True, exist_ok=True)
    result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["candidateCropCalibration"] = {**result["crop"], "policyVersion": result["policyVersion"], "passesConditionalModelGates": result["passesConditionalModelGates"], "passesAllProductGates": result["passesAllProductGates"]}
    if result["passesAllProductGates"]:
        manifest["cropContract"] = manifest["candidateCropCalibration"]
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
