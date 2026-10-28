import type { Effect, Session } from "./types";
import type { VoiceEngine } from "./voice-engine";
import { createBanksEngine } from "./banks-engine";
import { createThreeOscEngine } from "./three-osc-engine";

interface EffectNode {
  input: AudioNode;
  output: AudioNode;
  close(): void;
}

function makeEffect(context: AudioContext, spec: Effect): EffectNode {
  const input = context.createGain();
  const output = context.createGain();
  const nodes: AudioNode[] = [input, output];
  let oscillator: OscillatorNode | undefined;
  if (spec.kind === "gain") {
    output.gain.value = 10 ** (spec.value / 20);
    input.connect(output);
  } else if (spec.kind === "filter") {
    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = spec.value;
    filter.Q.value = Math.SQRT1_2;
    input.connect(filter).connect(output);
    nodes.push(filter);
  } else {
    const dry = context.createGain();
    const wet = context.createGain();
    nodes.push(dry, wet);
    if (spec.kind === "chorus") {
      const delay = context.createDelay(0.08);
      delay.delayTime.value = 0.025;
      oscillator = context.createOscillator();
      const modulation = context.createGain();
      oscillator.frequency.value = 0.8;
      modulation.gain.value = 0.005;
      oscillator.connect(modulation).connect(delay.delayTime);
      oscillator.start();
      dry.gain.value = 1 - spec.value * 0.5;
      wet.gain.value = spec.value * 0.5;
      input.connect(delay).connect(wet).connect(output);
      nodes.push(delay, oscillator, modulation);
    } else {
      dry.gain.value = 1 - spec.value;
      wet.gain.value = spec.value;
      // Four feedback combs parallel the native effect, with crossed stereo feedback.
      for (const seconds of [0.0297, 0.0371, 0.0411, 0.0437]) {
        const delay = context.createDelay(0.1);
        delay.delayTime.value = seconds;
        const feedback = context.createGain();
        feedback.gain.value = 0.72;
        const combGain = context.createGain();
        combGain.gain.value = 0.25;
        const split = context.createChannelSplitter(2);
        const merge = context.createChannelMerger(2);
        input.connect(delay);
        delay.connect(split);
        split.connect(merge, 0, 1);
        split.connect(merge, 1, 0);
        merge.connect(feedback).connect(delay);
        delay.connect(combGain).connect(wet);
        nodes.push(delay, feedback, combGain, split, merge);
      }
      wet.connect(output);
    }
    input.connect(dry).connect(output);
  }
  return {
    input,
    output,
    close() {
      oscillator?.stop();
      nodes.forEach((node) => node.disconnect());
    },
  };
}

export class BrowserInstrument {
  context: AudioContext | null = null;
  private engine: VoiceEngine | null = null;
  private kind: Session["instrument"] | null = null;
  private pending: Promise<void> = Promise.resolve();
  private source: AudioNode | null = null;
  private effects: EffectNode[] = [];
  private channel: GainNode | null = null;
  private master: GainNode | null = null;
  private limiter: WaveShaperNode | null = null;
  channelMeter: AnalyserNode | null = null;
  masterMeter: AnalyserNode | null = null;
  private effectSignature = "";
  private generation = 0;
  private state: Session | null = null;
  private activeNotes = new Map<number, number>();

  get ready() {
    return (
      this.kind === this.state?.instrument && (this.engine?.ready ?? false)
    );
  }

