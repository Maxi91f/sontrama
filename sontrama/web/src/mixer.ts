import { t, type TranslationKey } from "./i18n";
import {
  effectDefinitions,
  effectParameters,
  formatParameter,
  parameterPosition,
  parameterValue,
} from "./effect-schema";
import {
  effectInfo,
  type Effect,
  type EffectKind,
  type Session,
} from "./types";

type Bus = "channel" | "master";
type Patch = (change: (state: Session) => Partial<Session>) => Promise<unknown>;
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
const effectsKey = (bus: Bus) =>
  bus === "master" ? "master_effects" : "effects";
const field = (bus: Bus, name: "volume" | "pan" | "mute" | "solo") =>
  bus === "channel"
    ? name
    : name === "volume"
      ? "master"
      : (`master_${name}` as "master_pan" | "master_mute" | "master_solo");
const busName = (bus: Bus) =>
  t(bus === "channel" ? "mixer.channel" : "common.master");
const panText = (pan: number) =>
  pan === 0
    ? t("mixer.center")
    : t(pan < 0 ? "mixer.left" : "mixer.right", {
        amount: Math.round(Math.abs(pan) * 100),
      });

export function stereoMeter(bus: Bus, vertical = false) {
  return `<span class="bus-meter ${vertical ? "vertical" : ""}">${["left", "right"].map((side) => `<span class="meter" role="meter" aria-label="${t("mixer.stereoMeter", { channel: busName(bus), side: t(side === "left" ? "mixer.leftSide" : "mixer.rightSide") })}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" data-meter="${bus}" data-meter-side="${side}"><span></span></span>`).join("")}</span>`;
}

export class MixerView {
  private selected: Bus = "channel";
  private state: Session | null = null;
  private instrument = "";
  private dialog: HTMLDialogElement;
  private addingBus: Bus = "channel";

