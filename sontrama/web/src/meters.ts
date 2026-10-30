import { t } from "./i18n";

type Source = "server" | "preview";
const FLOOR = -60;
const position = (db: number) =>
  Math.max(0, Math.min(100, ((db - FLOOR) / -FLOOR) * 100));
const decibels = (amplitude: number) =>
  amplitude > 0 ? Math.max(FLOOR, 20 * Math.log10(amplitude)) : FLOOR;
const formatDb = (db: number) =>
  db <= FLOOR
    ? "−∞"
    : db.toLocaleString(document.documentElement.lang, {
        maximumFractionDigits: 1,
        minimumFractionDigits: 1,
      });

export class PeakReading {
  level = FLOOR;
  peak = FLOOR;
  private target = FLOOR;
  private updated = 0;
  private sampled = -Infinity;
  private holdUntil = 0;
  private clipUntil = 0;

  advance(now: number) {
    const elapsed = Math.max(0, now - this.updated) / 1000;
    const target = now - this.sampled > 300 ? FLOOR : this.target;
    this.level = Math.max(target, this.level - elapsed * 36);
    const fall =
      Math.max(0, now - Math.max(this.updated, this.holdUntil)) / 1000;
    this.peak = Math.max(this.level, this.peak - fall * 12);
    this.updated = now;
  }

  push(amplitude: number, now: number) {
    this.advance(now);
    const value = Number.isFinite(amplitude) ? Math.max(0, amplitude) : 0;
    this.target = decibels(value);
    this.level = Math.max(this.level, this.target);
    this.sampled = now;
    if (this.target >= this.peak) {
      this.peak = this.target;
      this.holdUntil = now + 900;
    }
    if (value >= 1) this.clipUntil = now + 2000;
  }

  clipping(now: number) {
    return now < this.clipUntil;
  }
}

export class StereoMeters {
  private source: Source = "server";
  private readings = this.empty();
  private empty() {
    return {
      channel: [new PeakReading(), new PeakReading()],
      master: [new PeakReading(), new PeakReading()],
    };
  }

  useSource(source: Source) {
    if (source === this.source) return;
    this.source = source;
    this.readings = this.empty();
  }

  clear() {
    this.readings = this.empty();
  }

  accept(
    source: Source,
    channel: number[],
    master: number[],
    now = performance.now(),
  ) {
    this.useSource(source);
    for (const [bus, values] of [
      ["channel", channel],
      ["master", master],
    ] as const) {
      for (let side = 0; side < 2; side++)
        this.readings[bus][side].push(values[side] ?? 0, now);
    }
  }

  paint(root: HTMLElement, now: number) {
    for (const values of Object.values(this.readings))
      for (const reading of values) reading.advance(now);
    for (const element of root.querySelectorAll<HTMLElement>("[data-meter]")) {
      const bus = element.dataset.meter as "channel" | "master";
      const reading =
        this.readings[bus][element.dataset.meterSide === "right" ? 1 : 0];
      const clipping = reading.clipping(now);
      element.style.setProperty("--meter-level", `${position(reading.level)}%`);
      element.style.setProperty("--meter-peak", `${position(reading.peak)}%`);
      element.dataset.levelDb = reading.level.toFixed(2);
      element.dataset.peakDb = reading.peak.toFixed(2);
      element.dataset.clipping = String(clipping);
      element.dataset.source = this.source;
      element.dataset.peakVisible = String(reading.peak > FLOOR);
      element.setAttribute(
        "aria-valuenow",
        String(Math.round(position(reading.level))),
      );
      const text =
        t("mixer.meterReading", {
          level: formatDb(reading.level),
          peak: formatDb(reading.peak),
        }) + (clipping ? ` · ${t("mixer.meterClipped")}` : "");
      element.setAttribute("aria-valuetext", text);
      element.title = text;
    }
  }
}
