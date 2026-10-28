import { test, expect } from "./fixtures";

test("live tabs, persisted controls, ordered effects and responsive geometry", async ({
  page,
}) => {
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  await page.goto("/");
  await expect(page.locator("#connection")).toHaveText("Conectado");
  await expect(page.getByLabel("Sonido", { exact: true })).toContainText(
    "Piano",
  );
  const initial = await (await page.request.get("/api/state")).json();
  await expect(page.locator('input[type="checkbox"]')).toHaveCount(0);
  await page.getByRole("tab", { name: "Entradas", exact: true }).click();
  const midiToggle = page.getByRole("button", {
    name: "MIDI del servidor",
    exact: true,
  });
  await midiToggle.click();
  await expect(midiToggle).toHaveAttribute(
    "aria-pressed",
    String(!initial.session.usb_enabled),
  );
  await midiToggle.click();
  await expect(midiToggle).toHaveAttribute(
    "aria-pressed",
    String(initial.session.usb_enabled),
  );

  for (const name of [
    "Entradas",
    "Instrumento",
    "Efectos",
    "Mixer",
    "Salida",
  ]) {
    await page.getByRole("tab", { name, exact: true }).click();
    await expect(page.locator("[role=tabpanel]:visible")).toHaveCount(1);
  }
  await page.getByRole("tab", { name: "Instrumento", exact: true }).click();
  await page.getByLabel("Octava", { exact: true }).selectOption("1");
  await expect
    .poll(
      async () =>
        (await (await page.request.get("/api/state")).json()).session.octave,
    )
    .toBe(1);
  await page.reload();
  await expect(page.getByLabel("Octava", { exact: true })).toHaveValue("1");
  await page.getByLabel("Octava", { exact: true }).selectOption("0");
  await page.getByRole("tab", { name: "Efectos", exact: true }).click();
  const effectToggle = page
    .locator(".effect")
    .first()
    .locator("button[data-fx-enabled]");
  const originallyEnabled = initial.session.effects[0].enabled;
  await effectToggle.click();
  await expect(effectToggle).toHaveAttribute(
    "aria-pressed",
    String(!originallyEnabled),
  );
  await effectToggle.click();
  await expect(effectToggle).toHaveAttribute(
    "aria-pressed",
    String(originallyEnabled),
  );

  await page.getByLabel("Añadir efecto", { exact: true }).selectOption("gain");
  await expect(page.locator(".effect")).toHaveCount(
    initial.session.effects.length + 1,
  );
  await page.getByRole("button", { name: "Subir Gain", exact: true }).click();
  await expect(
    page.locator(".effect").nth(initial.session.effects.length - 1),
  ).toContainText("Gain");
  await page.getByRole("button", { name: "Quitar Gain", exact: true }).click();
  await expect(page.locator(".effect")).toHaveCount(
    initial.session.effects.length,
  );
  for (const width of [1440, 768, 320]) {
    await page.setViewportSize({ width, height: 1200 });
    for (const name of [
      "Entradas",
      "Instrumento",
      "Efectos",
      "Mixer",
      "Salida",
    ]) {
      await page.getByRole("tab", { name, exact: true }).click();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
    await page.getByRole("tab", { name: "Instrumento", exact: true }).click();
    await page.screenshot({
      path: `../experiments/sontrama-app-${width}.png`,
      fullPage: true,
    });
  }
  expect(failures).toEqual([]);
});

test("WASM Banks produces audio from PC and pointer keys, then releases notes", async ({
  page,
}) => {
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  await page.goto("/");
  await expect(page.locator("#connection")).toHaveText("Conectado");
  await page.getByRole("tab", { name: "Salida", exact: true }).click();
  await page
    .getByRole("button", { name: "Activar preview", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Preview activado", exact: true }),
  ).toHaveAttribute("aria-pressed", "true", { timeout: 30000 });
  await page.getByText("Teclado de prueba", { exact: true }).click();
  await expect(page.locator(".keyboard-head button")).toHaveCount(1);
  await page
    .getByRole("button", { name: "Capturar teclado", exact: true })
    .click();
  await page.keyboard.down("z");
  await expect(page.locator('[data-note="60"]')).toHaveClass(/held/);
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
  await page.keyboard.up("z");
  await expect(page.locator('[data-note="60"]')).not.toHaveClass(/held/);
  await page.keyboard.down("q");
  await expect(page.locator('[data-note="72"]')).toHaveClass(/held/);
  await page.keyboard.up("q");
  await page.keyboard.down("s");
  await expect(page.locator('[data-note="61"]')).toHaveClass(/held/);
  await page.keyboard.up("s");
  const key = page.getByRole("button", { name: "Do4", exact: true });
  await key.hover({ position: { x: 5, y: 110 } });
  await page.mouse.down();
  await expect(key).toHaveClass(/held/);
  await page.mouse.up();
  await expect(key).not.toHaveClass(/held/);
  await page
    .getByRole("button", { name: "Teclado capturado", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Capturar teclado", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
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
    .toBeLessThan(0.0001);
  expect(failures).toEqual([]);
});

test("browser preview leaves the main output unchanged and releases a disconnected source", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#connection")).toHaveText("Conectado");
  try {
    await page.getByRole("tab", { name: "Salida", exact: true }).click();
    await page
      .getByRole("button", { name: "Activar preview", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Preview activado", exact: true }),
    ).toHaveAttribute("aria-pressed", "true", { timeout: 30000 });
    expect(
      (await (await page.request.get("/api/state")).json()).session.output,
    ).toBe("device");
    await page.evaluate(async () => {
      const socket = new WebSocket(`ws://${location.host}/ws`);
      (window as any).testMidi = socket;
      await new Promise<void>((resolve) => {
        socket.onmessage = () => resolve();
      });
      socket.send(JSON.stringify({ type: "midi", data: [144, 64, 110] }));
    });
    const peak = () =>
      page.evaluate(() => {
        const analyser = (window as any).sontrama.audio
          .masterMeter as AnalyserNode;
        const samples = new Float32Array(256);
        analyser.getFloatTimeDomainData(samples);
        return Math.max(...samples.map(Math.abs));
      });
    await expect.poll(peak).toBeGreaterThan(0.001);
    await page.evaluate(() => (window as any).testMidi.close());
    await expect.poll(peak, { timeout: 10000 }).toBeLessThan(0.0001);
  } finally {
    await page.request.patch("/api/session", { data: { output: "device" } });
  }
});

test("browser audition falls back to the main-thread engine without AudioWorklet", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(AudioContext.prototype, "audioWorklet", {
      get: () => undefined,
    }),
  );
  await page.goto("/");
  await expect(page.locator("#connection")).toHaveText("Conectado");
  await page.getByRole("tab", { name: "Salida", exact: true }).click();
  await page
    .getByRole("button", { name: "Activar preview", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Preview activado", exact: true }),
  ).toBeVisible({ timeout: 30000 });
  await page.getByText("Teclado de prueba", { exact: true }).click();
  await page
    .getByRole("button", { name: "Capturar teclado", exact: true })
    .click();
  await page.keyboard.down("z");
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
  await page.keyboard.up("z");
});

test("PC rows continue across octaves and aliases share note lifetime", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#connection")).toHaveText("Conectado");
  await page.getByText("Teclado de prueba", { exact: true }).click();
  await page
    .getByRole("button", { name: "Capturar teclado", exact: true })
    .click();
  await expect(page.locator("#browser-preview")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await page.evaluate(async () => {
    const observer = new WebSocket(`ws://${location.host}/ws`);
    (window as any).midiLog = [];
    await new Promise<void>((resolve) => {
      observer.onmessage = () => resolve();
    });
    observer.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "midi") (window as any).midiLog.push(message.data);
    };
    (window as any).observer = observer;
  });
  await page.keyboard.down("q");
  await page.keyboard.down(",");
  await expect(page.locator('[data-note="72"]')).toHaveClass(/held/);
  await page.keyboard.up("q");
  await expect(page.locator('[data-note="72"]')).toHaveClass(/held/);
  expect(
    await page.evaluate(() =>
      (window as any).midiLog.some(
        (data: number[]) => data[0] === 128 && data[1] === 72,
      ),
    ),
  ).toBe(false);
  await page.keyboard.up(",");
  await expect(page.locator('[data-note="72"]')).not.toHaveClass(/held/);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).midiLog.filter(
            (data: number[]) => data[0] === 128 && data[1] === 72,
          ).length,
      ),
    )
    .toBe(1);
  for (const [key, note] of [
    [".", 74],
    ["/", 76],
    ["l", 73],
    [";", 75],
    ["i", 84],
    ["o", 86],
    ["p", 88],
    ["[", 89],
    ["]", 91],
    ["9", 85],
    ["0", 87],
    ["=", 90],
    ["\\", 93],
  ] as const) {
    await page.keyboard.down(key);
    await expect(page.locator(`[data-note="${note}"]`)).toHaveClass(/held/);
    await page.keyboard.up(key);
    await expect(page.locator(`[data-note="${note}"]`)).not.toHaveClass(/held/);
  }
  await page
    .getByRole("button", { name: "Teclado capturado", exact: true })
    .click();
  await page.keyboard.down("z");
  await expect(page.locator('[data-note="60"]')).not.toHaveClass(/held/);
  await page.keyboard.up("z");
  await page.evaluate(() => (window as any).observer.close());
});

