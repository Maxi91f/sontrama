import type { VisualizationSettings } from "./visualizations";
import {
  t,
  setLanguage,
  apiError,
  LocalizedError,
  errorText,
  issueText,
  type ApiIssue,
} from "./i18n";
import { discardLegacyPreferences, legacyPreferences } from "./preferences";

export interface Configuration {
  interface: { language: "es" | "en"; motion: "system" | "reduced" | "full" };
  keyboard: {
    capture: boolean;
    panel_octave: number;
    velocity: number;
    labels: "shortcuts" | "notes" | "both" | "none";
  };
  audio: { device: string | null; sample_rate: number; block_size: number };
  midi: {
    devices: Record<
      string,
      { enabled: boolean; velocity_curve: "linear" | "soft" | "hard" }
    >;
  };
  library: { paths: string[] };
  browser_preview: boolean;
  preview_volume: number;
  preview_muted: boolean;
  visualizations: VisualizationSettings;
}
interface Resources {
  audio_devices: { id: string; name: string; api: string }[];
  audio_error: string | null;
  audio_issue?: ApiIssue | null;
  audio_enabled: boolean;
  midi_inputs: {
    id: string;
    name: string;
    location: string;
    connected: boolean;
  }[];
}
export interface SettingsMessage {
  type: "settings";
  settings: Configuration;
  initialized: boolean;
  resources: Resources;
}
export const sharedSettings: Configuration = {
  interface: { language: "en", motion: "system" },
  keyboard: {
    capture: false,
    panel_octave: 0,
    velocity: 100,
    labels: "shortcuts",
  },
  audio: { device: null, sample_rate: 44100, block_size: 256 },
  midi: { devices: {} },
  library: { paths: [] },
  browser_preview: true,
  preview_volume: 1,
  preview_muted: true,
  visualizations: {
    widgets: [],
    dock_order: ["keyboard"],
    dock_positions: {},
    keyboard_width: 600,
    collapsed: false,
    active: "keyboard",
  },
};
const sections = [
  ["interface", "settings.interface"],
  ["keyboard", "settings.keyboard"],
  ["audio", "settings.audio"],
  ["midi", "settings.midi"],
  ["library", "settings.library"],
] as const;
const escape = (value: unknown) =>
  String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
const option = (
  value: string | number,
  name: string,
  current: string | number,
) =>
  `<option value="${escape(value)}" ${value === current ? "selected" : ""}>${escape(name)}</option>`;
