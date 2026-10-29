// Render the browser DSP without audio hardware for native/browser parity checks.
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = await readFile(
  new URL("../web/src/effects-dsp.ts", import.meta.url),
  "utf8",
);
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
  },
});
const exports = {};
runInNewContext(outputText, { exports });
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
const dsp = new exports.EffectDSP(kind, rate, parameters);
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
  const left = Float32Array.from(block, (frame) => frame[0]);
  const right = Float32Array.from(block, (frame) => frame[1]);
  dsp.process(left, right);
  for (let index = 0; index < block.length; index++)
    output.push([left[index], right[index]]);
  offset += block.length;
}
process.stdout.write(JSON.stringify(output));
