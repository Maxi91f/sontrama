import { test as base, expect } from "@playwright/test";
import type { Configuration } from "../../web/src/settings";

export const test = base.extend<{ sharedConfiguration: void }>({
  sharedConfiguration: [
    async ({ request }, use) => {
      const original: Configuration = (
        await (await request.get("/api/settings")).json()
      ).settings;
      const state = await (await request.get("/api/state")).json();
      const originalSession = state.session;
      const font = state.catalog[0];
      if (font) {
        const preset = font.presets[0];
        await request.patch("/api/session", {
          data: {
            instrument: "banks",
            soundfont: font.id,
            bank: preset.bank,
            program: preset.program,
            octave: 0,
            sustain: false,
            mute: false,
            volume: 0.78,
            master: 0.85,
            pan: 0,
            master_pan: 0,
            master_mute: false,
            master_solo: false,
            master_effects: [],
            effects: [
              {
                id: "browser-test-chorus",
                kind: "chorus",
                enabled: true,
                value: 0.18,
              },
              {
                id: "browser-test-reverb",
                kind: "reverb",
                enabled: true,
                value: 0.26,
              },
            ],
          },
        });
      }
      await request.patch("/api/settings", {
        data: {
          interface: { language: "es" },
          keyboard: { capture: false, velocity: 100, labels: "shortcuts" },
          browser_preview: false,
        },
      });
      try {
        await use();
      } finally {
        const after: Configuration = (
          await (await request.get("/api/settings")).json()
        ).settings;
        const devices: Record<string, unknown> = { ...original.midi.devices };
        for (const id of Object.keys(after.midi.devices))
          if (!(id in devices)) devices[id] = null;
        await request.patch("/api/settings", {
          data: { ...original, midi: { devices } },
        });
        await request.patch("/api/session", { data: originalSession });
      }
    },
    { auto: true },
  ],
});
export { expect };
