export interface Signal {
  samples: Float32Array[];
  sampleRate: number;
  source: "preview";
  pitch?: Float32Array;
  pitchRate?: number;
  peaks?: number[];
  analysisSamples?: Float32Array[];
}

/** Hann-windowed radix-2 FFT, normalized to sinusoidal peak amplitude. */
export type SpectralWindow = "hann" | "hamming" | "blackman" | "rectangular";
export function spectrum(
  samples: Float32Array,
  window: SpectralWindow = "hann",
) {
  const size = samples.length;
  const real = new Float64Array(size),
    imaginary = new Float64Array(size);
  let windowSum = 0;
  for (let index = 0, reversed = 0; index < size; index++) {
    const phase = (2 * Math.PI * index) / (size - 1);
    const weight =
      window === "rectangular"
        ? 1
        : window === "hamming"
          ? 0.54 - 0.46 * Math.cos(phase)
          : window === "blackman"
            ? 0.42 - 0.5 * Math.cos(phase) + 0.08 * Math.cos(2 * phase)
            : 0.5 - 0.5 * Math.cos(phase);
    windowSum += weight;
    real[reversed] = samples[index] * weight;
    let bit = size >> 1;
    while (reversed & bit) {
      reversed ^= bit;
      bit >>= 1;
    }
    reversed ^= bit;
  }
  for (let length = 2; length <= size; length *= 2)
    for (let start = 0; start < size; start += length)
      for (let index = 0; index < length / 2; index++) {
        const angle = (-2 * Math.PI * index) / length,
          a = start + index,
          b = a + length / 2;
        const re = real[b] * Math.cos(angle) - imaginary[b] * Math.sin(angle),
          im = real[b] * Math.sin(angle) + imaginary[b] * Math.cos(angle);
        real[b] = real[a] - re;
        imaginary[b] = imaginary[a] - im;
        real[a] += re;
        imaginary[a] += im;
      }
  return Float32Array.from(real.subarray(0, size / 2), (value, index) =>
    Math.max(
      -160,
      20 *
        Math.log10(
          (Math.hypot(value, imaginary[index]) * 2) / windowSum + 1e-12,
        ),
    ),
  );
}

export function stereoStats(samples: Float32Array[]) {
  const [left, right] = samples;
  let sumL = 0,
    sumR = 0,
    ll = 0,
    rr = 0,
    lr = 0,
    peakL = 0,
    peakR = 0;
  for (let i = 0; i < left.length; i++) {
    const l = left[i],
      r = right[i];
    sumL += l;
    sumR += r;
    ll += l * l;
    rr += r * r;
    lr += l * r;
    peakL = Math.max(peakL, Math.abs(l));
    peakR = Math.max(peakR, Math.abs(r));
  }
  const n = left.length;
  const energyL = Math.max(0, ll - (sumL * sumL) / n),
    energyR = Math.max(0, rr - (sumR * sumR) / n);
  const denominator = Math.sqrt(energyL * energyR);
  return {
    rms: [Math.sqrt(ll / n), Math.sqrt(rr / n)],
    peaks: [peakL, peakR],
    correlation:
      denominator < 1e-9
        ? null
        : Math.max(-1, Math.min(1, (lr - (sumL * sumR) / n) / denominator)),
  };
}

/** YIN's normalized difference rejects silence and ambiguous/polyphonic frames. */
export function detectPitch(samples: Float32Array, rate: number) {
  const minLag = Math.max(2, Math.floor(rate / 2000));
  const maxLag = Math.min(
    Math.floor(samples.length / 2) - 1,
    Math.ceil(rate / 50),
  );
  if (maxLag <= minLag) return null;
  const count = samples.length - maxLag;
  let energy = 0,
    mean = 0;
  for (const sample of samples) {
    energy += sample * sample;
    mean += sample;
  }
  if (
    Math.sqrt(
      Math.max(0, energy / samples.length - (mean / samples.length) ** 2),
    ) < 0.001
  )
    return null;
  const difference = new Float64Array(maxLag + 1);
  let sum = 0;
  for (let lag = 1; lag <= maxLag; lag++) {
    let value = 0;
    for (let i = 0; i < count; i++) {
      const delta = samples[i] - samples[i + lag];
      value += delta * delta;
    }
    sum += value;
    difference[lag] = sum > 0 ? (value * lag) / sum : 1;
  }
  let lag = minLag;
  for (; lag < maxLag; lag++)
    if (difference[lag] < 0.12) {
      while (lag + 1 < maxLag && difference[lag + 1] < difference[lag]) lag++;
      break;
    }
  if (lag === maxLag) return null;
  const previous = difference[lag - 1],
    current = difference[lag],
    next = difference[lag + 1];
  const denominator = previous - 2 * current + next;
  const refined =
    lag +
    (Math.abs(denominator) > 1e-12
      ? Math.max(-1, Math.min(1, (previous - next) / (2 * denominator)))
      : 0);
  const frequency = rate / refined;
  if (frequency < 50 || frequency > 2000) return null;
  const midi = 69 + 12 * Math.log2(frequency / 440),
    note = Math.round(midi);
  return {
    frequency,
    note,
    cents: (midi - note) * 100,
    confidence: 1 - current,
  };
}

export function pitchWindow(stereo: Float32Array[]) {
  let strongest = stereo[0],
    energy = -1;
  for (const channel of stereo) {
    let next = 0;
    for (const sample of channel) next += sample * sample;
    if (next > energy) {
      strongest = channel;
      energy = next;
    }
  }
  const result = new Float32Array(Math.floor(strongest.length / 4));
  for (let i = 0; i < result.length; i++)
    result[i] =
      (strongest[i * 4] +
        strongest[i * 4 + 1] +
        strongest[i * 4 + 2] +
        strongest[i * 4 + 3]) /
      4;
  return result;
}
export const db = (amplitude: number) =>
  Math.max(-90, 20 * Math.log10(Math.max(1e-9, amplitude)));

export function signalPitch(signal: Signal) {
  const stats = stereoStats(signal.samples);
  const channel = stats.rms[0] >= stats.rms[1] ? 0 : 1;
  const fine = detectPitch(signal.samples[channel], signal.sampleRate);
  return fine && fine.frequency >= 180
    ? fine
    : signal.pitch
      ? detectPitch(signal.pitch, signal.pitchRate ?? signal.sampleRate / 4)
      : fine;
}

export interface SpectralSettings {
  fft_size: 256 | 512 | 1024 | 2048 | 4096;
  refresh_rate: 5 | 10 | 20;
  frequency_min: number;
  frequency_max: number;
  frequency_scale: "log" | "linear";
  window: SpectralWindow;
  smoothing: number;
  db_min: number;
  db_max: number;
  history_seconds: 2 | 4 | 8 | 16 | 32;
}
export const spectralDefaults: SpectralSettings = {
  fft_size: 1024,
  refresh_rate: 20,
  frequency_min: 40,
  frequency_max: 20000,
  frequency_scale: "log",
  window: "hann",
  smoothing: 0.5,
  db_min: -90,
  db_max: 0,
  history_seconds: 8,
};
export function spectralFrequency(
  position: number,
  settings: SpectralSettings,
  sampleRate: number,
) {
  const maximum = Math.min(settings.frequency_max, sampleRate / 2),
    minimum = Math.min(settings.frequency_min, maximum * 0.999);
  return settings.frequency_scale === "linear"
    ? minimum + (maximum - minimum) * position
    : minimum * (maximum / minimum) ** position;
}
