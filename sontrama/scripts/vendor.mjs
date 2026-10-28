import { mkdir, copyFile, readdir } from "node:fs/promises";
const destination = new URL("../public/vendor/", import.meta.url);
await mkdir(destination, { recursive: true });
for (const name of ["js-synthesizer.min.js", "js-synthesizer.worklet.min.js"]) {
  await copyFile(
    new URL(`../node_modules/js-synthesizer/dist/${name}`, import.meta.url),
    new URL(name, destination),
  );
}
const external = new URL(
  "../node_modules/js-synthesizer/externals/",
  import.meta.url,
);
const names = await readdir(external);
const engine = names
  .filter((name) => /^libfluidsynth-[\d.]+\.js$/.test(name))
  .sort()
  .at(-1);
if (!engine) throw new Error("Missing FluidSynth WASM distribution");
await copyFile(
  new URL(engine, external),
  new URL("libfluidsynth.js", destination),
);
for (const name of names.filter((name) => name.endsWith(".wasm"))) {
  await copyFile(new URL(name, external), new URL(name, destination));
}
await copyFile(
  new URL("../node_modules/js-synthesizer/LICENSE", import.meta.url),
  new URL("LICENSE.js-synthesizer.txt", destination),
);
await copyFile(
  new URL("LICENSE.fluidsynth.txt", external),
  new URL("LICENSE.fluidsynth.txt", destination),
);
await copyFile(
  new URL("README.md", external),
  new URL("README.fluidsynth.md", destination),
);
for (const font of ["inter", "jetbrains-mono"]) {
  await copyFile(
    new URL(
      `../node_modules/@fontsource-variable/${font}/LICENSE`,
      import.meta.url,
    ),
    new URL(`LICENSE.${font}.txt`, destination),
  );
}
