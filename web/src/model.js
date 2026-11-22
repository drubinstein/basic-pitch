// Run one window through the LiteRT.js model and copy its outputs back to JS arrays.
import { Tensor } from '@litertjs/core';
import { AUDIO_N_SAMPLES } from './pipeline.js';

export async function runWindow(model, samples) {
  const names = model.getOutputDetails().map((d) => d.name);
  const input = new Tensor(samples, [1, AUDIO_N_SAMPLES, 1]);
  const outputs = await model.run(input);
  input.delete?.();
  const result = {};
  for (let i = 0; i < outputs.length; i++) {
    const cpu = await outputs[i].moveTo('wasm');
    result[names[i]] = cpu.toTypedArray().slice();
    cpu.delete();
    outputs[i].delete?.();
  }
  return result;
}
