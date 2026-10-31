import { WasmCore, WasmOscillator, WasmPipeline } from "./dsp-core";
import type { Session, ThreeOscPatch } from "./types";
declare const sampleRate: number;
declare abstract class AudioWorkletProcessor {
  port: MessagePort;
}
declare function registerProcessor(name: string, processor: unknown): void;
class OscillatorProcessor extends AudioWorkletProcessor {
  private dsp: WasmOscillator;
  private closed = false;
  constructor(options: {
    processorOptions: {
      module: WebAssembly.Module;
      tables: Float32Array;
      patch: ThreeOscPatch;
    };
  }) {
    super();
    const { module, tables, patch } = options.processorOptions;
    this.dsp = new WasmOscillator(
      new WasmCore(module, tables),
      sampleRate,
      patch,
    );
    this.port.onmessage = ({ data }) => {
      if (data.type === "configure") this.dsp.configure(data.patch);
      else if (data.type === "midi") this.dsp.midi(data.data);
      else if (data.type === "panic") this.dsp.panic();
      else if (data.type === "close") {
        this.dsp.close();
        this.closed = true;
      }
    };
  }
  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    if (this.closed) return false;
    this.dsp.process(outputs[0][0], outputs[0][1]);
    return true;
  }
}
class PipelineProcessor extends AudioWorkletProcessor {
  private dsp: WasmPipeline;
  private closed = false;
  constructor(options: {
    processorOptions: { module: WebAssembly.Module; state: Session };
  }) {
    super();
    const { module, state } = options.processorOptions;
    this.dsp = new WasmPipeline(new WasmCore(module), sampleRate, state);
    this.port.onmessage = ({ data }) => {
      if (data.type === "configure") this.dsp.configure(data.state, data.reset);
      else if (data.type === "close") {
        this.dsp.close();
        this.closed = true;
      }
    };
  }
  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    if (this.closed) return false;
    this.dsp.process(inputs[0]?.[0], inputs[0]?.[1], outputs);
    return true;
  }
}
registerProcessor("sontrama-three-osc", OscillatorProcessor);
registerProcessor("sontrama-pipeline", PipelineProcessor);
