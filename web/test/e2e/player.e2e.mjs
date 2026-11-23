// The play button in a real browser: it must show Pause exactly while the song is playing, whatever
// stops it (the button, the song ending, opening another file, starting the microphone).
// Needs a build (npm run build) and Chrome; run with npm run test:e2e.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { serve, launch, openPage, toneFile, openFile, play, settle } from './harness.mjs';

let server, browser;
before(async () => { server = await serve(); browser = await launch(); });
after(async () => { await browser?.close(); server?.close(); });

// What the player shows, and what the audio element is doing.
const state = (page) => page.evaluate(() => {
  const audio = document.getElementById('audio'), button = document.getElementById('play');
  return { label: button.getAttribute('aria-label'), playing: document.getElementById('player').classList.contains('playing'), paused: audio.paused };
});
const SHOWS_PLAY = { label: 'Play', playing: false, paused: true };
const SHOWS_PAUSE = { label: 'Pause', playing: true, paused: false };

test('the button shows Pause while playing and Play once paused', async () => {
  const { page, errors } = await openPage(browser, server.url);
  await openFile(page, toneFile('a.wav', 6));
  assert.deepEqual(await state(page), SHOWS_PLAY);
  await play(page);
  assert.deepEqual(await state(page), SHOWS_PAUSE);
  await page.click('#play');
  await settle();
  assert.deepEqual(await state(page), SHOWS_PLAY);
  assert.deepEqual(errors, []);
  await page.close();
});

test('the song ending shows Play', async () => {
  const { page, errors } = await openPage(browser, server.url);
  await openFile(page, toneFile('short.wav', 1.2));
  await play(page);
  await page.waitForFunction(() => document.getElementById('audio').ended, { timeout: 10000 });
  await settle();
  assert.deepEqual(await state(page), SHOWS_PLAY);
  assert.deepEqual(errors, []);
  await page.close();
});

test('opening another file while playing stops it and shows Play', async () => {
  const { page, errors } = await openPage(browser, server.url);
  await openFile(page, toneFile('first.wav', 6));
  await play(page);
  await openFile(page, toneFile('second.wav', 4, 660));
  await settle();
  assert.deepEqual(await state(page), SHOWS_PLAY);
  // One click plays the new file.
  await play(page);
  assert.deepEqual(await state(page), SHOWS_PAUSE);
  assert.deepEqual(errors, []);
  await page.close();
});

test('recording from the microphone while playing stops it, and the recording opens showing Play', async () => {
  const { page, errors } = await openPage(browser, server.url, { fakeMic: true });
  await openFile(page, toneFile('song.wav', 6));
  await play(page);
  await page.click('#mic');
  await page.waitForFunction(() => document.getElementById('mic').classList.contains('recording'), { timeout: 10000 });
  assert.equal((await state(page)).paused, true);
  await settle(1500);
  await page.click('#mic');
  await page.waitForFunction(() => window.basicPitch?.recording && window.basicPitch.done, { timeout: 30000 });
  await page.waitForFunction(() => !document.getElementById('player').hidden && !document.getElementById('play').disabled, { timeout: 10000 });
  await settle();
  assert.deepEqual(await state(page), SHOWS_PLAY);
  assert.deepEqual(errors, []);
  await page.close();
});
