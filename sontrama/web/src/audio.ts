import type { Session } from "./types";
import type { VoiceEngine } from "./voice-engine";
import { createBanksEngine } from "./banks-engine";
import { createThreeOscEngine } from "./three-osc-engine";

import { makeEffect, prepareEffects, type EffectNode } from "./effects";

export class BrowserInstrument {
  context: AudioContext | null = null;
  private engine: VoiceEngine | null = null;
  private kind: Session["instrument"] | null = null;
  private pending: Promise<void> = Promise.resolve();
  private source: AudioNode | null = null;
  private effects: EffectNode[] = [];
  private masterEffects: EffectNode[] = [];
  private channelPan: StereoPannerNode | null = null;
  private masterPan: StereoPannerNode | null = null;
  channelStereo: AnalyserNode[] = [];
  masterStereo: AnalyserNode[] = [];
  channelPitch: AnalyserNode[] = [];
  masterPitch: AnalyserNode[] = [];
  private channel: GainNode | null = null;
  private master: GainNode | null = null;
  private limiter: WaveShaperNode | null = null;
  channelMeter: AnalyserNode | null = null;
  masterMeter: AnalyserNode | null = null;
  private effectSignature = "";
  private masterEffectSignature = "";
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
      await prepareEffects(context);
      this.channel = context.createGain();
      this.channelPan = context.createStereoPanner();
      this.masterPan = context.createStereoPanner();
      this.channelPan.connect(this.channel);
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
      this.channel.connect(this.channelMeter);
      this.masterPan.connect(this.master);
      const stereoMeters = (node: AudioNode, fftSize = 2048) => {
        const splitter = context.createChannelSplitter(2);
        node.connect(splitter);
        return [0, 1].map((channel) => {
          const analyser = context.createAnalyser();
          analyser.fftSize = fftSize;
          splitter.connect(analyser, channel);
          return analyser;
        });
      };
      this.channelStereo = stereoMeters(this.channel);
      this.masterStereo = stereoMeters(this.master);
      this.channelPitch = stereoMeters(this.channel, 4096);
      this.masterPitch = stereoMeters(this.master, 4096);
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

  apply(state: Session, reload = false): Promise<void> {
    const generation = this.generation;
    const next = this.pending
      .catch(() => {})
      .then(async () => {
        if (generation !== this.generation || !this.context) return;
        this.state = state;
        if (reload || !this.engine || this.kind !== state.instrument) {
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
          this.masterEffectSignature = "";
        } else await this.engine.configure(state);
        if (generation !== this.generation || !this.context) return;
        if (
          JSON.stringify(
            state.effects.map(({ id, kind, enabled }) => [id, kind, enabled]),
          ) !== this.effectSignature ||
          JSON.stringify(
            state.master_effects.map(({ id, kind, enabled }) => [
              id,
              kind,
              enabled,
            ]),
          ) !== this.masterEffectSignature
        )
          this.resetEffects(false);
        this.effects.forEach((effect, index) =>
          effect.configure(state.effects.filter((spec) => spec.enabled)[index]),
        );
        this.masterEffects.forEach((effect, index) =>
          effect.configure(
            state.master_effects.filter((spec) => spec.enabled)[index],
          ),
        );
        this.channelPan!.pan.setTargetAtTime(
          state.pan,
          this.context.currentTime,
          0.01,
        );
        this.masterPan!.pan.setTargetAtTime(
          state.master_pan,
          this.context.currentTime,
          0.01,
        );
        this.channel!.gain.setTargetAtTime(
          state.mute ? 0 : state.volume,
          this.context.currentTime,
          0.01,
        );
        this.master!.gain.setTargetAtTime(
          state.master_mute ? 0 : state.master,
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

  private resetEffects(force = true) {
    if (!this.source || !this.context || !this.channel || !this.state) return;
    const channelSignature = JSON.stringify(
      this.state.effects.map(({ id, kind, enabled }) => [id, kind, enabled]),
    );
    const masterSignature = JSON.stringify(
      this.state.master_effects.map(({ id, kind, enabled }) => [
        id,
        kind,
        enabled,
      ]),
    );
    // Rebuilding one bus must not cut the other bus's reverb or delay tails.
    if (force || channelSignature !== this.effectSignature) {
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
      tail.connect(this.channelPan!);
      this.effectSignature = channelSignature;
    }
    if (force || masterSignature !== this.masterEffectSignature) {
      this.channelMeter!.disconnect();
      this.masterEffects.forEach((effect) => effect.close());
      this.masterEffects = this.state.master_effects
        .filter((effect) => effect.enabled)
        .map((effect) => makeEffect(this.context!, effect));
      let tail: AudioNode = this.channelMeter!;
      for (const effect of this.masterEffects) {
        tail.connect(effect.input);
        tail = effect.output;
      }
      tail.connect(this.masterPan!);
      this.masterEffectSignature = masterSignature;
    }
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
    this.masterEffects.forEach((effect) => effect.close());
    this.effects = [];
    this.masterEffects = [];
    this.channelStereo = [];
    this.masterStereo = [];
    this.channelPitch = [];
    this.masterPitch = [];
    this.channelMeter = null;
    this.masterMeter = null;
    this.source?.disconnect();
    this.engine?.close();
    this.engine = null;
    this.kind = null;
    this.source = null;
    await this.context?.close();
    this.context = null;
    this.effectSignature = "";
    this.masterEffectSignature = "";
  }
}
