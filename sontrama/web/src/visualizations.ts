import { VisualRenderers } from "./visual-renderers";
import { MidiMonitor } from "./midi-monitor";
import {
  pitchWindow,
  spectralDefaults,
  type SpectralSettings,
  type Signal,
} from "./visual-analysis";
import { dockLayout, moveDock } from "./dock-layout";
import { DockResizeInteractions } from "./dock-resize";
import { VisualGridInteractions } from "./visual-grid";
import { t, errorText } from "./i18n";

export const visualizationKinds = [
  "oscilloscope",
  "spectrum",
  "spectrogram",
  "vectorscope",
  "correlation",
  "tuner",
  "midi",
  "vu",
] as const;
export interface VisualizationWidget {
  id: string;
  kind: (typeof visualizationKinds)[number];
  bus: "channel" | "master";
  width: 1 | 2 | 3;
  height: 160 | 240 | 320;
  dock_width: number;
  pinned: boolean;
  paused: boolean;
  scale: 0.5 | 1 | 2 | 4;
  meter_style: "bars" | "needle";
  spectral: SpectralSettings;
}
export interface VisualizationSettings {
  widgets: VisualizationWidget[];
  keyboard_width: number;
  dock_order: string[];
  dock_positions: Record<string, number | null>;
  collapsed: boolean;
  active: string;
}
export interface VisualizationFrame {
  sample_rate: number;
  channel: number[][];
  master: number[][];
  pitch?: { sample_rate: number; channel: number[]; master: number[] };
}
interface PackedVisualizationFrame {
  encoding: "float32-base64";
  sample_rate: number;
  channel: string[];
  master: string[];
  pitch: { sample_rate: number; channel: string; master: string };
}
function decodeSamples(encoded: string): number[] {
  const bytes = Uint8Array.from(atob(encoded), (character) =>
    character.charCodeAt(0),
  );
  const view = new DataView(bytes.buffer);
  return Array.from({ length: bytes.length / 4 }, (_, index) =>
    view.getFloat32(index * 4, true),
  );
}
const title = (widget: VisualizationWidget) => t(`visuals.${widget.kind}`);
const busName = (bus: string) =>
  bus === "master" ? "Master" : t("mixer.channel");
const option = (
  value: string | number,
  label: string,
  current: string | number,
) =>
  `<option value="${value}" ${value === current ? "selected" : ""}>${label}</option>`;

export function dockResizeHandle(id: string) {
  return `<button type="button" class="dock-resize-handle" data-dock-resize="${id}" aria-label="${t(id === "keyboard" ? "visuals.resizeKeyboard" : "visuals.resizePinned")}" title="${t("visuals.dockResizeHint")}"><svg viewBox="0 0 12 24" aria-hidden="true" focusable="false"><path d="M4 8v8m4-8v8" stroke="currentColor" stroke-width="1.5"/></svg></button>`;
}

export function dockPanel(
  id: string,
  label: string,
  body: string,
  controls: string,
  className: string,
  attributes = "",
) {
  return `<section class="dock-panel dock-item ${className}" data-widget="${id}" ${attributes}><header class="dock-panel-header ${id === "keyboard" ? "keyboard-head" : ""}"><button type="button" class="dock-move-handle" data-grid-handle="move" data-id="${id}" aria-label="${t("visuals.moveDock")}" title="${t("visuals.moveHint")}">⠿</button><h3>${label}</h3><div class="dock-panel-controls">${controls}</div></header>${body}</section>`;
}

