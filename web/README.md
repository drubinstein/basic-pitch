# Basic Pitch Live

Basic Pitch in the browser, deployed to GitHub Pages by `.github/workflows/pages.yml`. Audio stays on the
visitor's machine: the page decodes it to 22050 Hz mono, a worker runs the model one 2-second window at a time
with [LiteRT.js](https://ai.google.dev/edge/litert/web), and a streaming HMM decoder turns each window's
note and onset activations into notes as soon as they are final. The piano roll pans and zooms like a map.

Like map tiles, whatever is on screen is transcribed first. Windows can be processed in any order: each run
of windows gets its own streaming HMM, started one window (1.65 s) early so its notes match decoding from the
start, and where two runs meet the earlier one keeps going only until the notes it started are final
(`src/segments.js`). The HMM keeps only `maxLag` frames of history, and windows are dropped once no decoder
needs them, so memory doesn't grow with the file. Finished results are saved in the browser's IndexedDB,
keyed by a hash of the file and the mode, so reopening a file is instant (`src/cache.js`).

Two modes: **Live** is the streaming HMM above; **Original** is Basic Pitch's own note creation with the melodia
trick (`src/original.js`, a port of `output_to_notes_polyphonic` that gives the same notes as the Python code),
which needs the whole file, so its notes come at the end. The worker keeps the model's output, so the
**control panel** (`src/params.js`, `src/knob.js`) can re-decode with other settings, or the other decoder, in
milliseconds without running the model again.

The transcribe tab works like a map: the roll fills the screen with controls floating over it. **Layers** shows
the model's output before decoding and/or the notes. Playing follows the playhead (`src/playback.js`), and
**Song / Notes / Both** plays the notes on a small synth over the song to compare (`src/synth.js`). **Mic**
streams the microphone to the worker, which runs each model window as soon as its audio is in, so notes trail the
sound by about one window (`src/mic.js`). Pitch bends come from the model's contour output as in basic-pitch (`src/bends.js`): drawn
through each note, played by the synth, and written to the MIDI file. Notes download as MIDI written like
basic-pitch's (`src/midi.js`). The
How to use, Report and About tabs explain the controls, what we tried and why (with charts from
`src/report-data.json`), and credits.

```
npm ci
npm test        # windowing and timing vs Python, HMM and original notes vs the Python code, any window
                # order gives the same notes, MIDI and pitch bends vs Python, control-panel knobs, playback, synth scheduling, mic resampling
                # and WAV, chart helpers, cache round trip, model smoke test
npm run build   # static site in dist/
npm run serve   # serve dist/ on http://localhost:8123 with no special headers, like GitHub Pages
```

- `model/nmp_web.tflite` is `basic_pitch/saved_models/icassp_2022/nmp.tflite` with two metadata-only edits
  LiteRT.js needs (fixed batch size, outputs taken before the final reshapes). Rebuild it with
  `python web/tools/make_web_model.py` (needs `basic-pitch[tf]`); it checks the outputs are identical.
- LiteRT.js uses threads only when the page is cross-origin isolated. GitHub Pages can't send the COOP/COEP
  headers, so `coi-serviceworker` adds them; without it the model runs on one thread.
- Browsers resample with their own resampler, while the Python package uses librosa (soxr), so model
  outputs can differ slightly from `basic-pitch`'s for audio that isn't already 22050 Hz.
