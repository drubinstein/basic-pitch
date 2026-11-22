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
keyed by a hash of the file, so reopening a file is instant (`src/cache.js`).

```
npm ci
npm test        # windowing and timing vs Python, HMM notes vs the Python decoder, any window order
                # gives the same notes, cache round trip, model smoke test
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
