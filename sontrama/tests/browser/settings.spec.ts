import { test, expect } from "./fixtures";

test("settings preserves the Live session and pauses PC keyboard capture", async ({
  page,
}) => {
  await page.request.patch("/api/settings", {
    data: { keyboard: { capture: true } },
  });
  await page.addInitScript(() => {
    if (!localStorage.getItem("sontrama.preferences.v1"))
      localStorage.setItem(
        "sontrama.preferences.v1",
        JSON.stringify({
          tab: "mixer",
          captureKeyboard: true,
          previewEnabled: false,
        }),
      );
  });
  await page.goto("/");
  await expect(page.locator("#connection")).toHaveText("Conectado");
  const before = (await (await page.request.get("/api/state")).json()).session;
  await expect(
    page.getByRole("tab", { name: "Mixer", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.keyboard.down("z");
  await expect(page.locator('[data-note="60"]')).toHaveClass(/held/);
  await page
    .getByRole("button", { name: "Configuración", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Configuración", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#live-view")).toBeHidden();
  await expect(page.locator(".piano .held")).toHaveCount(0);
  await page.keyboard.up("z");
  await page.keyboard.down("x");
  await expect(page.locator(".piano .held")).toHaveCount(0);
  await page.keyboard.up("x");
  await expect(
    page
      .getByRole("navigation", { name: "Secciones de configuración" })
      .getByRole("link", { name: "Interfaz" }),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.getByLabel("Idioma").locator("option")).toHaveText([
    "Español",
    "English",
  ]);
  await page.getByLabel("Idioma").selectOption("es");
  expect(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("sontrama.preferences.v1")!),
    ),
  ).toEqual({ tab: "mixer" });
  expect(
    (await (await page.request.get("/api/settings")).json()).settings.keyboard
      .capture,
  ).toBe(true);
  expect((await (await page.request.get("/api/state")).json()).session).toEqual(
    before,
  );
  await page.reload();
  await expect(page.getByLabel("Idioma")).toHaveValue("es");
  await page.getByRole("button", { name: "← Volver", exact: true }).click();
  await expect(page.locator("#settings-view")).toBeHidden();
  await expect(
    page.getByRole("tab", { name: "Mixer", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("button", { name: "Configuración", exact: true }),
  ).toBeFocused();
  await page.keyboard.down("z");
  await expect(page.locator('[data-note="60"]')).toHaveClass(/held/);
  await page.keyboard.up("z");
});

test("settings navigation reflows above its content on small screens", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Configuración", exact: true })
    .click();
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByLabel("Idioma")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const nav = (await page.locator(".settings-nav").boundingBox())!;
    const content = (await page.locator(".settings-content").boundingBox())!;
    if (width <= 390)
      expect(nav.y + nav.height).toBeLessThanOrEqual(content.y + 1);
    else expect(nav.x + nav.width).toBeLessThanOrEqual(content.x + 1);
  }
  await page.goBack();
  await expect(page.locator("#settings-view")).toBeHidden();
});

test("keyboard and interface settings synchronize with a phone and saved feedback is a short toast", async ({
  page,
  browser,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/#settings/keyboard");
  await expect(
    page.getByRole("slider", { name: "Velocidad fija", exact: true }),
  ).toBeVisible();
  const phoneContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const phone = await phoneContext.newPage();
  try {
    await phone.goto("/#settings/keyboard");
    await page
      .getByRole("slider", { name: "Velocidad fija", exact: true })
      .fill("75");
    await page
      .getByRole("slider", { name: "Velocidad fija", exact: true })
      .dispatchEvent("change");
    await expect(
      phone.getByRole("slider", { name: "Velocidad fija", exact: true }),
    ).toHaveValue("75");
    await page.getByLabel("Etiquetas del teclado").selectOption("notes");
    await expect(phone.getByLabel("Etiquetas del teclado")).toHaveValue(
      "notes",
    );
    await expect(page.locator(".settings-toast")).toHaveText(
      "Configuración guardada",
    );
    await expect(page.locator(".settings-toast")).toBeVisible();
    const toast = (await page.locator(".settings-toast").boundingBox())!;
    expect(toast.y + toast.height).toBeGreaterThan(
      (await page.locator(".bottom-dock").boundingBox())!.y - 60,
    );
    await expect(page.locator(".settings-toast")).toBeHidden({ timeout: 3500 });
    await phone.reload();
    await expect(
      phone.getByRole("slider", { name: "Velocidad fija", exact: true }),
    ).toHaveValue("75");
    await page.getByRole("link", { name: "Interfaz", exact: true }).click();
    await phone.getByRole("link", { name: "Interfaz", exact: true }).click();
    await page.getByLabel("Animaciones").selectOption("reduced");
    await expect(phone.getByLabel("Animaciones")).toHaveValue("reduced");
    await expect(phone.locator("html")).toHaveAttribute(
      "data-motion",
      "reduced",
    );
    await page.getByRole("button", { name: "← Volver", exact: true }).click();
    await expect(page.locator('[data-note="62"] span')).toHaveText("Re4");
    await page.evaluate(async () => {
      const observer = new WebSocket(`ws://${location.host}/ws`);
      await new Promise((resolve) =>
        observer.addEventListener("message", resolve, { once: true }),
      );
      (window as any).settingsMidi = [];
      observer.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "midi")
          (window as any).settingsMidi.push(message.data);
      };
      (window as any).settingsObserver = observer;
    });
    await page
      .getByRole("button", { name: "Capturar teclado", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Teclado capturado", exact: true }),
    ).toBeVisible();
    await page.keyboard.down("z");
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as any).settingsMidi.some(
            (data: number[]) =>
              data[0] === 0x90 && data[1] === 60 && data[2] === 75,
          ),
        ),
      )
      .toBe(true);
    await page.keyboard.up("z");
    await page.evaluate(() => (window as any).settingsObserver.close());
    expect(errors).toEqual([]);
  } finally {
    await phoneContext.close();
  }
});

