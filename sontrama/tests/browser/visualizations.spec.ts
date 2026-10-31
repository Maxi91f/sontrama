import { test, expect, setSimulation } from "./fixtures";
import type { Page } from "@playwright/test";
async function addVisualization(page: Page, kind: "oscilloscope" | "spectrum") {
  await page.locator('[data-visual-action="picker"]').click();
  await page.getByRole("dialog").locator(`[data-kind="${kind}"]`).click();
}

test("visualization dashboard shares layout and pinned views while the keyboard stays in the dock", async ({
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
    data: {
      instrument: "three-osc",
      effects: [],
      master_effects: [],
      octave: 0,
    },
  });
  const phoneContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const phone = await phoneContext.newPage();
  try {
    await page.goto("/");
    await page.getByRole("tab", { name: "Output", exact: true }).click();
    await setSimulation(page, true);
    await page
      .getByRole("tab", { name: "Visualizations", exact: true })
      .click();
    await expect(page.getByRole("tab")).toHaveCount(5);
    await expect(page.locator(".bottom-dock")).toBeVisible();
    await addVisualization(page, "oscilloscope");
    const scope = page.locator(".visual-widget").first();
    await expect(scope).toBeVisible();
    const id = (await scope.getAttribute("data-widget"))!;
    await scope.getByLabel("Signal", { exact: true }).selectOption("channel");
    await scope
      .getByRole("button", { name: "Resize visualization", exact: true })
      .focus();
    await page.keyboard.press("ArrowRight");
    await expect(scope).toHaveAttribute("data-width", "3");
    await scope
      .getByRole("button", { name: "Resize visualization", exact: true })
      .focus();
    await page.keyboard.press("ArrowUp");
    await expect(scope).toHaveAttribute("data-height", "160");
    await scope.getByRole("button", { name: "Pin below", exact: true }).click();
    const pinned = page.locator(`.dock-visual[data-widget="${id}"]`);
    await expect(pinned).toBeVisible();
    await addVisualization(page, "spectrum");
    await expect(page.locator(".visual-widget")).toHaveCount(2);
    await page
      .locator(".visual-widget")
      .last()
      .getByRole("button", { name: "Move visualization", exact: true })
      .focus();
    await page.keyboard.press("ArrowLeft");
    await expect(
      page.locator(".visual-widget").first().getByRole("heading"),
    ).toHaveText("Spectrum");
    const scopeAgain = page.locator(`.visual-widget[data-widget="${id}"]`);
    const piano = await page.locator('[data-note="60"]').elementHandle();
    await page
      .getByRole("button", { name: "Capture keyboard", exact: true })
      .click();
    await page.keyboard.down("z");
    const canvas = scopeAgain.locator("canvas");
    await expect
      .poll(async () => Number(await canvas.getAttribute("data-peak")))
      .toBeGreaterThan(0.01);
    await expect(canvas).toHaveAttribute("data-source", "preview");
    await expect
      .poll(
        async () =>
          (await canvas.getAttribute("data-peak")) ===
          (await pinned.locator("canvas").getAttribute("data-peak")),
      )
      .toBe(true);
    await expect
      .poll(async () =>
        Math.abs(
          Number(
            await page
              .locator(".visual-widget")
              .first()
              .locator("canvas")
              .getAttribute("data-frequency"),
          ) - 261.63,
        ),
      )
      .toBeLessThan(44);
    await pinned.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(
      scopeAgain.getByRole("button", { name: "Pause", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.up("z");
    await expect(scopeAgain.locator("[data-visual-status]")).toContainText(
      "Paused",
    );
    const frozen = await canvas.getAttribute("data-peak");
    await expect
      .poll(async () =>
        Number(
          await page
            .locator(".visual-widget")
            .first()
            .locator("canvas")
            .getAttribute("data-peak"),
        ),
      )
      .toBeLessThan(0.001);
    expect(await canvas.getAttribute("data-peak")).toBe(frozen);
    expect(
      await piano!.evaluate(
        (element) => element === document.querySelector('[data-note="60"]'),
      ),
    ).toBe(true);
    await phone.goto("/");
    await phone
      .getByRole("tab", { name: "Visualizations", exact: true })
      .click();
    await expect(phone.locator(".visual-widget")).toHaveCount(2);
    await expect(
      phone.locator(`.visual-widget[data-widget="${id}"]`),
    ).toHaveAttribute("data-width", "3");
    await expect(phone.locator(".dock-keyboard")).toBeHidden();
    await phone.getByLabel("Show", { exact: true }).selectOption("keyboard");
    await expect(phone.locator(".dock-keyboard")).toBeVisible();
    await expect(phone.locator(".dock-visual")).toBeHidden();
    for (const width of [320, 768, 1240]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      const dock = (await page.locator(".bottom-dock").boundingBox())!;
      expect(Math.round(dock.y + dock.height)).toBe(900);
    }
    await page.getByRole("button", { name: "Collapse", exact: true }).click();
    await expect(phone.locator(".bottom-dock")).toHaveAttribute(
      "data-collapsed",
      "true",
    );
    await expect(page.locator(".bottom-dock")).toHaveAttribute(
      "data-collapsed",
      "true",
    );
    await expect
      .poll(
        async () => (await page.locator(".bottom-dock").boundingBox())!.height,
      )
      .toBeLessThan(110);
    await page.reload();
    await expect(page.locator(".bottom-dock")).toHaveAttribute(
      "data-collapsed",
      "true",
    );
    await expect(
      page.locator(".visual-widget").first().getByRole("heading"),
    ).toHaveText("Spectrum");
    await page.getByRole("button", { name: "Expand", exact: true }).click();
    await page
      .locator(`.visual-widget[data-widget="${id}"]`)
      .getByRole("button", { name: "Remove visualization", exact: true })
      .click();
    await expect(phone.locator(".dock-visual")).toHaveCount(0);
    await expect(page.locator(".visual-widget")).toHaveCount(1);
    await request.patch("/api/settings", {
      data: { interface: { language: "es" } },
    });
    await expect(
      page.getByRole("tab", { name: "Visualizaciones", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "+ Agregar visualización",
        exact: true,
      }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await phoneContext.close();
  }
});

test("grid dragging and corner resizing snap, persist and cancel without writes", async ({
  page,
  browser,
  request,
}) => {
  await request.patch("/api/settings", {
    data: {
      interface: { language: "en" },
      visualizations: {
        collapsed: true,
        widgets: ["a", "b", "c"].map((id) => ({
          id,
          kind: "oscilloscope",
          width: 1,
          height: 160,
        })),
      },
    },
  });
  await page.setViewportSize({ width: 1600, height: 1300 });
  await page.goto("/");
  await page.getByRole("tab", { name: "Visualizations", exact: true }).click();
  const first = page.locator('[data-widget="a"].visual-widget');
  const handle = first.getByRole("button", {
    name: "Move visualization",
    exact: true,
  });
  const start = (await handle.boundingBox())!;
  const third = (await page
    .locator('[data-widget="c"].visual-widget')
    .boundingBox())!;
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    third.x + third.width * 0.8,
    start.y + start.height / 2,
    { steps: 10 },
  );
  await expect(page.locator(".visual-drag-ghost")).toBeVisible();
  await expect(page.locator('[data-widget="c"]')).toHaveAttribute(
    "data-drop",
    "after",
  );
  await page.mouse.up();
  await expect
    .poll(() =>
      page
        .locator(".visual-widget")
        .evaluateAll((elements) =>
          elements.map((element) => (element as HTMLElement).dataset.widget),
        ),
    )
    .toEqual(["b", "c", "a"]);
  const card = page.locator('[data-widget="b"].visual-widget');
  const corner = card.getByRole("button", {
    name: "Resize visualization",
    exact: true,
  });
  const box = (await corner.boundingBox())!;
  const width = (await card.boundingBox())!.width;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2 + width + 20,
    box.y + box.height / 2 + 80,
    { steps: 10 },
  );
  await expect(card).toHaveCSS("--visual-width", "2");
  await expect(card).toHaveCSS("--visual-height", "240px");
  await page.mouse.up();
  await expect(card).toHaveAttribute("data-width", "2");
  await expect(card).toHaveAttribute("data-height", "240");
  const saved = (await (await request.get("/api/settings")).json()).settings
    .visualizations;
  const phoneContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  const phone = await phoneContext.newPage();
  try {
    await phone.goto("/");
    await phone
      .getByRole("tab", { name: "Visualizations", exact: true })
      .click();
    await expect(
      phone.locator('.visual-widget[data-widget="b"]'),
    ).toHaveAttribute("data-height", "240");
    const resize = (await corner.boundingBox())!;
    await page.mouse.move(resize.x + 10, resize.y + 10);
    await page.mouse.down();
    await page.mouse.move(resize.x + 150, resize.y + 90);
    await page.keyboard.press("Escape");
    await page.mouse.up();
    expect(
      (await (await request.get("/api/settings")).json()).settings
        .visualizations,
    ).toEqual(saved);
    await expect(page.locator(".grid-editing")).toHaveCount(0);
    await handle.focus();
    await page.keyboard.press("ArrowLeft");
    await expect
      .poll(() =>
        page
          .locator(".visual-widget")
          .evaluateAll((elements) =>
            elements.map((element) => (element as HTMLElement).dataset.widget),
          ),
      )
      .toEqual(["b", "a", "c"]);
    await page.reload();
    await expect(
      page.locator('.visual-widget[data-widget="b"]'),
    ).toHaveAttribute("data-width", "2");
    const touchCorner = phone.locator(
      '[data-widget="b"] [data-grid-handle="resize"]',
    );
    await touchCorner.scrollIntoViewIfNeeded();
    const touchBox = (await touchCorner.boundingBox())!;
    const touch = await phoneContext.newCDPSession(phone);
    const point = { x: touchBox.x + 12, y: touchBox.y + 12 };
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [point],
    });
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: point.x, y: point.y - 80 }],
    });
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect(
      page.locator('.visual-widget[data-widget="b"]'),
    ).toHaveAttribute("data-height", "160");
    await expect(
      phone.locator('.visual-widget[data-widget="b"]'),
    ).toHaveAttribute("data-width", "2");
    await phone.screenshot({ path: "../experiments/visuals/grid-touch.png" });
  } finally {
    await phoneContext.close();
  }
});

