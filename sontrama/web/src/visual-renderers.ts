import { t } from "./i18n";
import { PeakReading } from "./meters";
import {
  db,
  detectPitch,
  signalPitch,
  spectrum,
  spectralFrequency,
  stereoStats,
  type Signal,
} from "./visual-analysis";
import { midiDescription, type MidiReading } from "./midi-monitor";
import type { VisualizationWidget } from "./visualizations";

interface State {
  key: string;
  time: number;
  initialized: boolean;
  paused: boolean;
  historyFraction: number;
  history: HTMLCanvasElement;
  signal: Signal;
  bins: Float32Array[] | null;
  peaks: PeakReading[];
  needle: number;
  correlation: number | null;
  midi: MidiReading;
  pitch: ReturnType<typeof detectPitch>;
}
const colors = ["#138249", "#c02967"];
const clamp = (value: number, low = 0, high = 1) =>
  Math.max(low, Math.min(high, value));
const number = (value: number, digits = 1) =>
  value.toLocaleString(document.documentElement.lang, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
export class VisualRenderers {
  private states = new Map<string, State>();
  private analysis = new WeakMap<
    Signal,
    {
      stats: ReturnType<typeof stereoStats>;
      spectra: Map<string, Float32Array[]>;
      pitch?: ReturnType<typeof detectPitch>;
    }
  >();
  reset(id: string) {
    this.states.delete(id);
  }
  retain(ids: Set<string>) {
    for (const id of this.states.keys())
      if (!ids.has(id)) this.states.delete(id);
  }

  private analyze(signal: Signal) {
    let result = this.analysis.get(signal);
    if (!result) {
      result = { stats: stereoStats(signal.samples), spectra: new Map() };
      this.analysis.set(signal, result);
    }
    return result;
  }

  render(
    canvas: HTMLCanvasElement,
    widget: VisualizationWidget,
    signal: Signal,
    now: number,
    midi: MidiReading,
  ) {
    const ratio = Math.min(devicePixelRatio || 1, 2),
      width = Math.round(canvas.clientWidth * ratio),
      height = Math.round(canvas.clientHeight * ratio);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const w = width / ratio,
      h = height / ratio;
    const spectral = ["spectrum", "spectrogram"].includes(widget.kind);
    const config = widget.spectral;
    const key = `${widget.kind}:${widget.bus}:${signal.source}:${spectral ? JSON.stringify(config) : ""}`;
    let state = this.states.get(widget.id);
    if (!state || state.key !== key) {
      const history = document.createElement("canvas");
      history.width = 160;
      history.height = 128;
      const historyContext = history.getContext("2d")!;
      historyContext.fillStyle = "#fffef5";
      historyContext.fillRect(0, 0, 160, 128);
      state = {
        key,
        time: now,
        initialized: false,
        paused: false,
        historyFraction: 0,
        history,
        signal,
        bins: null,
        peaks: [new PeakReading(), new PeakReading()],
        needle: 0,
        correlation: null,
        midi: { events: [], notes: 0, sequence: 0 },
        pitch: null,
      };
      this.states.set(widget.id, state);
    }
    const interval = spectral ? 1000 / config.refresh_rate : 50;
    const updating =
      !state.initialized ||
      (!widget.paused && now - state.time >= interval - 1);
    if (!updating) signal = state.signal;
    const analysis = this.analyze(signal),
      stats = analysis.stats;
    const windows = signal.analysisSamples ?? signal.samples;
    const fftSize = spectral
      ? Math.min(config.fft_size, 2 ** Math.floor(Math.log2(windows[0].length)))
      : 1024;
    let rawBins: Float32Array[] | undefined;
    if (spectral) {
      const fftKey = `${fftSize}:${config.window}`;
      rawBins = analysis.spectra.get(fftKey);
      if (!rawBins) {
        rawBins = windows.map((samples) =>
          spectrum(samples.slice(-fftSize), config.window),
        );
        analysis.spectra.set(fftKey, rawBins);
      }
    }
    if (widget.kind === "tuner" && analysis.pitch === undefined)
      analysis.pitch = signalPitch(signal);
    if (updating) {
      state.signal = signal;
      const elapsed = state.paused
        ? 0.05
        : Math.min(0.2, Math.max(0.001, (now - state.time) / 1000));
      if (spectral && rawBins) {
        const alpha = config.smoothing ** (elapsed * 20);
        if (!state.bins || state.bins[0].length !== rawBins[0].length)
          state.bins = rawBins.map((bins) => bins.slice());
        else
          state.bins.forEach((bins, side) => {
            for (let i = 0; i < bins.length; i++)
              bins[i] =
                20 *
                Math.log10(
                  Math.max(
                    1e-9,
                    10 ** (bins[i] / 20) * alpha +
                      10 ** (rawBins![side][i] / 20) * (1 - alpha),
                  ),
                );
          });
      }
      const peaks = signal.peaks ?? stats.peaks;
      state.peaks.forEach((peak, side) => peak.push(peaks[side], now));
      const rms = Math.sqrt((stats.rms[0] ** 2 + stats.rms[1] ** 2) / 2);
      const target = rms;
      state.needle = state.initialized
        ? state.needle +
          (target - state.needle) *
            (1 - Math.exp(-elapsed / (target > state.needle ? 0.1 : 0.3)))
        : target;
      const correlation = stats.correlation;
      state.correlation =
        correlation === null
          ? null
          : state.correlation === null
            ? correlation
            : state.correlation +
              (correlation - state.correlation) *
                (1 - Math.exp(-elapsed / 0.12));
      state.midi = midi;
      state.pitch = analysis.pitch ?? null;
      if (widget.kind === "spectrogram") {
        const context = state.history.getContext("2d")!;
        state.historyFraction += (elapsed * 160) / config.history_seconds;
        const columns = Math.min(160, Math.floor(state.historyFraction));
        state.historyFraction -= columns;
        if (columns) context.drawImage(state.history, -columns, 0);
        const palette = [
          "#fffef5",
          "#fff168",
          "#ffd246",
          "#ff936c",
          "#d82b67",
          "#2b1720",
        ];
        for (let y = 0; y < 128; y++) {
          const frequency = spectralFrequency(
            1 - y / 127,
            config,
            signal.sampleRate,
          );
          const bin = Math.min(
            state.bins![0].length - 1,
            Math.round((frequency * fftSize) / signal.sampleRate),
          );
          const level =
            10 *
            Math.log10(
              (10 ** (state.bins![0][bin] / 10) +
                10 ** (state.bins![1][bin] / 10)) /
                2,
            );
          context.fillStyle =
            palette[
              Math.round(
                clamp(
                  (level - config.db_min) / (config.db_max - config.db_min),
                ) * 5,
              )
            ];
          if (columns) context.fillRect(160 - columns, y, columns, 1);
        }
      }
      state.time = now;
      state.initialized = true;
    }
    state.paused = widget.paused;
    ctx.fillStyle = "#fffef5";
    ctx.fillRect(0, 0, w, h);
    ctx.font = "11px monospace";
    ctx.lineWidth = 1;
    if (spectral) {
      canvas.dataset.fftSize = String(fftSize);
      canvas.dataset.sampleRate = String(signal.sampleRate);
      canvas.dataset.historySeconds = String(config.history_seconds);
      const info = canvas
        .closest(".visual-widget, .dock-panel")!
        .querySelector<HTMLElement>("[data-analysis-info]");
      if (info)
        info.textContent = t("visuals.analysisInfo", {
          rate: number(signal.sampleRate, 0),
          size: fftSize,
          resolution: number(signal.sampleRate / fftSize),
        });
    }
    canvas.dataset.source = widget.kind === "midi" ? "midi" : signal.source;
    canvas.dataset.peak = String(Math.max(...(signal.peaks ?? stats.peaks)));
    let summary = "";
    if (widget.kind === "oscilloscope" || widget.kind === "spectrum") {
      this.grid(ctx, w, h);
      signal.samples.forEach((samples, side) => {
        ctx.strokeStyle = colors[side];
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        if (widget.kind === "oscilloscope") {
          let start = 0;
          for (let i = 1; i < 256; i++)
            if (signal.samples[0][i - 1] <= 0 && signal.samples[0][i] > 0) {
              start = i;
              break;
            }
          for (let i = 0; i < 768; i++) {
            const x = (i * w) / 767,
              y =
                h / 2 -
                clamp(samples[start + i] * widget.scale, -1, 1) * h * 0.45;
            if (i) ctx.lineTo(x, y);
            else ctx.moveTo(x, y);
          }
        } else {
          const bins = state.bins![side];
          for (let x = 0; x < w; x++) {
            const frequency = spectralFrequency(
                x / w,
                config,
                signal.sampleRate,
              ),
              bin = Math.min(
                bins.length - 1,
                Math.round((frequency * fftSize) / signal.sampleRate),
              ),
              y =
                h -
                clamp(
                  (bins[bin] - config.db_min) / (config.db_max - config.db_min),
                ) *
                  (h - 16);
            if (x) ctx.lineTo(x, y);
            else ctx.moveTo(x, y);
          }
          if (side === 0) {
            let bin = 0;
            for (let i = 1; i < bins.length; i++)
              if (bins[i] > bins[bin]) bin = i;
            canvas.dataset.frequency = String(
              (bin * signal.sampleRate) / fftSize,
            );
          }
        }
        ctx.stroke();
      });
      this.text(
        ctx,
        widget.kind === "oscilloscope"
          ? `${number((768 / signal.sampleRate) * 1000)} ms`
          : `${number(config.frequency_min, 0)}–${number(Math.min(config.frequency_max, signal.sampleRate / 2), 0)} Hz · ${config.db_min}…${config.db_max} dBFS`,
        6,
        h - 5,
      );
    } else if (widget.kind === "spectrogram") {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(state.history, 32, 4, Math.max(1, w - 36), h - 22);
      const maximum = Math.min(config.frequency_max, signal.sampleRate / 2);
      for (const frequency of [100, 1000, 10000]) {
        if (frequency > maximum || frequency < config.frequency_min) continue;
        const fraction =
          config.frequency_scale === "linear"
            ? (frequency - config.frequency_min) /
              (maximum - config.frequency_min)
            : Math.log(frequency / config.frequency_min) /
              Math.log(maximum / config.frequency_min);
        const y = 4 + (1 - fraction) * (h - 22);
        this.text(
          ctx,
          frequency >= 1000 ? `${frequency / 1000}k` : String(frequency),
          3,
          y + 3,
          "left",
          9,
        );
      }
      this.text(ctx, "Hz", 3, h - 4, "left", 9);
      this.text(ctx, `−${config.history_seconds} s`, 32, h - 4, "left", 9);
      this.text(ctx, "0 s", w - 5, h - 4, "right", 9);
      canvas.dataset.historyColumns = String(state.history.width);
    } else if (widget.kind === "vectorscope") {
      const radius = Math.max(10, Math.min(w / 2 - 18, h / 2 - 14)),
        cx = w / 2,
        cy = h / 2;
      ctx.strokeStyle = "#b9b39c";
      ctx.beginPath();
      ctx.moveTo(cx, cy - radius);
      ctx.lineTo(cx + radius, cy);
      ctx.lineTo(cx, cy + radius);
      ctx.lineTo(cx - radius, cy);
      ctx.closePath();
      ctx.moveTo(cx, cy - radius);
      ctx.lineTo(cx, cy + radius);
      ctx.moveTo(cx - radius, cy);
      ctx.lineTo(cx + radius, cy);
      ctx.stroke();
      ctx.strokeStyle = colors[0];
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let i = 0; i < signal.samples[0].length; i += 2) {
        const l = signal.samples[0][i],
          r = signal.samples[1][i],
          x = cx + clamp(((l - r) * widget.scale) / 2, -1, 1) * radius,
          y = cy - clamp(((l + r) * widget.scale) / 2, -1, 1) * radius;
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      }
      ctx.stroke();
      this.text(ctx, "M", cx - 3, 12);
      this.text(ctx, "L", cx - radius, cy - 4);
      this.text(ctx, "R", cx + radius - 8, cy - 4);
    } else if (widget.kind === "correlation") {
      const value = state.correlation,
        x = 24,
        size = w - 48,
        y = h / 2 - 10;
      ctx.fillStyle = "#ffe0dd";
      ctx.fillRect(x, y, size / 2, 20);
      ctx.fillStyle = "#d5f7df";
      ctx.fillRect(x + size / 2, y, size / 2, 20);
      ctx.strokeStyle = "#000";
      ctx.strokeRect(x, y, size, 20);
      this.text(ctx, "−1", x, y + 37);
      this.text(ctx, "0", w / 2 - 3, y + 37);
      this.text(ctx, "+1", w - 38, y + 37);
      if (value !== null) {
        const marker = x + ((value + 1) * size) / 2;
        ctx.fillStyle = "#000";
        ctx.fillRect(marker - 2, y - 6, 4, 32);
      }
      summary =
        value === null
          ? t("visuals.noStereoSignal")
          : t("visuals.correlationReading", { value: number(value, 2) });
      canvas.dataset.correlation = value === null ? "" : String(value);
      this.text(
        ctx,
        value === null ? "—" : number(value, 2),
        w / 2,
        Math.max(20, y - 18),
        "center",
        20,
      );
    } else if (widget.kind === "tuner") {
      const pitch = state.pitch;
      canvas.dataset.frequency = String(pitch?.frequency ?? 0);
      canvas.dataset.note = String(pitch?.note ?? "");
      canvas.dataset.cents = String(pitch?.cents ?? 0);
      if (pitch) {
        const name = `${t("notes.names").split("|")[pitch.note % 12]}${Math.floor(pitch.note / 12) - 1}`;
        this.text(ctx, name, w / 2, h * 0.35, "center", Math.min(36, h / 3));
        this.text(
          ctx,
          `${number(pitch.frequency)} Hz · ${pitch.cents >= 0 ? "+" : ""}${number(pitch.cents)} ${t("visuals.cents")}`,
          w / 2,
          h * 0.6,
          "center",
          12,
        );
        const y = h * 0.78,
          left = 24,
          size = w - 48;
        ctx.strokeStyle = "#000";
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(left + size, y);
        ctx.moveTo(w / 2, y - 8);
        ctx.lineTo(w / 2, y + 8);
        ctx.stroke();
        ctx.fillStyle = Math.abs(pitch.cents) < 5 ? colors[0] : "#c02967";
        ctx.fillRect(
          left + clamp((pitch.cents + 50) / 100) * size - 3,
          y - 7,
          6,
          14,
        );
        this.text(ctx, "♭", left, y + 20);
        this.text(ctx, "♯", left + size - 8, y + 20);
        summary = `${name} · ${number(pitch.frequency)} Hz · ${number(pitch.cents)} ${t("visuals.cents")}`;
      } else {
        summary = t("visuals.playSingleNote");
        this.text(ctx, summary, w / 2, h / 2, "center", 12);
      }
    } else if (widget.kind === "vu") {
      const clipped = state.peaks.some((peak) =>
        peak.clipping(widget.paused ? state.time : now),
      );
      canvas.dataset.clipping = String(clipped);
      canvas.dataset.meterStyle = widget.meter_style;
      canvas.dataset.vu = String(db(state.needle) + 18);
      if (widget.meter_style === "needle") {
        const cx = w / 2,
          cy = h * 0.83,
          radius = Math.min(w * 0.44, h * 0.7);
        const angle = (vu: number) =>
          Math.PI * 1.15 + clamp((vu + 20) / 23) * Math.PI * 0.7;
        const compact = h < 130;
        const band = compact ? 7 : 12;
        // A shallow inset face and hard edge keep the physical dial in the studio palette.
        ctx.fillStyle = "#ddd5b4";
        ctx.fillRect(5, 5, w - 10, h - 10);
        ctx.fillStyle = "#fff9df";
        ctx.fillRect(7, 7, w - 16, h - 16);
        ctx.strokeStyle = "#7b7358";
        ctx.lineWidth = 1;
        ctx.strokeRect(5.5, 5.5, w - 11, h - 11);
        const zone = (from: number, to: number, color: string) => {
          ctx.beginPath();
          ctx.arc(cx, cy, radius, angle(from), angle(to));
          ctx.arc(cx, cy, radius - band, angle(to), angle(from), true);
          ctx.closePath();
          ctx.fillStyle = color;
          ctx.fill();
        };
        zone(-20, -5, "#eee5bf");
        zone(-5, 0, "#ffdf45");
        zone(0, 3, "#ef6863");
        ctx.strokeStyle = "#28251c";
        ctx.beginPath();
        ctx.arc(cx, cy, radius, angle(-20), angle(3));
        ctx.stroke();
        for (let vu = -20; vu <= 3; vu++) {
          const major = [-20, -10, -5, 0, 3].includes(vu);
          const a = angle(vu);
          ctx.lineWidth = major ? 1.5 : 0.7;
          ctx.strokeStyle = vu > 0 ? "#8c2020" : "#28251c";
          ctx.beginPath();
          ctx.moveTo(
            cx + Math.cos(a) * (radius + 1),
            cy + Math.sin(a) * (radius + 1),
          );
          ctx.lineTo(
            cx + Math.cos(a) * (radius - (major ? band + 4 : band * 0.65)),
            cy + Math.sin(a) * (radius - (major ? band + 4 : band * 0.65)),
          );
          ctx.stroke();
          if (major)
            this.text(
              ctx,
              vu > 0 ? `+${vu}` : String(vu),
              cx + Math.cos(a) * (radius - band - (compact ? 9 : 13)),
              cy + Math.sin(a) * (radius - band - (compact ? 9 : 13)),
              "center",
              compact ? 8 : 10,
              vu > 0 ? "#8c2020" : "#28251c",
            );
        }
        const a = angle(db(state.needle) + 18);
        const tipX = cx + Math.cos(a) * (radius - 2),
          tipY = cy + Math.sin(a) * (radius - 2);
        // A small fixed-offset shadow, tapered pointer and hub suggest depth without a glossy skin.
        ctx.strokeStyle = "#c7bfa0";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(cx + 2, cy + 2);
        ctx.lineTo(tipX + 2, tipY + 2);
        ctx.stroke();
        const half = compact ? 1.2 : 1.8;
        ctx.fillStyle = "#9b2930";
        ctx.beginPath();
        ctx.moveTo(cx - Math.sin(a) * half, cy + Math.cos(a) * half);
        ctx.lineTo(tipX, tipY);
        ctx.lineTo(cx + Math.sin(a) * half, cy - Math.cos(a) * half);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = "#191811";
        ctx.beginPath();
        ctx.arc(cx, cy, compact ? 3 : 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#8a8061";
        ctx.beginPath();
        ctx.arc(cx - 1, cy - 1, compact ? 1 : 2, 0, Math.PI * 2);
        ctx.fill();
        this.text(
          ctx,
          "VU",
          cx,
          cy - (compact ? 10 : 18),
          "center",
          compact ? 12 : 20,
          "#28251c",
        );
        this.text(
          ctx,
          "0 VU = −18 dBFS RMS",
          w / 2,
          h - 10,
          "center",
          compact ? 8 : 9,
        );
      } else {
        const x = 28,
          barWidth = Math.max(10, w - 78),
          barHeight = Math.min(24, (h - 42) / 3);
        state.peaks.forEach((peak, side) => {
          const y = 12 + side * (barHeight + 14),
            level = clamp((peak.level + 60) / 60),
            held = clamp((peak.peak + 60) / 60);
          this.text(ctx, side ? "R" : "L", 8, y + barHeight / 2 + 4);
          ctx.fillStyle = "#eee9d7";
          ctx.fillRect(x, y, barWidth, barHeight);
          for (const [start, end, color] of [
            [0, 0.8, "#52db82"],
            [0.8, 0.95, "#ffea00"],
            [0.95, 1, "#ff5277"],
          ] as const) {
            const size = Math.max(0, Math.min(level, end) - start);
            if (size) {
              ctx.fillStyle = color;
              ctx.fillRect(x + start * barWidth, y, size * barWidth, barHeight);
            }
          }
          ctx.strokeStyle = "#000";
          ctx.strokeRect(x, y, barWidth, barHeight);
          if (peak.peak > -60) {
            ctx.fillStyle = "#000";
            ctx.fillRect(x + held * barWidth - 1, y, 2, barHeight);
          }
          this.text(
            ctx,
            peak.level <= -60 ? "−∞" : number(peak.level, 0),
            x + barWidth + 5,
            y + barHeight / 2 + 4,
            "left",
            10,
          );
        });
        this.text(
          ctx,
          "−60               −12  −3  0 dBFS",
          x,
          Math.min(h - 4, 2 * (barHeight + 14) + 12),
          "left",
          9,
        );
      }
      if (clipped) {
        ctx.fillStyle = "#c02967";
        ctx.fillRect(w - 34, 3, 30, 13);
        this.text(ctx, "CLIP", w - 19, 13, "center", 9, "#fffef5");
      }
      canvas.dataset.levelLeftDb = String(state.peaks[0].level);
      canvas.dataset.levelRightDb = String(state.peaks[1].level);
      summary = `L ${number(state.peaks[0].level, 0)} · R ${number(state.peaks[1].level, 0)} dBFS${clipped ? " · CLIP" : ""}`;
    } else if (widget.kind === "midi") {
      const reading = state.midi,
        line = 18,
        rows = Math.max(1, Math.floor((h - 44) / line));
      this.text(ctx, `${t("visuals.heldNotes")}: ${reading.notes}`, 8, 15);
      this.text(ctx, "s", 7, 30, "left", 9);
      this.text(
        ctx,
        t("visuals.channelShort"),
        Math.min(70, w * 0.2),
        30,
        "left",
        9,
      );
      this.text(ctx, t("visuals.event"), Math.min(94, w * 0.3), 30, "left", 9);
      const events = reading.events.slice(-rows).reverse();
      if (!events.length)
        this.text(ctx, t("visuals.waitingMidi"), w / 2, h / 2, "center", 12);
      events.forEach((event, index) => {
        const y = 48 + index * line,
          description = midiDescription(event.data);
        if (now - event.time < 200) {
          ctx.fillStyle = "#fff168";
          ctx.fillRect(3, y - 12, w - 6, line);
        }
        this.text(ctx, `${number(event.time / 1000)}s`, 7, y, "left", 9);
        this.text(
          ctx,
          description.channel,
          Math.min(70, w * 0.2),
          y,
          "left",
          10,
        );
        this.text(
          ctx,
          `${description.event}  ${description.value}`,
          Math.min(94, w * 0.3),
          y,
          "left",
          10,
        );
      });
      canvas.dataset.eventCount = String(reading.events.length);
      canvas.dataset.activeNotes = String(reading.notes);
      summary = events.length
        ? `${midiDescription(events[0].data).event} ${midiDescription(events[0].data).value}`
        : t("visuals.waitingMidi");
    }
    canvas.setAttribute(
      "aria-label",
      `${t(`visuals.${widget.kind}`)}${summary ? ` · ${summary}` : ""}`,
    );
    const summaryElement = canvas
      .closest(".visual-widget, .dock-panel")!
      .querySelector<HTMLElement>("[data-visual-summary]");
    if (summaryElement)
      summaryElement.textContent = ["vu", "midi"].includes(widget.kind)
        ? summary
        : "";
  }

  private grid(ctx: CanvasRenderingContext2D, w: number, h: number) {
    ctx.strokeStyle = "#ded8b8";
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo(0, (h * i) / 4);
      ctx.lineTo(w, (h * i) / 4);
      ctx.stroke();
    }
  }
  private text(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    align: CanvasTextAlign = "left",
    size = 11,
    color = "#55503d",
  ) {
    ctx.fillStyle = color;
    ctx.font = `${size}px monospace`;
    ctx.textAlign = align;
    ctx.fillText(text, x, y);
    ctx.textAlign = "left";
  }
}