export class VisualizationsView {
  private settings: VisualizationSettings = {
    widgets: [],
    keyboard_width: 600,
    dock_order: ["keyboard"],
    dock_positions: {},
    collapsed: false,
    active: "keyboard",
  };
  private signature = "";
  private visible = false;
  private subscribed = false;
  private subscribedWindow = 1024;
  private serverFrame: VisualizationFrame | null = null;
  private received = -Infinity;
  private frozen = new Map<string, Signal>();
  private lastDraw = -Infinity;
  private feedback = "";
  private mutation = Promise.resolve();
  private grid: VisualGridInteractions;
  private dockGrid: VisualGridInteractions;
  private dockResize: DockResizeInteractions;
  private placement: HTMLElement | null = null;
  private renderers = new VisualRenderers();
  private monitor = new MidiMonitor();
  private midiSince = new Map<string, number>();
  private picker = document.createElement("dialog");
  private levels = new Map<
    string,
    { time: number; channel: number[]; master: number[] }
  >();

  constructor(
    private dashboard: HTMLElement,
    private dock: HTMLElement,
    private save: (settings: VisualizationSettings) => Promise<unknown>,
    private preview: () => {
      analysers: AnalyserNode[];
      sampleRate: number;
      pitchAnalysers?: AnalyserNode[];
    } | null,
    private subscribe: (enabled: boolean, windowSize?: number) => void,
    private releaseKeys: () => void,
  ) {
    this.dockResize = new DockResizeInteractions(dock, (id, width) =>
      this.mutate((next) => {
        if (id === "keyboard") next.keyboard_width = width;
        else {
          const widget = next.widgets.find((widget) => widget.id === id);
          if (widget) widget.dock_width = width;
        }
      }),
    );
    this.dockGrid = new VisualGridInteractions(
      dock,
      (id, target, before, x) =>
        this.mutate((next) => moveDock(next, id, target, before, x)),
      () => {},
      ".dock-item",
      false,
      (id, target, before, x) => this.previewPlacement(id, target, before, x),
    );
    this.grid = new VisualGridInteractions(
      dashboard,
      (id, target, before) =>
        this.mutate((next) => {
          const index = next.widgets.findIndex((widget) => widget.id === id);
          if (
            index < 0 ||
            id === target ||
            !next.widgets.some((widget) => widget.id === target)
          )
            return;
          const [widget] = next.widgets.splice(index, 1);
          const destination = next.widgets.findIndex(
            (widget) => widget.id === target,
          );
          next.widgets.splice(destination + (before ? 0 : 1), 0, widget);
        }),
      (id, size) =>
        this.mutate((next) => {
          const widget = next.widgets.find((widget) => widget.id === id);
          if (widget) Object.assign(widget, size);
        }),
    );
    this.picker.className = "visual-picker";
    document.body.append(this.picker);
    this.picker.addEventListener("close", () =>
      dashboard
        .querySelector<HTMLElement>("[data-visual-action=picker]")
        ?.focus({ preventScroll: true }),
    );
    this.picker.addEventListener("click", (event) => {
      if ((event.target as Element).closest("[data-picker-close]"))
        this.picker.close();
    });
    for (const root of [dashboard, dock, this.picker]) {
      root.addEventListener("click", (event) => {
        const button = (event.target as Element).closest<HTMLButtonElement>(
          "button[data-visual-action]",
        );
        if (!button) return;
        const { visualAction: action, id } = button.dataset;
        if (action === "picker") {
          this.showPicker();
          return;
        }
        if (action === "clear" && id) {
          this.midiSince.set(id, this.monitor.reading().sequence);
          this.renderers.reset(id);
          return;
        }
        if (action === "add" && this.picker.open) this.picker.close();
        this.mutate((next) => {
          const index = next.widgets.findIndex((widget) => widget.id === id);
          const widget = next.widgets[index];
          if (action === "add") {
            if (next.widgets.length >= 12) return;
            next.widgets.push({
              id: crypto.randomUUID?.() ?? `visual-${Date.now()}`,
              kind: button.dataset.kind as VisualizationWidget["kind"],
              bus: "master",
              width: 2,
              height: 240,
              dock_width: 300,
              pinned: false,
              paused: false,
              scale: 1,
              meter_style: "bars",
              spectral: { ...spectralDefaults },
            });
          } else if (action === "collapse") {
            next.collapsed = !next.collapsed;
            this.releaseKeys();
          } else if (widget) {
            if (action === "pin") {
              widget.pinned = !widget.pinned;
              if (widget.pinned) {
                next.active = widget.id;
                next.collapsed = false;
              }
            }
            if (action === "pause") widget.paused = !widget.paused;
            if (action === "meter-style")
              widget.meter_style =
                widget.meter_style === "needle" ? "bars" : "needle";
            if (action === "remove") next.widgets.splice(index, 1);
          }
          if (
            !next.widgets.some((item) => item.id === next.active && item.pinned)
          )
            next.active = "keyboard";
        });
      });
      root.addEventListener("change", (event) => {
        const input = event.target as HTMLSelectElement;
        const field = input.dataset.visualField;
        if (!field) return;
        const value = input.value;
        const id = input.dataset.id;
        this.mutate((next) => {
          if (field === "active") {
            next.active = value;
            this.releaseKeys();
          } else {
            const widget = next.widgets.find((item) => item.id === id);
            if (!widget) return;
            if (field === "bus") {
              widget.bus = value as VisualizationWidget["bus"];
              this.frozen.delete(widget.id);
            }
            if (field === "scale")
              widget.scale = Number(value) as VisualizationWidget["scale"];
            if (field.startsWith("spectral.")) {
              const key = field.slice(9) as keyof SpectralSettings;
              const candidate = {
                ...widget.spectral,
                [key]: ["window", "frequency_scale"].includes(key)
                  ? value
                  : Number(value),
              };
              widget.spectral = candidate as SpectralSettings;
            }
          }
        });
      });
    }
    new ResizeObserver(() => {
      document.documentElement.style.setProperty(
        "--dock-height",
        `${dock.getBoundingClientRect().height}px`,
      );
    }).observe(dock);
    document.addEventListener("visibilitychange", () =>
      this.syncSubscription(),
    );
  }

