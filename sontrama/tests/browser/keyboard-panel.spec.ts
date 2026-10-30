import { test, expect } from "./fixtures";

test("panel pointer glissando releases each key and octave shifts leave PC keys unchanged", async ({
  page,
  request,
}) => {
  await request.patch("/api/settings", {
    data: {
      interface: { language: "en" },
      keyboard: { capture: true, panel_octave: 0 },
      visualizations: { collapsed: false, keyboard_width: 600 },
    },
  });
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto("/");
  await page.evaluate(async () => {
    const socket = new WebSocket(`ws://${location.host}/ws`);
    await new Promise((resolve) =>
      socket.addEventListener("message", resolve, { once: true }),
    );
    (window as any).panelSource = socket;
    (window as any).panelMidi = [];
    socket.onmessage = ({ data }) => {
      const event = JSON.parse(data);
      if (event.type === "midi")
        (window as any).panelMidi.push([event.data[0] & 0xf0, event.data[1]]);
    };
  });
  try {
    const key = (note: number) => page.locator(`.piano [data-note="${note}"]`);
    const c = (await key(60).boundingBox())!,
      d = (await key(62).boundingBox())!,
      sharp = (await key(61).boundingBox())!,
      e = (await key(64).boundingBox())!;
    await page.mouse.move(c.x + 14, c.y + 85);
    await page.mouse.down();
    await expect(key(60)).toHaveClass(/held/);
    await page.mouse.move(d.x + 14, d.y + 85);
    await expect(key(60)).not.toHaveClass(/held/);
    await expect(key(62)).toHaveClass(/held/);
    await page.mouse.move(sharp.x + 8, sharp.y + 20);
    await expect(key(62)).not.toHaveClass(/held/);
    await expect(key(61)).toHaveClass(/held/);
    await page.mouse.move(c.x + 14, c.y - 20);
    await expect(page.locator(".piano .held")).toHaveCount(0);
    await page.mouse.move(e.x + 14, e.y + 85);
    await expect(key(64)).toHaveClass(/held/);
    await page.mouse.up();
    await expect(page.locator(".piano .held")).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => (window as any).panelMidi))
      .toEqual([
        [144, 60],
        [128, 60],
        [144, 62],
        [128, 62],
        [144, 61],
        [128, 61],
        [144, 64],
        [128, 64],
      ]);
    await page.evaluate(() => ((window as any).panelMidi = []));
    await page.keyboard.down("z");
    await expect
      .poll(() => page.evaluate(() => (window as any).panelMidi))
      .toEqual([[144, 60]]);
    await page
      .getByRole("button", { name: "Panel octave up", exact: true })
      .click();
    await expect(page.locator("#keyboard-octave-value")).toHaveText("C5");
    expect(await page.evaluate(() => (window as any).panelMidi)).toEqual([
      [144, 60],
    ]);
    await page.keyboard.up("z");
    await expect
      .poll(() => page.evaluate(() => (window as any).panelMidi))
      .toEqual([
        [144, 60],
        [128, 60],
      ]);
    await key(72).click({ position: { x: 12, y: 85 } });
    await expect
      .poll(() => page.evaluate(() => (window as any).panelMidi.slice(-2)))
      .toEqual([
        [144, 72],
        [128, 72],
      ]);
    await page.reload();
    await expect(page.locator("#keyboard-octave-value")).toHaveText("C5");
  } finally {
    await page.evaluate(() => (window as any).panelSource?.close());
  }
});

test("keyboard resizing reveals fixed-size keys and many dock panels never wrap", async ({
  page,
  request,
}) => {
  await request.patch("/api/settings", {
    data: {
      interface: { language: "en" },
      keyboard: { panel_octave: 0 },
      visualizations: { keyboard_width: 600, collapsed: false },
    },
  });
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto("/");
  const keyboard = page.locator(".dock-keyboard");
  const count = () =>
    keyboard.locator(".piano .white").evaluateAll((keys) => {
      const clip = document
        .querySelector(".piano-viewport")!
        .getBoundingClientRect();
      return keys.filter((key) => {
        const box = key.getBoundingClientRect();
        return box.left >= clip.left && box.right <= clip.right;
      }).length;
    });
  const before = await count(),
    keyWidth = (await keyboard.locator('[data-note="60"]').boundingBox())!
      .width;
  const handle = keyboard.getByRole("button", {
    name: "Resize keyboard panel",
    exact: true,
  });
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + 9, box.y + 60);
  await page.mouse.down();
  await page.mouse.move(box.x + 209, box.y + 60, { steps: 10 });
  await page.mouse.up();
  await expect(keyboard).toHaveAttribute("data-dock-width", "800");
  await expect.poll(count).toBeGreaterThan(before);
  expect(
    (await keyboard.locator('[data-note="60"]').boundingBox())!.width,
  ).toBe(keyWidth);
  await page.reload();
  await expect(keyboard).toHaveAttribute("data-dock-width", "800");
  const minimumHandle = (await handle.boundingBox())!;
  await page.mouse.move(minimumHandle.x + 9, minimumHandle.y + 60);
  await page.mouse.down();
  await page.mouse.move(minimumHandle.x - 700, minimumHandle.y + 60, {
    steps: 10,
  });
  await page.mouse.up();
  await expect(keyboard).toHaveAttribute("data-dock-width", "460");
  expect((await keyboard.boundingBox())!.width).toBe(460);
  expect(
    await keyboard.locator(".dock-panel-header").evaluate((header) => {
      const panel = header.parentElement!.getBoundingClientRect();
      return [...header.querySelectorAll("button")].every((button) => {
        const box = button.getBoundingClientRect();
        return box.left >= panel.left && box.right <= panel.right;
      });
    }),
  ).toBe(true);
  const widgets = Array.from({ length: 8 }, (_, index) => ({
    id: `row-${index}`,
    kind: "oscilloscope",
    pinned: true,
    dock_width: 300,
  }));
  await request.patch("/api/settings", {
    data: {
      visualizations: {
        widgets,
        dock_order: ["keyboard", ...widgets.map((widget) => widget.id)],
      },
    },
  });
  await expect(page.locator(".dock-panel")).toHaveCount(9);
  await expect
    .poll(() =>
      page
        .locator(".dock-panel")
        .evaluateAll(
          (items) =>
            new Set(items.map((item) => item.getBoundingClientRect().top)).size,
        ),
    )
    .toBe(1);
  expect(
    await page
      .locator(".dock-content")
      .evaluate((element) => element.scrollWidth > element.clientWidth),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 320, height: 844 });
  await expect
    .poll(() =>
      keyboard.locator(".dock-panel-header").evaluate((header) => {
        const panel = header.parentElement!.getBoundingClientRect();
        return [...header.querySelectorAll("button")].every((button) => {
          const box = button.getBoundingClientRect();
          return (
            box.left >= panel.left &&
            box.right <= panel.right &&
            box.right <= innerWidth
          );
        });
      }),
    )
    .toBe(true);
  await page.screenshot({
    path: "../experiments/visuals/keyboard-single-row.png",
  });
});
