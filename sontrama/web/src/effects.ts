import workletUrl from "./effects.worklet.ts?worker&url";
import { EffectDSP } from "./effects-dsp";
import { effectVector } from "./effect-schema";
import type { Effect } from "./types";

export interface EffectNode {
  input: AudioNode;
  output: AudioNode;
  configure(spec: Effect): void;
  close(): void;
}
const prepared = new WeakMap<AudioContext, Promise<void>>();
export async function prepareEffects(context: AudioContext) {
  if (!context.audioWorklet) return;
  if (!prepared.has(context))
    prepared.set(context, context.audioWorklet.addModule(workletUrl));
  await prepared.get(context);
}

export function makeEffect(context: AudioContext, spec: Effect): EffectNode {
  if (context.audioWorklet) {
    const node = new AudioWorkletNode(context, "sontrama-effect", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
      processorOptions: { kind: spec.kind, parameters: effectVector(spec) },
    });
    return {
      input: node,
      output: node,
      configure: (next) =>
        node.port.postMessage({
          type: "configure",
          parameters: effectVector(next),
        }),
      close() {
        node.port.postMessage({ type: "close" });
        node.port.close();
        node.disconnect();
      },
    };
  }
  const dsp = new EffectDSP(spec.kind, context.sampleRate, effectVector(spec));
  const node = context.createScriptProcessor(1024, 2, 2);
  node.onaudioprocess = (event) => {
    const left = event.outputBuffer.getChannelData(0),
      right = event.outputBuffer.getChannelData(1);
    left.set(event.inputBuffer.getChannelData(0));
    right.set(event.inputBuffer.getChannelData(1));
    dsp.process(left, right);
  };
  return {
    input: node,
    output: node,
    configure: (next) => dsp.configure(effectVector(next)),
    close() {
      node.onaudioprocess = null;
      node.disconnect();
    },
  };
}
