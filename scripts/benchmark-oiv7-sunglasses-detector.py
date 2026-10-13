import json
import hashlib
import sys
from pathlib import Path

project_dir = Path(__file__).resolve().parent.parent
benchmark_dir = project_dir / 'data' / 'face-benchmark'
detector_dir = benchmark_dir / '.staging' / 'oiv7-sunglasses-detector'
runtime_dir = detector_dir / 'python-runtime'
sys.path.insert(0, str(runtime_dir))

from ultralytics import YOLO

positive_dir = benchmark_dir / '.staging' / 'openimages-sunglasses'
positive_manifest_path = positive_dir / 'manifest.json'
current_gate_path = positive_dir / 'current-gate-results.json'
negative_manifest_path = project_dir / 'data' / 'face-db-real-research' / 'manifest.jsonl'
detector_manifest_path = detector_dir / 'manifest.json'
variant = sys.argv[1] if len(sys.argv) > 1 else 'n'
if variant not in {'n', 's'}:
    raise RuntimeError(f'Unsupported model variant: {variant}')
model_path = detector_dir / f'yolov8{variant}-oiv7.pt'
result_path = benchmark_dir / ('oiv7-sunglasses-detector-result.json' if variant == 'n' else f'oiv7{variant}-sunglasses-detector-result.json')

if result_path.exists():
    raise RuntimeError(f'Refusing to overwrite existing result: {result_path}')

positive_manifest = json.loads(positive_manifest_path.read_text(encoding='utf-8'))
current_gate = json.loads(current_gate_path.read_text(encoding='utf-8'))
detector_manifest = json.loads(detector_manifest_path.read_text(encoding='utf-8'))
sources = json.loads((benchmark_dir / 'sources.json').read_text(encoding='utf-8'))
source = next(item for item in sources['sources'] if item['id'] == 'ultralytics-yolov8n-oiv7-research-detector')
if variant == 'n':
    model_candidate = {
        'variant': 'n', 'name': source['name'], 'url': source['modelUrl'],
        'bytes': source['modelBytes'], 'sha256': source['modelSha256'],
        'parametersMillions': 3.5, 'officialOpenImagesMap50To95': 18.4,
    }
else:
    model_candidate = next(item for item in source['additionalModels'] if item['variant'] == variant)
model_bytes = model_path.read_bytes()
if len(model_bytes) != model_candidate['bytes'] or hashlib.sha256(model_bytes).hexdigest() != model_candidate['sha256']:
    raise RuntimeError(f'YOLOv8{variant} model verification failed before inference')
if current_gate.get('policyVersion') != 'HEADUP-OPENIMAGES-SUNGLASSES-TRANSIENT-GATE-1.0':
    raise RuntimeError('Unexpected transient current-gate policy')

positive_records = positive_manifest['records']
gate_records = {item['sampleId']: item for item in current_gate['records']}
if len(positive_records) != 87 or set(gate_records) != {item['sampleId'] for item in positive_records}:
    raise RuntimeError('Positive manifest and current-gate results do not align')

negative_records = []
for line in negative_manifest_path.read_text(encoding='utf-8').splitlines():
    item = json.loads(line)
    if item.get('view') == 'front':
        negative_records.append({
            'partition': item['partition'],
            'path': project_dir / 'data' / 'face-db-real-research' / item['relativePath'],
        })
if len(negative_records) != 102 or sum(item['partition'] == 'holdout' for item in negative_records) != 17:
    raise RuntimeError('Unexpected unobstructed-control partition counts')

model = YOLO(str(model_path))
class_ids = [int(key) for key, value in model.names.items() if value == 'Sunglasses']
if len(class_ids) != 1:
    raise RuntimeError('Sunglasses class is missing or ambiguous')
sunglasses_class_id = class_ids[0]

def maximum_confidence(path: Path) -> float:
    prediction = model.predict(
        source=str(path), imgsz=640, conf=0.001, iou=0.7, classes=[sunglasses_class_id],
        max_det=10, device='cpu', verbose=False,
    )[0]
    if prediction.boxes is None or len(prediction.boxes) == 0:
        return 0.0
    return float(prediction.boxes.conf.max().item())

positive_scores = []
for index, item in enumerate(positive_records):
    if index % 10 == 0:
        print(f'Positive sunglasses inference {index + 1}/{len(positive_records)}', flush=True)
    positive_scores.append({
        'sampleId': item['sampleId'],
        'split': item['split'],
        'score': maximum_confidence(positive_dir / item['relativePath']),
    })

negative_scores = []
for index, item in enumerate(negative_records):
    if index % 10 == 0:
        print(f'Unobstructed control inference {index + 1}/{len(negative_records)}', flush=True)
    negative_scores.append({'partition': item['partition'], 'score': maximum_confidence(item['path'])})

