from __future__ import annotations

import datetime
import json
import math
import runpy
import sys
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort

CAL = runpy.run_path(str(Path(__file__).with_name('calibrate-menpo39-yunet-crop.py')), run_name='headup_direct_repeatability')
detect, crop_matrix, tensor_for, restore, distribution = (CAL[name] for name in ['detect', 'crop_matrix', 'tensor_for', 'restore', 'distribution'])
CROP = {
    'left': (1.138812414528869, .03847504237478136, .11833929151974497),
    'right': (1.1504958141994608, -.03945996063163659, .12225221823707466),
}
METRICS = [
    'softTissueConvexityAngle', 'eLine', 'nasolabialAngle', 'mentolabialAngle',
    'softTissueChinProjection', 'mandibularPlaneInclinationProxy', 'profileVerticalProportion',
]


def physical(vector: np.ndarray) -> dict[str, float | np.ndarray]:
    return {
        'softTissueConvexityAngle': float(vector[0] * 180),
        'eLine': np.asarray([vector[1], vector[2]], dtype=np.float64),
        'nasolabialAngle': float(vector[3] * 180),
        'mentolabialAngle': float(vector[4] * 180),
        'softTissueChinProjection': float(vector[5]),
        'mandibularPlaneInclinationProxy': float(vector[6] * 90),
        'profileVerticalProportion': np.asarray([vector[7], vector[8]], dtype=np.float64),
    }


def metric_difference(left: float | np.ndarray, right: float | np.ndarray) -> float:
    if isinstance(left, np.ndarray):
        return float(np.max(np.abs(left - right)))
    return abs(float(left) - float(right))


def main() -> None:
    if len(sys.argv) != 6:
        raise SystemExit('usage: script LONDON_DIR GLOBAL_ONNX GEOMETRY_ONNX YUNET_ONNX RESULT_JSON')
    london_dir, global_path, geometry_path, yunet_path, result_path = map(Path, sys.argv[1:])
    files = sorted(london_dir.glob('*_profile.jpg'))
    if len(files) != 204:
        raise RuntimeError(f'expected 204 profile images, found {len(files)}')
    detector = ort.InferenceSession(str(yunet_path), providers=['CPUExecutionProvider'])
    global_session = ort.InferenceSession(str(global_path), providers=['CPUExecutionProvider'])
    geometry_session = ort.InferenceSession(str(geometry_path), providers=['CPUExecutionProvider'])
    records: dict[tuple[str, str], dict[str, float | np.ndarray]] = {}
    rejected: dict[str, int] = {}
    for path in files:
        subject = path.stem[:3]
        side = 'left' if '_left_profile' in path.stem else 'right'
        image = cv2.imread(str(path))
        box, score = detect(detector, image)
        if box is None or score < .85:
            rejected['yunet'] = rejected.get('yunet', 0) + 1
            continue
        matrix, inverse = crop_matrix(box, *CROP[side])
        tensor = tensor_for(image, matrix)
        normalized = global_session.run(['coordinates'], {'input': tensor})[0][0]
        landmarks = restore(normalized, inverse)
        direction = np.sign(landmarks[19, 0] - landmarks[10, 0])
        if (side == 'right' and direction <= 0) or (side == 'left' and direction >= 0):
            rejected['direction'] = rejected.get('direction', 0) + 1
            continue
        vector = np.asarray(geometry_session.run(['geometry'], {'input': tensor})[0][0], dtype=np.float64)
        if vector.shape != (9,) or not np.isfinite(vector).all():
            rejected['geometry'] = rejected.get('geometry', 0) + 1
            continue
        records[(subject, side)] = physical(vector)
    differences = {name: [] for name in METRICS}
    paired_subjects = 0
    for subject in sorted({key[0] for key in records}):
        if (subject, 'left') not in records or (subject, 'right') not in records:
            continue
        left, right = records[(subject, 'left')], records[(subject, 'right')]
        for name in METRICS:
            differences[name].append(metric_difference(left[name], right[name]))
        paired_subjects += 1
    result = {
        'testedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'policyVersion': 'HEADUP-LONDON-DIRECT-GEOMETRY-REPEATABILITY-1.0',
        'source': {'subjects': 102, 'images': 204, 'imagesCopied': False},
        'runtimeContract': {
            'globalLandmarks': 'menpo39-profile-v1.onnx',
            'directGeometry': 'menpo39-profile-geometry-v1.onnx',
            'minimumYuNetScore': .85,
            'directionGate': 'noseTip19 versus pogonion10',
        },
        'eligibleImages': len(records),
        'pairedSubjects': paired_subjects,
        'rejected': rejected,
        'pairedMetricDifference': {name: distribution(values) for name, values in differences.items()},
        'interpretation': 'Left/right paired repeatability of the exact direct-geometry values displayed by the app. Not manual landmark truth or per-image accuracy.',
        'retention': {'imagesCopied': False, 'individualPredictionsRetained': False},
    }
    result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
