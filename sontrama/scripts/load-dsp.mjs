// Use the browser's adapters in Node parity checks; never reimplement DSP here.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file);
  if (file.endsWith(".json")) return JSON.parse(fs.readFileSync(file, "utf8"));
  const exports = {};
  cache.set(file, exports);
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  });
  const require = (name) => {
    let resolved = path.resolve(path.dirname(file), name);
    if (!path.extname(resolved)) resolved += ".ts";
    return load(resolved);
  };
  runInNewContext(outputText, {
    exports,
    require,
    WebAssembly,
    Float32Array,
    Float64Array,
    Uint8Array,
    console,
  });
  return exports;
}
export async function loadDSP() {
  const module = await WebAssembly.compile(
    fs.readFileSync(path.join(root, "public/vendor/sontrama-dsp.wasm")),
  );
  return { module, ...load(path.join(root, "web/src/dsp-core.ts")) };
}
