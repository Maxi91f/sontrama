import { test, expect } from "./fixtures";

for (const fallback of [false, true]) {
  test(`local simulation CTA, silent analysis and shared preview controls (${fallback ? "fallback" : "worklet"})`, async ({
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
    await request.patch("/api/session", {
      data: {
        instrument: "three-osc",
        effects: [],
        master_effects: [],
        octave: 0,
      },
    });
    const session = (await (await request.get("/api/state")).json()).session;
    await request.patch("/api/settings", {
      data: {
        interface: { language: "en" },
        browser_preview: false,
        preview_muted: true,
        preview_volume: 1,
        keyboard: { capture: true },
        visualizations: {
          widgets: [
            {
              id: "scope",
              kind: "oscilloscope",
              pinned: true,
              dock_width: 360,
            },
            { id: "midi", kind: "midi" },
          ],
        },
      },
    });
    await page.addInitScript(() => {
      const send = WebSocket.prototype.send;
      (window as any).audioSubscriptions = [];
      WebSocket.prototype.send = function (data) {
        if (
          typeof data === "string" &&
          JSON.parse(data).type === "visualization_subscribe"
        )
          (window as any).audioSubscriptions.push(data);
        return send.call(this, data);
      };
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/");
    await page
      .getByRole("tab", { name: "Visualizations", exact: true })
      .click();
    const scope = page.locator('.visual-widget[data-widget="scope"]');
    const dock = page.locator('.dock-visual[data-widget="scope"]');
    await expect(
      scope.getByText("Enable local simulation to see this visualization."),
    ).toBeVisible();
    await expect(
      dock.getByRole("button", {
        name: "Enable local simulation",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.locator('.visual-widget[data-widget="midi"] .visual-simulation'),
    ).toBeHidden();
    await scope
      .getByRole("button", { name: "Enable local simulation", exact: true })
      .click();
    await page.waitForFunction(() => (window as any).sontrama.audio.ready);
    await expect(scope.locator(".visual-simulation")).toBeHidden();
    await expect(dock.locator(".visual-simulation")).toBeHidden();
    await page.evaluate(() => {
      const audio = (window as any).sontrama.audio;
      const analyser = audio.context.createAnalyser();
      analyser.fftSize = 2048;
      audio.monitor.connect(analyser);
      (window as any).audiblePreview = analyser;
    });
    const audiblePeak = () =>
      page.evaluate(() => {
        const samples = new Float32Array(2048);
        (window as any).audiblePreview.getFloatTimeDomainData(samples);
        return Math.max(...samples.map(Math.abs));
      });
    await page.keyboard.down("z");
    await expect
      .poll(async () =>
        Number(await scope.locator("canvas").getAttribute("data-peak")),
      )
      .toBeGreaterThan(0.001);
    await expect.poll(audiblePeak).toBe(0);
    await page.getByRole("tab", { name: "Output", exact: true }).click();
    await expect(
      page.getByLabel("Preview volume", { exact: true }),
    ).toHaveValue("100");
    await expect(page.locator("#preview-mute")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.getByLabel("Preview volume", { exact: true }).fill("37");
    await page
      .getByLabel("Preview volume", { exact: true })
      .dispatchEvent("change");
    await expect
      .poll(
        async () =>
          (await (await request.get("/api/settings")).json()).settings
            .preview_volume,
      )
      .toBe(0.37);
    await expect.poll(audiblePeak).toBe(0);
    await page.locator("#preview-mute").click();
    await expect.poll(audiblePeak).toBeGreaterThan(0.001);
    await page.locator("#preview-mute").click();
    await expect.poll(audiblePeak).toBeLessThan(0.000001);
    await expect
      .poll(async () =>
        Number(await dock.locator("canvas").getAttribute("data-peak")),
      )
      .toBeGreaterThan(0.001);
    await page.keyboard.up("z");
    expect((await (await request.get("/api/state")).json()).session).toEqual(
      session,
    );
    const other = await browser.newContext();
    try {
      const phone = await other.newPage();
      await phone.setViewportSize({ width: 390, height: 844 });
      await phone.goto("/");
      await phone.getByRole("tab", { name: "Output", exact: true }).click();
      await expect(
        phone.getByLabel("Preview volume", { exact: true }),
      ).toHaveValue("37");
      await expect(phone.locator("#preview-mute")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await page.locator("#open-settings").click();
      await page.locator('[data-section="audio"]').click();
      await expect(
        page.getByRole("button", { name: "Local simulation", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      await page
        .getByRole("button", { name: "Local simulation", exact: true })
        .click();
      await page.waitForFunction(() => !(window as any).sontrama.audio.ready);
      await page.locator("#close-settings").click();
      await page
        .getByRole("tab", { name: "Visualizations", exact: true })
        .click();
      await expect(
        scope.getByRole("button", {
          name: "Enable local simulation",
          exact: true,
        }),
      ).toBeVisible();
      await page.getByRole("tab", { name: "Instrument", exact: true }).click();
      await dock
        .getByRole("button", { name: "Enable local simulation", exact: true })
        .click();
      await expect(dock.locator(".visual-simulation")).toBeHidden();
      await phone.reload();
      await expect(
        phone.getByLabel("Preview volume", { exact: true }),
      ).toHaveValue("37");
      await expect(phone.locator("#preview-mute")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(page.locator("[data-visual-source]")).toHaveCount(0);
      expect(
        await page.evaluate(() => (window as any).audioSubscriptions),
      ).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await other.close();
    }
  });
}

test("enabled simulation starts automatically and a suspended context offers a resume action", async ({
  page,
  request,
}) => {
  await request.patch("/api/session", {
    data: { instrument: "three-osc", effects: [], master_effects: [] },
  });
  await request.patch("/api/settings", {
    data: {
      interface: { language: "es" },
      browser_preview: true,
      preview_muted: true,
      preview_volume: 1,
      visualizations: {
        widgets: [{ id: "resume", kind: "spectrum", pinned: true }],
      },
    },
  });
  await page.goto("/");
  await page.getByRole("tab", { name: "Visualizaciones", exact: true }).click();
  await page.waitForFunction(() => (window as any).sontrama.audio.ready);
  await page.evaluate(() => (window as any).sontrama.audio.context.suspend());
  const widget = page.locator('.visual-widget[data-widget="resume"]');
  await expect(
    widget.getByText(
      "Reanudá la simulación local para ver esta visualización.",
    ),
  ).toBeVisible();
  await widget
    .getByRole("button", { name: "Reanudar simulación", exact: true })
    .click();
  await expect(widget.locator(".visual-simulation")).toBeHidden();
  expect(
    await page.evaluate(() => (window as any).sontrama.audio.context.state),
  ).toBe("running");
  const settings = (await (await request.get("/api/settings")).json()).settings;
  expect(settings.browser_preview).toBe(true);
  expect(settings.preview_muted).toBe(true);
});