test("dock stays within the viewport and the keyboard keys keep their size", async ({
  page,
  browser,
  request,
}) => {
  await request.patch("/api/settings", {
    data: {
      interface: { language: "en" },
      visualizations: {
        collapsed: false,
        active: "keyboard",
        widgets: [
          {
            id: "dock-scope",
            kind: "oscilloscope",
            pinned: true,
            dock_width: 300,
          },
        ],
      },
    },
  });
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto("/");
  const keyboard = page.locator(".dock-keyboard");
  await expect(keyboard.locator("[data-dock-resize]")).toHaveCount(1);
  expect((await keyboard.boundingBox())!.width).toBe(600);
  const initial = (await keyboard.locator('[data-note="60"]').boundingBox())!;
  const scope = page.locator(".dock-visual");
  const handle = scope.getByRole("button", {
    name: "Resize pinned visualization",
    exact: true,
  });
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + 9, box.y + 60);
  await page.mouse.down();
  await page.mouse.move(1800, box.y + 60, { steps: 8 });
  const content = (await page.locator(".dock-content").boundingBox())!;
  const resized = (await scope.boundingBox())!;
  expect(resized.x + resized.width).toBeLessThanOrEqual(
    content.x + content.width,
  );
  await page.mouse.up();
  await expect
    .poll(async () => Number(await scope.getAttribute("data-dock-width")))
    .toBeGreaterThan(300);
  expect(
    (await keyboard.locator('[data-note="60"]').boundingBox())!.width,
  ).toBe(initial.width);
  await handle.focus();
  await page.keyboard.press("End");
  await expect
    .poll(() =>
      scope.evaluate((element) => element.getBoundingClientRect().right),
    )
    .toBeLessThanOrEqual(content.x + content.width);
  const other = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  const phone = await other.newPage();
  try {
    await phone.goto("/");
    expect((await phone.locator('[data-note="60"]').boundingBox())!.width).toBe(
      initial.width,
    );
    await expect(
      phone.locator(".dock-keyboard [data-dock-resize]"),
    ).toHaveCount(1);
    await phone.getByLabel("Show", { exact: true }).selectOption("dock-scope");
    const phoneHandle = phone.getByRole("button", {
      name: "Resize pinned visualization",
      exact: true,
    });
    const touchBox = (await phoneHandle.boundingBox())!;
    const touch = await other.newCDPSession(phone);
    const point = { x: touchBox.x + 9, y: touchBox.y + 60 };
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [point],
    });
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: 700, y: point.y }],
    });
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect
      .poll(async () => Number(await scope.getAttribute("data-dock-width")))
      .toBeLessThan(390);
    expect(
      await phone.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const phoneScope = (await phone.locator(".dock-visual").boundingBox())!;
    expect(phoneScope.x + phoneScope.width).toBeLessThanOrEqual(390);
    await page.getByRole("button", { name: "Collapse", exact: true }).click();
    await expect(page.locator(".bottom-dock")).toHaveAttribute(
      "data-collapsed",
      "true",
    );
    await expect
      .poll(
        async () => (await page.locator(".bottom-dock").boundingBox())!.height,
      )
      .toBeLessThanOrEqual(26);
    await expect(
      page.getByRole("button", { name: "Expand", exact: true }),
    ).toHaveText("⌃");
    await phone.getByRole("button", { name: "Expand", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Collapse", exact: true }),
    ).toHaveText("⌄");
    await page.reload();
    await expect(keyboard.locator("[data-dock-resize]")).toHaveCount(1);
    await page.screenshot({ path: "../experiments/visuals/dock-bounded.png" });
  } finally {
    await other.close();
  }
});

