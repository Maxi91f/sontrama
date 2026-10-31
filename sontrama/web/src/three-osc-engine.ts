import { WasmCore, WasmOscillator } from "./dsp-core";
import { prepareEffects } from "./effects";
import type { Session } from "./types";
import type { VoiceEngine } from "./voice-engine";
export async function createThreeOscEngine(
  context: AudioContext,
  state: Session,
): Promise<VoiceEngine> {
  const prepared = await prepareEffects(context);
  let sustain: boolean | undefined;
  if (context.audioWorklet) {
    const node = new AudioWorkletNode(context, "sontrama-three-osc", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: {
        module: prepared.module,
        tables: prepared.tables,
        patch: state.three_osc,
      },
    });
    return {
      node,
      ready: true,
      async configure(next) {
        node.port.postMessage({ type: "configure", patch: next.three_osc });
        if (sustain !== next.sustain) {
          node.port.postMessage({
            type: "midi",
            data: [0xb0, 64, next.sustain ? 127 : 0],
          });
          sustain = next.sustain;
        }
      },
      midi(data) {
        node.port.postMessage({ type: "midi", data });
      },
      panic() {
        node.port.postMessage({ type: "panic" });
      },
      close() {
        node.port.postMessage({ type: "close" });
        node.port.close();
        node.disconnect();
      },
    };
  }
  const dsp = new WasmOscillator(
    new WasmCore(prepared.module, prepared.tables),
    context.sampleRate,
    state.three_osc,
  );
  const node = context.createScriptProcessor(1024, 0, 2);
  node.onaudioprocess = (event) =>
    dsp.process(
      event.outputBuffer.getChannelData(0),
      event.outputBuffer.getChannelData(1),
    );
  return {
    node,
    ready: true,
    async configure(next) {
      dsp.configure(next.three_osc);
      if (sustain !== next.sustain) {
        dsp.midi([0xb0, 64, next.sustain ? 127 : 0]);
        sustain = next.sustain;
      }
    },
    midi(data) {
      dsp.midi(data);
    },
    panic() {
      dsp.panic();
    },
    close() {
      dsp.close();
      node.onaudioprocess = null;
      node.disconnect();
    },
  };
}