  private mutate(edit: (next: VisualizationSettings) => void) {
    this.mutation = this.mutation.then(async () => {
      const next = structuredClone(this.settings);
      edit(next);
      await this.persist(next);
    });
  }

  private async persist(next: VisualizationSettings) {
    this.feedback = "";
    try {
      await this.save(next);
      this.feedback = "";
    } catch (error) {
      this.feedback = errorText(error);
      this.signature = "";
      this.accept(this.settings);
    }
  }

  accept(settings: VisualizationSettings) {
    if (
      (settings.collapsed && !this.settings.collapsed) ||
      (matchMedia("(max-width: 800px)").matches &&
        settings.active !== this.settings.active)
    )
      this.releaseKeys();
    this.settings = settings;
    const signature = JSON.stringify([
      settings,
      document.documentElement.lang,
      this.feedback,
    ]);
    if (signature !== this.signature) {
      this.signature = signature;
      const focused = document.activeElement as HTMLElement | null;
      const focusRoot =
        focused && this.dashboard.contains(focused)
          ? this.dashboard
          : this.dock;
      const field = focused?.dataset.visualField;
      const action = focused?.dataset.visualAction;
      const handle = focused?.dataset.gridHandle;
      const dockHandle = focused?.dataset.dockResize;
      const id = focused?.dataset.id;
      const openAnalysis = [
        ...this.dashboard.querySelectorAll<HTMLElement>(
          ".visual-widget:has(.spectral-options[open])",
        ),
      ].map((element) => element.dataset.widget!);
      this.grid.cancel();
      this.dockGrid.cancel();
      this.dockResize.cancel();
      this.render();
      for (const id of openAnalysis)
        this.dashboard
          .querySelector<HTMLDetailsElement>(
            `.visual-widget[data-widget="${id}"] .spectral-options`,
          )
          ?.setAttribute("open", "");
      if (field || action || handle || dockHandle)
        [
          ...focusRoot.querySelectorAll<HTMLElement>(
            "[data-visual-field], [data-visual-action], [data-grid-handle], [data-dock-resize]",
          ),
        ]
          .find(
            (item) =>
              item.dataset.id === id &&
              (field
                ? item.dataset.visualField === field
                : handle
                  ? item.dataset.gridHandle === handle
                  : dockHandle
                    ? item.dataset.dockResize === dockHandle
                    : item.dataset.visualAction === action),
          )
          ?.focus({ preventScroll: true });
    }
    const identifiers = new Set(settings.widgets.map((widget) => widget.id));
    for (const id of this.frozen.keys())
      if (!identifiers.has(id)) this.frozen.delete(id);
    this.renderers.retain(identifiers);
    for (const id of this.midiSince.keys())
      if (!identifiers.has(id)) this.midiSince.delete(id);
    this.syncSubscription();
  }

