import { type ApiIssue, t } from "./i18n";
export type EffectKind = "chorus" | "reverb" | "gain" | "filter";
export interface Effect {
  id: string;
  kind: EffectKind;
  enabled: boolean;
  value: number;
}
export type WaveShape =
  "sine" | "triangle" | "square" | "saw" | "rounded-saw" | "noise";
export interface OscillatorSpec {
  enabled: boolean;
  shape: WaveShape;
  coarse: number;
  fine: number;
  pan: number;
  phase: number;
  detune: number;
  phase_start: number;
  mix: number;
}
export interface ThreeOscPatch {
  oscillators: OscillatorSpec[];
  envelope: { attack: number; decay: number; sustain: number; release: number };
  am_osc3: boolean;
  phase_random: number;
  hq: boolean;
}
export interface Session {
  instrument: "banks" | "three-osc";
  three_osc: ThreeOscPatch;
  soundfont: string;
  bank: number;
  program: number;
  octave: number;
  sustain: boolean;
  usb_enabled: boolean;
  midi_channel: number | null;
  volume: number;
  master: number;
  mute: boolean;
  solo: boolean;
  output: "device";
  effects: Effect[];
}
export interface Preset {
  name: string;
  bank: number;
  program: number;
}
export interface Bank {
  id: string;
  name: string;
  presets: Preset[];
}
export interface Snapshot {
  type: "state";
  session: Session;
  catalog: Bank[];
  status: {
    engine: string;
    audio: string;
    midi: string[];
    errors: string[];
    issues?: ApiIssue[];
    underruns: number;
    catalog_revision?: number;
  };
}
export const effectInfo: Record<
  EffectKind,
  {
    name: string;
    label: string;
    min: number;
    max: number;
    step: number;
    initial: number;
    format: (v: number) => string;
  }
> = {
  chorus: {
    get name() {
      return t("common.chorus");
    },
    get label() {
      return t("common.mix");
    },
    min: 0,
    max: 1,
    step: 0.01,
    initial: 0.18,
    format: (v) => `${Math.round(v * 100)}%`,
  },
  reverb: {
    get name() {
      return t("common.reverb");
    },
    get label() {
      return t("common.mix");
    },
    min: 0,
    max: 1,
    step: 0.01,
    initial: 0.26,
    format: (v) => `${Math.round(v * 100)}%`,
  },
  gain: {
    get name() {
      return t("common.gainName");
    },
    get label() {
      return t("common.gain");
    },
    min: -24,
    max: 12,
    step: 0.5,
    initial: 0,
    format: (v) => `${v > 0 ? "+" : ""}${v} dB`,
  },
  filter: {
    get name() {
      return t("common.filter");
    },
    get label() {
      return t("common.cutoff");
    },
    min: 100,
    max: 18000,
    step: 100,
    initial: 8000,
    format: (v) => `${v} Hz`,
  },
};
