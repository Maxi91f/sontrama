import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./style.css";
import { BrowserInstrument } from "./audio";
import { threeOscPanel } from "./three-osc-panel";
import { waveforms } from "./waveform-picker";
import { preferences, savePreferences } from "./preferences";
import {
  initializeSettings,
  settingsIcon,
  settingsView,
  sharedSettings,
  type SettingsController,
} from "./settings";
import {
  effectInfo,
  type EffectKind,
  type Session,
  type Snapshot,
} from "./types";

const app = document.querySelector<HTMLDivElement>("#app")!;
const audio = new BrowserInstrument();
const tabs = [
  ["inputs", "Entradas"],
  ["instrument", "Instrumento"],
  ["effects", "Efectos"],
  ["mixer", "Mixer"],
  ["output", "Salida"],
];
let snapshot: Snapshot | null = null;
let socket: WebSocket | null = null;
let reconnect: ReturnType<typeof setTimeout> | undefined;
let connected = false;
let previewEnabled = false;
let capturing = false;
let settingsOpen = false;
let settingsController: SettingsController | null = null;
let selectedTab = preferences.tab;
let midiAccess: MIDIAccess | null = null;
let starting = false;
let mutation = Promise.resolve();
let lastServerError = "";
const held = new Map<string, { note: number }>();
const incomingNotes = new Set<number>();
const escape = (value: unknown) =>
  String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
const selected = (value: boolean) => (value ? "selected" : "");
const $ = <T extends HTMLElement = HTMLElement>(selector: string) =>
  app.querySelector<T>(selector)!;

app.innerHTML = `
  <main class="studio">
    <header class="studio-header"><h1>Sontrama</h1><span class="live-tag">LIVE</span><div class="header-actions"><span id="connection" role="status">Conectando…</span><button type="button" id="open-settings" class="settings-trigger" aria-label="Configuración" title="Configuración" aria-controls="settings-view" aria-expanded="false">${settingsIcon}</button></div></header>
    <div id="live-view">
    <nav class="studio-tabs" role="tablist" aria-label="Secciones de Live">${tabs.map(([key, name]) => `<button type="button" id="tab-${key}" role="tab" aria-controls="panel-${key}" data-tab="${key}" aria-selected="false">${name}</button>`).join("")}</nav>
    <div id="notice" role="alert" hidden></div>
    <div class="workspace">${tabs.map(([key]) => `<section id="panel-${key}" class="pane" role="tabpanel" aria-labelledby="tab-${key}" hidden></section>`).join("")}</div>
    <details class="keyboard-drawer" ${capturing ? "open" : ""}><summary>Teclado de prueba</summary><section class="keyboard-pane">
      <div class="keyboard-head"><button id="capture-keyboard" type="button" aria-pressed="false">Capturar teclado</button></div>
      <div class="piano" aria-label="Teclado de Do4 a La6"></div>
    </section></details>
    </div>
    ${settingsView()}
  </main>`;

function notice(message = "") {
  $("#notice").textContent = message;
  $("#notice").hidden = !message;
}
function fail(error: unknown) {
  console.error(error);
  notice(error instanceof Error ? error.message : String(error));
}
function activate(tab: string, focus = false) {
  if (!tabs.some(([key]) => key === tab)) tab = "instrument";
  selectedTab = tab;
  savePreferences({ tab });
  for (const [key] of tabs) {
    const button = $<HTMLButtonElement>(`#tab-${key}`);
    button.setAttribute("aria-selected", String(key === tab));
    button.tabIndex = key === tab ? 0 : -1;
    $(`#panel-${key}`).hidden = key !== tab;
    if (focus && key === tab) button.focus();
  }
}
activate(selectedTab);
syncKeyboardButton();
app.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((button) => {
  button.addEventListener("click", () => activate(button.dataset.tab!));
  button.addEventListener("keydown", (event) => {
    const index = tabs.findIndex(([key]) => key === selectedTab);
    const target =
      event.key === "ArrowRight"
        ? (index + 1) % tabs.length
        : event.key === "ArrowLeft"
          ? (index + tabs.length - 1) % tabs.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? tabs.length - 1
              : -1;
    if (target >= 0) {
      event.preventDefault();
      activate(tabs[target][0], true);
    }
  });
});

