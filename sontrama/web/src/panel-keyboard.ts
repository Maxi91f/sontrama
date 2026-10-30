import { t } from "./i18n";
import type { Configuration } from "./settings";

/** On-screen note ownership is independent of PC keyboard mappings. */
export class PanelKeyboard {
  private octave = Infinity;
  private pointers = new Map<number, number | null>();
  private buttons = new Set<number>();

  constructor(
    private root: HTMLElement,
    private shortcuts: Record<number, string>,
    private on: (id: string, note: number) => void,
    private off: (id: string) => void,
  ) {
    root.addEventListener("pointerdown", (event) => {
      const key = (event.target as Element).closest<HTMLElement>("[data-note]");
      if (!key || !root.contains(key) || event.button !== 0) return;
      event.preventDefault();
      root.setPointerCapture(event.pointerId);
      const note = Number(key.dataset.note);
      this.pointers.set(event.pointerId, note);
      this.on(`pointer:${event.pointerId}`, note);
    });
    root.addEventListener("pointermove", (event) => {
      if (!this.pointers.has(event.pointerId)) return;
      if (event.pointerType === "mouse" && event.buttons === 0) {
        this.releasePointer(event.pointerId);
        return;
      }
      const key = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>("[data-note]");
      const note = key && root.contains(key) ? Number(key.dataset.note) : null;
      if (note === this.pointers.get(event.pointerId)) return;
      this.off(`pointer:${event.pointerId}`);
      this.pointers.set(event.pointerId, note);
      if (note !== null) this.on(`pointer:${event.pointerId}`, note);
    });
    for (const name of ["pointerup", "pointercancel", "lostpointercapture"])
      root.addEventListener(name, (event) =>
        this.releasePointer((event as PointerEvent).pointerId),
      );
    root.addEventListener("keydown", (event) => {
      const key = (event.target as Element).closest<HTMLElement>("[data-note]");
      if (!key || ![" ", "Enter"].includes(event.key)) return;
      event.preventDefault();
      if (event.repeat) return;
      const note = Number(key.dataset.note);
      this.buttons.add(note);
      this.on(`keybutton:${note}`, note);
    });
    root.addEventListener("keyup", (event) => {
      const key = (event.target as Element).closest<HTMLElement>("[data-note]");
      if (!key || ![" ", "Enter"].includes(event.key)) return;
      event.preventDefault();
      const note = Number(key.dataset.note);
      this.buttons.delete(note);
      this.off(`keybutton:${note}`);
    });
    root.addEventListener("focusout", (event) => {
      const key = (event.target as Element).closest<HTMLElement>("[data-note]");
      if (key) {
        const note = Number(key.dataset.note);
        this.buttons.delete(note);
        this.off(`keybutton:${note}`);
      }
    });
  }

  private releasePointer(id: number) {
    if (!this.pointers.has(id)) return;
    this.pointers.delete(id);
    this.off(`pointer:${id}`);
    if (this.root.hasPointerCapture(id)) this.root.releasePointerCapture(id);
  }

  release() {
    for (const id of this.pointers.keys()) this.releasePointer(id);
    for (const note of this.buttons) this.off(`keybutton:${note}`);
    this.buttons.clear();
  }

  update(settings: Configuration["keyboard"]) {
    if (settings.panel_octave !== this.octave) {
      this.release();
      this.octave = settings.panel_octave;
      this.root.replaceChildren();
      let whites = 0;
      for (let note = 60 + this.octave * 12; note <= 127; note++) {
        const white = [0, 2, 4, 5, 7, 9, 11].includes(note % 12);
        const key = document.createElement("button");
        key.type = "button";
        key.dataset.note = String(note);
        key.className = white ? "white" : "black";
        key.innerHTML = "<span></span>";
        if (white) whites++;
        else key.style.left = `${(whites - 0.31) * 28}px`;
        this.root.append(key);
      }
      this.root.style.width = `${whites * 28}px`;
      this.root.style.minWidth = `${whites * 28}px`;
      this.root.style.setProperty("--piano-columns", String(whites));
    }
    const names = t("notes.names").split("|");
    this.root.setAttribute("aria-label", t("keyboard.range"));
    for (const key of this.root.querySelectorAll<HTMLButtonElement>(
      "[data-note]",
    )) {
      const note = Number(key.dataset.note);
      const name = `${names[note % 12]}${Math.floor(note / 12) - 1}`;
      const shortcut = this.shortcuts[note] ?? "";
      key.setAttribute("aria-label", name);
      key.querySelector("span")!.textContent =
        settings.labels === "none"
          ? ""
          : settings.labels === "notes"
            ? name
            : settings.labels === "both"
              ? `${name}${shortcut ? " · " + shortcut : ""}`
              : `${note % 12 === 0 ? name + " · " : ""}${shortcut}`;
    }
  }
}
