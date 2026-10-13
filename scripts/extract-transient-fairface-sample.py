"""Extract a deterministic balanced FairFace validation sample for local evaluation.

Requires pyarrow on PYTHONPATH. The output manifest retains only aggregate strata
labels and sequential local filenames; original dataset paths are not copied.
"""

import hashlib
import json
import pathlib
import sys
from collections import defaultdict

import pyarrow.parquet as parquet


AGE_NAMES = ["0-2", "3-9", "10-19", "20-29", "30-39", "40-49", "50-59", "60-69", "70+"]
GENDER_NAMES = ["Male", "Female"]
RACE_NAMES = ["East Asian", "Indian", "Black", "White", "Middle Eastern", "Latino_Hispanic", "Southeast Asian"]


def age_bucket(age_index: int) -> str:
    if age_index <= 1:
        return "0-9"
    if age_index == 2:
        return "10-19"
    if age_index <= 4:
        return "20-39"
    return "40+"


def main() -> None:
    if len(sys.argv) != 5:
        raise SystemExit("usage: extract-transient-fairface-sample.py INPUT.parquet OUTPUT_DIR MANIFEST.json PER_STRATUM")
    parquet_path = pathlib.Path(sys.argv[1])
    output_dir = pathlib.Path(sys.argv[2])
    manifest_path = pathlib.Path(sys.argv[3])
    per_stratum = int(sys.argv[4])
    if per_stratum < 1:
        raise ValueError("PER_STRATUM must be positive")

    output_dir.mkdir(parents=True, exist_ok=True)
    table = parquet.read_table(parquet_path, columns=["image", "age", "gender", "race"])
    strata = defaultdict(list)
    for image, age, gender, race in zip(
        table["image"].to_pylist(),
        table["age"].to_pylist(),
        table["gender"].to_pylist(),
        table["race"].to_pylist(),
    ):
        image_bytes = image["bytes"]
        key = (race, gender, age_bucket(age))
        order = hashlib.sha256(image_bytes).digest()
        strata[key].append((order, image_bytes, age))

    expected_strata = len(RACE_NAMES) * len(GENDER_NAMES) * 4
    if len(strata) != expected_strata:
        raise RuntimeError(f"expected {expected_strata} strata, found {len(strata)}")

    selected = []
    for key in sorted(strata):
        candidates = sorted(strata[key], key=lambda item: item[0])
        if len(candidates) < per_stratum:
            raise RuntimeError(f"stratum {key} has only {len(candidates)} rows")
        for order, image_bytes, age in candidates[:per_stratum]:
            selected.append((key, order, image_bytes, age))

    records = []
    for index, ((race, gender, bucket), _, image_bytes, age) in enumerate(selected, start=1):
        filename = f"sample-{index:04d}.jpg"
        (output_dir / filename).write_bytes(image_bytes)
        records.append({
            "file": filename,
            "race": RACE_NAMES[race],
            "genderPresentation": GENDER_NAMES[gender],
            "ageBucket": bucket,
            "sourceAgeLabel": AGE_NAMES[age],
        })

    manifest = {
        "policyVersion": "HEADUP-TRANSIENT-FAIRFACE-1.0",
        "source": "HuggingFaceM4/FairFace validation config 0.25",
        "selection": "Deterministic SHA-256 order, balanced race x gender-presentation x four age buckets",
        "perStratum": per_stratum,
        "images": len(records),
        "records": records,
    }
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"images": len(records), "strata": len(strata), "manifest": str(manifest_path)}))


if __name__ == "__main__":
    main()