function meter(name: string) {
  return `<div class="meter" role="meter" aria-label="Nivel ${name}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" data-meter="${name}"><span></span></div>`;
}
function render() {
  if (!snapshot) return;
  const state = snapshot.session;
  const font = snapshot.catalog.find((bank) => bank.id === state.soundfont);
  const preset = font?.presets.find(
    (p) => p.bank === state.bank && p.program === state.program,
  );
  $("#panel-inputs").innerHTML = `<h2>Entradas MIDI</h2><div class="block">
    <div class="source"><button type="button" data-action="usb" aria-pressed="${state.usb_enabled}">MIDI del servidor</button><p class="muted">${snapshot.status.midi.length ? snapshot.status.midi.map(escape).join("<br>") : "Esperando un dispositivo USB MIDI…"}</p></div>
    <label class="field">Canal de entrada<select data-field="midi_channel" aria-label="Canal MIDI"><option value="" ${selected(state.midi_channel === null)}>Todos los canales</option>${Array.from({ length: 16 }, (_, index) => `<option value="${index}" ${selected(state.midi_channel === index)}>${index + 1}</option>`).join("")}</select></label>
    <div class="source"><strong>Teclado de computadora</strong><p class="muted">Pulsá «Capturar teclado» en el teclado de prueba.</p></div>
    <div class="source"><strong>MIDI conectado a esta computadora</strong><p class="muted" id="browser-midi-status">${midiAccess ? [...midiAccess.inputs.values()].map((input) => escape(input.name)).join(" · ") || "Sin dispositivos" : "Acceso opcional desde el navegador."}</p><button type="button" data-action="browser-midi">Conectar MIDI del navegador</button></div>
    <p class="route"><span class="route-chip">Entradas activas</span> → Instrumento 01</p></div>`;
  $("#panel-instrument").innerHTML =
    `<div class="block instrument-block"><h2>Instrumento activo · 01</h2>
    <label class="field instrument-field">Instrumento<select aria-label="Instrumento" data-field="instrument" class="instrument-select"><option value="banks" ${selected(state.instrument === "banks")}>Banks</option><option value="three-osc" ${selected(state.instrument === "three-osc")}>3 Osc</option></select></label>
    <div class="instrument-options" role="group" aria-label="Opciones de ${state.instrument === "banks" ? "Banks" : "3 Osc"}">
    ${
      state.instrument === "banks"
        ? `<label class="field preset-field">Sonido<select data-field="preset" aria-label="Sonido" ${font ? "" : "disabled"}>${font?.presets.map((p) => `<option value="${p.bank}:${p.program}" ${selected(p.bank === state.bank && p.program === state.program)}>${escape(p.name)} · ${p.bank}:${p.program}</option>`).join("") ?? "<option>Sin SoundFont</option>"}</select></label>
    <label class="field bank-field">SoundFont<select data-field="soundfont" aria-label="SoundFont">${snapshot.catalog.map((bank) => `<option value="${bank.id}" ${selected(bank.id === state.soundfont)}>${escape(bank.name)}</option>`).join("") || "<option>No hay bancos instalados</option>"}</select></label>`
        : threeOscPanel(state.three_osc)
    }
    <div class="instrument-controls"><label class="field">Octava<select data-field="octave" aria-label="Octava">${[-2, -1, 0, 1, 2].map((value) => `<option ${selected(value === state.octave)} value="${value}">${value > 0 ? "+" : ""}${value}</option>`).join("")}</select></label><div class="field">Sustain<button type="button" data-action="sustain" aria-pressed="${state.sustain}">CC64</button></div></div></div>
    <p class="route"><span class="route-chip">Salida de audio</span> → Canal 01</p>
    </div>`;
  $("#panel-effects").innerHTML =
    `<div class="panel-heading"><h2>Efectos · canal 01</h2><span class="muted">En serie ↓</span></div><div class="effects-list">${
      state.effects
        .map((effect, index) => {
          const info = effectInfo[effect.kind];
          return `<section class="effect ${effect.enabled ? "" : "bypassed"}" data-effect="${effect.id}"><div class="effect-top"><button type="button" data-fx-enabled="${effect.id}" aria-pressed="${effect.enabled}">${info.name}</button><button type="button" data-fx-move="${effect.id}" data-direction="-1" aria-label="Subir ${info.name}" ${index === 0 ? "disabled" : ""}>↑</button><button type="button" data-fx-move="${effect.id}" data-direction="1" aria-label="Bajar ${info.name}" ${index === state.effects.length - 1 ? "disabled" : ""}>↓</button><button type="button" data-fx-remove="${effect.id}" aria-label="Quitar ${info.name}">×</button></div><label class="range-label">${info.label}<output>${info.format(effect.value)}</output><input type="range" data-fx-value="${effect.id}" data-kind="${effect.kind}" aria-label="${info.label} ${info.name}" min="${info.min}" max="${info.max}" step="${info.step}" value="${effect.value}"></label></section>`;
        })
        .join("") ||
      '<p class="muted">Sin efectos. El audio pasa directamente al mixer.</p>'
    }</div><label class="field add-effect">Añadir efecto<select data-field="add-effect" aria-label="Añadir efecto" ${state.effects.length >= 8 ? "disabled" : ""}><option value="">Elegir efecto…</option>${Object.entries(
      effectInfo,
    )
      .map(([key, info]) => `<option value="${key}">${info.name}</option>`)
      .join("")}</select></label>`;
  $("#panel-mixer").innerHTML =
    `<h2>Mixer</h2><div class="mixer"><section class="block strip"><div class="strip-head"><h3>01</h3><span>${escape(state.instrument === "banks" ? (preset?.name ?? "Banks") : "3 Osc")}</span></div>${meter("channel")}<div class="strip-controls"><button type="button" data-action="mute" aria-pressed="${state.mute}">Mute</button><button type="button" data-action="solo" aria-pressed="${state.solo}">Solo</button></div><label class="range-label">Nivel<output>${Math.round(state.volume * 100)}%</output><input type="range" data-field="volume" min="0" max="1" step=".01" value="${state.volume}" aria-label="Volumen de canal 01"></label><p class="muted">Salida → Master</p></section><section class="block strip"><div class="strip-head"><h3>Master</h3></div>${meter("master")}<p class="muted solo-hint">Un canal activo${state.solo ? " · Solo" : ""}</p><label class="range-label">Nivel<output>${Math.round(state.master * 100)}%</output><input type="range" data-field="master" min="0" max="1" step=".01" value="${state.master}" aria-label="Volumen master"></label><p class="muted">Salida del servidor</p></section></div>`;
  $("#panel-output").innerHTML =
    `<h2>Salida de audio</h2><div class="output-sections"><section class="block"><h3>Salida principal</h3><p>Servidor · salida de audio</p><p class="muted">Sigue sonando aunque cierres el navegador.</p><div class="signal-path">MIDI → ${state.instrument === "banks" ? "Banks" : "3 Osc"} → ${
      state.effects
        .filter((effect) => effect.enabled)
        .map((effect) => effectInfo[effect.kind].name)
        .join(" → ") +
      (state.effects.some((effect) => effect.enabled) ? " → " : "")
    }Canal 01 → Master → Salida del servidor</div><p class="muted">Motor: ${escape(snapshot.status.engine)} · Audio: ${escape(snapshot.status.audio)}</p><p class="muted">Cortes de audio detectados: <span id="underruns">${snapshot.status.underruns}</span></p></section><section class="block"><h3>Preview en navegador</h3><p class="muted">Escuchá una copia del audio acá, sin cambiar la salida principal.</p><button type="button" id="browser-preview" data-action="preview" aria-pressed="${previewEnabled}">Activar preview</button></section></div>`;
  syncPreviewButton();
  const serverError = snapshot.status.errors.join(" · ");
  if (serverError) notice(serverError);
  else if (lastServerError && $("#notice").textContent === lastServerError)
    notice();
  lastServerError = serverError;
  bindControls();
}

