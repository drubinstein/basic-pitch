// Plays the transcribed notes with a simple synth, in time with the song, so the two can be compared
// (a crossfade from the song to the notes). Notes are { t0, t1, pitch, velocity } in seconds of the song. While
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

// The mix knob: -1 is only the song, +1 only the notes, an equal-power crossfade in between.
export function mix(balance) {
  const b = Math.min(1, Math.max(-1, balance)), a = ((b + 1) * Math.PI) / 4;
  return b === -1 ? { song: 1, notes: 0 } : b === 1 ? { song: 0, notes: 1 } : { song: Math.cos(a), notes: Math.sin(a) };
}
export const PRESETS = { song: -1, both: 0, notes: 1 };
export const preset = (balance) => (balance <= -1 ? 'song' : balance >= 1 ? 'notes' : 'both');

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
    const hz = noteHz(n.pitch);
    osc.frequency.value = hz;
    // Pitch bends (1/3 semitone each), one per frame spread over the note, from where the voice starts.
    const b = n.bends ?? [];
    if (b.length > 1) {
      const step = (n.t1 - n.t0) / b.length, from = end - (n.t1 - n.t0);
      let prev = 0;
      for (let i = 0; i < b.length; i++) {
        if (b[i] === prev && i) continue;
        prev = b[i];
        osc.frequency.setValueAtTime(hz * 2 ** (b[i] / 36), Math.max(start, from + i * step));
      }
    }
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
