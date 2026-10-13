"""Run V10 while preventing the projection expert from overwriting direction-owned anchors."""

from __future__ import annotations

import copy
import runpy
from pathlib import Path


V10 = runpy.run_path(
    str(Path(__file__).with_name("train-menpo39-hybrid-context-projection-refiners.py")),
    run_name="headup_menpo39_owned_context_projection_base",
)


def main() -> None:
    config = copy.deepcopy(V10["HYBRID_CONFIG"])
    config["projectionExpert"]["writeIndices"] = [14, 17, 19, 20, 21, 27]
    globals_for_v10 = V10["main"].__globals__
    globals_for_v10["EXPERIMENT_CONFIG"] = config
    globals_for_v10["EXPERIMENT_ARCHITECTURE"] = "Menpo39OwnedContextProjectionRefiners-v11"
    globals_for_v10["EXPERIMENT_POLICY"] = "HEADUP-MENPO39-OWNED-CONTEXT-PROJECTION-REFINERS-1.0"
    globals_for_v10["EXPERIMENT_DESCRIPTION"] = (
        "V10 losses with disjoint write ownership: projection writes only Menpo 14/17/19/20/21/27; "
        "joint context retains mandibular, menton, pogonion, fold and lower-lip anchors"
    )
    V10["main"]()


if __name__ == "__main__":
    main()