  constructor(
    private root: HTMLElement,
    private patch: Patch,
  ) {
    this.dialog = document.createElement("dialog");
    this.dialog.className = "effect-dialog";
    this.dialog.setAttribute("aria-labelledby", "effect-dialog-title");
    this.dialog.innerHTML = `<header class="effect-dialog-heading"><h2 id="effect-dialog-title"></h2><button type="button" data-close-dialog>×</button></header><div class="effect-choices">${Object.keys(
      effectInfo,
    )
      .map(
        (kind) =>
          `<button type="button" data-effect-kind="${kind}"><span><strong></strong><small></small></span><span aria-hidden="true">+</span></button>`,
      )
      .join("")}</div>`;
    document.body.append(this.dialog);
    this.dialog.addEventListener("close", () =>
      root
        .querySelector<HTMLButtonElement>("[data-mixer-add]")
        ?.focus({ preventScroll: true }),
    );
    this.dialog.addEventListener("click", (event) => {
      const button = (event.target as Element).closest<HTMLButtonElement>(
        "button",
      );
      if (button?.hasAttribute("data-close-dialog")) this.dialog.close();
      if (button?.dataset.effectKind) {
        const kind = button.dataset.effectKind as EffectKind;
        const key = effectsKey(this.addingBus);
        this.dialog.close();
        void this.patch((state) =>
          state[key].length >= 8
            ? {}
            : {
                [key]: [
                  ...state[key],
                  {
                    id:
                      crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
                    kind,
                    enabled: true,
                    value: effectInfo[kind].initial,
                  },
                ],
              },
        );
      }
    });
    root.addEventListener("click", (event) => this.click(event));
    root.addEventListener("input", (event) => this.input(event));
    root.addEventListener("change", (event) => this.change(event));
    root.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      const help = root.querySelector<HTMLDetailsElement>(
        ".parameter-info[open]",
      );
      if (help) {
        event.preventDefault();
        help.open = false;
        help.querySelector<HTMLElement>("summary")?.focus();
      }
    });
  }

  render(state: Session, instrument: string) {
    this.state = state;
    this.instrument = instrument;
    const bus = this.selected;
    const effects = state[effectsKey(bus)];
    this.root.innerHTML = `<h2>${t("nav.mixer")}</h2>
      <nav class="channel-selector" aria-label="${t("mixer.channels")}">${(["channel", "master"] as const).map((channel) => this.card(channel, state)).join("")}</nav>
      <section class="mixer-editor ${bus === "master" ? "master-editor" : ""}" id="mixer-editor" aria-labelledby="mixer-editor-heading" data-bus="${bus}">
        <header class="bus-heading"><span class="bus-number">${bus === "channel" ? "01" : "M"}</span><div><h3 id="mixer-editor-heading">${bus === "channel" ? escape(instrument) : busName(bus)}</h3><p class="muted">${t(bus === "channel" ? "mixer.channelRoute" : "mixer.masterRoute")}</p></div></header>
        <div class="mixer-chain"><div class="chain-heading"><p class="chain-caption">${t("mixer.chain")}</p><button type="button" data-mixer-add aria-haspopup="dialog" ${effects.length >= 8 ? "disabled" : ""}>${t("fx.add")}</button></div><div class="effects-list">${effects.map((effect, index) => this.effect(effect, index, effects.length)).join("") || `<p class="muted">${t("mixer.empty")}</p>`}</div></div>
        <div class="bus-controls"><div class="bus-ranges">
          <label class="range-label">${t("osc.pan")}<output>${panText(Number(state[field(bus, "pan")]))}</output><input data-bus-control="pan" type="range" aria-label="${t("mixer.panControl", { channel: busName(bus) })}" min="-1" max="1" step="0.01" value="${state[field(bus, "pan")]}"></label>
          <label class="range-label">${t("common.level")}<output>${Math.round(Number(state[field(bus, "volume")]) * 100)}%</output><input data-bus-control="volume" type="range" aria-label="${t(bus === "channel" ? "mixer.volume" : "mixer.masterVolume")}" min="0" max="1" step="0.01" value="${state[field(bus, "volume")]}"></label>
        </div>${stereoMeter(bus, true)}</div>
        <p class="bus-route">${t(bus === "channel" ? "mixer.route" : "mixer.serverRoute")}</p>
      </section>`;
    this.updateDialog();
  }

  private updateDialog() {
    this.dialog.querySelector("h2")!.textContent = t("fx.add");
    this.dialog
      .querySelector("[data-close-dialog]")!
      .setAttribute("aria-label", t("fx.close"));
    for (const button of this.dialog.querySelectorAll<HTMLButtonElement>(
      "[data-effect-kind]",
    )) {
      const kind = button.dataset.effectKind as EffectKind;
      button.querySelector("strong")!.textContent = effectInfo[kind].name;
      button.querySelector("small")!.textContent = t(`fx.description.${kind}`);
      button.disabled =
        (this.state?.[effectsKey(this.addingBus)].length ?? 0) >= 8;
    }
  }

  private card(bus: Bus, state: Session) {
    const selected = bus === this.selected;
    return `<div class="channel-card ${bus === "master" ? "master-card" : ""}" data-summary="${bus}">
      <button type="button" class="channel-pick" data-bus-select="${bus}" aria-label="${t("mixer.select", { channel: busName(bus) })}" aria-pressed="${selected}" aria-controls="mixer-editor" aria-describedby="summary-${bus}">
        <span class="card-heading"><span class="bus-number">${bus === "channel" ? "01" : "M"}</span><strong>${bus === "channel" ? escape(this.instrument) : busName(bus)}</strong><span class="selection-mark" aria-hidden="true">${selected ? "●" : "→"}</span></span>
        ${stereoMeter(bus)}
        <span class="card-stats" id="summary-${bus}"><span><small>${t("nav.effects")}</small><b>${state[effectsKey(bus)].length}</b></span><span><small>${t("mixer.summaryVolume")}</small><b data-summary-volume>${Math.round(Number(state[field(bus, "volume")]) * 100)}%</b></span><span><small>${t("osc.pan")}</small><b data-summary-pan>${panText(Number(state[field(bus, "pan")]))}</b></span></span>
      </button><div class="card-switches">${(["mute", "solo"] as const).map((control) => `<button type="button" data-bus-toggle="${control}" data-bus="${bus}" aria-label="${t(control === "mute" ? "mixer.muteBus" : "mixer.soloBus", { channel: busName(bus) })}" aria-pressed="${state[field(bus, control)]}">${t(control === "mute" ? "common.mute" : "common.solo")}</button>`).join("")}</div></div>`;
  }

  private effect(effect: Effect, index: number, length: number) {
    const info = effectInfo[effect.kind];
    return `<section class="effect ${effect.enabled ? "" : "bypassed"}" data-effect="${escape(effect.id)}"><div class="effect-top">
      <button type="button" data-mixer-enabled="${escape(effect.id)}" aria-pressed="${effect.enabled}">${info.name}</button>
      <span class="effect-tools"><button type="button" data-mixer-move="${escape(effect.id)}" data-direction="-1" aria-label="${t("fx.up", { effect: info.name })}" ${index === 0 ? "disabled" : ""}>↑</button><button type="button" data-mixer-move="${escape(effect.id)}" data-direction="1" aria-label="${t("fx.down", { effect: info.name })}" ${index === length - 1 ? "disabled" : ""}>↓</button><button type="button" data-mixer-remove="${escape(effect.id)}" aria-label="${t("fx.remove", { effect: info.name })}">×</button></span></div>
      <div class="effect-parameters">${this.parameters(effect)}</div></section>`;
  }

  private parameters(effect: Effect) {
    const values = effectParameters(effect);
    return Object.entries(effectDefinitions[effect.kind].parameters)
      .map(([name, definition]) => {
        if (
          effect.kind === "filter" &&
          name === "gain" &&
          !["peaking", "lowshelf", "highshelf"].includes(String(values.type))
        )
          return "";
        const label = t(`fx.parameter.${name}` as TranslationKey);
        const help = t(`fx.help.${name}` as TranslationKey);
        const helpId = `effect-help-${encodeURIComponent(effect.id)}-${name}`;
        const caption = `<details class="parameter-info"><summary title="${escape(help)}">${label}<span aria-hidden="true">?</span></summary><p id="${helpId}">${help}</p></details>`;
        const attributes = `title="${escape(help)}" aria-describedby="${helpId}" data-mixer-value="${escape(effect.id)}" data-kind="${effect.kind}" data-parameter="${name}" aria-label="${t("fx.parameter", { parameter: label, effect: effectInfo[effect.kind].name })}"`;
        if (definition.type === "choice")
          return `<div class="field effect-choice-field">${caption}<select ${attributes}>${definition.choices!.map((choice) => `<option value="${choice}" ${values[name] === choice ? "selected" : ""}>${t(`fx.option.${choice}` as TranslationKey)}</option>`).join("")}</select></div>`;
        const value = Number(values[name]);
        return `<div class="range-label effect-control">${caption}<output>${formatParameter(value, definition)}</output><input type="range" ${attributes} min="${definition.scale === "log" ? 0 : definition.min}" max="${definition.scale === "log" ? 1 : definition.max}" step="${definition.scale === "log" ? 0.001 : definition.step}" value="${parameterPosition(value, definition)}"></div>`;
      })
      .join("");
  }

  private click(event: Event) {
    const activeHelp = (event.target as Element).closest(".parameter-info");
    for (const help of this.root.querySelectorAll<HTMLDetailsElement>(
      ".parameter-info[open]",
    )) {
      if (help !== activeHelp) help.open = false;
    }
    const button = (event.target as Element).closest<HTMLButtonElement>(
      "button",
    );
    if (!button) return;
    if (button.hasAttribute("data-mixer-add")) {
      this.addingBus = this.selected;
      this.updateDialog();
      this.dialog.showModal();
      this.dialog
        .querySelector<HTMLButtonElement>("[data-effect-kind]")
        ?.focus();
      return;
    }
    if (button.dataset.busSelect) {
      this.selected = button.dataset.busSelect as Bus;
      if (this.state) this.render(this.state, this.instrument);
      const selected = this.root.querySelector<HTMLButtonElement>(
        `[data-bus-select="${this.selected}"]`,
      )!;
      selected.focus({ preventScroll: true });
      selected.scrollIntoView({ block: "nearest", inline: "nearest" });
      return;
    }
    if (button.dataset.busToggle) {
      const name = field(
        button.dataset.bus as Bus,
        button.dataset.busToggle as "mute" | "solo",
      );
      void this.patch((state) => ({ [name]: !state[name] }));
      return;
    }
    const key = effectsKey(this.selected);
    if (button.dataset.mixerEnabled)
      void this.patch((state) => ({
        [key]: state[key].map((effect) =>
          effect.id === button.dataset.mixerEnabled
            ? { ...effect, enabled: !effect.enabled }
            : effect,
        ),
      }));
    if (button.dataset.mixerRemove)
      void this.patch((state) => ({
        [key]: state[key].filter(
          (effect) => effect.id !== button.dataset.mixerRemove,
        ),
      }));
    if (button.dataset.mixerMove)
      void this.patch((state) => {
        const effects = [...state[key]];
        const from = effects.findIndex(
          (effect) => effect.id === button.dataset.mixerMove,
        );
        const to = from + Number(button.dataset.direction);
        if (from >= 0 && to >= 0 && to < effects.length)
          [effects[from], effects[to]] = [effects[to], effects[from]];
        return { [key]: effects };
      });
  }

  private input(event: Event) {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    const value = Number(input.value);
    if (input.dataset.busControl) {
      const text =
        input.dataset.busControl === "pan"
          ? panText(value)
          : `${Math.round(value * 100)}%`;
      input.previousElementSibling!.textContent = text;
      this.root.querySelector(
        `[data-summary="${this.selected}"] [data-summary-${input.dataset.busControl}]`,
      )!.textContent = text;
    } else if (input.dataset.mixerValue) {
      const definition =
        effectDefinitions[input.dataset.kind as EffectKind].parameters[
          input.dataset.parameter!
        ];
      input.previousElementSibling!.textContent = formatParameter(
        parameterValue(input, definition),
        definition,
      );
    }
  }

  private editedEffect(
    effect: Effect,
    input: HTMLInputElement | HTMLSelectElement,
  ): Effect {
    const name = input.dataset.parameter!;
    const definition = effectDefinitions[effect.kind].parameters[name];
    const value =
      input instanceof HTMLSelectElement
        ? input.value
        : parameterValue(input, definition);
    return {
      ...effect,
      parameters: { ...effectParameters(effect), [name]: value },
      ...(effectDefinitions[effect.kind].primary === name
        ? { value: Number(value) }
        : {}),
    };
  }

  private change(event: Event) {
    const input = event.target;
    if (!(
      input instanceof HTMLInputElement || input instanceof HTMLSelectElement
    ))
      return;
    const key = effectsKey(this.selected);
    if (input.dataset.busControl) {
      const name = field(
        this.selected,
        input.dataset.busControl as "volume" | "pan",
      );
      void this.patch(() => ({ [name]: Number(input.value) }));
    } else if (input.dataset.mixerValue)
      void this.patch((state) => ({
        [key]: state[key].map((effect) =>
          effect.id === input.dataset.mixerValue
            ? this.editedEffect(effect, input)
            : effect,
        ),
      }));
  }
}