function accept(state: Snapshot) {
  const previous = snapshot?.session;
  const reloadFont =
    snapshot?.status.catalog_revision !== undefined &&
    snapshot.status.catalog_revision !== state.status.catalog_revision;
  snapshot = state;
  if (
    previous &&
    ["instrument", "octave", "output", "soundfont", "bank", "program"].some(
      (key) =>
        previous[key as keyof Session] !== state.session[key as keyof Session],
    )
  )
    releaseAll();
  render();
  if (audio.context && !starting)
    void audio.apply(state.session, reloadFont).catch(fail);
}

function patch(
  change: Partial<Session> | ((state: Session) => Partial<Session>),
) {
  mutation = mutation
    .then(async () => {
      if (!snapshot) return;
      const response = await fetch("/api/session", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          typeof change === "function" ? change(snapshot.session) : change,
        ),
      });
      if (!response.ok) {
        const body = await response.json();
        throw new Error(body.detail ?? "No se pudo guardar.");
      }
      notice();
      accept(await response.json());
    })
    .catch((error) => {
      fail(error);
      render();
    });
  return mutation;
}

function syncKeyboardButton() {
  const button = $<HTMLButtonElement>("#capture-keyboard");
  button.setAttribute("aria-pressed", String(capturing));
  button.textContent = capturing ? "Teclado capturado" : "Capturar teclado";
}
function syncPreviewButton() {
  const button = app.querySelector<HTMLButtonElement>("#browser-preview");
  if (!button) return;
  button.disabled = starting;
  button.setAttribute("aria-pressed", String(previewEnabled));
  button.setAttribute("aria-busy", String(starting));
  button.textContent = starting
    ? "Cargando preview…"
    : previewEnabled
      ? audio.context?.state === "suspended"
        ? "Reactivar preview"
        : "Preview activado"
      : "Activar preview";
}
async function setPreview(enabled: boolean, automatic = false, persist = true) {
  if (!snapshot || starting) return;
  starting = true;
  let applied = false;
  syncPreviewButton();
  try {
    if (enabled) {
      const revision = snapshot.status.catalog_revision;
      await audio.start(snapshot.session, automatic);
      await audio.apply(
        snapshot.session,
        revision !== snapshot.status.catalog_revision,
      );
      previewEnabled = true;
      audio.context?.addEventListener("statechange", syncPreviewButton);
      notice();
    } else {
      previewEnabled = false;
      await audio.stop();
    }
    if (persist) await settingsController?.update({ browser_preview: enabled });
    applied = true;
  } catch (error) {
    applied = persist;
    fail(error);
  } finally {
    starting = false;
    syncPreviewButton();
    if (applied && sharedSettings.browser_preview !== previewEnabled)
      void setPreview(sharedSettings.browser_preview, true, false);
  }
}
async function togglePreview() {
  if (previewEnabled && audio.context?.state === "suspended") {
    try {
      await audio.context.resume();
      syncPreviewButton();
    } catch (error) {
      fail(error);
    }
    return;
  }
  await setPreview(!previewEnabled);
}

