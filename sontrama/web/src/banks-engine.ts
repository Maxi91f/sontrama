import { LocalizedError } from "./i18n";
import type { ISynthesizer } from "js-synthesizer";
import type { Session } from "./types";
import type { VoiceEngine } from "./voice-engine";
declare const JSSynth: typeof import("js-synthesizer");
class BanksEngine implements VoiceEngine {
  private fontId = -1;
  private font = "";
  private preset = "";
  private closed = false;
  private sustain: boolean | undefined;
  constructor(
    readonly node: AudioNode,
    private synth: ISynthesizer,
  ) {}
  get ready() {
    return this.fontId >= 0 && !this.closed;
  }
  async configure(state: Session) {
    if (!state.soundfont) throw new LocalizedError("errors.noSoundfont");
    if (this.font !== state.soundfont) {
      this.panic();
      const response = await fetch(
        `/api/soundfonts/${encodeURIComponent(state.soundfont)}`,
      );
      if (!response.ok) throw new LocalizedError("errors.loadSoundfont");
      const data = await response.arrayBuffer();
      if (this.closed) return;
      const identifier = await this.synth.loadSFont(data);
      if (this.closed) return;
      if (this.fontId >= 0) this.synth.unloadSFont(this.fontId);
      this.fontId = identifier;
      this.font = state.soundfont;
      this.preset = "";
    }
    const preset = `${state.bank}:${state.program}`;
    if (preset !== this.preset) {
      this.panic();
      this.synth.midiProgramSelect(0, this.fontId, state.bank, state.program);
      this.preset = preset;
      this.sustain = undefined;
    }
    if (this.sustain !== state.sustain) {
      this.synth.midiControl(0, 64, state.sustain ? 127 : 0);
      this.sustain = state.sustain;
    }
  }
  midi(data: number[]) {
    if (!this.ready) return;
    const kind = data[0] & 0xf0,
      value = data[1];
    if (kind === 0x90 && data[2]) this.synth.midiNoteOn(0, value, data[2]);
    else if (kind === 0x80 || kind === 0x90) this.synth.midiNoteOff(0, value);
    else if (kind === 0xb0) this.synth.midiControl(0, value, data[2]);
    else if (kind === 0xe0) this.synth.midiPitchBend(0, value + (data[2] << 7));
    else if (kind === 0xd0) this.synth.midiChannelPressure(0, value);
    else if (kind === 0xa0) this.synth.midiKeyPressure(0, value, data[2]);
  }
  panic() {
    this.synth.midiControl(0, 64, 0);
    this.synth.midiAllSoundsOff();
  }
  close() {
    this.closed = true;
    this.panic();
    this.node.disconnect();
    this.synth.close();
  }
}
export async function createBanksEngine(
  context: AudioContext,
): Promise<VoiceEngine> {
  await JSSynth.waitForReady();
  const settings = {
    initialGain: 0.6,
    chorusActive: false,
    reverbActive: false,
    polyphony: 128,
  };
  if (context.audioWorklet) {
    await context.audioWorklet.addModule("/vendor/libfluidsynth.js");
    await context.audioWorklet.addModule(
      "/vendor/js-synthesizer.worklet.min.js",
    );
    const synth = new JSSynth.AudioWorkletNodeSynthesizer();
    synth.init(context.sampleRate, settings);
    return new BanksEngine(synth.createAudioNode(context, settings), synth);
  }
  const synth = new JSSynth.Synthesizer();
  synth.init(context.sampleRate, settings);
  return new BanksEngine(synth.createAudioNode(context, 1024), synth);
}
