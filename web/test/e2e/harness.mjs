// Shared setup for the browser tests: a static server for dist/ and a headless Chrome page on it.
// The server sends the cross-origin isolation headers itself, so coi-serviceworker has nothing to do
// and the page doesn't reload under the test. Chrome comes from CHROME_PATH, or the usual install path.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const DIST = path.resolve(import.meta.dirname, '../../dist');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.wav': 'audio/wav' };
const CHROME = process.env.CHROME_PATH
  || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome');

export function serve() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error('No dist/ build: run `npm run build` first.');
  const server = http.createServer((req, res) => {
    let file = path.join(DIST, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(DIST)) return res.writeHead(403).end();
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() })));
}

// A headless Chrome. `fakeMic` swaps getUserMedia for a 440 Hz tone, since a real one can hang headless.
export async function launch() {
  return puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-first-run', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      ...(process.platform === 'darwin' ? ['--enable-features=NetworkServiceInProcess2', '--disable-features=NetworkServiceSandbox'] : [])],
  });
}

export async function openPage(browser, url, { fakeMic = false } = {}) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  if (fakeMic) {
    await page.evaluateOnNewDocument(() => {
      navigator.mediaDevices.getUserMedia = async () => {
        const ctx = new AudioContext(), osc = ctx.createOscillator(), dest = ctx.createMediaStreamDestination();
        osc.frequency.value = 440;
        osc.connect(dest);
        osc.start();
        return dest.stream;
      };
    });
  }
  await page.setViewport({ width: 1200, height: 800 });
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => self.crossOriginIsolated, { timeout: 10000 });
  return { page, errors };
}

// A mono 16-bit WAV of a sine tone, written to a temp file; returns its path.
export function toneFile(name, seconds, hz = 440) {
  const rate = 22050, n = Math.round(seconds * rate), buf = Buffer.alloc(44 + 2 * n);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + 2 * n, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(2 * rate, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(2 * n, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(12000 * Math.sin((2 * Math.PI * hz * i) / rate)), 44 + 2 * i);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bp-e2e-')), name);
  fs.writeFileSync(file, buf);
  return file;
}

export const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

// Open an audio file through the file picker and wait until it's playable.
export async function openFile(page, file) {
  const name = file.split(/[\\/]/).pop();
  await (await page.$('#file')).uploadFile(file);
  await page.waitForFunction((n) => window.basicPitch?.name === n && !document.getElementById('play').disabled, { timeout: 30000 }, name);
}

// Press play and wait until the audio is actually moving.
export async function play(page) {
  await page.click('#play');
  await page.waitForFunction(() => { const a = document.getElementById('audio'); return !a.paused && a.currentTime > 0.1; }, { timeout: 10000 });
}