export const settingsIcon = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" fill-rule="evenodd" d="M9 2h6l.5 3 2 1 2.5-1 3 5-2.5 2v2L23 16l-3 5-2.5-1-2 1-.5 3H9l-.5-3-2-1L4 21l-3-5 2.5-2v-2L1 10l3-5 2.5 1 2-1L9 2Zm3 7a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z" transform="translate(1 0) scale(.92)"/></svg>`;
export function settingsView() {
  return `<section id="settings-view" class="settings-view" aria-labelledby="settings-heading" hidden>
    <header class="settings-header"><h2 id="settings-heading" tabindex="-1">${t("nav.settings")}</h2><button type="button" id="close-settings">${t("nav.back")}</button></header>
    <div class="settings-layout"><nav class="settings-nav" aria-label="${t("nav.settingsSections")}">${sections.map(([key, name]) => `<a href="#settings/${key}" data-section="${key}">${t(name)}</a>`).join("")}</nav>
    <div class="settings-content"><p id="settings-feedback" role="status" hidden></p><div id="settings-fields"></div></div></div></section>`;
}
export function initializeSettings(
  root: HTMLElement,
  onVisibilityChange: (open: boolean) => void,
  onChange: (configuration: Configuration) => void,
) {
  const view = root.querySelector<HTMLElement>("#settings-view")!;
  const trigger = root.querySelector<HTMLButtonElement>("#open-settings")!;
  const fields = root.querySelector<HTMLElement>("#settings-fields")!;
  const heading = root.querySelector<HTMLElement>("#settings-heading")!;
  const feedback = root.querySelector<HTMLElement>("#settings-feedback")!;
  const toast = document.createElement("div");
  toast.className = "settings-toast";
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");
  toast.hidden = true;
  document.body.append(toast);
  let toastTimeout: ReturnType<typeof setTimeout> | undefined;
  let wasOpen = false,
    migrated = false,
    busy = false;
  let active = "interface";
  let audioDraft: Configuration["audio"] | null = null;
  let libraryDraft: string[] | null = null;
  let resources: Resources = {
    audio_devices: [],
    audio_error: null,
    audio_enabled: false,
    midi_inputs: [],
  };
  let pending = Promise.resolve();
  function status(message = "", error = false) {
    if (message && !error) {
      clearTimeout(toastTimeout);
      toast.textContent = message;
      toast.hidden = false;
      toastTimeout = setTimeout(() => {
        toast.hidden = true;
      }, 1800);
      feedback.hidden = true;
      return;
    }
    feedback.textContent = message;
    feedback.hidden = !message;
    feedback.setAttribute("role", error ? "alert" : "status");
    feedback.classList.toggle("error", error);
  }
  function render() {
    const config = sharedSettings;
    const title = `<h3>${t(sections.find(([key]) => key === active)![1])}</h3>`;
    if (active === "interface")
      fields.innerHTML =
        title +
        `<div class="settings-form"><label class="field">${t("settings.language")}<select id="interface-language">${option("es", t("languages.es"), config.interface.language)}${option("en", t("languages.en"), config.interface.language)}</select></label><label class="field">${t("settings.motion")}<select id="interface-motion">${[
          ["system", t("settings.systemMotion")],
          ["reduced", t("settings.reducedMotion")],
          ["full", t("settings.fullMotion")],
        ]
          .map(([key, name]) => option(key, name, config.interface.motion))
          .join("")}</select></label></div>`;
    if (active === "keyboard")
      fields.innerHTML =
        title +
        `<div class="settings-form"><button type="button" id="settings-capture" aria-pressed="${config.keyboard.capture}">${t("settings.capture")}</button><label class="range-label">${t("settings.velocity")}<output id="keyboard-velocity-value">${config.keyboard.velocity}</output><input type="range" id="keyboard-velocity" aria-label="${t("settings.velocity")}" min="1" max="127" step="1" value="${config.keyboard.velocity}"></label><p class="muted">${t("settings.velocityHint")}</p><label class="field">${t("settings.labels")}<select id="keyboard-labels">${[
          ["shortcuts", t("settings.shortcuts")],
          ["notes", t("settings.notes")],
          ["both", t("settings.both")],
          ["none", t("settings.hidden")],
        ]
          .map(([key, name]) => option(key, name, config.keyboard.labels))
          .join("")}</select></label></div>`;
    if (active === "audio") {
      const audio = audioDraft ?? config.audio;
      const known = resources.audio_devices.some(
        (device) => device.id === audio.device,
      );
      fields.innerHTML =
        title +
        `<div class="settings-form"><button type="button" id="settings-simulation" aria-pressed="${config.browser_preview}">${t("settings.simulation")}</button><p class="muted">${t("settings.simulationHint")}</p><label class="field">${t("settings.device")}<select id="audio-device">${option("", t("settings.defaultDevice"), audio.device ?? "")}${resources.audio_devices.map((device) => option(device.id, `${device.name} · ${device.api}`, audio.device ?? "")).join("")}${audio.device && !known ? option(audio.device, audio.device, audio.device) : ""}</select></label><button type="button" id="refresh-audio">${t("settings.refreshDevices")}</button><label class="field">${t("settings.sampleRate")}<select id="audio-rate">${[44100, 48000].map((rate) => option(rate, `${rate.toLocaleString(config.interface.language)} Hz`, audio.sample_rate)).join("")}</select></label><label class="field">${t("settings.buffer")}<select id="audio-block">${[256, 512, 1024].map((size) => option(size, t("settings.frames", { count: size }), audio.block_size)).join("")}</select></label><p class="muted">${t("settings.applyHint")}${resources.audio_enabled ? "" : t("settings.disabledHint")}</p>${resources.audio_error ? `<p class="muted">${escape(issueText(resources.audio_issue ?? { code: "audio_unavailable", message: resources.audio_error }))}</p>` : ""}<button type="button" id="apply-audio" ${busy ? "disabled" : ""}>${t("settings.applyAudio")}</button></div>`;
    }
    if (active === "midi")
      fields.innerHTML =
        title +
        `<div class="settings-midi-list">${
          resources.midi_inputs
            .map((device) => {
              const profile = config.midi.devices[device.id] ?? {
                enabled: true,
                velocity_curve: "linear",
              };
              return `<section class="settings-device" data-midi-device="${escape(device.id)}"><h4>${escape(device.name)}</h4><p class="muted">${device.location === "server" ? t("settings.server") : t("settings.browser")} · ${device.connected ? t("settings.detected") : t("settings.disconnected")}</p><button type="button" data-midi-enabled="${escape(device.id)}" aria-pressed="${profile.enabled}">${t("settings.autoConnect")}</button><label class="field">${t("settings.curve")}<select data-midi-curve="${escape(device.id)}" aria-label="${escape(t("settings.deviceCurve", { device: device.name }))}">${[
                ["linear", t("settings.linear")],
                ["soft", t("settings.soft")],
                ["hard", t("settings.hard")],
              ]
                .map(([key, name]) => option(key, name, profile.velocity_curve))
                .join("")}</select></label></section>`;
            })
            .join("") || `<p class="muted">${t("settings.noMidi")}</p>`
        }</div><p class="muted">${t("settings.curveHint")}</p>`;
    if (active === "library")
      fields.innerHTML =
        title +
        `<div class="settings-form"><label class="field">${t("settings.folders")}<textarea id="soundfont-paths" rows="5" spellcheck="false" placeholder="${t("settings.path")}">${escape((libraryDraft ?? config.library.paths).join("\n"))}</textarea></label><p class="muted">${t("settings.libraryHint")}</p><button type="button" id="apply-library" ${busy ? "disabled" : ""}>${t("settings.saveFolders")}</button><button type="button" id="refresh-library" ${busy ? "disabled" : ""}>${t("settings.scan")}</button></div>`;
    bind();
  }
  function accept(message: SettingsMessage) {
    if (
      !message.initialized &&
      !migrated &&
      (legacyPreferences.capture !== undefined ||
        legacyPreferences.preview !== undefined)
    ) {
      migrated = true;
      void update(
        {
          keyboard: { capture: legacyPreferences.capture ?? false },
          browser_preview: true,
        },
        true,
      ).catch(() => {});
      return;
    }
    Object.assign(sharedSettings, message.settings);
    resources = message.resources;
    if (message.initialized) discardLegacyPreferences();
    onChange(sharedSettings);
    setLanguage(sharedSettings.interface.language);
    heading.textContent = t("nav.settings");
    root.querySelector("#close-settings")!.textContent = t("nav.back");
    root
      .querySelector(".settings-nav")!
      .setAttribute("aria-label", t("nav.settingsSections"));
    for (const [key, label] of sections)
      root.querySelector(`[data-section="${key}"]`)!.textContent = t(label);
    const focused = fields.contains(document.activeElement)
      ? (document.activeElement as HTMLElement).id
      : null;
    render();
    if (focused)
      fields
        .querySelector<HTMLElement>(`#${CSS.escape(focused)}`)
        ?.focus({ preventScroll: true });
  }
  function update(patch: Record<string, unknown>, initializeOnly = false) {
    const request = pending
      .catch(() => {})
      .then(async () => {
        const response = await fetch(
          `/api/settings${initializeOnly ? "?initialize_only=true" : ""}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch),
          },
        );
        const message = await response.json();
        if (!response.ok) throw apiError(message.detail);
        accept(message);
        status(t("settings.saved"));
      });
    pending = request;
    return request.catch((error) => {
      status(errorText(error), true);
      render();
      throw error;
    });
  }
  const save = (patch: Record<string, unknown>) => {
    void update(patch).catch(() => {});
  };
  async function refreshAudio() {
    try {
      const response = await fetch("/api/settings?refresh=true");
      if (!response.ok) throw new LocalizedError("errors.devicesRefresh");
      accept(await response.json());
      render();
    } catch (error) {
      status(errorText(error), true);
    }
  }
  async function applyAudio() {
    busy = true;
    const candidate = audioDraft ?? sharedSettings.audio;
    render();
    try {
      await update({ audio: candidate });
      audioDraft = null;
    } catch {
      /* Keep the draft visible so it can be corrected. */
    } finally {
      busy = false;
      render();
    }
  }
  async function library(rescan: boolean) {
    busy = true;
    render();
    try {
      if (!rescan)
        await update({
          library: { paths: libraryDraft ?? sharedSettings.library.paths },
        });
      else {
        const response = await fetch("/api/settings/library/refresh", {
          method: "POST",
        });
        const result = await response.json();
        if (!response.ok) throw apiError(result.detail);
        accept(result);
        status(t("settings.catalogUpdated"));
      }
      libraryDraft = null;
    } catch (error) {
      status(errorText(error), true);
    } finally {
      busy = false;
      render();
    }
  }
  function bind() {
    const listen = (
      id: string,
      event: string,
      listener: (event: Event) => void,
    ) => fields.querySelector(`#${id}`)?.addEventListener(event, listener);
    listen("interface-language", "change", (event) =>
      save({
        interface: { language: (event.target as HTMLSelectElement).value },
      }),
    );
    listen("interface-motion", "change", (event) =>
      save({
        interface: { motion: (event.target as HTMLSelectElement).value },
      }),
    );
    listen("settings-capture", "click", () =>
      save({ keyboard: { capture: !sharedSettings.keyboard.capture } }),
    );
    listen("keyboard-velocity", "input", (event) => {
      fields.querySelector("#keyboard-velocity-value")!.textContent = (
        event.target as HTMLInputElement
      ).value;
    });
    listen("keyboard-velocity", "change", (event) =>
      save({
        keyboard: {
          velocity: Number((event.target as HTMLInputElement).value),
        },
      }),
    );
    listen("keyboard-labels", "change", (event) =>
      save({ keyboard: { labels: (event.target as HTMLSelectElement).value } }),
    );
    const audioChange = () => {
      audioDraft = {
        device:
          (fields.querySelector("#audio-device") as HTMLSelectElement).value ||
          null,
        sample_rate: Number(
          (fields.querySelector("#audio-rate") as HTMLSelectElement).value,
        ),
        block_size: Number(
          (fields.querySelector("#audio-block") as HTMLSelectElement).value,
        ),
      };
    };
    for (const id of ["audio-device", "audio-rate", "audio-block"])
      listen(id, "change", audioChange);
    listen("settings-simulation", "click", () =>
      save({ browser_preview: !sharedSettings.browser_preview }),
    );
    listen("refresh-audio", "click", () => void refreshAudio());
    listen("apply-audio", "click", () => void applyAudio());
    listen("soundfont-paths", "input", (event) => {
      libraryDraft = (event.target as HTMLTextAreaElement).value
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean);
    });
    listen("apply-library", "click", () => void library(false));
    listen("refresh-library", "click", () => void library(true));
    fields
      .querySelectorAll<HTMLButtonElement>("[data-midi-enabled]")
      .forEach((button) =>
        button.addEventListener("click", () => {
          const id = button.dataset.midiEnabled!,
            profile = sharedSettings.midi.devices[id] ?? {
              enabled: true,
              velocity_curve: "linear",
            };
          save({
            midi: {
              devices: { [id]: { ...profile, enabled: !profile.enabled } },
            },
          });
        }),
      );
    fields
      .querySelectorAll<HTMLSelectElement>("[data-midi-curve]")
      .forEach((select) =>
        select.addEventListener("change", () => {
          const id = select.dataset.midiCurve!,
            profile = sharedSettings.midi.devices[id] ?? {
              enabled: true,
              velocity_curve: "linear",
            };
          save({
            midi: {
              devices: { [id]: { ...profile, velocity_curve: select.value } },
            },
          });
        }),
      );
  }
  trigger.addEventListener("click", () => {
    location.hash = "settings/interface";
  });
  root.querySelector("#close-settings")!.addEventListener("click", () => {
    location.hash = "live";
  });
  const sync = () => {
    const open = location.hash.startsWith("#settings");
    const requested = location.hash.split("/")[1] ?? "interface";
    active = sections.some(([key]) => key === requested)
      ? requested
      : "interface";
    view.hidden = !open;
    trigger.setAttribute("aria-expanded", String(open));
    trigger.classList.toggle("selected", open);
    root
      .querySelectorAll<HTMLAnchorElement>("[data-section]")
      .forEach((link) => {
        if (link.dataset.section === active)
          link.setAttribute("aria-current", "page");
        else link.removeAttribute("aria-current");
      });
    onVisibilityChange(open);
    render();
    status();
    if (open && !wasOpen) {
      heading.focus({ preventScroll: true });
      void refreshAudio();
    } else if (wasOpen && !open) trigger.focus({ preventScroll: true });
    wasOpen = open;
  };
  window.addEventListener("hashchange", sync);
  view.addEventListener("keydown", (event) => {
    if (
      event.key === "Escape" &&
      !event.defaultPrevented &&
      !(event.target instanceof HTMLSelectElement)
    ) {
      location.hash = "live";
      event.preventDefault();
    }
  });
  sync();
  return { accept, update };
}
export type SettingsController = ReturnType<typeof initializeSettings>;
