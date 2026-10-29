import source from "../../src/sontrama/effect_specs.json";
import type { Effect } from "./types";

export type EffectKind = keyof typeof source;
export interface ParameterDefinition {
  type: "number" | "choice";
  default: number | string;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  scale?: string;
  choices?: string[];
}
export const effectDefinitions = source as Record<
  EffectKind,
  { primary: string; parameters: Record<string, ParameterDefinition> }
>;
export function effectParameters(
  effect: Effect,
): Record<string, number | string | boolean> {
  const definition = effectDefinitions[effect.kind];
  const defaults = Object.fromEntries(
    Object.entries(definition.parameters).map(([name, parameter]) => [
      name,
      parameter.default,
    ]),
  );
  return {
    ...defaults,
    ...effect.parameters,
    [definition.primary]: effect.value,
  };
}
export function effectVector(effect: Effect): number[] {
  const values = effectParameters(effect);
  return Object.entries(effectDefinitions[effect.kind].parameters).map(
    ([name, parameter]) =>
      parameter.type === "choice"
        ? parameter.choices!.indexOf(String(values[name]))
        : Number(values[name]),
  );
}
export function parameterValue(
  input: HTMLInputElement,
  definition: ParameterDefinition,
) {
  if (definition.scale !== "log") return Number(input.value);
  const value =
    definition.min! *
    (definition.max! / definition.min!) ** Number(input.value);
  return Math.max(
    definition.min!,
    Math.min(
      definition.max!,
      Number(
        (Math.round(value / definition.step!) * definition.step!).toFixed(6),
      ),
    ),
  );
}
export function parameterPosition(
  value: number,
  definition: ParameterDefinition,
) {
  return definition.scale === "log"
    ? Math.log(value / definition.min!) /
        Math.log(definition.max! / definition.min!)
    : value;
}
export function formatParameter(
  value: number,
  definition: ParameterDefinition,
) {
  const unit = definition.unit ?? "";
  if (unit === "%") return `${Math.round(value * 100)}%`;
  return `${Number(value.toFixed(2)).toLocaleString(document.documentElement.lang)}${unit === "°" || unit === ":1" || !unit ? "" : " "}${unit}`;
}
