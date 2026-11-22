// Microphone input: capture with an AudioWorklet at the model's 22050 Hz (or at the device's rate,
// resampled here, in browsers that won't record at 22050 Hz), in chunks, and save the recording as
// a WAV file once it stops.
const RATE = 22050;

// Streaming resampler: four low-pass biquads below the new Nyquist rate (so high frequencies
// don't fold down), then linear interpolation. Gives the same output however the input is chunked.
export class Resampler {
  constructor(from, to) {
    Object.assign(this, { from, to, step: from / to, t: 0, offset: 0, prev: 0 });
    const w = (2 * Math.PI * 0.45 * Math.min(from, to)) / from, alpha = Math.sin(w) / (2 * Math.SQRT1_2), c = Math.cos(w), a0 = 1 + alpha;
    this.b = [(1 - c) / 2 / a0, (1 - c) / a0, (1 - c) / 2 / a0];
    this.a = [(-2 * c) / a0, (1 - alpha) / a0];
    this.z = Array.from({ length: 4 }, () => [0, 0]);
  }

  #filter(input) {
    const y = Float32Array.from(input), [b0, b1, b2] = this.b, [a1, a2] = this.a;
    for (const z of this.z) {
      for (let i = 0; i < y.length; i++) {
        const x = y[i], out = b0 * x + z[0];
        z[0] = b1 * x - a1 * out + z[1];
        z[1] = b2 * x - a2 * out;
        y[i] = out;
      }
    }
    return y;
  }

  push(input) {
    const x = this.from > this.to ? this.#filter(input) : input, end = this.offset + x.length, out = [];
    while (this.t <= end - 1) {
      const i = Math.floor(this.t), frac = this.t - i;
      const a = i >= this.offset ? x[i - this.offset] : this.prev;
      if (i + 1 >= end) {
        if (frac !== 0) break; // needs the next chunk's first sample
        out.push(a);
      } else out.push(a + (x[i + 1 - this.offset] - a) * frac);
      this.t += this.step;
    }
    if (x.length) this.prev = x[x.length - 1];
    this.offset = end;
    return Float32Array.from(out);
  }
}

// 16-bit PCM mono WAV.
export function toWav(samples, rate) {
  const bytes = new Uint8Array(44 + samples.length * 2), v = new DataView(bytes.buffer);
  const text = (o, s) => [...s].forEach((ch, i) => { bytes[o + i] = ch.charCodeAt(0); });
  text(0, 'RIFF'); v.setUint32(4, bytes.length - 8, true); text(8, 'WAVE');
  text(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  text(36, 'data'); v.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => v.setInt16(44 + 2 * i, s < 0 ? Math.max(-32768, Math.round(s * 32768)) : Math.min(32767, Math.round(s * 32767)), true));
  return bytes;
}

const TAP = `class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) { this.port.postMessage(this.buf, [this.buf.buffer]); this.buf = new Float32Array(2048); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('tap', Tap);`;

// Starts the microphone; onAudio(Float32Array at 22050 Hz) for each chunk. Returns { ctx, stop }.
export async function startMic(onAudio) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
  let ctx, source, resampler = null;
  try {
    ctx = new AudioContext({ sampleRate: RATE });
    source = ctx.createMediaStreamSource(stream);
  } catch {
    ctx?.close();
    ctx = new AudioContext();
    source = ctx.createMediaStreamSource(stream);
    resampler = new Resampler(ctx.sampleRate, RATE);
  }
  const url = URL.createObjectURL(new Blob([TAP], { type: 'text/javascript' }));
  await ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  const tap = new AudioWorkletNode(ctx, 'tap'), mute = ctx.createGain();
  mute.gain.value = 0; // keeps the tap running without playing the mic back
  tap.port.onmessage = ({ data }) => onAudio(resampler ? resampler.push(data) : data);
  source.connect(tap).connect(mute).connect(ctx.destination);
  await ctx.resume();
  return {
    ctx,
    stop() {
      tap.port.onmessage = null;
      for (const track of stream.getTracks()) track.stop();
      ctx.close();
    },
  };
}
