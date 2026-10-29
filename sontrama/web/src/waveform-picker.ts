import { t } from "./i18n";
import type { WaveShape } from "./types";
export const waveforms: {
  shape: WaveShape;
  name: string;
  path: string;
}[] = [
  {
    shape: "sine",
    get name() {
      return t("wave.sine");
    },
    path: "M2 16C7 0 12 0 17 16S27 32 32 16S42 0 47 16S57 32 62 16",
  },
  {
    shape: "triangle",
    get name() {
      return t("wave.triangle");
    },
    path: "M2 16L9 3L24 29L39 3L54 29L62 16",
  },
  {
    shape: "square",
    get name() {
      return t("wave.square");
    },
    path: "M2 25V7H17V25H32V7H47V25H62",
  },
  {
    shape: "saw",
    get name() {
      return t("wave.saw");
    },
    path: "M2 27L17 5V27L32 5V27L47 5V27L62 5",
  },
  {
    shape: "rounded-saw",
    get name() {
      return t("wave.roundedSaw");
    },
    path: "M2 26Q10 25 17 5V26Q25 25 32 5V26Q40 25 47 5V26Q55 25 62 5",
  },
  {
    shape: "noise",
    get name() {
      return t("wave.noise");
    },
    path: "M2 16L5 5L8 25L11 12L14 19L17 3L20 27L23 10L26 20L29 14L32 28L35 4L38 20L41 9L44 26L47 14L50 3L53 23L56 11L59 26L62 16",
  },
];
export function waveformPicker(selected: WaveShape, oscillator: number) {
  return `<div class="waveform-picker"><div class="waveform-buttons" role="group" aria-label="${t("wave.group", { number: oscillator + 1 })}">${waveforms.map((wave) => `<button type="button" class="waveform-button" data-osc-shape="${wave.shape}" data-osc-index="${oscillator}" aria-pressed="${wave.shape === selected}" aria-label="${t("osc.parameter", { parameter: wave.name, number: oscillator + 1 })}" title="${wave.name}"><svg viewBox="0 0 64 32" aria-hidden="true" focusable="false"><path class="waveform-axis" d="M2 16H62"/><path d="${wave.path}"/></svg></button>`).join("")}</div></div>`;
}
