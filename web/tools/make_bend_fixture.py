"""Reference pitch bends and MIDI for web/test/bends.test.mjs, from basic_pitch.note_creation.

Takes the web model's contour output for vocadito_10 (web/tools/make_contour_fixture.mjs) and the
original-decoder notes for it (web/tools/make_original_fixture.py), and records what basic-pitch makes
of them: get_pitch_bends per note, and the pitch-wheel and note events note_events_to_midi writes
(one instrument, so bends of overlapping notes are dropped). Run from the repo root:
    python web/tools/make_bend_fixture.py
"""

import gzip
import io
import json
import pathlib

import mido
import numpy as np

from basic_pitch.note_creation import get_pitch_bends, model_frames_to_time, note_events_to_midi

FIXTURES = pathlib.Path(__file__).resolve().parents[1] / "test/fixtures"


def main() -> None:
    contour = np.frombuffer(gzip.decompress((FIXTURES / "vocadito_10_contour.f32.gz").read_bytes()), dtype=np.float32)
    contour = contour.reshape(-1, 264)
    ref = json.loads((FIXTURES / "vocadito_10_original.json").read_text())
    case = next(c for c in ref["cases"] if c["repeat"] == 1 and c["melodia"] and c["infer"])
    notes = [(s, e, p, a) for s, e, p, a in case["notes"]]
    with_bends = get_pitch_bends(contour, notes)
    times = model_frames_to_time(contour.shape[0])
    events = [(times[s], times[e], p, a, b) for s, e, p, a, b in with_bends]
    buf = io.BytesIO()
    note_events_to_midi(events).write(buf)
    midi = mido.MidiFile(file=io.BytesIO(buf.getvalue()))
    track, tick, messages = midi.tracks[-1], 0, []
    for msg in track:
        tick += msg.time
        if msg.type == "pitchwheel":
            messages.append(["bend", tick, msg.pitch])
        elif msg.type in ("note_on", "note_off"):
            messages.append(["on" if msg.type == "note_on" and msg.velocity > 0 else "off", tick, msg.note])
    out = {
        "bends": [[s, e, p, [int(v) for v in b]] for s, e, p, _, b in with_bends],
        "midi": messages,
        "ppq": midi.ticks_per_beat,
    }
    (FIXTURES / "vocadito_10_bends.json").write_text(json.dumps(out) + "\n")
    print(len(out["bends"]), "notes;", sum(m[0] == "bend" for m in messages), "pitch-wheel events")


if __name__ == "__main__":
    main()
