import workletUrl from "./shared-dsp.worklet.ts?worker&url";
import { WasmCore, WasmPipeline } from "./dsp-core";
import { prepareDSP, type PreparedDSP } from "./dsp-loader";
import type { Session } from "./types";
const worklets = new WeakMap<AudioContext, Promise<PreparedDSP>>();
export function prepareEffects(context: AudioContext): Promise<PreparedDSP> {
  if (!worklets.has(context))
    worklets.set(
      context,
      (async () => {
        const prepared = await prepareDSP();
        if (context.audioWorklet)
          await context.audioWorklet.addModule(workletUrl);
        return prepared;
      })(),
    );
  return worklets.get(context)!;
}
export interface PipelineNode {
  input: AudioNode;
  output: AudioNode;
  channel: AudioNode;
  master: AudioNode;
  configure(state: Session, reset?: boolean): void;
  close(): void;
}
export async function createPipeline(
  context: AudioContext,
  state: Session,
): Promise<PipelineNode> {
  const prepared = await prepareEffects(context);
  if (context.audioWorklet) {
    const node = new AudioWorkletNode(context, "sontrama-pipeline", {
      numberOfInputs: 1,
      numberOfOutputs: 3,
      outputChannelCount: [2, 2, 2],
      channelCount: 2,
      channelCountMode: "explicit",
      processorOptions: { module: prepared.module, state },
    });
    const taps = [0, 1, 2].map((index) => {
      const tap = context.createGain();
      tap.channelCount = 2;
      tap.channelCountMode = "explicit";
      node.connect(tap, index);
      return tap;
    });
    return {
      input: node,
      output: taps[0],
      channel: taps[1],
      master: taps[2],
      configure(next, reset = false) {
        node.port.postMessage({ type: "configure", state: next, reset });
      },
      close() {
        node.port.postMessage({ type: "close" });
        node.port.close();
        node.disconnect();
        taps.forEach((tap) => tap.disconnect());
      },
    };
  }
  // One shared pipeline avoids adding a ScriptProcessor buffer for every effect.
  const dsp = new WasmPipeline(
    new WasmCore(prepared.module),
    context.sampleRate,
    state,
  );
  const node = context.createScriptProcessor(1024, 2, 6);
  node.onaudioprocess = (event) =>
    dsp.process(
      event.inputBuffer.getChannelData(0),
      event.inputBuffer.getChannelData(1),
      [0, 2, 4].map((index) => [
        event.outputBuffer.getChannelData(index),
        event.outputBuffer.getChannelData(index + 1),
      ]),
    );
  const splitter = context.createChannelSplitter(6);
  node.connect(splitter);
  const taps = [0, 2, 4].map((index) => {
    const tap = context.createChannelMerger(2);
    splitter.connect(tap, index, 0);
    splitter.connect(tap, index + 1, 1);
    return tap;
  });
  return {
    input: node,
    output: taps[0],
    channel: taps[1],
    master: taps[2],
    configure(next, reset = false) {
      dsp.configure(next, reset);
    },
    close() {
      node.onaudioprocess = null;
      node.disconnect();
      splitter.disconnect();
      taps.forEach((tap) => tap.disconnect());
      dsp.close();
    },
  };
}