// A remembered preview can be initialized while autoplay is suspended. Resume
// on the next local gesture without changing the user's saved preference.
function resumeRememberedPreview(event: Event) {
  if ((event.target as Element)?.closest?.("#browser-preview")) return;
  if (sharedSettings.browser_preview && audio.context?.state === "suspended")
    void audio.context.resume().catch(fail);
}
window.addEventListener("pointerdown", resumeRememberedPreview, {
  capture: true,
});
window.addEventListener("keydown", resumeRememberedPreview, { capture: true });

function bindControls() {
  app
    .querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-field]")
    .forEach((input) => {
      input.addEventListener("change", () => {
        const field = input.dataset.field!;
        const value = input.value;
        if (field === "instrument") {
          void patch({ instrument: value as Session["instrument"] });
        } else if (field === "preset") {
          const [bank, program] = value.split(":").map(Number);
          void patch({ bank, program });
        } else if (field === "soundfont") {
          const first = snapshot?.catalog.find((bank) => bank.id === value)
            ?.presets[0];
          if (first)
            void patch({
              soundfont: value,
              bank: first.bank,
              program: first.program,
            });
        } else if (field === "add-effect") {
          if (!value) return;
          const kind = value as EffectKind;
          void patch((state) => ({
            effects: [
              ...state.effects,
              {
                id: crypto.randomUUID
                  ? crypto.randomUUID()
                  : `${Date.now()}-${Math.random()}`,
                kind,
                enabled: true,
                value: effectInfo[kind].initial,
              },
            ],
          }));
        } else if (field === "midi_channel")
          void patch({ midi_channel: value === "" ? null : Number(value) });
        else void patch({ [field]: Number(value) });
      });
      if (input.type === "range")
        input.addEventListener("input", () => {
          input.previousElementSibling!.textContent = `${Math.round(Number(input.value) * 100)}%`;
        });
    });
  app
    .querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-osc-param]")
    .forEach((input) => {
      input.addEventListener("change", () => {
        void patch((state) => {
          const config = structuredClone(state.three_osc);
          const value =
            input instanceof HTMLSelectElement
              ? input.value
              : Number(input.value);
          const key = input.dataset.oscParam!;
          if (input.dataset.oscIndex !== undefined)
            Object.assign(config.oscillators[Number(input.dataset.oscIndex)], {
              [key]: value,
            });
          else if (key === "phase_random") config.phase_random = Number(value);
          else Object.assign(config.envelope, { [key]: value });
          return { three_osc: config };
        });
      });
      if (input instanceof HTMLInputElement)
        input.addEventListener("input", () => {
          const suffix = input.dataset.suffix ?? "";
          input.previousElementSibling!.textContent =
            suffix === "%"
              ? `${Math.round(Number(input.value) * 100)}%`
              : `${input.value}${suffix}`;
        });
    });
  app.querySelectorAll<HTMLInputElement>("[data-fx-value]").forEach((input) => {
    input.addEventListener("input", () => {
      input.previousElementSibling!.textContent = effectInfo[
        input.dataset.kind as EffectKind
      ].format(Number(input.value));
    });
    input.addEventListener(
      "change",
      () =>
        void patch((state) => ({
          effects: state.effects.map((effect) =>
            effect.id === input.dataset.fxValue
              ? { ...effect, value: Number(input.value) }
              : effect,
          ),
        })),
    );
  });
}