  setVisible(visible: boolean) {
    if (!visible) this.grid.cancel();
    this.visible = visible;
    this.syncSubscription();
  }
  reconnect() {
    this.subscribed = false;
    this.syncSubscription();
  }
  receive(frame: VisualizationFrame | PackedVisualizationFrame) {
    this.serverFrame =
      "encoding" in frame
        ? {
            sample_rate: frame.sample_rate,
            channel: frame.channel.map(decodeSamples),
            master: frame.master.map(decodeSamples),
            pitch: {
              sample_rate: frame.pitch.sample_rate,
              channel: decodeSamples(frame.pitch.channel),
              master: decodeSamples(frame.pitch.master),
            },
          }
        : frame;
    this.received = performance.now();
  }

  private syncSubscription() {
    const enabled =
      !document.hidden &&
      !this.preview() &&
      this.settings.widgets.some(
        (widget) =>
          !widget.paused &&
          widget.kind !== "midi" &&
          (this.visible ||
            (!this.settings.collapsed &&
              widget.pinned &&
              (!matchMedia("(max-width: 800px)").matches ||
                this.settings.active === widget.id))),
      );
    const windowSize = Math.max(
      1024,
      ...this.settings.widgets
        .filter(
          (widget) =>
            ["spectrum", "spectrogram"].includes(widget.kind) &&
            !widget.paused &&
            (this.visible || (!this.settings.collapsed && widget.pinned)),
        )
        .map((widget) => widget.spectral.fft_size),
    );
    if (
      enabled !== this.subscribed ||
      (enabled && windowSize !== this.subscribedWindow)
    ) {
      this.subscribed = enabled;
      this.subscribedWindow = windowSize;
      this.subscribe(enabled, windowSize);
    }
  }

  midi(data: number[]) {
    this.monitor.receive(data);
  }
  silenceMidi() {
    this.monitor.silence();
  }
  receiveLevels(
    source: "server" | "preview",
    channel: number[],
    master: number[],
  ) {
    this.levels.set(source, { time: performance.now(), channel, master });
  }
  private showPicker() {
    this.picker.setAttribute("aria-label", t("visuals.add"));
    this.picker.innerHTML = `<header><h2>${t("visuals.add")}</h2><button type="button" data-picker-close aria-label="${t("visuals.close")}">×</button></header><div class="visual-picker-grid">${visualizationKinds.map((kind) => `<button type="button" data-visual-action="add" data-kind="${kind}"><strong>${t(`visuals.${kind}`)}</strong><span>${t(`visuals.description.${kind}`)}</span></button>`).join("")}</div>`;
    this.picker.showModal();
  }
  private modeButton(widget: VisualizationWidget, compact = false) {
    const needle = widget.meter_style === "needle";
    return widget.kind === "vu"
      ? `<button type="button" data-visual-action="meter-style" data-id="${widget.id}" aria-pressed="${needle}" aria-label="${t("visuals.meterMode")}" title="${t(needle ? "visuals.switchBars" : "visuals.switchNeedle")}">${compact ? (needle ? "◴" : "▥") : t(needle ? "visuals.needle" : "visuals.bars")}</button>`
      : widget.kind === "midi"
        ? `<button type="button" data-visual-action="clear" data-id="${widget.id}">${t("visuals.clear")}</button>`
        : "";
  }

