import { test, expect, setSimulation } from "./fixtures";
const kinds = [
  "spectrogram",
  "vectorscope",
  "correlation",
  "tuner",
  "midi",
  "vu",
] as const;

test("new views render real preview audio and MIDI, share pause and persist VU display mode", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await request.patch("/api/settings", {
    data: {
      interface: { language: "en" },
      visualizations: {
        collapsed: false,
        widgets: kinds.map((kind) => ({
          id: kind,
          kind,
          width: 1,
          height: 160,
          pinned: true,
          dock_width: 300,
        })),
      },
    },
  });
  await request.patch("/api/session", {
    data: {
      instrument: "three-osc",
      effects: [],
      master_effects: [],
      octave: 0,
      volume: 0.7,
      master: 0.7,
    },
  });
  await page.setViewportSize({ width: 1600, height: 1700 });
  await page.goto("/");
  await page.getByRole("tab", { name: "Visualizations", exact: true }).click();
  await page.locator('[data-visual-action="picker"]').click();
  const picker = page.getByRole("dialog");
  await expect(picker.locator("[data-kind]")).toHaveCount(8);
  await picker.locator('[data-kind="tuner"]').click();
  await expect(page.locator(".visual-widget")).toHaveCount(7);
  await page
    .locator(".visual-widget")
    .last()
    .getByRole("button", { name: "Remove visualization", exact: true })
    .click();
  await expect(page.locator(".visual-widget")).toHaveCount(6);
  await page.getByRole("tab", { name: "Output", exact: true }).click();
  await setSimulation(page, true);
  await page.getByRole("tab", { name: "Visualizations", exact: true }).click();
  await page.evaluate(async () => {
    const socket = new WebSocket(`ws://${location.host}/ws`);
    await new Promise((resolve) =>
      socket.addEventListener("message", resolve, { once: true }),
    );
    (window as any).visualInput = socket;
    socket.send(JSON.stringify({ type: "midi", data: [0x90, 69, 110] }));
  });
  const widget = (kind: string) =>
    page.locator(`.visual-widget[data-widget="${kind}"]`);
  const canvas = (kind: string) => widget(kind).locator("canvas");
  try {
    await expect
      .poll(async () =>
        Math.abs(
          Number(await canvas("tuner").getAttribute("data-frequency")) - 440,
        ),
      )
      .toBeLessThan(2);
    await expect(canvas("tuner")).toHaveAttribute("data-note", "69");
    await expect
      .poll(async () =>
        Math.abs(Number(await canvas("tuner").getAttribute("data-cents"))),
      )
      .toBeLessThan(5);
    await expect
      .poll(async () =>
        Number(await canvas("correlation").getAttribute("data-correlation")),
      )
      .toBeGreaterThan(0.98);
    await expect
      .poll(async () =>
        Number(await canvas("vectorscope").getAttribute("data-peak")),
      )
      .toBeGreaterThan(0.01);
    await expect(canvas("spectrogram")).toHaveAttribute(
      "data-history-columns",
      "160",
    );
    await expect(canvas("midi")).toHaveAttribute("data-active-notes", "1");
    await expect(canvas("midi")).toHaveAttribute("aria-label", /Note on.*A4/);
    await expect(
      widget("midi").getByLabel("Signal", { exact: true }),
    ).toHaveCount(0);
    await expect(canvas("vu")).toHaveAttribute("data-meter-style", "bars");
    await widget("vu")
      .getByRole("button", { name: "Meter display mode", exact: true })
      .click();
    await expect(canvas("vu")).toHaveAttribute("data-meter-style", "needle");
    await expect
      .poll(async () => Number(await canvas("vu").getAttribute("data-vu")))
      .toBeGreaterThan(-20);
    const pinned = page.locator('.dock-visual[data-widget="vu"]');
    await expect(pinned.locator("canvas")).toHaveAttribute(
      "data-meter-style",
      "needle",
    );
    expect(
      (
        await (await request.get("/api/settings")).json()
      ).settings.visualizations.widgets.find(
        (item: { id: string }) => item.id === "vu",
      ).meter_style,
    ).toBe("needle");
    await pinned
      .getByRole("button", { name: "Meter display mode", exact: true })
      .click();
    await expect(canvas("vu")).toHaveAttribute("data-meter-style", "bars");
    await expect
      .poll(() =>
        page
          .locator(".dock-panel")
          .evaluateAll(
            (items) =>
              new Set(items.map((item) => item.getBoundingClientRect().top))
                .size,
          ),
      )
      .toBe(1);
    await request.patch("/api/session", {
      data: {
        effects: [
          { id: "vu-overload", kind: "gain", value: 24, enabled: true },
          { id: "vu-overload-extra", kind: "gain", value: 12, enabled: true },
        ],
      },
    });
    await expect(canvas("vu")).toHaveAttribute("data-clipping", "true");
    await expect(pinned.locator("canvas")).toHaveAttribute(
      "data-clipping",
      "true",
    );
    await request.patch("/api/session", { data: { effects: [] } });
    await page.evaluate(() =>
      (window as any).visualInput.send(
        JSON.stringify({ type: "midi", data: [0x80, 69, 0] }),
      ),
    );
    await expect(canvas("midi")).toHaveAttribute("data-active-notes", "0");
    await expect
      .poll(async () =>
        Number(await canvas("tuner").getAttribute("data-frequency")),
      )
      .toBe(0);
    await page.evaluate(() => {
      for (const data of [
        [0xb0, 1, 99],
        [0xe0, 0, 80],
      ])
        (window as any).visualInput.send(
          JSON.stringify({ type: "midi", data }),
        );
    });
    await expect(canvas("midi")).toHaveAttribute(
      "aria-label",
      /Pitch bend.*2048/,
    );
    await widget("midi")
      .getByRole("button", { name: "Clear", exact: true })
      .click();
    await expect(canvas("midi")).toHaveAttribute("data-event-count", "0");
    await widget("midi")
      .getByRole("button", { name: "Pause", exact: true })
      .click();
    await page.evaluate(() =>
      (window as any).visualInput.send(
        JSON.stringify({ type: "midi", data: [0xb0, 74, 127] }),
      ),
    );
    await expect(canvas("midi")).toHaveAttribute("data-event-count", "0");
    await widget("midi")
      .getByRole("button", { name: "Pause", exact: true })
      .click();
    await expect(canvas("midi")).toHaveAttribute("data-event-count", "1");
    for (const width of [320, 768, 1400]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
    await page.setViewportSize({ width: 1600, height: 2000 });
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({
      path: "../experiments/visuals/new-visualizations.png",
      fullPage: true,
    });
    expect(errors).toEqual([]);
  } finally {
    await page.evaluate(() => (window as any).visualInput?.close());
  }
});

