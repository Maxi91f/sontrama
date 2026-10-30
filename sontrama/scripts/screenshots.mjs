import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium, expect } from "@playwright/test";

const appDirectory = fileURLToPath(new URL("../", import.meta.url));
const assets = path.resolve(appDirectory, "../docs/assets");
const temporary = await mkdtemp(path.join(tmpdir(), "sontrama-screenshots-"));
const run = promisify(execFile);
const listener = createServer();
await new Promise((resolve, reject) => {
  listener.once("error", reject);
  listener.listen(0, "127.0.0.1", resolve);
});
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const baseURL = `http://127.0.0.1:${port}`;
const server = spawn("uv", ["run", "--frozen", "sontrama"], {
  cwd: appDirectory,
  env: {
    ...process.env,
    SONTRAMA_HOST: "127.0.0.1",
    SONTRAMA_PORT: port,
    SONTRAMA_STATE: path.join(temporary, "session.json"),
    SONTRAMA_NO_AUDIO: "1",
    SONTRAMA_NO_MIDI: "1",
    OPENBLAS_NUM_THREADS: "1",
  },
  stdio: ["ignore", "ignore", "inherit"],
});
const stopped = new Promise((resolve) => {
  server.once("exit", resolve);
  server.once("error", resolve);
});
let browser;
try {
  await mkdir(assets, { recursive: true });
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (server.exitCode !== null) throw new Error("Screenshot server exited");
    try {
      const response = await fetch(`${baseURL}/api/state`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      // The isolated server may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error("Screenshot server did not become ready");
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
  });
  const page = await browser.newPage({
    viewport: { width: 1240, height: 1100 },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });
  await page.goto(baseURL);
  await page.locator("#connection.connected").waitFor();
  await page.evaluate(() => document.fonts.ready);
  // Save notifications are transient overlays, not part of the illustrated controls.
  const captureStyle = ".settings-toast { visibility: hidden !important; }";
  const drawer = page.locator(".bottom-dock");
  const waitForToast = () =>
    page.locator(".settings-toast").waitFor({ state: "hidden" });
  const setDrawer = async (open) => {
    if ((await drawer.getAttribute("data-collapsed")) === String(open))
      await drawer.locator('[data-visual-action="collapse"]').click();
    await expect(drawer).toHaveAttribute("data-collapsed", String(!open));
  };
  const fitPage = async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    const studio = await page.locator(".studio").boundingBox();
    const dock = await drawer.boundingBox();
    await page.setViewportSize({
      width: page.viewportSize().width,
      height: Math.ceil(studio.y + studio.height + dock.height + 32),
    });
    await page.evaluate(() => new Promise(requestAnimationFrame));
  };
  const capture = async (name) => {
    await waitForToast();
    await page.mouse.move(0, 0);
    await page
      .locator(":focus")
      .evaluateAll((elements) => elements.forEach((element) => element.blur()));
    // Fit the content above the fixed dock so full-page captures do not overlap it.
    await fitPage();
    const box = await page.locator(".studio").boundingBox();
    const viewport = page.viewportSize();
    const top = Math.max(0, box.y - 12);
    await page.screenshot({
      style: captureStyle,
      path: path.join(assets, name),
      clip: {
        x: 0,
        y: top,
        width: viewport.width,
        height: viewport.height - top,
      },
    });
  };
  await page
    .getByRole("combobox", { name: "Instrument", exact: true })
    .selectOption("three-osc");
  await page.locator(".oscillator").nth(2).waitFor();
  await capture("three-osc.png");
  await page.getByRole("tab", { name: "Mixer", exact: true }).click();
  await setDrawer(true);
  await page
    .getByRole("button", { name: "Capture keyboard", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await (await fetch(`${baseURL}/api/settings`)).json()).settings
          .keyboard.capture,
    )
    .toBe(true);
  for (const key of ["z", "c", "b"]) await page.keyboard.down(key);
  await capture("effects.png");
  for (const key of ["z", "c", "b"]) await page.keyboard.up(key);
  await setDrawer(false);

  await page.getByRole("button", { name: "Add effect", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Filter", exact: false })
    .click();
  await page
    .getByRole("button", { name: "Remove Filter", exact: true })
    .waitFor();
  await waitForToast();
  await fitPage();
  await page.locator(".mixer-chain").screenshot({
    path: path.join(assets, "effects-chain.png"),
    style: captureStyle,
  });

  await page.getByRole("tab", { name: "Output", exact: true }).click();
  await page
    .getByRole("button", { name: "Enable preview", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Preview enabled", exact: true })
    .waitFor();
  await page.getByRole("tab", { name: "Mixer", exact: true }).click();
  await page.getByRole("button", { name: "Edit Master", exact: true }).click();
  for (const name of ["Compressor", "Limiter"]) {
    await page.getByRole("button", { name: "Add effect", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name, exact: false })
      .click();
    await page.getByRole("button", { name, exact: true }).waitFor();
  }
  await page.evaluate(async () => {
    const socket = new WebSocket(
      `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`,
    );
    await new Promise((resolve) =>
      socket.addEventListener("message", resolve, { once: true }),
    );
    window.midiDemoSource = socket;
  });
  const chord = async (notes, active) => {
    await page.evaluate(
      ({ notes, active }) => {
        for (const note of notes)
          window.midiDemoSource.send(
            JSON.stringify({
              type: "midi",
              data: [active ? 0x90 : 0x80, note, active ? 90 : 0],
            }),
          );
      },
      { notes, active },
    );
    await page.waitForFunction(
      ({ notes, active }) =>
        notes.every(
          (note) =>
            document
              .querySelector(`[data-note="${note}"]`)
              .classList.contains("held") === active,
        ),
      { notes, active },
    );
  };
  await chord([60, 64, 67], true);
  await page.waitForFunction(
    () =>
      Number(
        document
          .querySelector('[data-meter="master"]')
          .getAttribute("aria-valuenow"),
      ) > 0,
  );
  await fitPage();
  await page
    .locator("#panel-mixer")
    .screenshot({ path: path.join(assets, "mixer.png"), style: captureStyle });
  await chord([60, 64, 67], false);
  await page
    .getByRole("button", { name: "Edit Channel 01", exact: true })
    .click();
  await page.getByRole("tab", { name: "Output", exact: true }).click();
  await page
    .getByRole("button", { name: "Preview enabled", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Enable preview", exact: true })
    .waitFor();
  await page.getByRole("tab", { name: "Mixer", exact: true }).click();
  await setDrawer(true);
  await waitForToast();

  const idle = path.join(temporary, "midi-idle.png");
  const keyboard = page.locator(".dock-keyboard");
  await page.mouse.move(0, 0);
  await keyboard.screenshot({ path: idle, style: captureStyle });
  const animation = ["-delay", "80", idle];
  const progression = [
    [60, 64, 67],
    [67, 71, 74],
    [69, 72, 76],
    [65, 69, 72],
  ];
  for (const [index, notes] of progression.entries()) {
    await chord(notes, true);
    const frame = path.join(temporary, `midi-chord-${index}.png`);
    await keyboard.screenshot({ path: frame, style: captureStyle });
    animation.push("-delay", "90", frame, "-delay", "20", idle);
    await chord(notes, false);
  }
  await run("convert", [
    ...animation,
    "-loop",
    "0",
    "-strip",
    "-layers",
    "Optimize",
    path.join(assets, "midi.gif"),
  ]);
  // Capture analyzers driven by real preview audio, without changing local state.
  const response = await fetch(`${baseURL}/api/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      visualizations: {
        collapsed: false,
        keyboard_width: 460,
        dock_order: ["demo-vu", "keyboard", "demo-stereo"],
        widgets: [
          { id: "demo-scope", kind: "oscilloscope", width: 1, height: 240 },
          { id: "demo-fft", kind: "spectrum", width: 1, height: 240 },
          { id: "demo-spectrum", kind: "spectrogram", width: 1, height: 240 },
          {
            id: "demo-correlation",
            kind: "correlation",
            width: 1,
            height: 240,
          },
          { id: "demo-tuner", kind: "tuner", width: 1, height: 240 },
          { id: "demo-midi", kind: "midi", width: 1, height: 240 },
          {
            id: "demo-stereo",
            kind: "vectorscope",
            width: 1,
            height: 240,
            pinned: true,
            dock_width: 300,
          },
          {
            id: "demo-vu",
            kind: "vu",
            width: 1,
            height: 240,
            pinned: true,
            dock_width: 300,
            meter_style: "needle",
          },
        ],
      },
    }),
  });
  if (!response.ok) throw new Error("Unable to configure visualizations");
  await page.getByRole("tab", { name: "Output", exact: true }).click();
  await page
    .getByRole("button", { name: "Enable preview", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Preview enabled", exact: true })
    .waitFor();
  await page.getByRole("tab", { name: "Visualizations", exact: true }).click();
  await page.locator('.visual-widget[data-widget="demo-vu"]').waitFor();
  for (const notes of progression) {
    await chord(notes, true);
    await page.waitForTimeout(650);
    await chord(notes, false);
  }
  // A single sustained A gives the tuner a clear reading in the overview.
  await chord([69], true);
  await page.waitForTimeout(600);
  await capture("visualizations.png");
  await page.getByRole("tab", { name: "Mixer", exact: true }).click();
  await waitForToast();
  await drawer.screenshot({
    path: path.join(assets, "monitor-bar.png"),
    style: captureStyle,
  });
  await chord([69], false);
  await page.evaluate(() => window.midiDemoSource.close());
  await setDrawer(false);
  await page
    .getByRole("button", { name: "Remove Filter", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Remove Filter", exact: true })
    .waitFor({ state: "detached" });
  await page.getByRole("tab", { name: "Instrument", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Instrument", exact: true })
    .selectOption("banks");
  await page.getByRole("combobox", { name: "Sound", exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await capture("mobile.png");
  console.log("Saved real UI screenshots to docs/assets (isolated session).");
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  const timer = setTimeout(() => server.kill("SIGKILL"), 5000);
  await stopped;
  clearTimeout(timer);
  await rm(temporary, { recursive: true, force: true });
}
