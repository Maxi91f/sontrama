import { test, expect, setSimulation } from "./fixtures";

for (const fallback of [false, true]) {
  test(`expanded effects persist, sync and process audio (${fallback ? "fallback" : "worklet"})`, async ({
    page,
    browser,
    request,
  }) => {
    if (fallback)
      await page.addInitScript(() =>
        Object.defineProperty(AudioContext.prototype, "audioWorklet", {
          get: () => undefined,
        }),
      );
    const failures: string[] = [];
    page.on("pageerror", (error) => failures.push(error.message));
    await request.patch("/api/settings", {
      data: { interface: { language: "en" } },
    });
    await request.patch("/api/session", {
      data: { instrument: "three-osc", effects: [], master_effects: [] },
    });
    const observer = await browser.newPage();
    try {
      await page.goto("/");
      await observer.goto("/");
      await page.getByRole("tab", { name: "Output", exact: true }).click();
      await setSimulation(page, true);
      await page.waitForFunction(() => (window as any).sontrama.audio.ready);
      await page.getByRole("tab", { name: "Mixer", exact: true }).click();
      await observer.getByRole("tab", { name: "Mixer", exact: true }).click();
      const add = async (name: string) => {
        await page
          .getByRole("button", { name: "Add effect", exact: true })
          .click();
        await page
          .getByRole("dialog")
          .getByRole("button", { name, exact: false })
          .click();
        await expect(page.getByRole("dialog")).toBeHidden();
        await expect(
          page.locator(".effect-top > button").filter({ hasText: name }),
        ).toBeVisible();
      };
      await add("Chorus");
      await page.getByLabel("Chorus Feedback", { exact: true }).fill("0.6");
      await page
        .getByLabel("Chorus Feedback", { exact: true })
        .dispatchEvent("change");
      await expect(
        observer.getByLabel("Chorus Feedback", { exact: true }),
      ).toHaveValue("0.6");
      await add("Reverb");
      await page.getByLabel("Reverb Decay", { exact: true }).fill("5.2");
      await page
        .getByLabel("Reverb Decay", { exact: true })
        .dispatchEvent("change");
      await expect(
        observer.getByLabel("Reverb Decay", { exact: true }),
      ).toHaveValue("5.2");
      await add("Filter");
      await page
        .getByLabel("Filter Type", { exact: true })
        .selectOption("peaking");
      await page.getByLabel("Filter Gain", { exact: true }).fill("6");
      await page
        .getByLabel("Filter Gain", { exact: true })
        .dispatchEvent("change");
      await page.getByLabel("Filter Slope", { exact: true }).selectOption("24");
      await add("Gain");
      await page.getByLabel("Gain Stereo width", { exact: true }).fill("1.4");
      await page
        .getByLabel("Gain Stereo width", { exact: true })
        .dispatchEvent("change");
      await page
        .getByRole("button", { name: "Edit Master", exact: true })
        .click();
      await add("Compressor");
      await page
        .getByLabel("Compressor Threshold", { exact: true })
        .fill("-24");
      await page
        .getByLabel("Compressor Threshold", { exact: true })
        .dispatchEvent("change");
      await add("Limiter");
      await page.getByLabel("Limiter Ceiling", { exact: true }).fill("-6");
      await page
        .getByLabel("Limiter Ceiling", { exact: true })
        .dispatchEvent("change");
      await page.getByLabel("Limiter Input gain", { exact: true }).fill("24");
      await page
        .getByLabel("Limiter Input gain", { exact: true })
        .dispatchEvent("change");
      await page.evaluate(async () => {
        const socket = new WebSocket(
          `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`,
        );
        await new Promise((resolve) =>
          socket.addEventListener("message", resolve, { once: true }),
        );
        (window as any).effectSource = socket;
        for (const note of [48, 55, 60, 64, 67])
          socket.send(
            JSON.stringify({ type: "midi", data: [0x90, note, 127] }),
          );
      });
      await expect
        .poll(() =>
          page.evaluate(() => {
            const analyser = (window as any).sontrama.audio
              .masterMeter as AnalyserNode;
            const samples = new Float32Array(256);
            analyser.getFloatTimeDomainData(samples);
            return Math.max(...samples.map(Math.abs));
          }),
        )
        .toBeGreaterThan(0.001);
      const peak = await page.evaluate(() => {
        const analyser = (window as any).sontrama.audio
          .masterMeter as AnalyserNode;
        const samples = new Float32Array(256);
        analyser.getFloatTimeDomainData(samples);
        return Math.max(...samples.map(Math.abs));
      });
      expect(peak).toBeLessThan(0.502);
      const state = (await (await request.get("/api/state")).json()).session;
      expect(
        state.effects.map((effect: { kind: string }) => effect.kind),
      ).toEqual(["chorus", "reverb", "filter", "gain"]);
      expect(
        state.master_effects.map((effect: { kind: string }) => effect.kind),
      ).toEqual(["compressor", "limiter"]);
      expect(state.master_effects[1].parameters.ceiling).toBe(-6);
      expect(state.effects[1].parameters.decay).toBe(5.2);
      for (const width of [1440, 768, 390, 320]) {
        await page.setViewportSize({ width, height: 1000 });
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
      }
      await page.reload();
      await page
        .getByRole("button", { name: "Edit Master", exact: true })
        .click();
      await expect(
        page.getByLabel("Limiter Ceiling", { exact: true }),
      ).toHaveValue("-6");
      expect(failures).toEqual([]);
    } finally {
      await observer.close();
    }
  });
}

test("effect terminology and parameter help work in English and Spanish", async ({
  page,
  request,
}) => {
  await request.patch("/api/settings", {
    data: { interface: { language: "en" } },
  });
  await request.patch("/api/session", {
    data: {
      instrument: "three-osc",
      effects: [
        { id: "terms-reverb", kind: "reverb", value: 0.26 },
        { id: "terms-compressor", kind: "compressor", value: -18 },
        {
          id: "terms-filter",
          kind: "filter",
          value: 1000,
          parameters: { type: "lowshelf" },
        },
        { id: "terms-limiter", kind: "limiter", value: -1 },
      ],
    },
  });
  await page.goto("/");
  await page.getByRole("tab", { name: "Mixer", exact: true }).click();
  await expect(
    page.getByLabel("Reverb Dry/Wet", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Filter Frequency", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Limiter Input gain", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Compressor Sidechain HPF", { exact: true }),
  ).toBeVisible();
  const compressor = page.locator('[data-effect="terms-compressor"]');
  const knee = compressor.locator("summary").filter({ hasText: /^Knee/ });
  await knee.focus();
  await page.keyboard.press("Enter");
  await expect(compressor.locator(".parameter-info[open] p")).toContainText(
    "more gradual",
  );
  await page.keyboard.press("Escape");
  await expect(compressor.locator(".parameter-info[open]")).toHaveCount(0);
  await expect(knee).toBeFocused();
  await request.patch("/api/settings", {
    data: { interface: { language: "es" } },
  });
  await expect(
    page.getByLabel("Original/Efecto Reverb", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Knee Compresor", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Release Compresor", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Tiempo de reverberación Reverb", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Tipo Filtro", { exact: true }).locator("option:checked"),
  ).toHaveText("Low shelf");
  await page.setViewportSize({ width: 320, height: 900 });
  await knee.click();
  await expect(compressor.locator(".parameter-info[open] p")).toContainText(
    "más gradual",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "../experiments/mixer/parameter-help-mobile.png",
    fullPage: true,
  });
});