app.addEventListener("click", (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>("button");
  if (!button) return;
  if (button.dataset.oscShape)
    void patch((state) => {
      const config = structuredClone(state.three_osc);
      config.oscillators[Number(button.dataset.oscIndex)].shape = button.dataset
        .oscShape as Session["three_osc"]["oscillators"][number]["shape"];
      return { three_osc: config };
    });
  if (button.dataset.oscToggle)
    void patch((state) => {
      const config = structuredClone(state.three_osc);
      const key = button.dataset.oscToggle!;
      if (button.dataset.oscIndex !== undefined) {
        const osc = config.oscillators[Number(button.dataset.oscIndex)];
        Object.assign(osc, { [key]: !osc.enabled });
      } else Object.assign(config, { [key]: !config[key as "hq" | "am_osc3"] });
      return { three_osc: config };
    });
  if (button.dataset.fxEnabled)
    void patch((state) => ({
      effects: state.effects.map((effect) =>
        effect.id === button.dataset.fxEnabled
          ? { ...effect, enabled: !effect.enabled }
          : effect,
      ),
    }));
  if (button.dataset.fxRemove)
    void patch((state) => ({
      effects: state.effects.filter(
        (effect) => effect.id !== button.dataset.fxRemove,
      ),
    }));
  if (button.dataset.fxMove)
    void patch((state) => {
      const effects = [...state.effects];
      const from = effects.findIndex(
        (effect) => effect.id === button.dataset.fxMove,
      );
      const to = from + Number(button.dataset.direction);
      if (to >= 0 && to < effects.length)
        [effects[from], effects[to]] = [effects[to], effects[from]];
      return { effects };
    });
  const action = button.dataset.action;
  if (action === "preview") void togglePreview();
  else if (action === "usb")
    void patch((state) => ({ usb_enabled: !state.usb_enabled }));
  else if (action === "browser-midi") void connectMidi();
  else if (action && ["mute", "solo", "sustain"].includes(action))
    void patch((state) => ({
      [action]: !state[action as "mute" | "solo" | "sustain"],
    }));
});

app.addEventListener("keydown", (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>(
    "button[data-osc-shape]",
  );
  if (!button) return;
  const index = waveforms.findIndex(
    (wave) => wave.shape === button.dataset.oscShape,
  );
  const next =
    event.key === "ArrowRight"
      ? (index + 1) % waveforms.length
      : event.key === "ArrowLeft"
        ? (index + waveforms.length - 1) % waveforms.length
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? waveforms.length - 1
            : -1;
  if (next < 0) return;
  event.preventDefault();
  const oscillator = Number(button.dataset.oscIndex),
    shape = waveforms[next].shape;
  void patch((state) => {
    const config = structuredClone(state.three_osc);
    config.oscillators[oscillator].shape = shape;
    return { three_osc: config };
  }).then(() =>
    app
      .querySelector<HTMLButtonElement>(
        `button[data-osc-index="${oscillator}"][data-osc-shape="${shape}"]`,
      )
      ?.focus({ preventScroll: true }),
  );
});

