"""Run V10 with separate validation weights for projection nasal anchors and pogonion."""

from __future__ import annotations

import runpy
from pathlib import Path


V10 = runpy.run_path(
    str(Path(__file__).with_name("train-menpo39-hybrid-context-projection-refiners.py")),
    run_name="headup_menpo39_split_control_base",
)

BLEND_CONTROLS = {
    "jointContext": {
        "sourceGroup": "jointContext",
        "writeIndices": list(V10["JOINT_INDICES"]),
    },
    "projectionNasal": {
        "sourceGroup": "projectionExpert",
        "writeIndices": [14, 17, 19, 20, 21, 27],
    },
    "projectionPogonion": {
        "sourceGroup": "projectionExpert",
        "writeIndices": [10],
    },
}


def main() -> None:
    globals_for_v10 = V10["main"].__globals__
    globals_for_v10["EXPERIMENT_BLEND_CONTROLS"] = BLEND_CONTROLS
    globals_for_v10["EXPERIMENT_ARCHITECTURE"] = "Menpo39SplitControlRefiners-v12"
    globals_for_v10["EXPERIMENT_POLICY"] = "HEADUP-MENPO39-SPLIT-CONTROL-REFINERS-1.0"
    globals_for_v10["EXPERIMENT_DESCRIPTION"] = (
        "V10 losses with three validation controls: full joint-context output, projection nasal/brow/upper-lip "
        "indices 14/17/19/20/21/27, and projection pogonion index 10"
    )
    V10["main"]()


if __name__ == "__main__":
    main()
