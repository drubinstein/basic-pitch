"""Reference notes from basic_pitch.note_creation for web/test/original.test.mjs.

Runs output_to_notes_polyphonic (Basic Pitch's own note creation, with the predict() defaults) on
the vocadito_10 model outputs in web/test/fixtures, as is and tiled 4 times, with and without the
melodia trick, and once without inferred onsets. Run from the repo root:
    python web/tools/make_original_fixture.py
"""

import gzip
import json
import pathlib

import numpy as np

from basic_pitch.note_creation import output_to_notes_polyphonic

FIXTURES = pathlib.Path(__file__).resolve().parents[1] / "test/fixtures"


def load(name: str) -> np.ndarray:
    return np.frombuffer(gzip.decompress((FIXTURES / name).read_bytes()), dtype=np.float32).reshape(-1, 88)


def main() -> None:
    note, onset = load("vocadito_10_note.f32.gz"), load("vocadito_10_onset.f32.gz")
    out = {"onset_thresh": 0.5, "frame_thresh": 0.3, "min_note_len": 11, "energy_tol": 11, "cases": []}
    cases = [(1, True, True), (1, False, True), (4, True, True), (4, False, True), (1, True, False)]
    for repeat, melodia, infer in cases:
        notes = output_to_notes_polyphonic(
            np.tile(note, (repeat, 1)),
            np.tile(onset, (repeat, 1)),
            onset_thresh=0.5,
            frame_thresh=0.3,
            min_note_len=11,
            infer_onsets=infer,
            max_freq=None,
            min_freq=None,
            melodia_trick=melodia,
        )
        rounded = [[s, e, p, round(a, 6)] for s, e, p, a in notes]
        out["cases"].append({"repeat": repeat, "melodia": melodia, "infer": infer, "notes": rounded})
    (FIXTURES / "vocadito_10_original.json").write_text(json.dumps(out) + "\n")
    print({(c["repeat"], c["melodia"], c["infer"]): len(c["notes"]) for c in out["cases"]})


if __name__ == "__main__":
    main()
