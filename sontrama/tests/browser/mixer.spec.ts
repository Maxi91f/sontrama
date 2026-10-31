import { test, expect, setSimulation } from "./fixtures";

test("channel selector edits one bus, syncs controls and processes master audio", async ({
  page,
  browser,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await request.patch("/api/settings", {
    data: { interface: { language: "en" } },
  });
  await request.patch("/api/session", {
    data: { instrument: "three-osc", effects: [], master_effects: [] },
  });
  const phoneContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const phone = await phoneContext.newPage();
  try {
    await page.goto("/");
    await phone.goto("/");
    await page.getByRole("tab", { name: "Output", exact: true }).click();
    await setSimulation(page, true);
    await page.waitForFunction(() => (window as any).sontrama.audio.ready);
    for (const screen of [page, phone])
      await screen.getByRole("tab", { name: "Mixer", exact: true }).click();
    await expect(page.getByRole("tab")).toHaveCount(5);
    await expect(page.locator(".channel-card")).toHaveCount(2);
    await expect(
      page.locator(
        ".channel-selector input, .channel-selector select, button button",
      ),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Mute · Master", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Edit Channel 01", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      phone.getByRole("button", { name: "Mute · Master", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await page
      .getByRole("button", { name: "Mute · Master", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Mute · Master", exact: true }),
    ).toHaveAttribute("aria-pressed", "false");
    const before = (await (await request.get("/api/state")).json()).session;
    await page
      .getByRole("button", { name: "Edit Master", exact: true })
      .click();
    expect((await (await request.get("/api/state")).json()).session).toEqual(
      before,
    );
    await expect(page.locator(".mixer-editor")).toHaveCount(1);
    await expect(page.locator(".mixer-editor")).toHaveAttribute(
      "data-bus",
      "master",
    );
    await page.getByRole("button", { name: "Add effect", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Gain", exact: false })
      .click();
    await page.getByLabel("Gain Gain", { exact: true }).fill("-12");
    await page.getByLabel("Gain Gain", { exact: true }).dispatchEvent("change");
    await expect
      .poll(
        async () =>
          (await (await request.get("/api/state")).json()).session
            .master_effects[0]?.value,
      )
      .toBe(-12);
    await expect(
      page.locator('[data-summary="master"] .card-stats'),
    ).toContainText("1");
    await page.getByLabel("Pan · Master", { exact: true }).fill("1");
    await page
      .getByLabel("Pan · Master", { exact: true })
      .dispatchEvent("change");
    await expect(
      phone.locator('[data-summary="master"] [data-summary-pan]'),
    ).toHaveText("100% R");
    await page.evaluate(async () => {
      const socket = new WebSocket(
        `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`,
      );
      await new Promise((resolve) =>
        socket.addEventListener("message", resolve, { once: true }),
      );
      (window as any).mixerSource = socket;
      socket.send(JSON.stringify({ type: "midi", data: [0x90, 60, 100] }));
    });
    await expect
      .poll(() =>
        page.evaluate(() => {
          const audio = (window as any).sontrama.audio;
          const peaks = audio.masterStereo.map((analyser: AnalyserNode) => {
            const samples = new Float32Array(256);
            analyser.getFloatTimeDomainData(samples);
            return Math.max(...samples.map(Math.abs));
          });
          const channelPeaks = audio.channelStereo.map(
            (analyser: AnalyserNode) => {
              const samples = new Float32Array(256);
              analyser.getFloatTimeDomainData(samples);
              return Math.max(...samples.map(Math.abs));
            },
          );
          const ratio = peaks[1] / (channelPeaks[0] + channelPeaks[1]);
          return (
            peaks[0] < 1e-6 && peaks[1] > 0.001 && ratio > 0.2 && ratio < 0.225
          );
        }),
      )
      .toBe(true);
    await expect
      .poll(async () =>
        Number(
          await page
            .locator('[data-summary="master"] [data-meter-side="right"]')
            .getAttribute("aria-valuenow"),
        ),
      )
      .toBeGreaterThan(0);
    await page
      .getByRole("button", { name: "Mute · Master", exact: true })
      .click();
    await expect
      .poll(async () =>
        Number(
          await page
            .locator('[data-summary="master"] [data-meter-side="right"]')
            .getAttribute("aria-valuenow"),
        ),
      )
      .toBe(0);
    await expect
      .poll(async () =>
        Number(
          await page
            .locator('[data-summary="channel"] [data-meter-side="right"]')
            .getAttribute("aria-valuenow"),
        ),
      )
      .toBeGreaterThan(0);
    await page
      .getByRole("button", { name: "Mute · Master", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Edit Channel 01", exact: true })
      .click();
    await expect(page.locator(".effect")).toHaveCount(0);
    await page.getByRole("button", { name: "Add effect", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Filter", exact: false })
      .click();
    const state = (await (await request.get("/api/state")).json()).session;
    await expect
      .poll(
        async () =>
          (await (await request.get("/api/state")).json()).session.effects
            .length,
      )
      .toBe(1);
    expect(state.master_effects[0].kind).toBe("gain");
    await page
      .getByRole("button", { name: "Edit Master", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Remove Gain", exact: true })
      .click();
    await expect(page.locator(".effect")).toHaveCount(0);
    for (const width of [1440, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const name of ["Channel 01", "Master"]) {
        await page
          .getByRole("button", { name: `Edit ${name}`, exact: true })
          .click();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await expect(page.locator(".mixer-editor")).toHaveCount(1);
      }
    }
    await page.reload();
    await expect(
      page.locator('[data-summary="master"] [data-summary-pan]'),
    ).toHaveText("100% R");
    expect(errors).toEqual([]);
  } finally {
    await page.evaluate(() => (window as any).mixerSource?.close());
    await phoneContext.close();
  }
});

test("effect picker stays beside the chain heading and supports modal keyboard navigation", async ({
  page,
  request,
}) => {
  await request.patch("/api/settings", {
    data: { interface: { language: "en" }, keyboard: { capture: true } },
  });
  await page.goto("/");
  await page.getByRole("tab", { name: "Mixer", exact: true }).click();
  const before = (await (await request.get("/api/state")).json()).session
    .effects;
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const add = page.getByRole("button", { name: "Add effect", exact: true });
    const heading = await page.locator(".chain-caption").boundingBox();
    const trigger = await add.boundingBox();
    expect(trigger!.x).toBeGreaterThanOrEqual(heading!.x + heading!.width);
    await add.click();
    const dialog = page.getByRole("dialog", {
      name: "Add effect",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button")).toHaveCount(7);
    await page.keyboard.press("z");
    await expect(page.locator(".piano .held")).toHaveCount(0);
    await page.keyboard.press("Tab");
    expect(
      await dialog.evaluate((element) =>
        element.contains(document.activeElement),
      ),
    ).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    if (width === 320)
      await page.screenshot({
        path: "../experiments/mixer/effect-dialog-mobile.png",
        fullPage: true,
      });
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(add).toBeFocused();
  }
  expect(
    (await (await request.get("/api/state")).json()).session.effects,
  ).toEqual(before);
});

test("stereo meters hold peaks, latch overloads and reset when switching sources", async ({
  page,
  request,
}) => {
  await request.patch("/api/settings", {
    data: { interface: { language: "en" } },
  });
  await request.patch("/api/session", {
    data: {
      instrument: "three-osc",
      volume: 1,
      master: 0.01,
      effects: [{ id: "meter-gain", kind: "gain", enabled: true, value: 24 }],
      master_effects: [],
    },
  });
  await page.goto("/");
  await page.getByRole("tab", { name: "Output", exact: true }).click();
  await setSimulation(page, true);
  await page.getByRole("tab", { name: "Mixer", exact: true }).click();
  const channel = page.locator(
    '[data-summary="channel"] [data-meter-side="left"]',
  );
  const master = page.locator(
    '[data-summary="master"] [data-meter-side="left"]',
  );
  const editor = page.locator('.mixer-editor [data-meter-side="left"]');
  await page.evaluate(async () => {
    const socket = new WebSocket(`ws://${location.host}/ws`);
    await new Promise((resolve) =>
      socket.addEventListener("message", resolve, { once: true }),
    );
    (window as any).meterSource = socket;
    socket.send(JSON.stringify({ type: "midi", data: [0x90, 60, 127] }));
  });
  try {
    await expect(channel).toHaveAttribute("data-clipping", "true");
    await expect(editor).toHaveAttribute("data-clipping", "true");
    await expect(master).toHaveAttribute("data-clipping", "false");
    await expect(channel).toHaveAttribute("data-source", "preview");
    await expect(channel).toHaveAttribute("aria-valuetext", /dBFS.*Full scale/);
    for (const width of [1240, 320]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
    await page.setViewportSize({ width: 1240, height: 900 });
    await page.screenshot({
      path: "../experiments/meters/overload.png",
      fullPage: true,
    });
    await page.evaluate(() =>
      (window as any).meterSource.send(
        JSON.stringify({ type: "midi", data: [0x80, 60, 0] }),
      ),
    );
    await expect
      .poll(async () => {
        const level = Number(await channel.getAttribute("data-level-db"));
        const peak = Number(await channel.getAttribute("data-peak-db"));
        return peak - level;
      })
      .toBeGreaterThan(12);
    const held = Number(await channel.getAttribute("data-peak-db"));
    await expect
      .poll(async () => Number(await channel.getAttribute("data-peak-db")))
      .toBeLessThan(held - 5);
    await expect(channel).toHaveAttribute("data-clipping", "false");
    await page.getByRole("tab", { name: "Output", exact: true }).click();
    await setSimulation(page, false);
    await page.getByRole("tab", { name: "Mixer", exact: true }).click();
    await expect(channel).toHaveAttribute("data-source", "preview");
    await expect(channel).toHaveAttribute("data-peak-db", "-60.00");
    await expect(channel).toHaveAttribute("data-clipping", "false");
  } finally {
    await page.evaluate(() => (window as any).meterSource?.close());
  }
});
