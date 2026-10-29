import { t } from "./i18n";
import type { ThreeOscPatch } from "./types";
import { waveformPicker } from "./waveform-picker";
function range(
  label: string,
  key: string,
  value: number,
  min: number,
  max: number,
  step: number,
  suffix: string,
  oscillator?: number,
) {
  const name =
    oscillator === undefined
      ? label
      : t("osc.parameter", { parameter: label, number: oscillator + 1 });
  const formatted =
    suffix === "%"
      ? `${Math.round(value * 100)}%`
      : `${Number(value.toFixed(3))}${suffix}`;
  return `<label class="range-label">${label}<output>${formatted}</output><input type="range" aria-label="${name}" data-osc-param="${key}" ${oscillator === undefined ? "" : `data-osc-index="${oscillator}"`} data-suffix="${suffix}" min="${min}" max="${max}" step="${step}" value="${value}"></label>`;
}
export function threeOscPanel(patch: ThreeOscPatch) {
  return `<div class="three-osc-panel"><div class="oscillators">${patch.oscillators
    .map(
      (osc, index) =>
        `<section class="oscillator ${osc.enabled ? "" : "bypassed"}"><div class="oscillator-heading"><button type="button" data-osc-toggle="enabled" data-osc-index="${index}" aria-pressed="${osc.enabled}">${t("osc.title", { number: index + 1 })}</button>${waveformPicker(osc.shape, index)}</div><div class="oscillator-controls">${range(t("osc.coarse"), "coarse", osc.coarse, -24, 24, 1, " st", index)}${range(t("osc.fine"), "fine", osc.fine, -100, 100, 1, " ct", index)}${range(t("osc.pan"), "pan", osc.pan, -1, 1, 0.01, "", index)}${range(t("osc.startPhase"), "phase_start", osc.phase_start, 0, 360, 1, "°", index)}${range(t("osc.stereoPhase"), "phase", osc.phase, 0, 360, 1, "°", index)}${range(t("osc.stereoDetune"), "detune", osc.detune, -100, 100, 1, " ct", index)}${index ? range(t("common.mix"), "mix", osc.mix, 0, 1, 0.01, "%", index) : `<p class="muted oscillator-mix-note">${t("osc.base")}</p>`}</div></section>`,
    )
    .join(
      "",
    )}</div><section class="osc-global"><h3>${t("osc.envelope")}</h3><div class="envelope-controls">${range(t("osc.attack"), "attack", patch.envelope.attack, 0.001, 5, 0.001, " s")}${range(t("osc.decay"), "decay", patch.envelope.decay, 0.001, 5, 0.001, " s")}${range(t("common.sustain"), "sustain", patch.envelope.sustain, 0, 1, 0.01, "%")}${range(t("osc.release"), "release", patch.envelope.release, 0.001, 5, 0.001, " s")}</div><div class="osc-options"><button type="button" data-osc-toggle="am_osc3" aria-pressed="${patch.am_osc3}">${t("osc.am")}</button><button type="button" data-osc-toggle="hq" aria-pressed="${patch.hq}">${t("common.hq")}</button></div>${range(t("osc.randomPhase"), "phase_random", patch.phase_random, 0, 1, 0.01, "%")}</section></div>`;
}