test("all dock items reorder independently without resizing or replacing the keyboard", async ({
  page,
  browser,
  request,
}) => {
  await request.patch("/api/settings", {
    data: {
      interface: { language: "en" },
      visualizations: {
        collapsed: false,
        widgets: ["a", "b"].map((id) => ({
          id,
          kind: "oscilloscope",
          pinned: true,
          dock_width: 220,
        })),
        dock_order: ["keyboard", "a", "b"],
      },
    },
  });
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto("/");
  const keyboard = page.locator(".dock-keyboard");
  const key = await keyboard.locator('[data-note="60"]').elementHandle();
  const size = (await keyboard.boundingBox())!;
  const handle = keyboard.getByRole("button", {
    name: "Move item in monitor bar",
    exact: true,
  });
  const start = (await handle.boundingBox())!;
  const last = (await page
    .locator('.dock-visual[data-widget="b"]')
    .boundingBox())!;
  await page.mouse.move(start.x + 12, start.y + 12);
  await page.mouse.down();
  await page.mouse.move(last.x + last.width - 30, last.y + 20, { steps: 10 });
  await page.mouse.up();
  const order = () =>
    page
      .locator(".dock-content > .dock-item")
      .evaluateAll((items) =>
        items.map((item) => (item as HTMLElement).dataset.widget),
      );
  await expect.poll(order).toEqual(["a", "b", "keyboard"]);
  expect((await keyboard.boundingBox())!.width).toBe(size.width);
  await expect(keyboard.locator("[data-dock-resize]")).toHaveCount(1);
  expect(
    await key!.evaluate(
      (element) =>
        element === document.querySelector('.piano [data-note="60"]'),
    ),
  ).toBe(true);
  await page
    .locator('.dock-visual[data-widget="b"] [data-grid-handle]')
    .focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(order).toEqual(["b", "a", "keyboard"]);
  const saved = (await (await request.get("/api/settings")).json()).settings
    .visualizations;
  expect(saved.widgets.map((widget: { id: string }) => widget.id)).toEqual([
    "a",
    "b",
  ]);
  const other = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  try {
    const phone = await other.newPage();
    await phone.goto("/");
    await expect
      .poll(() =>
        phone
          .locator(".dock-content > .dock-item")
          .evaluateAll((items) =>
            items.map((item) => (item as HTMLElement).dataset.widget),
          ),
      )
      .toEqual(["b", "a", "keyboard"]);
    await page.reload();
    await expect.poll(order).toEqual(["b", "a", "keyboard"]);
  } finally {
    await other.close();
  }
});

