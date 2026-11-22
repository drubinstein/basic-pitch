// Let LiteRT.js's browser/worker loader run under Node: it calls importScripts() when that exists
// and fetch()es the .wasm next to it.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
globalThis.require = createRequire(import.meta.url);
globalThis.self = globalThis;
const toPath = (u) => (String(u).startsWith('file:') ? fileURLToPath(String(u)) : String(u));
globalThis.importScripts = (url) => {
  // Run the Emscripten loader as CommonJS so its Node code path finds require/__dirname.
  const file = toPath(url);
  const fn = vm.runInThisContext('(function (require, __dirname, __filename, module, exports) {' + fs.readFileSync(file, 'utf8') + '\n})', { filename: file });
  const module = { exports: {} };
  fn(createRequire(file), path.dirname(file), file, module, module.exports);
  if (!globalThis.ModuleFactory && typeof module.exports === 'function') globalThis.ModuleFactory = module.exports;
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const s = String(url);
  if (s.startsWith('/') || s.startsWith('file:')) {
    const body = fs.readFileSync(toPath(s));
    return new Response(body, { headers: { 'Content-Type': s.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream' } });
  }
  return realFetch(url, init);
};
