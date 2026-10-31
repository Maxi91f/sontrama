import type { Session } from "./types";
import type { VoiceEngine } from "./voice-engine";
import { createBanksEngine } from "./banks-engine";
import { createThreeOscEngine } from "./three-osc-engine";
import { createPipeline, prepareEffects, type PipelineNode } from "./effects";
import { prepareDSP } from "./dsp-loader";
import { LocalizedError } from "./i18n";
import contract from "../../src/sontrama/dsp/core_contract.json";
export interface EngineContract {
  core_revision: string;
  sample_rate: number;
  fluidsynth_version: string | null;
}
export class BrowserInstrument {
  context: AudioContext | null = null;
  private engine: VoiceEngine | null = null;
  private kind: Session["instrument"] | null = null;
  private pipeline: PipelineNode | null = null;
  private monitor: GainNode | null = null;
  private monitorVolume = 1;
  private monitorMuted = true;
  private pending: Promise<void> = Promise.resolve();
  private generation = 0;
  private state: Session | null = null;
  private requestedState: Session | null = null;
  private loading = false;
  private queuedMidi: { data: number[]; transpose: boolean }[] = [];
  private server: EngineContract | null = null;
  private activeNotes = new Map<number, number>();
  channelStereo: AnalyserNode[] = [];
  masterStereo: AnalyserNode[] = [];
  channelPitch: AnalyserNode[] = [];
  masterPitch: AnalyserNode[] = [];
  channelMeter: AnalyserNode | null = null;
  masterMeter: AnalyserNode | null = null;
  get ready() {
    return (
      this.kind === this.state?.instrument && (this.engine?.ready ?? false)
    );
  }
  setServerEngine(server: EngineContract | undefined) {
    this.server = server ?? null;
  }
  private async compatible(state: Session) {
    const prepared = await prepareDSP();
    if (this.server && this.server.core_revision !== prepared.revision)
      throw new LocalizedError("errors.previewCoreMismatch");
    if (
      state.instrument === "banks" &&
      this.server &&
      this.server.fluidsynth_version !== contract.fluidsynth
    )
      throw new LocalizedError("errors.previewBanksMismatch", {
        expected: contract.fluidsynth,
        actual: this.server.fluidsynth_version ?? "—",
      });
  }
  async start(state: Session, automatic = false) {
    this.loading = true;
    this.requestedState = state;
    try {
      await this.startPrepared(state, automatic);
    } catch (error) {
      await this.stop();
      throw error;
    } finally {
      this.loading = false;
    }
  }
  private async startPrepared(state: Session, automatic = false) {
    await this.compatible(state);
    if (this.context) {
      const resumed = this.context.resume();
      if (automatic) void resumed.catch(() => {});
      else await resumed;
      await this.apply(state);
      return;
    }
    const context = (this.context = new AudioContext({
      latencyHint: "interactive",
      sampleRate: this.server?.sample_rate ?? 44100,
    }));
    try {
      const resumed = context.resume();
      if (automatic) void resumed.catch(() => {});
      else await resumed;
      await prepareEffects(context);
      this.pipeline = await createPipeline(context, state);
      this.monitor = context.createGain();
      this.monitor.gain.value = this.monitorMuted ? 0 : this.monitorVolume;
      this.pipeline.output.connect(this.monitor);
      this.monitor.connect(context.destination);
      const stereo = (node: AudioNode, size: number) => {
        const splitter = context.createChannelSplitter(2);
        node.connect(splitter);
        return [0, 1].map((channel) => {
          const analyser = context.createAnalyser();
          analyser.fftSize = size;
          splitter.connect(analyser, channel);
          return analyser;
        });
      };
      this.channelStereo = stereo(this.pipeline.channel, 2048);
      this.masterStereo = stereo(this.pipeline.master, 2048);
      this.channelPitch = stereo(this.pipeline.channel, 4096);
      this.masterPitch = stereo(this.pipeline.master, 4096);
      this.channelMeter = context.createAnalyser();
      this.masterMeter = context.createAnalyser();
      this.channelMeter.fftSize = this.masterMeter.fftSize = 256;
      this.pipeline.channel.connect(this.channelMeter);
      this.pipeline.master.connect(this.masterMeter);
      await this.apply(this.requestedState ?? state);
    } catch (error) {
      await this.stop();
      throw error;
    }
  }
  apply(state: Session, reload = false): Promise<void> {
    this.requestedState = state;
    if (
      this.context &&
      this.server &&
      this.context.sampleRate !== this.server.sample_rate
    ) {
      const pending = this.pending;
      return (async () => {
        await this.stop();
        await pending.catch(() => {});
        await this.start(this.requestedState ?? state);
      })();
    }
    if (!this.pipeline) return Promise.resolve();
    const generation = this.generation;
    const next = this.pending
      .catch(() => {})
      .then(async () => {
        if (generation !== this.generation || !this.context) return;
        try {
          await this.compatible(state);
        } catch (error) {
          this.panic();
          this.kind = null;
          throw error;
        }
        if (generation !== this.generation || !this.context) return;
        this.state = state;
        const replaced =
          reload || !this.engine || this.kind !== state.instrument;
        if (replaced) {
          const factories = {
            banks: createBanksEngine,
            "three-osc": createThreeOscEngine,
          };
          const engine = await factories[state.instrument](this.context, state);
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
          engine.node.connect(this.pipeline!.input);
        } else await this.engine!.configure(state);
        if (generation !== this.generation) return;
        this.pipeline!.configure(state, replaced);
        for (const item of this.queuedMidi.splice(0))
          this.midi(item.data, item.transpose);
      });
    this.pending = next;
    return next;
  }
  midi(data: number[], transpose = true) {
    if (!this.ready || !this.engine) {
      if (this.loading || this.context) {
        if (this.queuedMidi.length >= 256) {
          this.queuedMidi = [];
          this.engine?.panic();
        } else this.queuedMidi.push({ data: [...data], transpose });
      }
      return;
    }
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
  setPreviewOutput(volume: number, muted: boolean) {
    this.monitorVolume = Math.max(0, Math.min(1, volume));
    this.monitorMuted = muted;
    if (this.monitor && this.context) {
      const gain = this.monitor.gain;
      gain.cancelScheduledValues(this.context.currentTime);
      gain.setTargetAtTime(
        muted ? 0 : this.monitorVolume,
        this.context.currentTime,
        0.005,
      );
    }
  }
  panic(resetEffects = true) {
    this.queuedMidi = [];
    this.engine?.panic();
    this.activeNotes.clear();
    this.engine?.midi([0xb0, 64, this.state?.sustain ? 127 : 0]);
    if (resetEffects && this.state) this.pipeline?.configure(this.state, true);
  }
  async stop() {
    this.loading = false;
    this.generation++;
    this.panic(false);
    this.engine?.close();
    this.engine = null;
    this.kind = null;
    this.pipeline?.close();
    this.pipeline = null;
    this.monitor?.disconnect();
    this.monitor = null;
    this.channelStereo = [];
    this.masterStereo = [];
    this.channelPitch = [];
    this.masterPitch = [];
    this.channelMeter = this.masterMeter = null;
    await this.context?.close();
    this.context = null;
  }
}
