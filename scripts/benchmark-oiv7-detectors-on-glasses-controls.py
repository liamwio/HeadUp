import json
import sys
from pathlib import Path

project_dir = Path(__file__).resolve().parent.parent
benchmark_dir = project_dir / 'data' / 'face-benchmark'
detector_dir = benchmark_dir / '.staging' / 'oiv7-sunglasses-detector'
sys.path.insert(0, str(detector_dir / 'python-runtime'))

from ultralytics import YOLO

glasses_dir = benchmark_dir / '.staging' / 'openimages-glasses'
manifest = json.loads((glasses_dir / 'manifest.json').read_text(encoding='utf-8'))
n_result = json.loads((benchmark_dir / 'oiv7-sunglasses-detector-result.json').read_text(encoding='utf-8'))
s_result = json.loads((benchmark_dir / 'oiv7s-sunglasses-detector-result.json').read_text(encoding='utf-8'))
result_path = benchmark_dir / 'oiv7-detectors-on-glasses-control-result.json'
if result_path.exists():
    raise RuntimeError(f'Refusing to overwrite existing result: {result_path}')
if len(manifest['records']) != 180:
    raise RuntimeError('Unexpected ordinary-glasses control count')

models = {
    'yolov8n': {
        'model': YOLO(str(detector_dir / 'yolov8n-oiv7.pt')),
        'threshold': float(n_result['selectedThresholdResult']['threshold']),
        'sourceResult': 'oiv7-sunglasses-detector-result.json',
    },
    'yolov8s': {
        'model': YOLO(str(detector_dir / 'yolov8s-oiv7.pt')),
        'threshold': float(s_result['selectedThresholdResult']['threshold']),
        'sourceResult': 'oiv7s-sunglasses-detector-result.json',
    },
}
for value in models.values():
    class_ids = [int(key) for key, name in value['model'].names.items() if name == 'Sunglasses']
    if len(class_ids) != 1:
        raise RuntimeError('Sunglasses class is missing or ambiguous')
    value['classId'] = class_ids[0]

def maximum_confidence(model, class_id, path: Path) -> float:
    prediction = model.predict(
        source=str(path), imgsz=640, conf=0.001, iou=0.7, classes=[class_id],
        max_det=10, device='cpu', verbose=False,
    )[0]
    if prediction.boxes is None or len(prediction.boxes) == 0:
        return 0.0
    return float(prediction.boxes.conf.max().item())

scores = {name: [] for name in models}
for index, item in enumerate(manifest['records']):
    if index % 10 == 0:
        print(f'Ordinary-glasses hard-negative inference {index + 1}/{len(manifest["records"])}', flush=True)
    path = glasses_dir / item['relativePath']
    for name, value in models.items():
        scores[name].append({
            'split': item['split'], 'sizeBand': item['sizeBand'],
            'positionBand': item['positionBand'], 'annotationOcclusion': item['annotationOcclusion'],
            'score': maximum_confidence(value['model'], value['classId'], path),
        })

def summarize(items, threshold):
    flagged = sum(item['score'] >= threshold for item in items)
    return {
        'controls': len(items),
        'sunglassesFalsePositiveProxy': flagged,
        'falsePositiveProxyRate': round(flagged / len(items), 4) if items else None,
    }

model_results = {}
for name, value in models.items():
    items = scores[name]
    threshold = value['threshold']
    model_results[name] = {
        'frozenThreshold': threshold,
        'thresholdSourceResult': value['sourceResult'],
        'overall': summarize(items, threshold),
        'bySplit': {key: summarize([item for item in items if item['split'] == key], threshold) for key in ['validation', 'test']},
        'bySizeBand': {key: summarize([item for item in items if item['sizeBand'] == key], threshold) for key in ['close', 'standard', 'context']},
        'byPositionBand': {key: summarize([item for item in items if item['positionBand'] == key], threshold) for key in ['centered', 'off_center']},
        'byAnnotationOcclusion': {key: summarize([item for item in items if item['annotationOcclusion'] == key], threshold) for key in ['clear', 'occluded']},
    }

result = {
    'policyVersion': 'HEADUP-OIV7-SUNGLASSES-DETECTORS-GLASSES-CONTROL-1.0',
    'selection': {
        'controls': len(manifest['records']),
        'validationControls': sum(item['split'] == 'validation' for item in manifest['records']),
        'testControls': sum(item['split'] == 'test' for item in manifest['records']),
        'criteria': manifest['selection']['candidateCriteria'],
        'labelLimitation': manifest['selection']['labelLimitation'],
        'thresholdsFrozenBeforeThisAudit': True,
    },
    'models': model_results,
    'interpretation': 'These nominal ordinary-glasses images are hard-negative proxies for a Sunglasses detector. Frozen thresholds prevent tuning on this audit set.',
    'limitations': 'Open Images box labels are not exhaustive. A Glasses box without a Sunglasses box does not prove transparent lenses, so counts are false-positive proxies rather than adjudicated clinical false positives.',
    'retention': {
        'controlImagesDeletedAfterRun': False,
        'modelDeletedAfterRun': False,
        'runtimeDeletedAfterRun': False,
        'individualPredictionsRetained': False,
        'aggregateOnly': True,
    },
}
result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps({
    'resultPath': str(result_path),
    'yolov8nFalsePositiveProxy': model_results['yolov8n']['overall']['sunglassesFalsePositiveProxy'],
    'yolov8sFalsePositiveProxy': model_results['yolov8s']['overall']['sunglassesFalsePositiveProxy'],
}, ensure_ascii=False, indent=2), flush=True)
