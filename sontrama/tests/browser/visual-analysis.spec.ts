import { test, expect } from "@playwright/test";
import {
  db,
  detectPitch,
  pitchWindow,
  signalPitch,
  spectrum,
  stereoStats,
  spectralFrequency,
  spectralDefaults,
} from "../../web/src/visual-analysis";
const tone = (
  frequency: number,
  rate: number,
  length: number,
  amplitude = 0.3,
) =>
  Float32Array.from(
    { length },
    (_, i) => amplitude * Math.sin((2 * Math.PI * frequency * i) / rate),
  );
for (const frequency of [55, 82.4069, 110, 261.6256, 440, 880, 1760])
  test(`tuner identifies ${frequency} Hz within five cents`, () => {
    const rate = 44100,
      full = tone(frequency, rate, 4096),
      raw = full.slice(-1024);
    const pitch = signalPitch({
      samples: [raw, raw],
      sampleRate: rate,
      source: "server",
      pitch: pitchWindow([full, full]),
      pitchRate: rate / 4,
    });
    expect(pitch).not.toBeNull();
    expect(
      Math.abs(1200 * Math.log2(pitch!.frequency / frequency)),
    ).toBeLessThan(5);
  });
test("analysis rejects silence and distinguishes stereo polarity without inventing correlation", () => {
  const sine = tone(440, 44100, 1024),
    inverted = Float32Array.from(sine, (value) => -value),
    silence = new Float32Array(1024);
  expect(stereoStats([sine, sine]).correlation).toBeCloseTo(1, 8);
  expect(stereoStats([sine, inverted]).correlation).toBeCloseTo(-1, 8);
  expect(stereoStats([silence, silence]).correlation).toBeNull();
  expect(stereoStats([sine, silence]).correlation).toBeNull();
  expect(detectPitch(silence, 11025)).toBeNull();
  expect(detectPitch(new Float32Array(1024).fill(0.2), 11025)).toBeNull();
  expect(db(stereoStats([sine, sine]).rms[0])).toBeCloseTo(
    20 * Math.log10(0.3 / Math.sqrt(2)),
    1,
  );
  const bins = spectrum(sine),
    strongest = bins.indexOf(Math.max(...bins));
  expect(Math.abs((strongest * 44100) / 1024 - 440)).toBeLessThan(44100 / 1024);
});

for (const window of ["hann", "hamming", "blackman", "rectangular"] as const)
  test(`FFT ${window} preserves amplitude with different resolutions`, () => {
    for (const size of [256, 1024, 4096]) {
      const samples = tone((44100 * 8) / size, 44100, size, 0.25);
      const bins = spectrum(samples, window);
      expect(bins.indexOf(Math.max(...bins))).toBe(8);
      expect(Math.abs(bins[8] - 20 * Math.log10(0.25))).toBeLessThan(0.1);
    }
  });

test("spectral axes respect scale and Nyquist without inventing a -90 dB noise floor", () => {
  const config = {
    ...spectralDefaults,
    frequency_min: 100,
    frequency_max: 10000,
  };
  expect(spectralFrequency(0.5, config, 44100)).toBeCloseTo(1000);
  expect(
    spectralFrequency(0.5, { ...config, frequency_scale: "linear" }, 44100),
  ).toBeCloseTo(5050);
  expect(spectralFrequency(1, config, 16000)).toBe(8000);
  expect(spectrum(new Float32Array(1024)).every((value) => value <= -120)).toBe(
    true,
  );
});
