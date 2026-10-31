// Identical input timelines exercise native and WASM instrument/pipeline builds.
import { loadDSP } from "./load-dsp.mjs";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const cases = JSON.parse(input);
const { module, WasmCore, WasmOscillator, WasmPipeline } = await loadDSP();
const output = [];
for (const test of Array.isArray(cases) ? cases : [cases]) {
  const core = new WasmCore(module),
    osc = new WasmOscillator(core, test.rate, test.patch, test.seed ?? 1);
  const pipeline = test.session
    ? new WasmPipeline(core, test.rate, test.session)
    : null;
  let offset = 0,
    index = 0,
    iteration = 0;
  const events = test.events ?? [],
    chunks = test.chunks ?? [128];
  const pcm = new Float32Array(test.frames * 2),
    channel = new Float32Array(test.frames * 2),
    master = new Float32Array(test.frames * 2);
  while (offset < test.frames) {
    while (index < events.length && events[index].at === offset) {
      const event = events[index++];
      if (event.midi) osc.midi(event.midi);
      if (event.patch) osc.configure(event.patch);
      if (event.session)
        pipeline.configure(event.session, event.reset ?? false);
    }
    const end = Math.min(
      offset + chunks[iteration++ % chunks.length],
      test.frames,
      events[index]?.at ?? test.frames,
    );
    const left = new Float32Array(end - offset),
      right = new Float32Array(end - offset);
    osc.process(left, right);
    const buses = pipeline
      ? [0, 1, 2].map(() => [
          new Float32Array(left.length),
          new Float32Array(left.length),
        ])
      : [
          [left, right],
          [left, right],
          [left, right],
        ];
    if (pipeline) pipeline.process(left, right, buses);
    for (let i = 0; i < left.length; i++)
      for (let side = 0; side < 2; side++) {
        pcm[(offset + i) * 2 + side] = buses[0][side][i];
        channel[(offset + i) * 2 + side] = buses[1][side][i];
        master[(offset + i) * 2 + side] = buses[2][side][i];
      }
    offset = end;
  }
  pipeline?.close();
  osc.close();
  output.push({
    name: test.name,
    revision: core.revision(),
    samples: Buffer.from(pcm.buffer).toString("base64"),
    channel: Buffer.from(channel.buffer).toString("base64"),
    master: Buffer.from(master.buffer).toString("base64"),
  });
}
process.stdout.write(JSON.stringify(output));
