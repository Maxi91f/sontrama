// Render the production WASM effect adapter for native/WASM parity checks.
import { loadDSP } from "./load-dsp.mjs";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const {
  kind,
  rate,
  parameters,
  samples,
  chunks = [256],
  updates = [],
} = JSON.parse(input);
const { module, WasmCore, WasmEffect } = await loadDSP();
const core = new WasmCore(module),
  dsp = new WasmEffect(core, rate, kind, parameters);
const pointer = core.allocate(4096 * 2 * 4);
const output = [];
let offset = 0,
  iteration = 0;
while (offset < samples.length) {
  for (const update of updates)
    if (update.at === offset) dsp.configure(update.parameters);
  const block = samples.slice(
    offset,
    offset + chunks[iteration++ % chunks.length],
  );
  const data = core.floats(pointer, block.length * 2);
  for (let i = 0; i < block.length; i++) {
    data[i * 2] = block[i][0];
    data[i * 2 + 1] = block[i][1];
  }
  dsp.process(pointer, block.length);
  for (let i = 0; i < block.length; i++)
    output.push([data[i * 2], data[i * 2 + 1]]);
  offset += block.length;
}
dsp.close();
core.api.free(pointer);
process.stdout.write(JSON.stringify(output));
