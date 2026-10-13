import argparse
import json
import os
import sys
from collections import OrderedDict
from pathlib import Path

import cv2
import numpy as np
import torch
import torch.nn.functional as functional


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    parser.add_argument("--london", required=True)
    parser.add_argument("--physical-manifest", required=True)
    parser.add_argument("--output", required=True)
    return parser.parse_args()


args = parse_args()
repo_dir = Path(args.repo).resolve()
sys.path.insert(0, str(repo_dir))

from src.anti_spoof_predict import AntiSpoofPredict, MODEL_MAPPING  # noqa: E402
from src.data_io import transform as transforms  # noqa: E402
from src.generate_patches import CropImage  # noqa: E402
from src.utility import get_kernel, parse_model_name  # noqa: E402


def load_models(model_dir):
    loaded = []
    device = torch.device("cpu")
    for model_path in sorted(Path(model_dir).glob("*.pth")):
        height, width, model_type, scale = parse_model_name(model_path.name)
        model = MODEL_MAPPING[model_type](conv6_kernel=get_kernel(height, width)).to(device)
        state_dict = torch.load(model_path, map_location=device, weights_only=True)
        first_key = next(iter(state_dict))
        if first_key.startswith("module."):
            state_dict = OrderedDict((key[7:], value) for key, value in state_dict.items())
        model.load_state_dict(state_dict)
        model.eval()
        loaded.append({"path": model_path, "height": height, "width": width, "scale": scale, "model": model})
    if len(loaded) != 2:
        raise RuntimeError(f"Expected two Silent-Face ensemble models, found {len(loaded)}")
    return loaded


detector = AntiSpoofPredict(0)
cropper = CropImage()
to_tensor = transforms.Compose([transforms.ToTensor()])
models = load_models(repo_dir / "resources" / "anti_spoof_models")


def score_image(image):
    if image is None or image.size == 0:
        return None
    bbox = detector.get_bbox(image)
    if bbox[2] <= 1 or bbox[3] <= 1:
        return None
    prediction = np.zeros((1, 3), dtype=np.float64)
    for item in models:
        parameters = {
            "org_img": image,
            "bbox": bbox,
            "scale": item["scale"],
            "out_w": item["width"],
            "out_h": item["height"],
            "crop": item["scale"] is not None,
        }
        crop = cropper.crop(**parameters)
        tensor = to_tensor(crop).unsqueeze(0)
        with torch.no_grad():
            prediction += functional.softmax(item["model"](tensor), dim=1).cpu().numpy()
    real_score = float(prediction[0, 1] / len(models))
    return round(1.0 - real_score, 8)


london_files = sorted(Path(args.london).glob("*_front.jpg"))
if len(london_files) != 102:
    raise RuntimeError(f"Expected 102 London front images, found {len(london_files)}")
bona_fide_scores = []
for index, image_path in enumerate(london_files):
    print(f"Scoring authorized bona-fide {index + 1}/102", flush=True)
    bona_fide_scores.append(score_image(cv2.imread(str(image_path), cv2.IMREAD_COLOR)))

physical_manifest_path = Path(args.physical_manifest).resolve()
physical_manifest = json.loads(physical_manifest_path.read_text(encoding="utf-8"))
fractions = [0.15, 0.3, 0.45, 0.6, 0.75, 0.9]
video_scores = []
for video_index, record in enumerate(physical_manifest["samples"]):
    video_path = physical_manifest_path.parent / record["relativePath"]
    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise RuntimeError(f"Unable to decode replay video slot {video_index + 1}")
    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    if frame_count < 2:
        raise RuntimeError(f"Invalid frame count for replay video slot {video_index + 1}")
    scores = []
    for frame_index, fraction in enumerate(fractions):
        print(f"Scoring replay video {video_index + 1}/6 frame {frame_index + 1}/6", flush=True)
        target_frame = min(frame_count - 1, max(0, round((frame_count - 1) * fraction)))
        capture.set(cv2.CAP_PROP_POS_FRAMES, target_frame)
        success, frame = capture.read()
        if not success:
            raise RuntimeError(f"Unable to read replay video {video_index + 1} frame {frame_index + 1}")
        scores.append(score_image(frame))
    capture.release()
    video_scores.append(scores)

output = {
    "policyVersion": "HEADUP-SILENT-FACE-SCORES-1.0",
    "runtime": {
        "python": sys.version.split()[0],
        "torch": torch.__version__,
        "opencv": cv2.__version__,
        "numpy": np.__version__,
        "device": "cpu",
    },
    "ensembleModels": [item["path"].name for item in models],
    "bonaFideScores": bona_fide_scores,
    "videoScores": video_scores,
    "sampleFractions": fractions,
    "retention": {"imagesWritten": False, "framesWritten": False, "individualScoresTemporary": True},
}
Path(args.output).write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