test("dock panels share their shell and keep empty space after positioning", async ({
  page,
  request,
}) => {
  await request.patch("/api/settings", {
    data: {
      interface: { language: "en" },
      visualizations: {
        collapsed: false,
        dock_positions: {},
        dock_order: ["keyboard", "scope-position"],
        widgets: [
          {
            id: "scope-position",
            kind: "oscilloscope",
            pinned: true,
            dock_width: 300,
          },
        ],
      },
    },
  });
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto("/");
  const keyboard = page.locator(".dock-keyboard");
  const scope = page.locator(".dock-visual");
  expect((await keyboard.boundingBox())!.height).toBe(
    (await scope.boundingBox())!.height,
  );
  await expect(keyboard).toHaveClass(/dock-panel/);
  await expect(scope).toHaveClass(/dock-panel/);
  await expect(keyboard).toHaveCSS(
    "background-color",
    await scope.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    ),
  );
  const scopeHandle = scope.getByRole("button", {
    name: "Move item in monitor bar",
    exact: true,
  });
  const origin = (await scopeHandle.boundingBox())!;
  await page.mouse.move(origin.x + 12, origin.y + 12);
  await page.mouse.down();
  await page.mouse.move(1280, origin.y + 12, { steps: 10 });
  const shadow = page.locator(".dock-placement-shadow");
  await expect(shadow).toBeVisible();
  const preview = (await shadow.boundingBox())!;
  await expect(page.locator(".dock-item[data-drop]")).toHaveCount(0);
  await page.screenshot({
    path: "../experiments/visuals/placement-shadow.png",
  });
  await page.mouse.up();
  await expect(shadow).toHaveCount(0);

  await expect
    .poll(
      async () =>
        (await (await request.get("/api/settings")).json()).settings
          .visualizations.dock_positions["scope-position"] ?? 0,
    )
    .toBeGreaterThan(700);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const scope = document
          .querySelector(".dock-visual")
          ?.getBoundingClientRect();
        const keyboard = document
          .querySelector(".dock-keyboard")
          ?.getBoundingClientRect();
        return scope && keyboard ? scope.x - keyboard.right : -Infinity;
      }),
    )
    .toBeGreaterThan(80);
  await expect
    .poll(async () => Math.abs((await scope.boundingBox())!.x - preview.x))
    .toBeLessThan(1);
  await expect
    .poll(async () => Math.abs((await scope.boundingBox())!.y - preview.y))
    .toBeLessThan(1);
  expect((await scope.boundingBox())!.width).toBe(preview.width);
  const keyboardHandle = keyboard.getByRole("button", {
    name: "Move item in monitor bar",
    exact: true,
  });
  const from = (await keyboardHandle.boundingBox())!;
  await page.mouse.move(from.x + 12, from.y + 12);
  await page.mouse.down();
  await page.mouse.move(from.x + 312, from.y + 12, { steps: 10 });
  await page.mouse.up();
  await expect
    .poll(async () => (await keyboard.boundingBox())!.x)
    .toBeGreaterThan(200);
  await expect(keyboard.locator("[data-dock-resize]")).toHaveCount(1);
  const left = (await keyboard.boundingBox())!.x;
  await page.reload();
  await expect.poll(async () => (await keyboard.boundingBox())!.x).toBe(left);
  expect((await keyboard.boundingBox())!.height).toBe(
    (await scope.boundingBox())!.height,
  );
  await page.screenshot({ path: "../experiments/visuals/dock-position.png" });
});
