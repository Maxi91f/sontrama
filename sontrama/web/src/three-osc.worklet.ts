import { ThreeOscDSP } from "./three-osc-dsp";
import type { ThreeOscPatch } from "./types";
declare const sampleRate: number;
declare abstract class AudioWorkletProcessor {
  port: MessagePort;
}
declare function registerProcessor(name: string, processor: unknown): void;
class ThreeOscProcessor extends AudioWorkletProcessor {
  private synth: ThreeOscDSP;
  private closed = false;
  constructor(options: { processorOptions: { patch: ThreeOscPatch } }) {
    super();
    this.synth = new ThreeOscDSP(sampleRate, options.processorOptions.patch);
    this.port.onmessage = (event) => {
      if (event.data.type === "midi") this.synth.midi(event.data.data);
      else if (event.data.type === "configure")
        this.synth.configure(event.data.patch);
      else if (event.data.type === "panic") this.synth.panic();
      else if (event.data.type === "close") {
        this.synth.panic();
        this.closed = true;
      }
    };
  }
  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    const [left, right] = outputs[0];
    if (this.closed) {
      left.fill(0);
      right.fill(0);
      return false;
    }
    this.synth.process(left, right);
    return true;
  }
}
registerProcessor("sontrama-three-osc", ThreeOscProcessor);