function send(data: number[], controller?: string) {
  if (socket?.readyState === WebSocket.OPEN)
    socket.send(JSON.stringify({ type: "midi", data, controller }));
  else notice("Sin conexión con el servidor.");
}
function updateHeld() {
  const notes = new Set([
    ...incomingNotes,
    ...[...held.values()].map((item) => item.note),
  ]);
  app
    .querySelectorAll<HTMLButtonElement>("[data-note]")
    .forEach((button) =>
      button.classList.toggle("held", notes.has(Number(button.dataset.note))),
    );
}
function highlightMidi(data: number[]) {
  const kind = data[0] & 0xf0;
  if (kind === 0x90 && data[2] > 0) incomingNotes.add(data[1]);
  else if (kind === 0x80 || (kind === 0x90 && data[2] === 0))
    incomingNotes.delete(data[1]);
  else if (kind === 0xb0 && (data[1] === 120 || data[1] === 123))
    incomingNotes.clear();
  else return;
  updateHeld();
}
function noteOn(id: string, note: number) {
  if (held.has(id)) return;
  const duplicate = [...held.values()].some((item) => item.note === note);
  held.set(id, { note });
  if (!duplicate) {
    send([0x90, note, sharedSettings.keyboard.velocity]);
  }
  updateHeld();
}
function noteOff(id: string) {
  const item = held.get(id);
  if (!item) return;
  held.delete(id);
  if (![...held.values()].some((other) => other.note === item.note)) {
    send([0x80, item.note, 0]);
  }
  updateHeld();
}
function releaseAll() {
  for (const id of [...held.keys()]) noteOff(id);
  if (socket?.readyState === WebSocket.OPEN)
    socket.send(JSON.stringify({ type: "release" }));
}
const mapping: [string, number, string][] = [
  ["KeyZ", 60, "Z"],
  ["KeyS", 61, "S"],
  ["KeyX", 62, "X"],
  ["KeyD", 63, "D"],
  ["KeyC", 64, "C"],
  ["KeyV", 65, "V"],
  ["KeyG", 66, "G"],
  ["KeyB", 67, "B"],
  ["KeyH", 68, "H"],
  ["KeyN", 69, "N"],
  ["KeyJ", 70, "J"],
  ["KeyM", 71, "M"],
  ["KeyQ", 72, "Q"],
  ["Digit2", 73, "2"],
  ["KeyW", 74, "W"],
  ["Digit3", 75, "3"],
  ["KeyE", 76, "E"],
  ["KeyR", 77, "R"],
  ["Digit5", 78, "5"],
  ["KeyT", 79, "T"],
  ["Digit6", 80, "6"],
  ["KeyY", 81, "Y"],
  ["Digit7", 82, "7"],
  ["KeyU", 83, "U"],
  ["Comma", 72, ","],
  ["KeyL", 73, "L"],
  ["Period", 74, "."],
  ["Semicolon", 75, ";"],
  ["Slash", 76, "/"],
  ["KeyI", 84, "I"],
  ["Digit9", 85, "9"],
  ["KeyO", 86, "O"],
  ["Digit0", 87, "0"],
  ["KeyP", 88, "P"],
  ["BracketLeft", 89, "["],
  ["Equal", 90, "="],
  ["BracketRight", 91, "]"],
  ["Backslash", 93, "\\"],
];
const keyNotes = Object.fromEntries(
  mapping.map(([code, note]) => [code, note]),
);
const labels: Record<number, string> = {};
for (const [, note, label] of mapping)
  labels[note] = labels[note] ? `${labels[note]} · ${label}` : label;
