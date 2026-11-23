// The time axis under the piano roll is a seek bar: click to jump, drag to scrub, arrow keys to step.
// Needs a build (npm run build) and Chrome; run with npm run test:e2e.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { serve, launch, openPage, toneFile, openFile, play, settle } from './harness.mjs';

let server, browser;
before(async () => { server = await serve(); browser = await launch(); });
after(async () => { await browser?.close(); server?.close(); });

const LONG = toneFile('long.wav', 20);
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} is not within ${tol} of ${b}`);

// The seek bar's box, and the times at its two ends.
async function bar(page) {
  const box = await (await page.$('#scrub')).boundingBox();
  const { t0, span } = await page.evaluate(() => { const r = window.pianoRoll; return { t0: r.t0, span: r.view().span }; });
  return { ...box, y: box.y + box.height / 2, t0, span, at: (f) => ({ x: box.x + f * box.width, t: t0 + f * span }) };
}
const now = (page) => page.evaluate(() => ({ time: document.getElementById('audio').currentTime, playhead: window.pianoRoll.playhead, t0: window.pianoRoll.t0 }));

async function zoomIn(page) {
  await page.focus('#roll');
  await page.keyboard.press('+');
  await page.keyboard.press('+');
  await settle(100);
}

test('clicking the time axis jumps there', async () => {
  const { page, errors } = await openPage(browser, server.url);
  await openFile(page, LONG);
  const b = await bar(page), mid = b.at(0.5);
  await page.mouse.click(mid.x, b.y);
  await settle(200);
  const n = await now(page);
  near(n.time, mid.t, 0.1, 'audio time');
  near(n.playhead, mid.t, 0.1, 'playhead');
  assert.equal(n.t0, b.t0, 'the view stays put');
  assert.deepEqual(errors, []);
  await page.close();
});

test('dragging along the axis scrubs, without panning the view', async () => {
  const { page, errors } = await openPage(browser, server.url);
  await openFile(page, LONG);
  await zoomIn(page);
  const b = await bar(page), from = b.at(0.2), to = b.at(0.8);
  assert.ok(b.t0 > 0 && b.span < 20, 'zoomed in, so a pan would show');
  await page.mouse.move(from.x, b.y);
  await page.mouse.down();
  await page.mouse.move(b.at(0.5).x, b.y, { steps: 5 });
  near((await now(page)).time, b.at(0.5).t, 0.1, 'audio time mid-drag');
  await page.mouse.move(to.x, b.y, { steps: 5 });
  await page.mouse.up();
  await settle(200);
  const n = await now(page);
  near(n.time, to.t, 0.1, 'audio time after the drag');
  assert.equal(n.t0, b.t0, 'the view stays put');
  assert.deepEqual(errors, []);
  await page.close();
});

test('while following the playhead, scrubbing holds the view still, and following resumes after', async () => {
  const { page, errors } = await openPage(browser, server.url);
  await openFile(page, LONG);
  await zoomIn(page);
  await play(page);
  assert.equal(await page.evaluate(() => window.pianoRoll.following), true);
  const b = await bar(page);
  await page.mouse.move(b.at(0.1).x, b.y);
  await page.mouse.down();
  const held = (await now(page)).t0;
  await page.mouse.move(b.at(0.9).x, b.y, { steps: 8 });
  await settle(300);
  assert.equal((await now(page)).t0, held, 'the view stays still while dragging');
  await page.mouse.up();
  assert.equal(await page.evaluate(() => window.pianoRoll.following), true);
  assert.equal(await page.evaluate(() => document.getElementById('audio').paused), false, 'still playing');
  assert.deepEqual(errors, []);
  await page.close();
});

test('dragging the roll above the axis still pans and does not seek', async () => {
  const { page, errors } = await openPage(browser, server.url);
  await openFile(page, LONG);
  await zoomIn(page);
  const b = await bar(page), y = b.y - 200;
  await page.mouse.move(b.at(0.7).x, y);
  await page.mouse.down();
  await page.mouse.move(b.at(0.3).x, y, { steps: 5 });
  await page.mouse.up();
  await settle(200);
  const n = await now(page);
  assert.ok(n.t0 > b.t0, 'the view panned');
  assert.equal(n.time, 0, 'no seek');
  assert.deepEqual(errors, []);
  await page.close();
});

test('the seek bar works from the keyboard and reports where it is', async () => {
  const { page, errors } = await openPage(browser, server.url);
  await openFile(page, LONG);
  await page.focus('#scrub');
  const aria = () => page.$eval('#scrub', (s) => ({ role: s.getAttribute('role'), now: +s.getAttribute('aria-valuenow'), max: +s.getAttribute('aria-valuemax'), text: s.getAttribute('aria-valuetext') }));
  const a = await aria();
  assert.equal(a.role, 'slider');
  near(a.max, 20, 0.05, 'aria-valuemax');
  await page.keyboard.press('ArrowRight');
  await settle(150);
  near((await now(page)).time, 5, 0.05, 'ArrowRight');
  assert.deepEqual(await aria().then(({ now: v, text }) => [Math.round(v), text]), [5, '0:05.0']);
  await page.keyboard.down('Shift');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.up('Shift');
  await settle(150);
  near((await now(page)).time, 6, 0.05, 'shift+ArrowRight');
  await page.keyboard.press('End');
  await settle(150);
  near((await now(page)).time, 20, 0.05, 'End');
  await page.keyboard.press('Home');
  await settle(150);
  near((await now(page)).time, 0, 0.05, 'Home');
  assert.deepEqual(errors, []);
  await page.close();
});

test('the axis is not a seek bar while recording from the microphone', async () => {
  const { page, errors } = await openPage(browser, server.url, { fakeMic: true });
  await openFile(page, LONG);
  assert.equal(await page.$eval('#scrub', (s) => s.hidden), false);
  await page.click('#mic');
  await page.waitForFunction(() => document.getElementById('mic').classList.contains('recording'), { timeout: 10000 });
  assert.equal(await page.$eval('#scrub', (s) => s.hidden), true);
  await settle(1000);
  await page.click('#mic');
  await page.waitForFunction(() => window.basicPitch?.recording && window.basicPitch.done, { timeout: 30000 });
  await page.waitForFunction(() => !document.getElementById('scrub').hidden, { timeout: 10000 });
  assert.deepEqual(errors, []);
  await page.close();
});