  private spectralControls(widget: VisualizationWidget) {
    if (!["spectrum", "spectrogram"].includes(widget.kind)) return "";
    const config = widget.spectral;
    const select = (
      key: keyof SpectralSettings,
      label: string,
      values: (string | number)[],
      captions?: string[],
    ) =>
      `<label>${label}<select data-visual-field="spectral.${key}" data-id="${widget.id}" aria-label="${label}">${values.map((value, index) => option(value, captions?.[index] ?? String(value), config[key])).join("")}</select></label>`;
    const input = (
      key: keyof SpectralSettings,
      label: string,
      min: number,
      max: number,
      step = 1,
    ) =>
      `<label>${label}<input type="number" data-visual-field="spectral.${key}" data-id="${widget.id}" aria-label="${label}" min="${min}" max="${max}" step="${step}" value="${config[key]}"></label>`;
    return `<details class="spectral-options"><summary>${t("visuals.analysisSettings")}</summary><div class="spectral-options-grid">${select("fft_size", t("visuals.fftSize"), [256, 512, 1024, 2048, 4096])}${select("window", t("visuals.window"), ["hann", "hamming", "blackman", "rectangular"], ["Hann", "Hamming", "Blackman", t("visuals.rectangular")])}${select("refresh_rate", t("visuals.refreshRate"), [5, 10, 20], ["5 Hz", "10 Hz", "20 Hz"])}${select("frequency_scale", t("visuals.frequencyScale"), ["log", "linear"], [t("visuals.logarithmic"), t("visuals.linear")])}${input("frequency_min", t("visuals.frequencyMin"), 20, 20000)}${input("frequency_max", t("visuals.frequencyMax"), 40, 24000)}${input("db_min", t("visuals.levelMin"), -120, -20)}${input("db_max", t("visuals.levelMax"), -18, 12)}<label>${t("visuals.smoothing")}<select data-visual-field="spectral.smoothing" data-id="${widget.id}" aria-label="${t("visuals.smoothing")}">${[0, 0.25, 0.5, 0.75, 0.95].map((value) => option(value, `${value * 100}%`, config.smoothing)).join("")}</select></label>${
      widget.kind === "spectrogram"
        ? select(
            "history_seconds",
            t("visuals.scrollSpeed"),
            [2, 4, 8, 16, 32],
            [2, 4, 8, 16, 32].map((seconds) =>
              t("visuals.historySpan", { seconds }),
            ),
          )
        : ""
    }</div><p class="muted" data-analysis-info></p></details>`;
  }

  private canvas(widget: VisualizationWidget) {
    const label =
      widget.kind === "midi"
        ? title(widget)
        : `${title(widget)} · ${busName(widget.bus)}`;
    const stereo = ["oscilloscope", "spectrum", "vectorscope"].includes(
      widget.kind,
    );
    return `<canvas data-visual-canvas="${widget.id}" role="img" aria-label="${label}"></canvas><div class="visual-legend">${stereo ? '<span class="signal-left">L</span><span class="signal-right">R</span>' : ""}<span data-visual-summary></span><span data-visual-source>${t("visuals.waiting")}</span></div>`;
  }

