import type { EffectKind } from "./types";

// Match dsp/effects.c. State is allocated once and survives parameter edits.
export class EffectDSP {
  private p = new Float64Array(12);
  private coefficient = new Float64Array(5);
  private z = new Float64Array(8);
  private aux = new Float64Array(16);
  private damping = new Float64Array(8);
  private highX = new Float64Array(2);
  private highY = new Float64Array(2);
  private lowY = new Float64Array(2);
  private detectorX = new Float64Array(2);
  private detectorY = new Float64Array(2);
  private x = new Float64Array(2);
  private y = new Float64Array(2);
  private wet = new Float64Array(2);
  private delayed = new Float64Array(2);
  private predelay = new Float64Array(2);
  private rings: Float32Array[];
  private capacity: number;
  private clock = 0;
  private phase = 0;
  private reduction = 0;
  private gain = 1;
  private hold = 0;

  constructor(
    private kind: EffectKind,
    private rate: number,
    parameters: number[],
  ) {
    this.capacity = Math.ceil(rate * 0.25) + 4;
    const count =
      kind === "reverb" ? 7 : kind === "chorus" || kind === "limiter" ? 1 : 0;
    this.rings = Array.from(
      { length: count },
      () => new Float32Array(this.capacity * 2),
    );
    this.configure(parameters);
  }

  configure(parameters: number[]) {
    this.p.set(parameters);
    const p = this.p,
      a = this.aux;
    if (this.kind === "gain") a[0] = 10 ** (p[0] / 20);
    if (this.kind === "filter") this.biquad();
    if (this.kind === "reverb") {
      for (const [index, time] of [0.0297, 0.0371, 0.0411, 0.0437].entries()) {
        a[index] = Math.floor(this.rate * time * (0.6 + 1.6 * p[2]));
        a[4 + index] = 10 ** ((-3 * a[index]) / (this.rate * p[0]));
      }
      a[8] =
        1 -
        Math.exp((-2 * Math.PI * Math.min(p[3], this.rate * 0.45)) / this.rate);
      a[9] = Math.exp(
        (-2 * Math.PI * Math.min(p[6], this.rate * 0.45)) / this.rate,
      );
      a[10] = Math.exp(
        (-2 * Math.PI * Math.min(p[7], this.rate * 0.45)) / this.rate,
      );
      a[11] = p[4] * 0.7;
      a[12] = Math.floor(p[1] * 0.001 * this.rate);
      a[13] = Math.floor(0.005 * this.rate);
      a[14] = Math.floor(0.0017 * this.rate);
    }
    if (this.kind === "compressor") {
      a[0] = Math.exp(-1 / (p[2] * 0.001 * this.rate));
      a[1] = Math.exp(-1 / (p[3] * 0.001 * this.rate));
      a[2] = Math.exp((-2 * Math.PI * p[6]) / this.rate);
    }
    if (this.kind === "limiter") {
      a[0] = 10 ** (p[0] / 20);
      a[1] = 10 ** (p[1] / 20);
      a[2] = Math.exp(-1 / (p[2] * 0.001 * this.rate));
      a[3] = Math.floor(p[3] * 0.001 * this.rate);
    }
  }

