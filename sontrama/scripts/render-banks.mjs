// Use the exact pinned WASM FluidSynth distribution shipped to the browser.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const library = require("../node_modules/js-synthesizer/externals/libfluidsynth-2.4.6.js");
const JSSynth = require("js-synthesizer");
JSSynth.Synthesizer.initializeWithFluidSynthModule(library);
await JSSynth.waitForReady();
let data = "";
for await (const chunk of process.stdin) data += chunk;
const cases = JSON.parse(data);
const results = [];
for (const test of cases) {
  const synth = new JSSynth.Synthesizer();
  synth.init(test.rate, {
    initialGain: 0.6,
    chorusActive: false,
    reverbActive: false,
    polyphony: 128,
  });
  const font = readFileSync(test.soundfont);
  const fontId = await synth.loadSFont(
    font.buffer.slice(font.byteOffset, font.byteOffset + font.byteLength),
  );
  synth.midiProgramSelect(0, fontId, 0, 0);
  let offset = 0,
    index = 0;
  const output = new Float32Array(test.frames * 2);
  while (offset < test.frames) {
    while (index < test.events.length && test.events[index].at === offset) {
      const midi = test.events[index++].midi;
      const kind = midi[0] & 0xf0;
      if (kind === 0x90 && midi[2]) synth.midiNoteOn(0, midi[1], midi[2]);
      else if (kind === 0x80 || kind === 0x90) synth.midiNoteOff(0, midi[1]);
      else if (kind === 0xb0) synth.midiControl(0, midi[1], midi[2]);
      else if (kind === 0xe0) synth.midiPitchBend(0, midi[1] + (midi[2] << 7));
      else if (kind === 0xd0) synth.midiChannelPressure(0, midi[1]);
      else if (kind === 0xa0) synth.midiKeyPressure(0, midi[1], midi[2]);
    }
    const end = Math.min(
      offset + 128,
      test.frames,
      test.events[index]?.at ?? test.frames,
    );
    const left = new Float32Array(end - offset),
      right = new Float32Array(end - offset);
    synth.render([left, right]);
    for (let i = 0; i < left.length; i++) {
      output[(offset + i) * 2] = left[i];
      output[(offset + i) * 2 + 1] = right[i];
    }
    offset = end;
  }
  synth.close();
  results.push(Buffer.from(output.buffer).toString("base64"));
}
process.stdout.write(JSON.stringify(results));