test("MIDI-only monitor receives events without requesting server audio frames", async ({
  page,
  request,
}) => {
  await request.patch("/api/settings", {
    data: {
      interface: { language: "en" },
      browser_preview: false,
      visualizations: { widgets: [{ id: "midi-only", kind: "midi" }] },
    },
  });
  await page.addInitScript(() => {
    const send = WebSocket.prototype.send;
    (window as any).subscriptions = [];
    WebSocket.prototype.send = function (data) {
      if (typeof data === "string") {
        const event = JSON.parse(data);
        if (event.type === "visualization_subscribe")
          (window as any).subscriptions.push(event.enabled);
      }
      return send.call(this, data);
    };
  });
  await page.goto("/");
  await page.getByRole("tab", { name: "Visualizations", exact: true }).click();
  await page.evaluate(async () => {
    const socket = new WebSocket(`ws://${location.host}/ws`);
    await new Promise((resolve) =>
      socket.addEventListener("message", resolve, { once: true }),
    );
    (window as any).midiOnlySource = socket;
    socket.send(JSON.stringify({ type: "midi", data: [0xb0, 1, 90] }));
  });
  await expect(page.locator(".visual-widget canvas")).toHaveAttribute(
    "aria-label",
    /CC.*#1 = 90/,
  );
  await page.evaluate(() => {
    for (let value = 0; value < 80; value++)
      (window as any).midiOnlySource.send(
        JSON.stringify({ type: "midi", data: [0xb0, 21, value] }),
      );
  });
  await expect(page.locator(".visual-widget canvas")).toHaveAttribute(
    "data-event-count",
    "64",
  );
  await expect(page.locator(".visual-widget canvas")).toHaveAttribute(
    "aria-label",
    /CC.*#21 = 79/,
  );
  expect(
    await page.evaluate(() => (window as any).subscriptions.includes(true)),
  ).toBe(false);
  await page.evaluate(() => (window as any).midiOnlySource.close());
});
