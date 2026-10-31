// Compile the portable DSP once; runtime code never invokes a compiler.
import { createHash } from "node:crypto";
import {
  readFile,
  writeFile,
  mkdir,
  access,
  rename,
  rm,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = path.join(root, "src/sontrama/dsp");
const contract = JSON.parse(
  await readFile(path.join(directory, "core_contract.json"), "utf8"),
);
const sources = [
  "three_osc.c",
  "effects.c",
  "mixer.c",
  "core_contract.json",
  "../effect_specs.json",
];
const digest = createHash("sha256");
for (const name of sources)
  digest.update(
    Buffer.concat([
      Buffer.from(name + "\0"),
      await readFile(path.join(directory, name)),
    ]),
  );
const revision = digest.digest("hex");
const output = path.join(root, "public/vendor");
await mkdir(output, { recursive: true });
try {
  const previous = JSON.parse(
    await readFile(path.join(output, "sontrama-dsp.json"), "utf8"),
  );
  await access(path.join(output, "sontrama-dsp.wasm"));
  if (
    previous.revision === revision &&
    previous.compiler === contract.emscripten
  )
    process.exit(0);
} catch {
  /* A missing/stale artifact must be built before Vite or deployment. */
}
const compiler =
  process.env.EMCC || path.join(root, ".cache/emsdk/upstream/emscripten/emcc");
const functions = [
  "sontrama_core_revision",
  "malloc",
  "free",
  "sontrama_table_count",
  "sontrama_tables",
  "sontrama_install_tables",
  "sontrama_osc_create",
  "sontrama_osc_free",
  "sontrama_osc_configure",
  "sontrama_osc_midi",
  "sontrama_osc_process",
  "sontrama_osc_panic",
  "sontrama_osc_voice",
  "sontrama_effect_create",
  "sontrama_effect_configure",
  "sontrama_effect_process",
  "sontrama_effect_free",
  "sontrama_bus_create",
  "sontrama_bus_free",
  "sontrama_bus_configure",
  "sontrama_bus_process",
  "sontrama_clip",
];
const temporary = path.join(output, "sontrama-dsp.next.wasm");
try {
  execFileSync(
    compiler,
    [
      ...sources
        .filter((s) => s.endsWith(".c"))
        .map((s) => path.join(directory, s)),
      "-O3",
      "-ffp-contract=off",
      `-DSONTRAMA_CORE_REVISION="${revision}"`,
      "-sSTANDALONE_WASM=1",
      "--no-entry",
      "-sALLOW_MEMORY_GROWTH=1",
      "-sINITIAL_MEMORY=16777216",
      `-sEXPORTED_FUNCTIONS=${JSON.stringify(functions.map((name) => "_" + name))}`,
      "-o",
      temporary,
    ],
    { stdio: "inherit" },
  );
  await rename(temporary, path.join(output, "sontrama-dsp.wasm"));
  await writeFile(
    path.join(output, "sontrama-dsp.json"),
    JSON.stringify(
      { revision, abi: contract.abi, compiler: contract.emscripten },
      null,
      2,
    ) + "\n",
  );
  console.log("Built shared audio core:", revision.slice(0, 12));
} catch (error) {
  await rm(temporary, { force: true });
  throw new Error(
    "Could not build the shared audio core. Run ./task/init/wasm.sh or set EMCC.",
    { cause: error },
  );
}
