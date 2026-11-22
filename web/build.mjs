// Assemble the static site in dist/: bundled app + worker, the web model, LiteRT.js wasm files,
// the cross-origin-isolation service worker and the example audio.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const out = 'dist';
const copy = (from, to) => { fs.mkdirSync(path.dirname(path.join(out, to)), { recursive: true }); fs.copyFileSync(from, path.join(out, to)); };

fs.rmSync(out, { recursive: true, force: true });
const common = { bundle: true, minify: true, sourcemap: true, target: 'es2022', logLevel: 'warning' };
await esbuild.build({ ...common, entryPoints: ['src/app.js'], format: 'esm', outfile: `${out}/app.js` });
await esbuild.build({ ...common, entryPoints: ['src/worker.js'], format: 'iife', outfile: `${out}/worker.js` });

copy('index.html', 'index.html');
copy('report.html', 'report.html');
copy('model/nmp_web.tflite', 'model/nmp_web.tflite');
copy('node_modules/coi-serviceworker/coi-serviceworker.min.js', 'coi-serviceworker.min.js');
copy('../tests/resources/vocadito_10.wav', 'examples/vocadito_10.wav');
const wasm = 'node_modules/@litertjs/core/wasm';
for (const f of fs.readdirSync(wasm)) if (!f.includes('jspi')) copy(path.join(wasm, f), path.join('wasm', f));
fs.writeFileSync(path.join(out, '.nojekyll'), '');

const size = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((s, e) => s + (e.isDirectory() ? size(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
console.log(`built ${out}/ (${(size(out) / 1e6).toFixed(1)} MB)`);
