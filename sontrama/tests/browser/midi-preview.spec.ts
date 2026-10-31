import { test, expect, setSimulation } from "./fixtures";
import { MidiPreview } from "../../web/src/midi-preview";
import type { Session } from "../../web/src/types";
import type { Configuration } from "../../web/src/settings";
const session = { octave: 1 } as Session;
const configuration = { midi: { devices: {} } } as Configuration;
test("local MIDI is immediate, acknowledgements do not retrigger, and rejected notes are released", () => {
  const played: number[][] = [];
  const bridge = new MidiPreview(
    (data) => played.push([...data]),
    () => played.push([0xb0, 120, 0]),
  );
  bridge.connection = "web:test";
  const id = bridge.predict([0x91, 60, 100], session, configuration);
  expect(played).toEqual([[0x90, 72, 100]]);
  expect(
    bridge.receive({ data: [0x90, 72, 100], event_id: id, origin: "web:test" }),
  ).toBe(false);
  bridge.acknowledge(id, [[0x90, 72, 100]]);
  expect(played).toHaveLength(1);
  const rejected = bridge.predict([0x90, 62, 100], session, configuration);
  bridge.acknowledge(rejected, []);
  expect(played.at(-1)).toEqual([0x80, 74, 0]);
  const off = bridge.predict([0x81, 60, 0], session, configuration);
  expect(played.at(-1)).toEqual([0x80, 72, 0]);
  bridge.receive({ data: [0x80, 72, 0], event_id: off, origin: "web:test" });
  bridge.acknowledge(off, [[0x80, 72, 0]]);
  expect(played.filter((data) => data[0] === 0x90)).toHaveLength(2);
});
test("late echoes stay retired after panic and another source is never deduplicated", () => {
  const played: number[][] = [];
  const bridge = new MidiPreview(
    (data) => played.push(data),
    () => played.push([0xb0, 120, 0]),
  );
  bridge.connection = "web:test";
  const id = bridge.predict([0x90, 60, 100], session, configuration);
  bridge.reset();
  bridge.receive({ data: [0x90, 72, 100], event_id: id, origin: "web:test" });
  expect(played).toHaveLength(2);
  bridge.receive({ data: [0x90, 72, 100], event_id: id, origin: "web:other" });
  expect(played).toHaveLength(3);
});
test("overlapping local controllers preserve note ownership and apply the shared velocity curve", () => {
  const played: number[][] = [];
  const bridge = new MidiPreview(
    (data) => played.push(data),
    () => {},
  );
  bridge.connection = "web:test";
  const config = {
    midi: {
      devices: {
        "browser:Soft": { enabled: true, velocity_curve: "soft" },
        "browser:Blocked": { enabled: false, velocity_curve: "linear" },
      },
    },
  } as Configuration;
  bridge.predict([0x90, 60, 64], session, config, "Soft");
  expect(played[0]).toEqual([0x90, 72, 90]);
  bridge.predict([0x90, 60, 100], session, config, "Other");
  bridge.predict([0x80, 60, 0], session, config, "Soft");
  expect(played).toHaveLength(2);
  bridge.predict([0x80, 60, 0], session, config, "Other");
  expect(played.at(-1)).toEqual([0x80, 72, 0]);
  bridge.predict([0x90, 60, 100], session, config, "Blocked");
  expect(played).toHaveLength(3);
});
test("the real preview plays before a deliberately delayed network send and never repeats its echo", async ({
  page,
  request,
}) => {
  await request.patch("/api/settings", {
    data: { interface: { language: "en" }, keyboard: { capture: true } },
  });
  await request.patch("/api/session", {
    data: {
      instrument: "three-osc",
      effects: [],
      master_effects: [],
      octave: 0,
    },
  });
  await page.addInitScript(() => {
    const send = WebSocket.prototype.send;
    (window as any).deferred = [];
    (window as any).flushMidi = () => {
      for (const [socket, message] of (window as any).deferred.splice(0))
        send.call(socket, message);
    };
    WebSocket.prototype.send = function (data) {
      if (typeof data === "string" && JSON.parse(data).type === "midi") {
        (window as any).deferred.push([this, data]);
        return;
      }
      return send.call(this, data);
    };
  });
  await page.goto("/");
  await page.getByRole("tab", { name: "Output", exact: true }).click();
  await setSimulation(page, true);
  await page.waitForFunction(() => (window as any).sontrama.audio.ready);
  await page.evaluate(() => {
    const audio = (window as any).sontrama.audio,
      original = audio.midi.bind(audio);
    (window as any).previewCalls = [];
    audio.midi = (data: number[], transpose: boolean) => {
      (window as any).previewCalls.push([...data]);
      original(data, transpose);
    };
  });
  await page.keyboard.down("z");
  expect(await page.evaluate(() => (window as any).previewCalls)).toEqual([
    [0x90, 60, 100],
  ]);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const analyser = (window as any).sontrama.audio.masterMeter;
        const samples = new Float32Array(256);
        analyser.getFloatTimeDomainData(samples);
        return Math.max(...samples.map(Math.abs));
      }),
    )
    .toBeGreaterThan(0.001);
  expect(await page.evaluate(() => (window as any).deferred.length)).toBe(1);
  await page.evaluate(() => (window as any).flushMidi());
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => (window as any).previewCalls.length)).toBe(
    1,
  );
  await page.keyboard.up("z");
  expect(
    await page.evaluate(() => (window as any).previewCalls.at(-1)),
  ).toEqual([0x80, 60, 0]);
  await page.evaluate(() => (window as any).flushMidi());
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => (window as any).previewCalls.length)).toBe(
    2,
  );
});

