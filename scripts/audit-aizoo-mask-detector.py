import argparse
import json
from pathlib import Path

import cv2
import numpy as np


FEATURE_MAP_SIZES = [[33, 33], [17, 17], [9, 9], [5, 5], [3, 3]]
ANCHOR_SIZES = [[0.04, 0.056], [0.08, 0.11], [0.16, 0.22], [0.32, 0.45], [0.64, 0.72]]
ANCHOR_RATIOS = [[1, 0.62, 0.42]] * 5


def generate_anchors():
    groups = []
    for index, feature_size in enumerate(FEATURE_MAP_SIZES):
        cx = (np.linspace(0, feature_size[0] - 1, feature_size[0]) + 0.5) / feature_size[0]
        cy = (np.linspace(0, feature_size[1] - 1, feature_size[1]) + 0.5) / feature_size[1]
        cx_grid, cy_grid = np.meshgrid(cx, cy)
        center = np.concatenate((np.expand_dims(cx_grid, -1), np.expand_dims(cy_grid, -1)), axis=-1)
        anchor_count = len(ANCHOR_SIZES[index]) + len(ANCHOR_RATIOS[index]) - 1
        center_tiled = np.tile(center, (1, 1, 2 * anchor_count))
        dimensions = []
        for scale in ANCHOR_SIZES[index]:
            ratio = ANCHOR_RATIOS[index][0]
            width, height = scale * np.sqrt(ratio), scale / np.sqrt(ratio)
            dimensions.extend([-width / 2, -height / 2, width / 2, height / 2])
        for ratio in ANCHOR_RATIOS[index][1:]:
            scale = ANCHOR_SIZES[index][0]
            width, height = scale * np.sqrt(ratio), scale / np.sqrt(ratio)
            dimensions.extend([-width / 2, -height / 2, width / 2, height / 2])
        groups.append((center_tiled + np.array(dimensions)).reshape((-1, 4)))
    return np.expand_dims(np.concatenate(groups, axis=0), axis=0)


def decode_bbox(anchors, outputs):
    variances = np.array([0.1, 0.1, 0.2, 0.2])
    centers_x = (anchors[:, :, 0:1] + anchors[:, :, 2:3]) / 2
    centers_y = (anchors[:, :, 1:2] + anchors[:, :, 3:4]) / 2
    widths = anchors[:, :, 2:3] - anchors[:, :, 0:1]
    heights = anchors[:, :, 3:4] - anchors[:, :, 1:2]
    scaled = outputs * variances
    predicted_x = scaled[:, :, 0:1] * widths + centers_x
    predicted_y = scaled[:, :, 1:2] * heights + centers_y
    predicted_w = np.exp(scaled[:, :, 2:3]) * widths
    predicted_h = np.exp(scaled[:, :, 3:4]) * heights
    return np.concatenate((predicted_x - predicted_w / 2, predicted_y - predicted_h / 2,
                           predicted_x + predicted_w / 2, predicted_y + predicted_h / 2), axis=-1)


def nms(boxes, confidences, confidence_threshold=0.05, iou_threshold=0.4):
    source_indices = np.where(confidences > confidence_threshold)[0]
    boxes, confidences = boxes[source_indices], confidences[source_indices]
    if len(boxes) == 0:
        return np.array([], dtype=np.int64)
    xmin, ymin, xmax, ymax = boxes[:, 0], boxes[:, 1], boxes[:, 2], boxes[:, 3]
    areas = (xmax - xmin + 1e-3) * (ymax - ymin + 1e-3)
    indices, picked = np.argsort(confidences), []
    while len(indices):
        last = len(indices) - 1
        chosen = indices[last]
        picked.append(chosen)
        overlap_xmin = np.maximum(xmin[chosen], xmin[indices[:last]])
        overlap_ymin = np.maximum(ymin[chosen], ymin[indices[:last]])
        overlap_xmax = np.minimum(xmax[chosen], xmax[indices[:last]])
        overlap_ymax = np.minimum(ymax[chosen], ymax[indices[:last]])
        overlap = np.maximum(0, overlap_xmax - overlap_xmin) * np.maximum(0, overlap_ymax - overlap_ymin)
        iou = overlap / (areas[indices[:last]] + areas[chosen] - overlap)
        indices = np.delete(indices, np.concatenate(([last], np.where(iou > iou_threshold)[0])))
    return source_indices[picked]


def infer(net, output_names, anchors, image_path):
    image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError(f"Unable to decode {image_path}")
    rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
    net.setInput(cv2.dnn.blobFromImage(rgb, scalefactor=1 / 255.0, size=(260, 260)))
    outputs = net.forward(output_names)
    bbox_output = next((value for value in outputs if value.shape[-1] == 4), None)
    class_output = next((value for value in outputs if value.shape[-1] == 2), None)
    if bbox_output is None or class_output is None:
        raise ValueError(f"Unexpected model outputs: {[value.shape for value in outputs]}")
    boxes, classes = decode_bbox(anchors, bbox_output)[0], class_output[0]
    winning_scores = np.max(classes, axis=1)
    winning_classes = np.argmax(classes, axis=1)
    kept = nms(boxes, winning_scores)
    mask_scores = [float(classes[index, 0]) for index in kept if winning_classes[index] == 0]
    return {
        "maskScore": max(mask_scores, default=0.0),
        "detectionCount": int(len(kept)),
        "maskDetectionCount": len(mask_scores),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--prototxt", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    net = cv2.dnn.readNet(args.model, args.prototxt)
    layer_names = net.getLayerNames()
    output_names = [layer_names[int(index) - 1] for index in np.array(net.getUnconnectedOutLayers()).flatten()]
    anchors = generate_anchors()
    with Path(args.output).open("x", encoding="utf-8") as output:
        for index, record in enumerate(manifest["records"]):
            result = infer(net, output_names, anchors, Path(record["absolutePath"]))
            output.write(json.dumps({"sampleId": record["sampleId"], **result}, separators=(",", ":")) + "\n")
            if (index + 1) % 100 == 0 or index + 1 == len(manifest["records"]):
                print(f"Scored {index + 1}/{len(manifest['records'])}", flush=True)


if __name__ == "__main__":
    main()