thresholds = [0.01, 0.02, 0.03, 0.05, 0.075, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5]
validation_positive = [item for item in positive_scores if item['split'] == 'validation']
test_positive = [item for item in positive_scores if item['split'] == 'test']
engineering_negative = [item for item in negative_scores if item['partition'] == 'engineering_qa']
holdout_negative = [item for item in negative_scores if item['partition'] == 'holdout']
current_false_accept_ids = {sample_id for sample_id, item in gate_records.items() if item['combinedPass']}

threshold_analysis = []
for threshold in thresholds:
    validation_detected = sum(item['score'] >= threshold for item in validation_positive)
    test_detected = sum(item['score'] >= threshold for item in test_positive)
    engineering_false_positive = sum(item['score'] >= threshold for item in engineering_negative)
    holdout_false_positive = sum(item['score'] >= threshold for item in holdout_negative)
    caught_current_false_accepts = sum(
        item['sampleId'] in current_false_accept_ids and item['score'] >= threshold
        for item in positive_scores
    )
    threshold_analysis.append({
        'threshold': threshold,
        'tuningValidationPositiveDetected': validation_detected,
        'tuningValidationPositiveTotal': len(validation_positive),
        'tuningValidationRecall': round(validation_detected / len(validation_positive), 4),
        'tuningEngineeringNegativeFalsePositive': engineering_false_positive,
        'tuningEngineeringNegativeTotal': len(engineering_negative),
        'tuningEngineeringFalsePositiveRate': round(engineering_false_positive / len(engineering_negative), 4),
        'holdoutTestPositiveDetected': test_detected,
        'holdoutTestPositiveTotal': len(test_positive),
        'holdoutTestRecall': round(test_detected / len(test_positive), 4),
        'holdoutNegativeFalsePositive': holdout_false_positive,
        'holdoutNegativeTotal': len(holdout_negative),
        'holdoutNegativeFalsePositiveRate': round(holdout_false_positive / len(holdout_negative), 4),
        'currentGateFalseAcceptsCaught': caught_current_false_accepts,
        'currentGateFalseAcceptsTotal': len(current_false_accept_ids),
        'combinedResidualFalseAccepts': len(current_false_accept_ids) - caught_current_false_accepts,
    })

eligible = [item for item in threshold_analysis if item['tuningEngineeringNegativeFalsePositive'] <= 1]
selection_pool = eligible or threshold_analysis
selected = sorted(
    selection_pool,
    key=lambda item: (
        -item['tuningValidationRecall'],
        item['tuningEngineeringNegativeFalsePositive'],
        -item['threshold'],
    ),
)[0]

result = {
    'policyVersion': 'HEADUP-OIV7-SUNGLASSES-DETECTOR-AUDIT-1.0' if variant == 'n' else f'HEADUP-OIV7{variant.upper()}-SUNGLASSES-DETECTOR-AUDIT-1.0',
    'modelRuntime': detector_manifest,
    'modelCandidate': model_candidate,
    'selection': {
        'positiveSource': 'Open Images validation and test images with official Human face + Sunglasses boxes',
        'positiveValidationTuning': len(validation_positive),
        'positiveTestHoldout': len(test_positive),
        'negativeSource': 'Face Research Lab London neutral front images; nominally unobstructed control assumption',
        'negativeEngineeringTuning': len(engineering_negative),
        'negativeHoldout': len(holdout_negative),
        'thresholdSelectionRule': 'maximize validation-positive recall among thresholds with at most one engineering-control false positive; tie-break by fewer false positives then higher threshold',
        'selectedThreshold': selected['threshold'],
    },
    'thresholdAnalysis': threshold_analysis,
    'selectedThresholdResult': selected,
    'interpretation': f'This evaluates whether the dedicated YOLOv8{variant} Open Images detector can catch real sunglasses that the current production gate accepts. Validation and engineering partitions select a threshold; test and holdout partitions report independent image-level results.',
    'limitations': 'Open Images positives are image-disjoint but subject identity is unknown; London controls are assumed unobstructed from the source protocol and may include ordinary eyewear. The AGPL/Enterprise model is research-only and is not bundled into HeadUp.',
    'retention': {
        'positiveImagesDeletedAfterRun': False,
        'modelDeletedAfterRun': False,
        'runtimeDeletedAfterRun': False,
        'individualPredictionsRetained': False,
        'aggregateOnly': True,
    },
}
result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps({
    'resultPath': str(result_path),
    'selectedThreshold': selected['threshold'],
    'holdoutTestRecall': selected['holdoutTestRecall'],
    'holdoutNegativeFalsePositiveRate': selected['holdoutNegativeFalsePositiveRate'],
    'combinedResidualFalseAccepts': selected['combinedResidualFalseAccepts'],
}, ensure_ascii=False, indent=2), flush=True)