  private render() {
    const widgets = this.settings.widgets;
    this.dashboard.innerHTML = `<div class="visual-toolbar"><h2>${t("nav.visualizations")}</h2><div><button type="button" data-visual-action="picker" ${widgets.length >= 12 ? "disabled" : ""}>+ ${t("visuals.add")}</button></div></div><p class="muted">${t("visuals.hint")}</p><p role="alert" class="visual-error"></p><div class="visual-grid">${widgets.map((widget) => `<article class="visual-widget" data-widget="${widget.id}" data-width="${widget.width}" data-height="${widget.height}" style="--visual-width:${widget.width};--visual-height:${widget.height}px"><header><button type="button" class="visual-move-handle" data-grid-handle="move" data-id="${widget.id}" aria-label="${t("visuals.move")}" title="${t("visuals.moveHint")}">⠿</button><h3>${title(widget)}</h3><div class="visual-actions"><button type="button" data-visual-action="pin" data-id="${widget.id}" aria-pressed="${widget.pinned}">${t(widget.pinned ? "visuals.pinned" : "visuals.pin")}</button><button type="button" data-visual-action="remove" data-id="${widget.id}" aria-label="${t("visuals.remove")}">×</button></div></header><div class="visual-controls">${widget.kind !== "midi" ? `<label>${t("visuals.signal")}<select aria-label="${t("visuals.signal")}" data-visual-field="bus" data-id="${widget.id}">${option("channel", busName("channel"), widget.bus)}${option("master", "Master", widget.bus)}</select></label>` : ""}${["oscilloscope", "vectorscope"].includes(widget.kind) ? `<label>${t("visuals.scale")}<select aria-label="${t("visuals.scale")}" data-visual-field="scale" data-id="${widget.id}">${[0.5, 1, 2, 4].map((scale) => option(scale, `×${scale}`, widget.scale)).join("")}</select></label>` : ""}${this.modeButton(widget)}<button type="button" data-visual-action="pause" data-id="${widget.id}" aria-pressed="${widget.paused}">${t("visuals.pause")}</button></div>${this.spectralControls(widget)}${this.canvas(widget)}<button type="button" class="visual-resize-handle" data-grid-handle="resize" data-id="${widget.id}" aria-label="${t("visuals.resize")}" title="${t("visuals.resizeHint")}"><svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M5 15 15 5M10 15l5-5" fill="none" stroke="currentColor" stroke-width="2"/></svg></button></article>`).join("")}</div>${widgets.length ? "" : `<div class="visual-empty">${t("visuals.empty")}</div>`}`;
    this.dashboard.querySelector(".visual-error")!.textContent = this.feedback;
    this.dock.dataset.collapsed = String(this.settings.collapsed);
    this.dock.querySelector(".dock-heading")!.textContent = t("visuals.dock");
    const toggle = this.dock.querySelector<HTMLButtonElement>(
      "[data-visual-action=collapse]",
    )!;
    toggle.textContent = this.settings.collapsed ? "⌃" : "⌄";
    toggle.setAttribute(
      "aria-label",
      t(this.settings.collapsed ? "visuals.expand" : "visuals.collapse"),
    );
    toggle.title = t(
      this.settings.collapsed ? "visuals.expand" : "visuals.collapse",
    );
    toggle.setAttribute("aria-expanded", String(!this.settings.collapsed));
    const pinned = this.settings.dock_order.flatMap((id) =>
      widgets.filter((widget) => widget.id === id && widget.pinned),
    );
    this.dock.querySelector(".dock-picker")!.innerHTML =
      `<label>${t("visuals.show")}<select aria-label="${t("visuals.show")}" data-visual-field="active">${option("keyboard", t("keyboard.title"), this.settings.active)}${pinned.map((widget) => option(widget.id, `${title(widget)} · ${busName(widget.bus)}`, this.settings.active)).join("")}</select></label>`;
    const keyboard = this.dock.querySelector<HTMLElement>(".dock-keyboard")!;
    keyboard.dataset.active = String(this.settings.active === "keyboard");
    keyboard.dataset.dockWidth = String(
      Math.max(460, this.settings.keyboard_width),
    );
    keyboard.style.setProperty(
      "--dock-item-width",
      `${Math.max(460, this.settings.keyboard_width)}px`,
    );
    keyboard
      .querySelector("[data-dock-resize]")!
      .setAttribute("aria-label", t("visuals.resizeKeyboard"));
    keyboard
      .querySelector("[data-grid-handle]")!
      .setAttribute("aria-label", t("visuals.moveDock"));
    keyboard.querySelector<HTMLElement>("[data-grid-handle]")!.title =
      t("visuals.moveHint");
    const content = this.dock.querySelector<HTMLElement>(".dock-content")!;
    content
      .querySelectorAll(".dock-visual")
      .forEach((element) => element.remove());
    const markup = pinned
      .map((widget) =>
        dockPanel(
          widget.id,
          widget.kind === "midi"
            ? title(widget)
            : `${title(widget)} · ${busName(widget.bus)}`,
          `${this.canvas(widget)}${dockResizeHandle(widget.id)}`,
          `${this.modeButton(widget, true)}<button type="button" data-visual-action="pause" data-id="${widget.id}" aria-pressed="${widget.paused}">${t("visuals.pause")}</button><button type="button" data-visual-action="pin" data-id="${widget.id}" aria-label="${t("visuals.unpin")}">×</button>`,
          "dock-visual",
          `style="--dock-item-width:${widget.dock_width}px" data-dock-width="${widget.dock_width}" data-active="${widget.id === this.settings.active}"`,
        ),
      )
      .join("");
    content.insertAdjacentHTML("beforeend", markup);
    for (const id of this.settings.dock_order) {
      if (id === "keyboard") break;
      const item = [...content.children].find(
        (element) => (element as HTMLElement).dataset.widget === id,
      );
      if (item) content.insertBefore(item, keyboard);
    }
    this.layoutDock();
  }

