// Plays the transcribed notes with a simple synth, in time with the song, so the two can be compared
// (song, notes, or both). Notes are { t0, t1, pitch, velocity } in seconds of the song. While
// playing, tick(t) with the song's time schedules the notes starting in the next LOOKAHEAD seconds.
import { noteHz } from './notes.js';

const LOOKAHEAD = 0.25, MAX_VOICES = 32;

export const byStart = (notes) => [...notes].sort((a, b) => a.t0 - b.t0 || a.pitch - b.pitch);

// Notes (sorted by start) that start in [from, to).
export function startingIn(sorted, from, to) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid].t0 < from) lo = mid + 1; else hi = mid; }
  const out = [];
  for (let i = lo; i < sorted.length && sorted[i].t0 < to; i++) out.push(sorted[i]);
  return out;
}

// Peak gain of one voice for a MIDI velocity, quiet enough for chords.
export const voiceGain = (velocity) => (velocity > 0 ? 0.22 * (Math.min(127, velocity) / 127) ** 1.5 : 0);

// Gains for the song and the notes for each listening choice.
export const mix = (listen) => (listen === 'song' ? { song: 1, notes: 0 } : listen === 'notes' ? { song: 0, notes: 1 } : { song: 0.8, notes: 0.8 });

export class NotePlayer {
  constructor(ctx, out) {
    Object.assign(this, { ctx, out, notes: [], voices: new Set(), until: null });
  }

  // New notes keep coming during transcription; ones that start later than what's already
  // scheduled will still play.
  setNotes(notes) {
    this.notes = byStart(notes);
  }

  // Silence everything, e.g. on pause or a jump.
  reset() {
    const now = this.ctx.currentTime;
    for (const v of this.voices) {
      v.gain.gain.cancelScheduledValues(now);
      v.gain.gain.setTargetAtTime(0, now, 0.01);
      try { v.osc.stop(now + 0.06); } catch { /* not started yet */ }
    }
    this.voices.clear();
    this.until = null;
  }

  // t: the song's current time.
  tick(t) {
    const now = this.ctx.currentTime, offset = now - t;
    let from = this.until;
    if (from === null || from < t) {
      // Starting (or after a hiccup): notes already sounding come in right away.
      for (const n of this.notes) if (n.t0 < t && t < n.t1 - 0.05) this.#voice(n, now, n.t1 + offset);
      from = t;
    }
    const to = t + LOOKAHEAD;
    for (const n of startingIn(this.notes, from, to)) this.#voice(n, Math.max(now, n.t0 + offset), n.t1 + offset);
    this.until = to;
  }

  get active() { return this.voices.size; }

  #voice(n, start, end) {
    if (this.voices.size >= MAX_VOICES) return;
    const { ctx } = this, osc = ctx.createOscillator(), gain = ctx.createGain(), peak = voiceGain(n.velocity);
    const stopAt = Math.max(end, start + 0.05);
    osc.type = 'triangle';
    osc.frequency.value = noteHz(n.pitch);
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(peak, start + 0.008);
    gain.gain.setTargetAtTime(peak * 0.55, start + 0.008, 0.25);
    gain.gain.setTargetAtTime(0, stopAt, 0.04);
    osc.connect(gain).connect(this.out);
    osc.start(start);
    osc.stop(stopAt + 0.3);
    const v = { osc, gain };
    this.voices.add(v);
    osc.onended = () => { this.voices.delete(v); osc.disconnect(); gain.disconnect(); };
  }
}
