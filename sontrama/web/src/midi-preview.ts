import type { Configuration } from "./settings";
import type { Session } from "./types";
type Midi = number[];
interface Pending {
  expected: Midi[];
  epoch: number;
}
interface Echo {
  data: Midi;
  event_id?: string;
  origin?: string;
}
function noteState(notes: Map<number, number>, data: Midi) {
  const kind = data[0] & 0xf0;
  if (kind === 0x90 && data[2]) notes.set(data[1], data[2]);
  else if (kind === 0x80 || kind === 0x90) notes.delete(data[1]);
  else if (kind === 0xb0 && (data[1] === 120 || data[1] === 123)) notes.clear();
}
export class MidiPreview {
  private sequence = 0;
  private prefix = Array.from(crypto.getRandomValues(new Uint32Array(4)), (n) =>
    n.toString(16),
  ).join("-");
  private pending = new Map<string, Pending>();
  private history = new Map<string, number>();
  private epoch = 0;
  private canonical = new Map<number, number>();
  private audible = new Map<number, number>();
  private keys = new Map<string, number>();
  private counts = new Map<number, number>();
  connection: string | null = null;
  constructor(
    private play: (data: Midi) => void,
    private silence: () => void,
  ) {}
  private emit(data: Midi) {
    this.play(data);
    noteState(this.audible, data);
  }
  predict(
    data: Midi,
    state: Session,
    configuration: Configuration,
    controller?: string,
    enabled = true,
  ): string {
    const id = `${this.prefix}-${++this.sequence}`;
    const kind = data[0] & 0xf0;
    const profile = controller
      ? configuration.midi.devices[`browser:${controller}`]
      : undefined;
    if (
      !enabled ||
      !this.connection ||
      profile?.enabled === false ||
      kind === 0xc0 ||
      (kind === 0xb0 && [0, 32].includes(data[1]))
    )
      return id;
    if (this.pending.size >= 512) this.reset();
    const expected: Midi[] = [];
    const key = `${controller ?? "keyboard"}:${data[0] & 15}:${data[1]}`;
    const release = () => {
      const note = this.keys.get(key);
      if (note === undefined) return;
      this.keys.delete(key);
      const count = (this.counts.get(note) ?? 1) - 1;
      if (count) {
        this.counts.set(note, count);
      } else {
        this.counts.delete(note);
        expected.push([0x80, note, 0]);
      }
    };
    if (kind === 0x90 && data[2]) {
      const note = data[1] + state.octave * 12;
      if (note < 0 || note > 127) return id;
      if (this.keys.has(key)) release();
      this.keys.set(key, note);
      this.counts.set(note, (this.counts.get(note) ?? 0) + 1);
      const power = profile
        ? { linear: 1, soft: 0.5, hard: 2 }[profile.velocity_curve]
        : 1;
      const velocity = profile
        ? Math.max(1, Math.min(127, Math.round(127 * (data[2] / 127) ** power)))
        : data[2];
      expected.push([0x90, note, velocity]);
    } else if (kind === 0x80 || kind === 0x90) release();
    else expected.push([kind, ...data.slice(1)]);
    this.pending.set(id, { expected, epoch: this.epoch });
    this.history.set(id, this.epoch);
    if (this.history.size > 2048)
      this.history.delete(this.history.keys().next().value!);
    expected.forEach((message) => this.emit(message));
    return id;
  }
  receive(message: Echo): boolean {
    const epoch = message.event_id
      ? this.history.get(message.event_id)
      : undefined;
    // IDs are unpredictable and scoped to one originating browser. Retired IDs
    // remain suppressed after an instrument switch, panic, blur or disconnect.
    if (
      epoch !== undefined &&
      (message.origin === this.connection ||
        message.origin?.startsWith((this.connection ?? "\0") + ":midi:"))
    ) {
      if (epoch === this.epoch) noteState(this.canonical, message.data);
      return false;
    }
    noteState(this.canonical, message.data);
    this.emit(message.data);
    return true;
  }
  acknowledge(id: string, routed: Midi[]) {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (
      pending.epoch !== this.epoch ||
      JSON.stringify(pending.expected) === JSON.stringify(routed)
    )
      return;
    const desired = new Map(this.canonical);
    for (const prediction of this.pending.values())
      if (prediction.epoch === this.epoch)
        prediction.expected.forEach((data) => noteState(desired, data));
    for (const note of this.audible.keys())
      if (!desired.has(note)) this.emit([0x80, note, 0]);
    for (const [note, velocity] of desired)
      if (this.audible.get(note) !== velocity)
        this.emit([0x90, note, velocity]);
  }
  reset() {
    this.epoch++;
    this.pending.clear();
    this.keys.clear();
    this.counts.clear();
    this.canonical.clear();
    this.audible.clear();
    this.silence();
  }
}