test("audio and library forms validate, persist and remain responsive", async ({
  page,
}) => {
  await page.goto("/#settings/audio");
  await page.getByLabel("Frecuencia de muestreo").selectOption("48000");
  await page.getByLabel("Tamaño de buffer").selectOption("512");
  await page
    .getByRole("button", { name: "Aplicar audio", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await (await page.request.get("/api/settings")).json()).settings.audio
          .sample_rate,
    )
    .toBe(48000);
  await page.reload();
  await expect(page.getByLabel("Tamaño de buffer")).toHaveValue("512");
  await page.getByRole("link", { name: "Biblioteca", exact: true }).click();
  const original = await page.getByLabel("Carpetas de SoundFonts").inputValue();
  await page
    .getByLabel("Carpetas de SoundFonts")
    .fill("/nonexistent-sontrama-test-library");
  await page
    .getByRole("button", { name: "Guardar carpetas", exact: true })
    .click();
  await expect(page.locator("#settings-feedback")).toHaveAttribute(
    "role",
    "alert",
  );
  await expect(page.locator("#settings-feedback")).toContainText("No existe");
  await page.getByLabel("Carpetas de SoundFonts").fill(original);
  await page
    .getByRole("button", { name: "Guardar carpetas", exact: true })
    .click();
  await expect(page.locator(".settings-toast")).toBeVisible();
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const name of ["Interfaz", "Teclado", "Audio", "MIDI", "Biblioteca"]) {
      await page.getByRole("link", { name, exact: true }).click();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
  }
});

test("MIDI device controls change the actual routing and velocity curve", async ({
  page,
}) => {
  await page.goto("/#settings/midi");
  await page.evaluate(async () => {
    const controller = new WebSocket(`ws://${location.host}/ws`);
    await new Promise((resolve) =>
      controller.addEventListener("message", resolve, { once: true }),
    );
    (window as any).controllerEvents = [];
    controller.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "midi")
        (window as any).controllerEvents.push(message.data);
    };
    (window as any).controller = controller;
    controller.send(
      JSON.stringify({ type: "midi_devices", names: ["UI Test Keyboard"] }),
    );
  });
  const curve = page.getByRole("combobox", {
    name: "Curva de velocidad · UI Test Keyboard",
    exact: true,
  });
  const device = page.locator('[data-midi-device="browser:UI Test Keyboard"]');
  try {
    await expect(curve).toBeVisible();
    await curve.selectOption("soft");
    await expect
      .poll(
        async () =>
          (await (await page.request.get("/api/settings")).json()).settings.midi
            .devices["browser:UI Test Keyboard"].velocity_curve,
      )
      .toBe("soft");
    await page.evaluate(() =>
      (window as any).controller.send(
        JSON.stringify({
          type: "midi",
          controller: "UI Test Keyboard",
          data: [0x90, 60, 64],
        }),
      ),
    );
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as any).controllerEvents.some(
            (data: number[]) =>
              data[0] === 0x90 && data[1] === 60 && data[2] === 90,
          ),
        ),
      )
      .toBe(true);
    await expect(page.locator('[data-note="60"]')).toHaveClass(/held/);
    await device
      .getByRole("button", { name: "Conectar automáticamente", exact: true })
      .click();
    await expect(
      device.getByRole("button", {
        name: "Conectar automáticamente",
        exact: true,
      }),
    ).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator(".piano .held")).toHaveCount(0);
    await curve.selectOption("hard");
    await expect
      .poll(
        async () =>
          (await (await page.request.get("/api/settings")).json()).settings.midi
            .devices["browser:UI Test Keyboard"].velocity_curve,
      )
      .toBe("hard");
    await device
      .getByRole("button", { name: "Conectar automáticamente", exact: true })
      .click();
    await expect(
      device.getByRole("button", {
        name: "Conectar automáticamente",
        exact: true,
      }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.evaluate(() =>
      (window as any).controller.send(
        JSON.stringify({
          type: "midi",
          controller: "UI Test Keyboard",
          data: [0x90, 62, 64],
        }),
      ),
    );
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as any).controllerEvents.some(
            (data: number[]) =>
              data[0] === 0x90 && data[1] === 62 && data[2] === 32,
          ),
        ),
      )
      .toBe(true);
  } finally {
    await page.evaluate(() => (window as any).controller.close());
  }
});
