import { test, expect } from "./fixtures";

test("spectral settings persist, sync and use real 4096-sample server and preview windows", async ({
  page,
  browser,
  request,
}) => {
  await request.patch("/api/settings", {
    data: {
      interface: { language: "en" },
      visualizations: {
        widgets: [
          { id: "spectrum-settings", kind: "spectrum" },
          { id: "gram-settings", kind: "spectrogram" },
        ],
      },
    },
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
    (window as any).analysisWindows = [];
    WebSocket.prototype.send = function (data) {
      if (typeof data === "string") {
        const message = JSON.parse(data);
        if (message.type === "visualization_subscribe" && message.enabled)
          (window as any).analysisWindows.push(message.window_size);
      }
      return send.call(this, data);
    };
  });
  await page.goto("/");
  await page.getByRole("tab", { name: "Visualizations", exact: true }).click();
  const spectrum = page.locator(
    '.visual-widget[data-widget="spectrum-settings"]',
  );
  await spectrum.locator(".spectral-options > summary").click();
  await spectrum.getByLabel("FFT size", { exact: true }).selectOption("4096");
  await expect(spectrum.locator(".spectral-options")).toHaveAttribute(
    "open",
    "",
  );
  await expect(spectrum.locator("canvas")).toHaveAttribute(
    "data-fft-size",
    "4096",
  );
  expect(
    await page.evaluate(() => (window as any).analysisWindows.includes(4096)),
  ).toBe(true);
  await expect(spectrum.locator("[data-analysis-info]")).toContainText("4096");
  await spectrum
    .getByLabel("Window function", { exact: true })
    .selectOption("blackman");
  await spectrum
    .getByLabel("Frequency scale", { exact: true })
    .selectOption("linear");
  await spectrum
    .getByLabel("Minimum frequency (Hz)", { exact: true })
    .fill("100");
  await spectrum
    .getByLabel("Minimum frequency (Hz)", { exact: true })
    .press("Tab");
  await spectrum
    .getByLabel("Maximum frequency (Hz)", { exact: true })
    .fill("10000");
  await spectrum
    .getByLabel("Maximum frequency (Hz)", { exact: true })
    .press("Tab");
  await spectrum.getByLabel("Refresh rate", { exact: true }).selectOption("10");
  await spectrum.getByLabel("Smoothing", { exact: true }).selectOption("0.75");
  const gram = page.locator('.visual-widget[data-widget="gram-settings"]');
  await gram.locator(".spectral-options > summary").click();
  await gram
    .getByLabel("Scroll speed / time span", { exact: true })
    .selectOption("32");
  await expect(gram.locator("canvas")).toHaveAttribute(
    "data-history-seconds",
    "32",
  );
  const other = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  try {
    const phone = await other.newPage();
    await phone.goto("/");
    await phone
      .getByRole("tab", { name: "Visualizations", exact: true })
      .click();
    const shared = phone.locator(
      '.visual-widget[data-widget="spectrum-settings"]',
    );
    await shared.locator(".spectral-options > summary").click();
    await expect(shared.getByLabel("FFT size", { exact: true })).toHaveValue(
      "4096",
    );
    await expect(
      shared.getByLabel("Window function", { exact: true }),
    ).toHaveValue("blackman");
    await expect(
      shared.getByLabel("Frequency scale", { exact: true }),
    ).toHaveValue("linear");
    await expect(
      shared.getByLabel("Minimum frequency (Hz)", { exact: true }),
    ).toHaveValue("100");
    await expect(shared.getByLabel("Smoothing", { exact: true })).toHaveValue(
      "0.75",
    );
    expect(
      await phone.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.getByRole("tab", { name: "Output", exact: true }).click();
    await page
      .getByRole("button", { name: "Enable preview", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Preview enabled", exact: true }),
    ).toBeVisible();

    await page
      .getByRole("tab", { name: "Visualizations", exact: true })
      .click();
    await expect
      .poll(() => page.evaluate(() => (window as any).sontrama.audio.ready))
      .toBe(true);
    await page.evaluate(async () => {
      const socket = new WebSocket(`ws://${location.host}/ws`);
      await new Promise((resolve) =>
        socket.addEventListener("message", resolve, { once: true }),
      );
      (window as any).spectralInput = socket;
      socket.send(JSON.stringify({ type: "midi", data: [144, 69, 110] }));
    });
    await expect(spectrum.locator("canvas")).toHaveAttribute(
      "data-source",
      "preview",
    );
    await expect(spectrum.locator("canvas")).toHaveAttribute(
      "data-fft-size",
      "4096",
    );
    await expect
      .poll(async () =>
        Math.abs(
          Number(
            await spectrum.locator("canvas").getAttribute("data-frequency"),
          ) - 440,
        ),
      )
      .toBeLessThan(13);
    const rate = await page.evaluate(
      () => (window as any).sontrama.audio.context.sampleRate,
    );
    await expect(spectrum.locator("canvas")).toHaveAttribute(
      "data-sample-rate",
      String(rate),
    );
    const saved = (
      await (await request.get("/api/settings")).json()
    ).settings.visualizations.widgets.find(
      (widget: { id: string }) => widget.id === "spectrum-settings",
    ).spectral;
    expect(saved).toMatchObject({
      fft_size: 4096,
      window: "blackman",
      frequency_scale: "linear",
      frequency_min: 100,
      frequency_max: 10000,
      smoothing: 0.75,
      refresh_rate: 10,
    });
    await page.reload();
    await expect(spectrum.locator("canvas")).toHaveAttribute(
      "data-fft-size",
      "4096",
    );
  } finally {
    await page.evaluate(() => (window as any).spectralInput?.close());
    await other.close();
  }
});
