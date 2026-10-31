import { WasmCore } from "./dsp-core";
import { LocalizedError } from "./i18n";
export interface PreparedDSP {
  module: WebAssembly.Module;
  tables: Float32Array;
  revision: string;
}
let prepared: Promise<PreparedDSP> | null = null;
export function prepareDSP(): Promise<PreparedDSP> {
  if (!prepared)
    prepared = (async () => {
      const [metadata, response] = await Promise.all([
        fetch("/vendor/sontrama-dsp.json", { cache: "no-cache" }).then((r) => {
          if (!r.ok) throw new Error("Missing DSP manifest");
          return r.json();
        }),
        fetch("/vendor/sontrama-dsp.wasm", { cache: "no-cache" }),
      ]);
      if (!response.ok) throw new Error("Missing DSP module");
      const module = await WebAssembly.compile(await response.arrayBuffer());
      const core = new WasmCore(module);
      if (core.revision() !== metadata.revision)
        throw new Error("DSP module and manifest revisions differ");
      const tables = core.tables();
      return { module, tables, revision: metadata.revision };
    })().catch((error) => {
      prepared = null;
      console.error(error);
      throw new LocalizedError("errors.previewCoreLoad");
    });
  return prepared;
}