const noteNames = [
  "Do",
  "Do♯",
  "Re",
  "Re♯",
  "Mi",
  "Fa",
  "Fa♯",
  "Sol",
  "Sol♯",
  "La",
  "La♯",
  "Si",
];
for (let octave = 0; octave < 3; octave++) {
  for (const offset of [0, 2, 4, 5, 7, 9, 11]) {
    const note = 60 + octave * 12 + offset;
    if (note <= 93) addKey(note, `white ${octave ? "upper" : ""}`);
  }
  for (const [position, offset] of [
    [1, 1],
    [2, 3],
    [4, 6],
    [5, 8],
    [6, 10],
  ]) {
    const note = 60 + octave * 12 + offset;
    if (note <= 93)
      addKey(
        note,
        `black ${octave ? "upper" : ""}`,
        octave * 7 + position - 0.31,
      );
  }
}
function addKey(note: number, className: string, left?: number) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.dataset.note = String(note);
  const name = `${noteNames[note % 12]}${Math.floor(note / 12) - 1}`;
  button.setAttribute("aria-label", name);
  button.innerHTML = `<span></span>`;
  if (left !== undefined)
    button.style.left = `calc(100% / var(--piano-columns) * ${left})`;
  button.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    noteOn(`pointer:${event.pointerId}`, note);
  });
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"])
    button.addEventListener(name, (event) =>
      noteOff(`pointer:${(event as PointerEvent).pointerId}`),
    );
  button.addEventListener("keydown", (event) => {
    if ([" ", "Enter"].includes(event.key)) {
      event.preventDefault();
      if (!event.repeat) noteOn(`keybutton:${note}`, note);
    }
  });
  button.addEventListener("keyup", (event) => {
    if ([" ", "Enter"].includes(event.key)) {
      event.preventDefault();
      noteOff(`keybutton:${note}`);
    }
  });
  button.addEventListener("blur", () => noteOff(`keybutton:${note}`));
  $(".piano").append(button);
}
$("#capture-keyboard").addEventListener("click", () => {
  releaseAll();
  capturing = !capturing;
  syncKeyboardButton();
  void settingsController
    ?.update({ keyboard: { capture: capturing } })
    .catch((error) => {
      capturing = sharedSettings.keyboard.capture;
      if (capturing) $<HTMLDetailsElement>(".keyboard-drawer").open = true;
      syncKeyboardButton();
      fail(error);
    });
});
window.addEventListener("keydown", (event) => {
  if (
    !capturing ||
    settingsOpen ||
    event.ctrlKey ||
    event.altKey ||
    event.metaKey ||
    event.repeat
  )
    return;
  if (
    (event.target as Element)?.closest(
      "select, textarea, [contenteditable=true], input",
    )
  )
    return;
  const note = keyNotes[event.code];
  if (note === undefined) return;
  event.preventDefault();
  noteOn(`pc:${event.code}`, note);
});
window.addEventListener("keyup", (event) => noteOff(`pc:${event.code}`));
window.addEventListener("blur", releaseAll);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) releaseAll();
});
$(".keyboard-drawer").addEventListener("toggle", () => {
  if (!$<HTMLDetailsElement>(".keyboard-drawer").open) {
    releaseAll();
    capturing = false;
    syncKeyboardButton();
    void settingsController
      ?.update({ keyboard: { capture: false } })
      .catch((error) => {
        capturing = sharedSettings.keyboard.capture;
        if (capturing) $<HTMLDetailsElement>(".keyboard-drawer").open = true;
        syncKeyboardButton();
        fail(error);
      });
  }
});

async function connectMidi() {
  if (!navigator.requestMIDIAccess) {
    notice(
      "Web MIDI requiere un navegador compatible y HTTPS o localhost. El MIDI USB del servidor funciona sin Web MIDI.",
    );
    return;
  }
  try {
    midiAccess = await navigator.requestMIDIAccess({ sysex: false });
    const wire = () => {
      for (const input of midiAccess!.inputs.values())
        input.onmidimessage = (event) => {
          if (!event.data || event.data[0] >= 0xf0) return;
          const data = [...event.data];
          send(data, input.name || input.id);
        };
      releaseAll();
      const label = app.querySelector("#browser-midi-status");
      if (label)
        label.textContent =
          [...midiAccess!.inputs.values()]
            .map((input) => input.name)
            .join(" · ") || "Sin dispositivos";
      reportMidiDevices();
    };
    midiAccess.onstatechange = wire;
    wire();
  } catch (error) {
    fail(error);
  }
}