  async start(state: Session, automatic = false) {
    if (this.context) {
      const resumed = this.context.resume();
      if (automatic) void resumed.catch(() => {});
      else await resumed;
      await this.apply(state);
      return;
    }
    const context = (this.context = new AudioContext({
      latencyHint: "interactive",
    }));
    try {
      const resumed = context.resume();
      if (automatic) void resumed.catch(() => {});
      else await resumed;
      this.channel = context.createGain();
      this.master = context.createGain();
      this.channelMeter = context.createAnalyser();
      this.masterMeter = context.createAnalyser();
      this.channelMeter.fftSize = 256;
      this.masterMeter.fftSize = 256;
      this.limiter = context.createWaveShaper();
      const curve = new Float32Array(65537);
      for (let i = 0; i < curve.length; i++)
        curve[i] = Math.max(-1, Math.min(1, ((i / 65536) * 2 - 1) * 4));
      // Scale into the curve's input domain, then hard-limit at +/-1 like the native output.
      const pre = context.createGain();
      pre.gain.value = 0.25;
      this.limiter.curve = curve;
      this.channel.connect(this.channelMeter).connect(this.master);
      this.master
        .connect(this.masterMeter)
        .connect(pre)
        .connect(this.limiter)
        .connect(context.destination);
      await this.apply(state);
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  apply(state: Session): Promise<void> {
    const generation = this.generation;
    const next = this.pending
      .catch(() => {})
      .then(async () => {
        if (generation !== this.generation || !this.context) return;
        this.state = state;
        if (!this.engine || this.kind !== state.instrument) {
          const factories = {
            banks: createBanksEngine,
            "three-osc": createThreeOscEngine,
          };
          const engine = await factories[state.instrument](this.context, state);
          if (generation !== this.generation) {
            engine.close();
            return;
          }
          try {
            await engine.configure(state);
          } catch (error) {
            engine.close();
            throw error;
          }
          if (generation !== this.generation) {
            engine.close();
            return;
          }
          this.engine?.close();
          this.engine = engine;
          this.kind = state.instrument;
          this.source = engine.node;
          this.effectSignature = "";
        } else await this.engine.configure(state);
        if (generation !== this.generation || !this.context) return;
        const signature = JSON.stringify(state.effects);
        if (signature !== this.effectSignature) {
          this.resetEffects();
        }
        this.channel!.gain.setTargetAtTime(
          state.mute ? 0 : state.volume,
          this.context.currentTime,
          0.01,
        );
        this.master!.gain.setTargetAtTime(
          state.master,
          this.context.currentTime,
          0.01,
        );
      });
    this.pending = next;
    return next;
  }

  midi(data: number[], transpose = true) {
    if (!this.ready || !this.engine) return;
    const routed = [...data],
      kind = data[0] & 0xf0;
    if (transpose && (kind === 0x80 || kind === 0x90)) {
      if (kind === 0x90 && data[2]) {
        const key = data[1] + (this.state?.octave ?? 0) * 12;
        if (key < 0 || key > 127) return;
        this.activeNotes.set(data[1], key);
        routed[1] = key;
      } else {
        routed[1] = this.activeNotes.get(data[1]) ?? data[1];
        this.activeNotes.delete(data[1]);
      }
    }
    this.engine.midi(routed);
  }

  private resetEffects() {
    if (!this.source || !this.context || !this.channel || !this.state) return;
    this.source.disconnect();
    this.effects.forEach((effect) => effect.close());
    this.effects = this.state.effects
      .filter((effect) => effect.enabled)
      .map((effect) => makeEffect(this.context!, effect));
    let tail = this.source;
    for (const effect of this.effects) {
      tail.connect(effect.input);
      tail = effect.output;
    }
    tail.connect(this.channel);
    this.effectSignature = JSON.stringify(this.state.effects);
  }

  panic(resetEffects = true) {
    this.engine?.panic();
    this.activeNotes.clear();
    this.engine?.midi([0xb0, 64, this.state?.sustain ? 127 : 0]);
    if (resetEffects) this.resetEffects();
  }

  async stop() {
    this.generation++;
    this.panic(false);
    this.effects.forEach((effect) => effect.close());
    this.effects = [];
    this.source?.disconnect();
    this.engine?.close();
    this.engine = null;
    this.kind = null;
    this.source = null;
    await this.context?.close();
    this.context = null;
    this.effectSignature = "";
  }
}