  private dockWidths() {
    return new Map(
      [...this.dock.querySelectorAll<HTMLElement>(".dock-item")].map((item) => [
        item.dataset.widget!,
        item.dataset.widget === "keyboard"
          ? parseFloat(item.style.getPropertyValue("--dock-item-width")) ||
            this.settings.keyboard_width
          : parseFloat(item.style.getPropertyValue("--dock-item-width")) ||
            Number(item.dataset.dockWidth),
      ]),
    );
  }

  private dockAvailable(content: HTMLElement) {
    const style = getComputedStyle(content);
    return (
      content.clientWidth -
      (parseFloat(style.paddingLeft) || 0) -
      (parseFloat(style.paddingRight) || 0)
    );
  }

  private layoutDock() {
    const content = this.dock.querySelector<HTMLElement>(".dock-content")!;
    const available = this.dockAvailable(content);
    if (available <= 0) return;
    const mobile =
      matchMedia("(max-width: 800px)").matches &&
      !this.dock.classList.contains("layout-reordering");
    const settings = mobile
      ? {
          ...this.settings,
          dock_order: [this.settings.active],
          dock_positions: {},
        }
      : this.settings;
    const plan = dockLayout(settings, this.dockWidths(), available);
    content.style.gridTemplateColumns = `repeat(24, ${available / 24}px)`;
    content.style.gridAutoColumns = `${available / 24}px`;
    for (const item of content.querySelectorAll<HTMLElement>(".dock-item")) {
      const cell = plan.get(item.dataset.widget!);
      if (!cell) continue;
      item.style.gridColumn = `${cell.column} / span ${cell.span}`;
      item.style.gridRow = "1";
    }
  }

  private previewPlacement(
    id: string | null,
    target: string,
    before: boolean,
    x?: number,
  ) {
    this.placement?.remove();
    this.placement = null;
    if (!id || x === undefined) return;
    const content = this.dock.querySelector<HTMLElement>(".dock-content")!;
    if (content.clientWidth <= 24) return;
    const proposed = structuredClone(this.settings);
    moveDock(proposed, id, target, before, x);
    const cell = dockLayout(
      proposed,
      this.dockWidths(),
      this.dockAvailable(content),
    ).get(id);
    if (!cell) return;
    const shadow = document.createElement("div");
    shadow.className = "dock-placement-shadow";
    shadow.setAttribute("aria-hidden", "true");
    shadow.style.gridColumn = `${cell.column} / span ${cell.span}`;
    shadow.style.gridRow = String(cell.row);
    shadow.style.width = `${cell.width}px`;
    content.append(shadow);
    this.placement = shadow;
  }

