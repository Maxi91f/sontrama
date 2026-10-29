import { test, expect } from "./fixtures";

test("language changes sync across screens, preserve notes and localize dynamic controls", async ({
  page,
  browser,
  request,
}) => {
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  const phoneContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const phone = await phoneContext.newPage();
  try {
    await page.goto("/#settings/interface");
    await phone.goto("/");
    await expect(page.getByLabel("Idioma")).toHaveValue("es");
    await request.patch("/api/session", { data: { instrument: "three-osc" } });
    await phone.locator(".keyboard-drawer summary").click();
    await phone.locator('[data-note="60"]').focus();
    await phone.keyboard.down("Enter");
    await expect(phone.locator('[data-note="60"]')).toHaveClass(/held/);
    const pianoKey = await phone.locator('[data-note="60"]').elementHandle();
    await page.getByLabel("Idioma").selectOption("en");
    await expect(
      page.getByRole("heading", { name: "Settings", exact: true }),
    ).toBeVisible();
    await expect(phone.locator("html")).toHaveAttribute("lang", "en");
    await expect(
      phone.getByRole("tab", { name: "Instrument", exact: true }),
    ).toBeVisible();
    await expect(phone.getByLabel("Fine tuning · oscillator 1")).toBeVisible();
    await expect(
      phone.getByRole("button", { name: "Sine · oscillator 1", exact: true }),
    ).toBeVisible();
    expect(
      await pianoKey!.evaluate(
        (key) => key === document.querySelector('[data-note="60"]'),
      ),
    ).toBe(true);
    await expect(phone.locator('[data-note="60"]')).toHaveClass(/held/);
    await expect(phone.locator('[data-note="60"]')).toHaveAttribute(
      "aria-label",
      "C4",
    );
    await phone.keyboard.up("Enter");
    await expect(phone.locator('[data-note="60"]')).not.toHaveClass(/held/);
    await page.setViewportSize({ width: 320, height: 900 });
    for (const section of [
      "Interface",
      "Keyboard",
      "Audio",
      "MIDI",
      "Library",
    ]) {
      await page.getByRole("link", { name: section, exact: true }).click();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await phone.screenshot({
      path: "../experiments/sontrama-localization-en.png",
      fullPage: true,
    });
    await page.getByRole("link", { name: "Library", exact: true }).click();
    await page
      .getByLabel("SoundFont folders")
      .fill("/missing-localization-fonts");
    await page
      .getByRole("button", { name: "Save folders", exact: true })
      .click();
    await expect(page.locator("#settings-feedback")).toContainText(
      "Directory or SoundFont does not exist: /missing-localization-fonts",
    );
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await page.getByRole("link", { name: "Interface", exact: true }).click();
    await expect(page.getByLabel("Language")).toHaveValue("en");
    await page.getByLabel("Language").selectOption("es");
    await expect(
      phone.getByRole("tab", { name: "Instrumento", exact: true }),
    ).toBeVisible();
    await expect(
      phone.getByLabel("Afinación fina · oscilador 1"),
    ).toBeVisible();
    expect(failures).toEqual([]);
  } finally {
    await phoneContext.close();
  }
});