function connect() {
  clearTimeout(reconnect);
  socket = new WebSocket(
    `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`,
  );
  socket.onopen = () => {
    connected = true;
    $("#connection").textContent = "Conectado";
    $("#connection").className = "connected";
    notice();
    reportMidiDevices();
  };
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "state") accept(message);
    else if (message.type === "settings") settingsController?.accept(message);
    else if (message.type === "midi") {
      highlightMidi(message.data);
      if (previewEnabled) audio.midi(message.data, false);
    } else if (message.type === "panic") {
      audio.panic();
      held.clear();
      incomingNotes.clear();
      updateHeld();
    } else if (message.type === "error") notice(message.message);
    else if (message.type === "meters" && !(audio.ready && previewEnabled))
      updateMeters(message.channel, message.master);
    if (message.underruns !== undefined && app.querySelector("#underruns"))
      $("#underruns").textContent = String(message.underruns);
  };
  socket.onclose = () => {
    connected = false;
    incomingNotes.clear();
    releaseAll();
    updateHeld();
    audio.panic();
    $("#connection").textContent = "Desconectado · reintentando…";
    $("#connection").className = "";
    reconnect = setTimeout(connect, 1500);
  };
  socket.onerror = () => socket?.close();
}
function updateMeters(channel: number, master: number) {
  for (const [name, value] of [
    ["channel", channel],
    ["master", master],
  ] as const) {
    const element = app.querySelector<HTMLElement>(`[data-meter=${name}]`);
    if (element) {
      element.setAttribute("aria-valuenow", String(Math.round(value * 100)));
      element.querySelector<HTMLElement>("span")!.style.width =
        `${Math.min(100, value * 100)}%`;
    }
  }
}
const meterBuffer = new Float32Array(256);
function browserMeters() {
  if (audio.ready && previewEnabled) {
    const peak = (analyser: AnalyserNode | null) => {
      if (!analyser) return 0;
      analyser.getFloatTimeDomainData(meterBuffer);
      return Math.min(
        1,
        meterBuffer.reduce(
          (maximum, value) => Math.max(maximum, Math.abs(value)),
          0,
        ),
      );
    };
    updateMeters(peak(audio.channelMeter), peak(audio.masterMeter));
  }
  setTimeout(browserMeters, 80);
}
function reportMidiDevices() {
  if (socket?.readyState === WebSocket.OPEN && midiAccess)
    socket.send(
      JSON.stringify({
        type: "midi_devices",
        names: [...midiAccess.inputs.values()]
          .filter((input) => input.state === "connected")
          .map((input) => input.name || input.id),
      }),
    );
}
function updateKeyboardLabels() {
  const mode = sharedSettings.keyboard.labels;
  app.querySelectorAll<HTMLButtonElement>("[data-note]").forEach((button) => {
    const note = Number(button.dataset.note);
    const name = `${noteNames[note % 12]}${Math.floor(note / 12) - 1}`;
    const text =
      mode === "none"
        ? ""
        : mode === "notes"
          ? name
          : mode === "both"
            ? `${name}${labels[note] ? " · " + labels[note] : ""}`
            : `${note % 12 === 0 ? name + " · " : ""}${labels[note] ?? ""}`;
    button.querySelector("span")!.textContent = text;
  });
}
settingsController = initializeSettings(
  app,
  (open) => {
    if (open && !settingsOpen) for (const id of [...held.keys()]) noteOff(id);
    settingsOpen = open;
    $("#live-view").hidden = open;
  },
  (configuration) => {
    document.documentElement.lang = configuration.interface.language;
    document.documentElement.dataset.motion = configuration.interface.motion;
    if (capturing && !configuration.keyboard.capture)
      for (const id of [...held.keys()]) noteOff(id);
    capturing = configuration.keyboard.capture;
    if (capturing) $<HTMLDetailsElement>(".keyboard-drawer").open = true;
    syncKeyboardButton();
    updateKeyboardLabels();
    if (
      snapshot &&
      !starting &&
      configuration.browser_preview !== previewEnabled
    )
      void setPreview(configuration.browser_preview, true, false);
  },
);
updateKeyboardLabels();
connect();
browserMeters();
window.addEventListener("pagehide", () => {
  releaseAll();
  socket?.close();
  clearTimeout(reconnect);
});
// A narrow debug surface supports integration checks without coupling the UI to the engine.
Object.assign(window, {
  sontrama: {
    audio,
    get connected() {
      return connected;
    },
  },
});
