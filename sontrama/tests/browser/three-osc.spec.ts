import { expect, test } from "./fixtures";

for (const fallback of [false, true]) {
  test(`3 Osc sounds without SoundFonts, edits live and swaps engines (${fallback ? "fallback" : "worklet"})`, async ({
    page,
  }) => {
    const original = (await (await page.request.get("/api/state")).json())
      .session;
    const failures: string[] = [];
    page.on("pageerror", (error) => failures.push(error.message));
    if (fallback)
      await page.addInitScript(() =>
        Object.defineProperty(AudioContext.prototype, "audioWorklet", {
          get: () => undefined,
        }),
      );
    try {
      await page.goto("/");
      await expect(page.locator("#connection")).toHaveText("Conectado");
      await page.getByRole("tab", { name: "Instrumento", exact: true }).click();
      await page
        .getByRole("combobox", { name: "Instrumento", exact: true })
        .selectOption("three-osc");
      await expect(page.locator(".oscillator")).toHaveCount(3);
      await expect(page.getByLabel("Sonido", { exact: true })).toHaveCount(0);
      const fonts: string[] = [];
      page.on("request", (request) => {
        if (request.url().includes("/api/soundfonts/"))
          fonts.push(request.url());
      });
      await page.getByRole("tab", { name: "Salida", exact: true }).click();
      await page
        .getByRole("button", { name: "Activar preview", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "Preview activado", exact: true }),
      ).toBeVisible({ timeout: 30000 });
      expect(fonts).toEqual([]);
      await page.getByText("Teclado de prueba", { exact: true }).click();
      await page
        .getByRole("button", { name: "Capturar teclado", exact: true })
        .click();
      await page.keyboard.down("n");
      const peak = () =>
        page.evaluate(() => {
          const analyser = (window as any).sontrama.audio
            .masterMeter as AnalyserNode;
          const samples = new Float32Array(256);
          analyser.getFloatTimeDomainData(samples);
          return Math.max(...samples.map(Math.abs));
        });
      await expect.poll(peak).toBeGreaterThan(0.01);
      await page.getByRole("tab", { name: "Instrumento", exact: true }).click();
      await expect(
        page.getByRole("button", { name: /Invertir fase/ }),
      ).toHaveCount(0);
      await page
        .getByRole("slider", {
          name: "Fase inicial · oscilador 1",
          exact: true,
        })
        .evaluate((element: HTMLInputElement) => {
          element.value = "90";
          element.dispatchEvent(new Event("change", { bubbles: true }));
        });
      await expect
        .poll(
          async () =>
            (await (await page.request.get("/api/state")).json()).session
              .three_osc.oscillators[0].phase_start,
        )
        .toBe(90);
      await expect(page.locator('[data-note="69"]')).toHaveClass(/held/);

      await page
        .getByRole("button", { name: "Sierra · oscilador 1", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "Sierra · oscilador 1", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      const waveButtons = page.getByRole("group", {
        name: "Forma de onda · oscilador 1",
        exact: true,
      });
      await expect(
        waveButtons.locator('button[aria-pressed="true"]'),
      ).toHaveCount(1);
      const saw = page.getByRole("button", {
        name: "Sierra · oscilador 1",
        exact: true,
      });
      await saw.focus();
      await saw.press("ArrowRight");
      await expect(
        page.getByRole("button", {
          name: "Sierra redondeada · oscilador 1",
          exact: true,
        }),
      ).toHaveAttribute("aria-pressed", "true");
      await expect(
        waveButtons.locator('button[aria-pressed="true"]'),
      ).toHaveCount(1);
      await page
        .getByRole("button", {
          name: "Sierra redondeada · oscilador 1",
          exact: true,
        })
        .press("ArrowLeft");
      await expect(
        page.getByRole("button", { name: "Sierra · oscilador 1", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator('[data-note="69"]')).toHaveClass(/held/);
      await expect.poll(peak).toBeGreaterThan(0.01);
      await page.keyboard.up("n");
      await page
        .getByLabel("Semitonos · oscilador 2", { exact: true })
        .evaluate((element: HTMLInputElement) => {
          element.value = "12";
          element.dispatchEvent(new Event("change", { bubbles: true }));
        });
      await expect
        .poll(
          async () =>
            (await (await page.request.get("/api/state")).json()).session
              .three_osc.oscillators[1].coarse,
        )
        .toBe(12);
      await page
        .getByRole("button", { name: "AM del oscilador 3", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "AM del oscilador 3", exact: true }),
      ).toHaveAttribute("aria-pressed", String(!original.three_osc.am_osc3));
      await page.reload();
      await expect(
        page.getByRole("combobox", { name: "Instrumento", exact: true }),
      ).toHaveValue("three-osc");
      await expect(
        page.getByRole("button", { name: "Sierra · oscilador 1", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      await expect(
        page.getByLabel("Semitonos · oscilador 2", { exact: true }),
      ).toHaveValue("12");
      await expect(
        page.getByRole("slider", {
          name: "Fase inicial · oscilador 1",
          exact: true,
        }),
      ).toHaveValue("90");
      await expect
        .poll(() => page.evaluate(() => (window as any).sontrama.audio.ready))
        .toBe(true);
      await page
        .getByRole("combobox", { name: "Instrumento", exact: true })
        .selectOption("banks");
      await expect(page.getByLabel("Sonido", { exact: true })).toBeVisible();
      await expect.poll(() => fonts.length).toBeGreaterThan(0);
      await expect
        .poll(() => page.evaluate(() => (window as any).sontrama.audio.ready))
        .toBe(true);
      await page
        .getByRole("combobox", { name: "Instrumento", exact: true })
        .selectOption("three-osc");
      await expect(page.locator(".oscillator")).toHaveCount(3);
      await page.locator("h1").click();
      await page.keyboard.down("z");
      await expect.poll(peak).toBeGreaterThan(0.001);
      await page.keyboard.up("z");
      for (const width of [1440, 768, 320]) {
        await page.setViewportSize({ width, height: 1200 });
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        if (!fallback)
          await page.screenshot({
            path: `../experiments/sontrama-three-osc-${width}.png`,
            fullPage: true,
          });
      }
      expect(failures).toEqual([]);
    } finally {
      await page.request.patch("/api/session", { data: original });
    }
  });
}
