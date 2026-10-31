import { type ApiIssue, t, type TranslationKey } from "./i18n";
import {
  effectDefinitions,
  formatParameter,
  type EffectKind,
} from "./effect-schema";
export type { EffectKind } from "./effect-schema";
export interface Effect {
  id: string;
  kind: EffectKind;
  enabled: boolean;
  value: number;
  parameters?: Record<string, number | string | boolean>;
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
  pan: number;
  master_pan: number;
  master_mute: boolean;
  master_solo: boolean;
  master_effects: Effect[];
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
  connection_id?: string;
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
    engine_contract?: import("./audio").EngineContract;
  };
}
export const effectInfo = Object.fromEntries(
  (
    [
      "chorus",
      "reverb",
      "filter",
      "gain",
      "compressor",
      "limiter",
    ] as EffectKind[]
  ).map((kind) => {
    const definition = effectDefinitions[kind];
    const primary = definition.parameters[definition.primary];
    return [
      kind,
      {
        get name() {
          return t(`fx.name.${kind}` as TranslationKey);
        },
        get label() {
          return t(`fx.parameter.${definition.primary}` as TranslationKey);
        },
        min: primary.min!,
        max: primary.max!,
        step: primary.step!,
        initial: Number(primary.default),
        format: (value: number) => formatParameter(value, primary),
      },
    ];
  }),
) as Record<
  EffectKind,
  {
    name: string;
    label: string;
    min: number;
    max: number;
    step: number;
    initial: number;
    format(value: number): string;
  }
>;
