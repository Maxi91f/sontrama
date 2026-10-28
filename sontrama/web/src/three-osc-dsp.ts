import type { ThreeOscPatch, WaveShape } from "./types";
const size = 2048;
const tables = new Map<string, Float32Array>();
function table(shape: WaveShape, power: number) {
  const key = `${shape}:${power}`,
    cached = tables.get(key);
  if (cached) return cached;
  const result = new Float32Array(size);
  for (let harmonic = 1; harmonic <= 2 ** power; harmonic++) {
    let amplitude: number;
    if (shape === "sine") amplitude = harmonic === 1 ? 1 : 0;
    else if (shape === "triangle")
      amplitude =
        harmonic % 2
          ? ((8 / Math.PI ** 2) * (-1) ** ((harmonic - 1) / 2)) / harmonic ** 2
          : 0;
    else if (shape === "square")
      amplitude = harmonic % 2 ? 4 / (Math.PI * harmonic) : 0;
    else if (shape === "saw") amplitude = -2 / (Math.PI * harmonic);
    else amplitude = -1 / harmonic ** 2;
    if (!amplitude) continue;
    for (let sample = 0; sample < size; sample++)
      result[sample] +=
        amplitude * Math.sin((2 * Math.PI * harmonic * sample) / size);
  }
  tables.set(key, result);
  return result;
}
interface Voice {
  note: number;
  velocity: number;
  phases: number[];
  age: number;
  keyDown: boolean;
  releaseAge: number | null;
  releaseLevel: number;
  pressure: number;
}
export class ThreeOscDSP {
  private voices = new Map<number, Voice>();
  private sustain = false;
  private bend = 0;
  private mod = 0;
  private pressure = 0;
  private volume = 1;
  private expression = 1;
  private pan = 0;
  private clock = 0;
  constructor(
    private rate: number,
    private patch: ThreeOscPatch,
  ) {}
  configure(patch: ThreeOscPatch) {
    for (const voice of this.voices.values()) {
      patch.oscillators.forEach((osc, index) => {
        const before = this.patch.oscillators[index];
        const common = (osc.phase_start - before.phase_start) / 360;
        voice.phases[index * 2] =
          (((voice.phases[index * 2] + common) % 1) + 1) % 1;
        voice.phases[index * 2 + 1] =
          (((voice.phases[index * 2 + 1] +
            common +
            (osc.phase - before.phase) / 360) %
            1) +
            1) %
          1;
      });
    }
    this.patch = patch;
  }
  private level(age: number) {
    const time = age / this.rate,
      env = this.patch.envelope;
    if (time < env.attack) return time / env.attack;
    if (time < env.attack + env.decay)
      return 1 - ((1 - env.sustain) * (time - env.attack)) / env.decay;
    return env.sustain;
  }
  private release(voice: Voice) {
    if (voice.releaseAge !== null) return;
    voice.releaseAge = 0;
    voice.releaseLevel = this.level(voice.age);
  }
  midi(data: number[]) {
    const kind = data[0] & 0xf0,
      value = data[1],
      amount = data[2];
    if (kind === 0x90 && amount) {
      this.voices.delete(value);
      if (this.voices.size >= 16)
        this.voices.delete(this.voices.keys().next().value!);
      const phases = Array.from(
        { length: 6 },
        () => Math.random() * this.patch.phase_random,
      );
      this.patch.oscillators.forEach((osc, index) => {
        phases[index * 2] = (phases[index * 2] + osc.phase_start / 360) % 1;
        phases[index * 2 + 1] =
          (phases[index * 2 + 1] + (osc.phase_start + osc.phase) / 360) % 1;
      });
      this.voices.set(value, {
        note: value,
        velocity: amount / 127,
        phases,
        age: 0,
        keyDown: true,
        releaseAge: null,
        releaseLevel: 0,
        pressure: 0,
      });
    } else if (kind === 0x80 || kind === 0x90) {
      const voice = this.voices.get(value);
      if (voice) {
        voice.keyDown = false;
        if (!this.sustain) this.release(voice);
      }
    } else if (kind === 0xe0)
      this.bend = ((value + (amount << 7) - 8192) / 8192) * 2;
    else if (kind === 0xd0) this.pressure = value / 127;
    else if (kind === 0xa0) {
      const voice = this.voices.get(value);
      if (voice) voice.pressure = amount / 127;
    } else if (kind === 0xb0) {
      if (value === 64) {
        this.sustain = amount >= 64;
        if (!this.sustain)
          for (const voice of this.voices.values())
            if (!voice.keyDown) this.release(voice);
      } else if (value === 1) this.mod = amount / 127;
      else if (value === 7) this.volume = amount / 127;
      else if (value === 11) this.expression = amount / 127;
      else if (value === 10)
        this.pan = Math.max(-1, Math.min(1, (amount - 64) / 63));
      else if (value === 120) this.panic();
      else if (value === 123)
        for (const voice of this.voices.values()) {
          voice.keyDown = false;
          if (!this.sustain) this.release(voice);
        }
      else if (value === 121) {
        this.sustain = false;
        this.bend = this.mod = this.pressure = this.pan = 0;
        this.volume = this.expression = 1;
        for (const voice of this.voices.values())
          if (!voice.keyDown) this.release(voice);
      }
    }
  }
  process(left: Float32Array, right: Float32Array) {
    left.fill(0);
    right.fill(0);
    const patch = this.patch,
      oscillators = patch.oscillators;
    const mix2 = oscillators[1].enabled ? oscillators[1].mix : 0;
    const mix3 = oscillators[2].enabled ? oscillators[2].mix : 0;
    for (const [note, voice] of this.voices) {
      const frequencies = oscillators.map((osc) =>
        [0, 1].map(
          (channel) =>
            440 *
            2 **
              ((voice.note -
                69 +
                osc.coarse +
                (osc.fine + osc.detune * (channel ? 0.5 : -0.5)) / 100 +
                this.bend) /
                12),
        ),
      );
      const waves = oscillators.map((osc, index) =>
        frequencies[index].map((frequency) =>
          osc.shape === "noise"
            ? null
            : table(
                osc.shape,
                patch.hq
                  ? Math.min(
                      9,
                      Math.floor(
                        Math.log2(
                          Math.max(
                            1,
                            (this.rate * 0.49) / (frequency * 2 ** (0.5 / 12)),
                          ),
                        ),
                      ),
                    )
                  : 9,
              ),
        ),
      );
      const pans = oscillators.map((osc) => {
        const angle =
          ((Math.max(-1, Math.min(1, osc.pan + this.pan)) + 1) * Math.PI) / 4;
        return [Math.cos(angle), Math.sin(angle)];
      });
      const depth =
        Math.max(this.mod, this.pressure * 0.5, voice.pressure * 0.5) * 0.5;
      for (let sample = 0; sample < left.length; sample++) {
        const envelope =
          voice.releaseAge === null
            ? this.level(voice.age)
            : voice.releaseLevel *
              Math.max(
                0,
                1 - voice.releaseAge / (patch.envelope.release * this.rate),
              );
        const vibrato =
          2 **
          ((Math.sin(((this.clock + sample) * 2 * Math.PI * 5) / this.rate) *
            depth) /
            12);
        for (let channel = 0; channel < 2; channel++) {
          let first = 0,
            second = 0,
            third = 0;
          for (let oscillator = 0; oscillator < 3; oscillator++) {
            const spec = oscillators[oscillator];
            if (!spec.enabled) continue;
            const frequency = frequencies[oscillator][channel] * vibrato;
            const phaseIndex = oscillator * 2 + channel,
              phase = voice.phases[phaseIndex];
            voice.phases[phaseIndex] = (phase + frequency / this.rate) % 1;
            const wave = waves[oscillator][channel];
            let signal = 0;
            if (!wave) signal = Math.random() * 2 - 1;
            else if (frequency < this.rate * 0.49) {
              const position = phase * size,
                index = Math.floor(position),
                fraction = position - index;
              signal =
                wave[index] * (1 - fraction) +
                wave[(index + 1) % size] * fraction;
            }
            signal *= pans[oscillator][channel];
            if (oscillator === 0) first = signal;
            else if (oscillator === 1) second = signal;
            else third = signal;
          }
          let combined = first * (1 - mix2) + second * mix2;
          combined = patch.am_osc3
            ? combined * (1 - mix3 + mix3 * (third + 1) * 0.5)
            : combined * (1 - mix3) + third * mix3;
          const output = channel === 0 ? left : right;
          output[sample] +=
            combined *
            envelope *
            0.2 *
            voice.velocity *
            this.volume *
            this.expression;
        }
        voice.age++;
        if (voice.releaseAge !== null) voice.releaseAge++;
      }
      if (
        voice.releaseAge !== null &&
        voice.releaseAge >= patch.envelope.release * this.rate
      )
        this.voices.delete(note);
    }
    this.clock += left.length;
  }
  panic() {
    this.voices.clear();
    this.sustain = false;
    this.bend = 0;
  }
}