  private biquad() {
    const p = this.p,
      type = p[0];
    const w = (2 * Math.PI * Math.min(p[1], this.rate * 0.45)) / this.rate;
    const c = Math.cos(w),
      alpha = Math.sin(w) / (2 * p[2]);
    const a = 10 ** (p[4] / (p[3] === 1 ? 80 : 40));
    let b0: number,
      b1 = 0,
      b2: number,
      a0: number,
      a1: number,
      a2: number;
    if (type === 0) {
      b0 = b2 = (1 - c) / 2;
      b1 = 1 - c;
      a0 = 1 + alpha;
      a1 = -2 * c;
      a2 = 1 - alpha;
    } else if (type === 1) {
      b0 = b2 = (1 + c) / 2;
      b1 = -(1 + c);
      a0 = 1 + alpha;
      a1 = -2 * c;
      a2 = 1 - alpha;
    } else if (type === 2) {
      b0 = alpha;
      b2 = -alpha;
      a0 = 1 + alpha;
      a1 = -2 * c;
      a2 = 1 - alpha;
    } else if (type === 3) {
      b0 = b2 = 1;
      b1 = -2 * c;
      a0 = 1 + alpha;
      a1 = -2 * c;
      a2 = 1 - alpha;
    } else if (type === 4) {
      b0 = 1 + alpha * a;
      b1 = -2 * c;
      b2 = 1 - alpha * a;
      a0 = 1 + alpha / a;
      a1 = -2 * c;
      a2 = 1 - alpha / a;
    } else {
      const beta = 2 * Math.sqrt(a) * alpha;
      if (type === 5) {
        b0 = a * (a + 1 - (a - 1) * c + beta);
        b1 = 2 * a * (a - 1 - (a + 1) * c);
        b2 = a * (a + 1 - (a - 1) * c - beta);
        a0 = a + 1 + (a - 1) * c + beta;
        a1 = -2 * (a - 1 + (a + 1) * c);
        a2 = a + 1 + (a - 1) * c - beta;
      } else {
        b0 = a * (a + 1 + (a - 1) * c + beta);
        b1 = -2 * a * (a - 1 + (a + 1) * c);
        b2 = a * (a + 1 + (a - 1) * c - beta);
        a0 = a + 1 - (a - 1) * c + beta;
        a1 = 2 * (a - 1 - (a + 1) * c);
        a2 = a + 1 - (a - 1) * c - beta;
      }
    }
    this.coefficient.set([b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0]);
  }

  private read(ring: number, delay: number, channel: number) {
    let at = this.clock - delay;
    if (at < 0) at += this.capacity;
    const first = Math.floor(at),
      fraction = at - first;
    return (
      this.rings[ring][first * 2 + channel] * (1 - fraction) +
      this.rings[ring][((first + 1) % this.capacity) * 2 + channel] * fraction
    );
  }

  private width(pair: Float64Array, value: number) {
    const mid = (pair[0] + pair[1]) * 0.5,
      side = (pair[0] - pair[1]) * 0.5 * value;
    pair[0] = mid + side;
    pair[1] = mid - side;
  }