  draw(now: number) {
    if (now - this.lastDraw < 50 || document.hidden) return;
    this.lastDraw = now;
    this.layoutDock();
    this.syncSubscription();
    const preview = this.preview();
    const signals = new Map<string, Signal>();

    for (const widget of this.settings.widgets) {
      const canvases = [
        ...document.querySelectorAll<HTMLCanvasElement>(
          `canvas[data-visual-canvas="${widget.id}"]`,
        ),
      ].filter((canvas) => canvas.checkVisibility());
      if (!canvases.length) continue;
      let signal = widget.paused ? this.frozen.get(widget.id) : undefined;
      if (!signal) {
        signal = signals.get(widget.bus);
        if (!signal) {
          const samples = [new Float32Array(1024), new Float32Array(1024)];
          if (preview)
            preview.analysers
              .slice(
                widget.bus === "channel" ? 0 : 2,
                widget.bus === "channel" ? 2 : 4,
              )
              .forEach((analyser, index) =>
                analyser.getFloatTimeDomainData(samples[index]),
              );
          else if (this.serverFrame && now - this.received < 400)
            samples.forEach((buffer, index) =>
              buffer.set(this.serverFrame![widget.bus][index].slice(-1024)),
            );
          const needsPitch = this.settings.widgets.some(
            (candidate) =>
              candidate.kind === "tuner" &&
              candidate.bus === widget.bus &&
              !candidate.paused,
          );
          const needsLong = this.settings.widgets.some(
            (candidate) =>
              ["spectrum", "spectrogram"].includes(candidate.kind) &&
              candidate.bus === widget.bus &&
              candidate.spectral.fft_size > 1024,
          );
          let pitch: Float32Array | undefined,
            pitchRate: number | undefined,
            analysisSamples: Float32Array[] | undefined;
          if ((needsPitch || needsLong) && preview?.pitchAnalysers) {
            const offset = widget.bus === "channel" ? 0 : 2;
            const windows = preview.pitchAnalysers
              .slice(offset, offset + 2)
              .map((analyser) => {
                const buffer = new Float32Array(4096);
                analyser.getFloatTimeDomainData(buffer);
                return buffer;
              });
            if (needsPitch) {
              pitch = pitchWindow(windows);
              pitchRate = preview.sampleRate / 4;
            }
            if (needsLong) analysisSamples = windows;
          } else if (
            needsPitch &&
            this.serverFrame?.pitch &&
            now - this.received < 400
          ) {
            pitch = Float32Array.from(this.serverFrame.pitch[widget.bus]);
            pitchRate = this.serverFrame.pitch.sample_rate;
          }
          if (
            !preview &&
            needsLong &&
            this.serverFrame &&
            now - this.received < 400
          )
            analysisSamples = this.serverFrame[widget.bus].map((values) =>
              Float32Array.from(values),
            );
          const source = preview ? "preview" : "server";
          const levels = this.levels.get(source);
          signal = {
            samples,
            pitch,
            pitchRate,
            analysisSamples,
            peaks:
              levels && now - levels.time < 160
                ? levels[widget.bus]
                : undefined,
            sampleRate:
              preview?.sampleRate ?? this.serverFrame?.sample_rate ?? 44100,
            source: preview ? "preview" : "server",
          };
          signals.set(widget.bus, signal);
        }
      }
      this.frozen.set(widget.id, signal);
      for (const canvas of canvases) {
        const label = canvas.parentElement!.querySelector(
          "[data-visual-source]",
        )!;
        label.textContent = `${t(widget.kind === "midi" ? "visuals.midiSource" : `visuals.${signal.source}`)}${widget.paused ? ` · ${t("visuals.paused")}` : ""}`;
        this.renderers.render(
          canvas,
          widget,
          signal,
          now,
          this.monitor.reading(this.midiSince.get(widget.id) ?? 0),
        );
      }
    }
  }
}