test("shared preview follows the server sample rate and rejects another core revision", async ({
  page,
  request,
}) => {
  await request.patch("/api/settings", {
    data: { interface: { language: "en" }, audio: { sample_rate: 44100 } },
  });
  await request.patch("/api/session", {
    data: { instrument: "three-osc", effects: [], master_effects: [] },
  });
  await page.goto("/");
  await page.getByRole("tab", { name: "Output", exact: true }).click();
  await setSimulation(page, true);
  await page.waitForFunction(() => (window as any).sontrama.audio.ready);
  expect(
    await page.evaluate(
      () => (window as any).sontrama.audio.context.sampleRate,
    ),
  ).toBe(44100);
  await request.patch("/api/settings", {
    data: { audio: { sample_rate: 48000 } },
  });
  await page.waitForFunction(
    () =>
      (window as any).sontrama.audio.ready &&
      (window as any).sontrama.audio.context.sampleRate === 48000,
  );
  await setSimulation(page, false);
  await page.evaluate(() => {
    const audio = (window as any).sontrama.audio;
    audio.setServerEngine({
      core_revision: "invalid-core",
      sample_rate: 48000,
      fluidsynth_version: "2.4.6",
    });
  });
  await setSimulation(page, true);
  await expect(
    page.getByText(
      "The server and browser audio engines differ. Refresh the page after rebuilding.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(await page.evaluate(() => (window as any).sontrama.audio.ready)).toBe(
    false,
  );
});

for (const instrument of ["banks", "three-osc"] as const) {
  test(`live parameter edits preserve MIDI pedal sustain in ${instrument}`, async ({
    page,
    request,
  }) => {
    await request.patch("/api/settings", {
      data: { interface: { language: "en" } },
    });
    const state = await (await request.get("/api/state")).json();
    test.skip(
      instrument === "banks" && !state.catalog.length,
      "A SoundFont is required for Banks",
    );
    await request.patch("/api/session", {
      data: { instrument, effects: [], master_effects: [], sustain: false },
    });
    await page.goto("/");
    await page.getByRole("tab", { name: "Output", exact: true }).click();
    await setSimulation(page, true);
    await page.waitForFunction(() => (window as any).sontrama.audio.ready);
    await page.evaluate(async () => {
      const ws = new WebSocket(`ws://${location.host}/ws`);
      await new Promise((resolve) =>
        ws.addEventListener("open", resolve, { once: true }),
      );
      (window as any).sustainSource = ws;
      ws.send(JSON.stringify({ type: "midi", data: [0xb0, 64, 127] }));
      ws.send(JSON.stringify({ type: "midi", data: [0x90, 69, 100] }));
    });
    const peak = () =>
      page.evaluate(() => {
        const audio = (window as any).sontrama.audio;
        const buffer = new Float32Array(256);
        audio.masterMeter.getFloatTimeDomainData(buffer);
        return Math.max(...buffer.map(Math.abs));
      });
    try {
      await expect.poll(peak).toBeGreaterThan(0.002);
      await page.evaluate(() =>
        (window as any).sustainSource.send(
          JSON.stringify({ type: "midi", data: [0x80, 69, 0] }),
        ),
      );
      await request.patch("/api/session", { data: { volume: 0.7 } });
      await page.waitForTimeout(350);
      await expect.poll(peak).toBeGreaterThan(0.002);
      await page.evaluate(() =>
        (window as any).sustainSource.send(
          JSON.stringify({ type: "midi", data: [0xb0, 64, 0] }),
        ),
      );
      await expect.poll(peak, { timeout: 5000 }).toBeLessThan(0.001);
    } finally {
      await page.evaluate(() => (window as any).sustainSource?.close());
    }
  });
}

test("MIDI received while the shared module loads is played after initialization", async ({
  page,
  request,
}) => {
  await request.patch("/api/settings", {
    data: { interface: { language: "en" }, keyboard: { capture: true } },
  });
  await request.patch("/api/session", {
    data: {
      instrument: "three-osc",
      effects: [],
      master_effects: [],
      octave: 0,
    },
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/vendor/sontrama-dsp.wasm", async (route) => {
    await held;
    await route.continue();
  });
  await page.goto("/");
  await page.getByRole("tab", { name: "Output", exact: true }).click();
  await setSimulation(page, true);
  await page.keyboard.down("z");
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).sontrama.audio.queuedMidi.length),
    )
    .toBe(1);
  release();
  await page.waitForFunction(() => (window as any).sontrama.audio.ready);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const audio = (window as any).sontrama.audio;
        const samples = new Float32Array(256);
        audio.masterMeter.getFloatTimeDomainData(samples);
        return Math.max(...samples.map(Math.abs));
      }),
    )
    .toBeGreaterThan(0.001);
  await page.keyboard.up("z");
});