  process(left: Float32Array, right: Float32Array) {
    const p = this.p,
      a = this.aux,
      x = this.x,
      y = this.y;
    for (let frame = 0; frame < left.length; frame++) {
      x[0] = y[0] = left[frame];
      x[1] = y[1] = right[frame];
      if (this.kind === "gain") {
        this.width(y, p[1]);
        y[0] *= a[0];
        y[1] *= a[0];
      } else if (this.kind === "filter") {
        const b = this.coefficient;
        for (let stage = 0; stage < (p[3] === 1 ? 2 : 1); stage++) {
          for (let ch = 0; ch < 2; ch++) {
            const index = stage * 4 + ch * 2;
            const result = y[ch] * b[0] + this.z[index];
            this.z[index] = y[ch] * b[1] - result * b[3] + this.z[index + 1];
            this.z[index + 1] = y[ch] * b[2] - result * b[4];
            y[ch] = result;
          }
        }
        for (let ch = 0; ch < 2; ch++)
          y[ch] = x[ch] * (1 - p[5]) + y[ch] * p[5];
      } else if (this.kind === "chorus") {
        for (let ch = 0; ch < 2; ch++) {
          const delay = Math.max(
            1,
            (p[2] + p[1] * Math.sin(this.phase + (ch * p[3] * Math.PI) / 180)) *
              0.001 *
              this.rate,
          );
          const delayed = this.read(0, delay, ch);
          this.rings[0][this.clock * 2 + ch] = x[ch] + delayed * p[4];
          y[ch] = x[ch] * (1 - p[5]) + delayed * p[5];
        }
        this.phase += (2 * Math.PI * p[0]) / this.rate;
        if (this.phase >= 2 * Math.PI) this.phase -= 2 * Math.PI;
      } else if (this.kind === "reverb") {
        const wet = this.wet,
          delayed = this.delayed;
        wet.fill(0);
        for (let ch = 0; ch < 2; ch++) {
          this.predelay[ch] = a[12] > 0 ? this.read(0, a[12], ch) : x[ch];
          this.rings[0][this.clock * 2 + ch] = x[ch];
        }
        for (let line = 0; line < 4; line++) {
          for (let ch = 0; ch < 2; ch++) {
            delayed[ch] = this.read(line + 1, a[line], ch);
            const index = line * 2 + ch;
            this.damping[index] += a[8] * (delayed[ch] - this.damping[index]);
            wet[ch] += delayed[ch] * 0.25;
          }
          for (let ch = 0; ch < 2; ch++)
            this.rings[line + 1][this.clock * 2 + ch] =
              this.predelay[ch] + this.damping[line * 2 + 1 - ch] * a[line + 4];
        }
        for (let stage = 0; stage < 2; stage++) {
          for (let ch = 0; ch < 2; ch++) {
            const delayed = this.read(stage + 5, a[13 + stage], ch);
            const result = delayed - a[11] * wet[ch];
            this.rings[stage + 5][this.clock * 2 + ch] =
              wet[ch] + a[11] * result;
            wet[ch] = result;
          }
        }
        this.width(wet, p[5]);
        for (let ch = 0; ch < 2; ch++) {
          const high = a[9] * (this.highY[ch] + wet[ch] - this.highX[ch]);
          this.highX[ch] = wet[ch];
          this.highY[ch] = high;
          this.lowY[ch] = (1 - a[10]) * high + a[10] * this.lowY[ch];
          y[ch] = x[ch] * (1 - p[8]) + this.lowY[ch] * p[8];
        }
      } else if (this.kind === "compressor") {
        let peak = 1e-12;
        for (let ch = 0; ch < 2; ch++) {
          const high = a[2] * (this.detectorY[ch] + x[ch] - this.detectorX[ch]);
          this.detectorX[ch] = x[ch];
          this.detectorY[ch] = high;
          peak = Math.max(peak, Math.abs(high));
        }
        const over = 20 * Math.log10(peak) - p[0],
          knee = p[4];
        let reduction = 0;
        if (knee > 0 && Math.abs(over) <= knee * 0.5)
          reduction = ((1 - 1 / p[1]) * (over + knee * 0.5) ** 2) / (2 * knee);
        else if (over > knee * 0.5) reduction = over * (1 - 1 / p[1]);
        const target = -reduction,
          coefficient = a[target < this.reduction ? 0 : 1];
        this.reduction =
          coefficient * this.reduction + (1 - coefficient) * target;
        const gain = 10 ** ((this.reduction + p[5]) / 20);
        for (let ch = 0; ch < 2; ch++)
          y[ch] = x[ch] * (1 - p[7]) + x[ch] * gain * p[7];
      } else if (this.kind === "limiter") {
        const delayed = this.delayed;
        const peak = Math.max(Math.abs(x[0] * a[1]), Math.abs(x[1] * a[1]));
        const needed = Math.min(1, a[0] / Math.max(peak, 1e-12));
        if (needed < this.gain) {
          this.gain = needed;
          this.hold = a[3];
        } else if (this.hold > 0) this.hold--;
        else this.gain = 1 - a[2] + a[2] * this.gain;
        for (let ch = 0; ch < 2; ch++) {
          const driven = x[ch] * a[1];
          delayed[ch] = a[3] > 0 ? this.read(0, a[3], ch) : driven;
          this.rings[0][this.clock * 2 + ch] = driven;
        }
        const safe = Math.min(
          this.gain,
          a[0] / Math.max(1e-12, Math.abs(delayed[0]), Math.abs(delayed[1])),
        );
        for (let ch = 0; ch < 2; ch++)
          y[ch] = Math.max(-a[0], Math.min(a[0], delayed[ch] * safe));
      }
      left[frame] = y[0];
      right[frame] = y[1];
      this.clock = (this.clock + 1) % this.capacity;
    }
  }
}
