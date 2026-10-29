import { EffectDSP } from "./effects-dsp";
import type { EffectKind } from "./types";
declare const sampleRate: number;
declare abstract class AudioWorkletProcessor {
  port: MessagePort;
}
declare function registerProcessor(name: string, processor: unknown): void;

class EffectProcessor extends AudioWorkletProcessor {
  private dsp: EffectDSP;
  private closed = false;
  constructor(options: {
    processorOptions: { kind: EffectKind; parameters: number[] };
  }) {
    super();
    const { kind, parameters } = options.processorOptions;
    this.dsp = new EffectDSP(kind, sampleRate, parameters);
    this.port.onmessage = (event) => {
      if (event.data.type === "configure")
        this.dsp.configure(event.data.parameters);
      if (event.data.type === "close") this.closed = true;
    };
  }
  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    const [left, right] = outputs[0];
    if (this.closed) return false;
    const inputLeft = inputs[0]?.[0],
      inputRight = inputs[0]?.[1] ?? inputLeft;
    if (inputLeft) left.set(inputLeft);
    else left.fill(0);
    if (inputRight) right.set(inputRight);
    else right.fill(0);
    this.dsp.process(left, right);
    return true;
  }
}
registerProcessor("sontrama-effect", EffectProcessor);
