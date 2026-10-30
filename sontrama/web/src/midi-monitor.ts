import { t } from "./i18n";
export interface MidiReading {
  events: { sequence: number; time: number; data: number[] }[];
  notes: number;
  sequence: number;
}
export class MidiMonitor {
  private events: MidiReading["events"] = [];
  private active = new Set<number>();
  private sequence = 0;
  receive(data: number[]) {
    if (!data.length) return;
    const status = data[0] & 0xf0,
      channel = data[0] & 15,
      note = channel * 128 + (data[1] ?? 0);
    if (status === 0x90 && data[2] > 0) this.active.add(note);
    else if (status === 0x80 || (status === 0x90 && data[2] === 0))
      this.active.delete(note);
    else if (status === 0xb0 && [120, 123].includes(data[1]))
      for (const key of this.active)
        if (Math.floor(key / 128) === channel) this.active.delete(key);
    this.events.push({
      sequence: ++this.sequence,
      time: performance.now(),
      data: data.slice(0, 3),
    });
    if (this.events.length > 64) this.events.shift();
  }
  silence() {
    this.active.clear();
  }
  reading(since = 0): MidiReading {
    return {
      events: this.events.filter((event) => event.sequence > since),
      notes: this.active.size,
      sequence: this.sequence,
    };
  }
}
export function midiDescription(data: number[]) {
  const kind = data[0] & 0xf0,
    channel = data[0] < 0xf0 ? String((data[0] & 15) + 1) : "—";
  const note = `${t("notes.names").split("|")[(data[1] ?? 0) % 12]}${Math.floor((data[1] ?? 0) / 12) - 1}`;
  const value = data[2] ?? data[1] ?? 0;
  if (kind === 0x90 || kind === 0x80)
    return {
      channel,
      event: t(
        kind === 0x80 || data[2] === 0 ? "visuals.noteOff" : "visuals.noteOn",
      ),
      value: `${note} · ${t("visuals.velocity")} ${value}`,
    };
  if (kind === 0xb0)
    return { channel, event: "CC", value: `#${data[1]} = ${value}` };
  if (kind === 0xe0)
    return {
      channel,
      event: t("visuals.pitchBend"),
      value: String(((data[2] ?? 0) << 7) + (data[1] ?? 0) - 8192),
    };
  if (kind === 0xa0 || kind === 0xd0)
    return {
      channel,
      event: t("visuals.pressure"),
      value: `${kind === 0xa0 ? note + " · " : ""}${value}`,
    };
  if (kind === 0xc0)
    return {
      channel,
      event: t("visuals.program"),
      value: String((data[1] ?? 0) + 1),
    };
  return {
    channel,
    event: "MIDI",
    value: data
      .map((byte) => byte.toString(16).padStart(2, "0").toUpperCase())
      .join(" "),
  };
}