test("capture and preview preferences survive reload and synchronize across browsers", async ({
  page,
  browser,
}) => {
  await page.goto("/");
  await expect(page.locator("#connection")).toHaveText("Conectado");
  await page.getByRole("tab", { name: "Salida", exact: true }).click();
  await page
    .getByRole("button", { name: "Activar preview", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Preview activado", exact: true }),
  ).toBeVisible({ timeout: 30000 });
  await page.getByText("Teclado de prueba", { exact: true }).click();
  await page
    .getByRole("button", { name: "Capturar teclado", exact: true })
    .click();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Teclado capturado", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".keyboard-drawer")).toHaveAttribute("open", "");
  await expect(
    page.getByRole("button", { name: "Preview activado", exact: true }),
  ).toHaveAttribute("aria-pressed", "true", { timeout: 30000 });
  await page.keyboard.down("z");
  await expect(page.locator('[data-note="60"]')).toHaveClass(/held/);
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
  await page.keyboard.up("z");
  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  await other.goto("/");
  await other.getByRole("tab", { name: "Salida", exact: true }).click();
  await expect(
    other.getByRole("button", { name: "Teclado capturado", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    other.getByRole("button", { name: "Preview activado", exact: true }),
  ).toBeVisible({ timeout: 30000 });
  await page
    .getByRole("button", { name: "Teclado capturado", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Preview activado", exact: true })
    .click();
  await page.reload();
  await expect(page.locator("#capture-keyboard")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(
    page.getByRole("button", { name: "Activar preview", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  expect(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("sontrama.preferences.v1")!),
    ),
  ).toEqual({ tab: "output" });
  await expect(other.locator("#capture-keyboard")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(
    other.getByRole("button", { name: "Activar preview", exact: true }),
  ).toBeVisible();
  await otherContext.close();
});

test("incoming MIDI highlights chords without browser preview and releases on disconnect", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#connection")).toHaveText("Conectado");
  await page.getByText("Teclado de prueba", { exact: true }).click();
  await page.evaluate(async () => {
    const socket = new WebSocket(
      `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`,
    );
    await new Promise<void>((resolve) =>
      socket.addEventListener("message", () => resolve(), { once: true }),
    );
    (window as any).midiTestSocket = socket;
    for (const note of [60, 64, 67])
      socket.send(JSON.stringify({ type: "midi", data: [0x93, note, 90] }));
  });
  for (const note of [60, 64, 67])
    await expect(page.locator(`[data-note="${note}"]`)).toHaveClass(/held/);
  await page.evaluate(() =>
    (window as any).midiTestSocket.send(
      JSON.stringify({ type: "midi", data: [0x93, 64, 0] }),
    ),
  );
  await expect(page.locator('[data-note="64"]')).not.toHaveClass(/held/);
  await expect(page.locator('[data-note="60"]')).toHaveClass(/held/);
  await page.evaluate(() => (window as any).midiTestSocket.close());
  await expect(page.locator(".piano .held")).toHaveCount(0);
});
