import { discardLegacyPreferences, legacyPreferences } from "./preferences";

export interface Configuration {
  interface: { language: "es"; motion: "system" | "reduced" | "full" };
  keyboard: {
    capture: boolean;
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
}
interface Resources {
  audio_devices: { id: string; name: string; api: string }[];
  audio_error: string | null;
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
  interface: { language: "es", motion: "system" },
  keyboard: { capture: false, velocity: 100, labels: "shortcuts" },
  audio: { device: null, sample_rate: 44100, block_size: 256 },
  midi: { devices: {} },
  library: { paths: [] },
  browser_preview: false,
};
const sections = [
  ["interface", "Interfaz"],
  ["keyboard", "Teclado"],
  ["audio", "Audio"],
  ["midi", "MIDI"],
  ["library", "Biblioteca"],
];
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
    <header class="settings-header"><h2 id="settings-heading" tabindex="-1">Configuración</h2><button type="button" id="close-settings">← Volver</button></header>
    <div class="settings-layout"><nav class="settings-nav" aria-label="Secciones de configuración">${sections.map(([key, name]) => `<a href="#settings/${key}" data-section="${key}">${name}</a>`).join("")}</nav>
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
    const title = `<h3>${sections.find(([key]) => key === active)![1]}</h3>`;
    if (active === "interface")
      fields.innerHTML =
        title +
        `<div class="settings-form"><label class="field">Idioma<select id="interface-language"><option value="es">Español</option></select></label><label class="field">Animaciones<select id="interface-motion">${[
          ["system", "Seguir al sistema"],
          ["reduced", "Reducidas"],
          ["full", "Activadas"],
        ]
          .map(([key, name]) => option(key, name, config.interface.motion))
          .join("")}</select></label></div>`;
    if (active === "keyboard")
      fields.innerHTML =
        title +
        `<div class="settings-form"><button type="button" id="settings-capture" aria-pressed="${config.keyboard.capture}">Capturar teclado al abrir</button><label class="range-label">Velocidad fija<output id="keyboard-velocity-value">${config.keyboard.velocity}</output><input type="range" id="keyboard-velocity" aria-label="Velocidad fija" min="1" max="127" step="1" value="${config.keyboard.velocity}"></label><p class="muted">Intensidad de las notas tocadas desde la PC o la pantalla.</p><label class="field">Etiquetas del teclado<select id="keyboard-labels">${[
          ["shortcuts", "Atajos"],
          ["notes", "Notas"],
          ["both", "Notas y atajos"],
          ["none", "Ocultas"],
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
        `<div class="settings-form"><label class="field">Dispositivo de salida<select id="audio-device">${option("", "Predeterminado del sistema", audio.device ?? "")}${resources.audio_devices.map((device) => option(device.id, `${device.name} · ${device.api}`, audio.device ?? "")).join("")}${audio.device && !known ? option(audio.device, audio.device, audio.device) : ""}</select></label><button type="button" id="refresh-audio">Actualizar dispositivos</button><label class="field">Frecuencia de muestreo<select id="audio-rate">${[44100, 48000].map((rate) => option(rate, `${rate.toLocaleString("es")} Hz`, audio.sample_rate)).join("")}</select></label><label class="field">Tamaño de buffer<select id="audio-block">${[256, 512, 1024].map((size) => option(size, `${size} frames`, audio.block_size)).join("")}</select></label><p class="muted">Aplicar reinicia la salida y libera las notas activas.${resources.audio_enabled ? "" : " La salida del servidor está desactivada en este entorno; se guardará la configuración para cuando se active."}</p>${resources.audio_error ? `<p class="muted">${escape(resources.audio_error)}</p>` : ""}<button type="button" id="apply-audio" ${busy ? "disabled" : ""}>Aplicar audio</button></div>`;
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
              return `<section class="settings-device" data-midi-device="${escape(device.id)}"><h4>${escape(device.name)}</h4><p class="muted">${device.location === "server" ? "Servidor" : "Navegador"} · ${device.connected ? "Detectado" : "Desconectado"}</p><button type="button" data-midi-enabled="${escape(device.id)}" aria-pressed="${profile.enabled}">Conectar automáticamente</button><label class="field">Curva de velocidad<select data-midi-curve="${escape(device.id)}" aria-label="Curva de velocidad · ${escape(device.name)}">${[
                ["linear", "Lineal"],
                ["soft", "Suave"],
                ["hard", "Dura"],
              ]
                .map(([key, name]) => option(key, name, profile.velocity_curve))
                .join("")}</select></label></section>`;
            })
            .join("") ||
          '<p class="muted">No se detectaron dispositivos MIDI. Conectá uno al servidor, o habilitá el MIDI del navegador en Entradas.</p>'
        }</div><p class="muted">Suave requiere menos fuerza para tocar fuerte; dura requiere más. Las preferencias se recuerdan al reconectar cada controlador.</p>`;
    if (active === "library")
      fields.innerHTML =
        title +
        `<div class="settings-form"><label class="field">Carpetas de SoundFonts<textarea id="soundfont-paths" rows="5" spellcheck="false" placeholder="/ruta/a/soundfonts">${escape((libraryDraft ?? config.library.paths).join("\n"))}</textarea></label><p class="muted">Una carpeta o archivo SF2 por línea, en el servidor. Aplicar actualiza el catálogo y libera las notas activas.</p><button type="button" id="apply-library" ${busy ? "disabled" : ""}>Guardar carpetas</button><button type="button" id="refresh-library" ${busy ? "disabled" : ""}>Buscar SoundFonts</button></div>`;
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
          browser_preview: legacyPreferences.preview ?? false,
        },
        true,
      ).catch(() => {});
      return;
    }
    Object.assign(sharedSettings, message.settings);
    resources = message.resources;
    if (message.initialized) discardLegacyPreferences();
    onChange(sharedSettings);
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
        if (!response.ok)
          throw new Error(
            message.detail ?? "No se pudo guardar la configuración.",
          );
        accept(message);
        status("Guardado en el servidor.");
      });
    pending = request;
    return request.catch((error) => {
      status(error instanceof Error ? error.message : String(error), true);
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
      if (!response.ok)
        throw new Error("No se pudieron actualizar los dispositivos.");
      accept(await response.json());
      render();
    } catch (error) {
      status(String(error), true);
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
        if (!response.ok)
          throw new Error(
            result.detail ?? "No se pudo actualizar el catálogo.",
          );
        accept(result);
        status("Catálogo actualizado.");
      }
      libraryDraft = null;
    } catch (error) {
      status(String(error), true);
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
    listen("interface-language", "change", () =>
      save({ interface: { language: "es" } }),
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
