// Adapters only: all synthesis, controller handling, effects and mixing run in C/WASM.
import contract from "../../src/sontrama/dsp/core_contract.json";
import { effectVector, effectDefinitions } from "./effect-schema";
import type { Effect, Session, ThreeOscPatch } from "./types";
const kinds = Object.keys(effectDefinitions);
interface Exports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  sontrama_core_revision(): number;
  _initialize(): void;
  malloc(bytes: number): number;
  free(pointer: number): void;
  sontrama_table_count(): number;
  sontrama_tables(): number;
  sontrama_install_tables(pointer: number): void;
  sontrama_osc_create(rate: number, seed: number): number;
  sontrama_osc_configure(pointer: number, parameters: number): void;
  sontrama_osc_midi(
    pointer: number,
    status: number,
    value: number,
    amount: number,
  ): void;
  sontrama_osc_panic(pointer: number): void;
  sontrama_osc_free(pointer: number): void;
  sontrama_osc_process(pointer: number, output: number, frames: number): void;
  sontrama_effect_create(
    kind: number,
    rate: number,
    parameters: number,
    count: number,
  ): number;
  sontrama_effect_configure(
    pointer: number,
    parameters: number,
    count: number,
  ): void;
  sontrama_effect_process(
    pointer: number,
    input: number,
    output: number,
    frames: number,
  ): void;
  sontrama_effect_free(pointer: number): void;
  sontrama_bus_create(rate: number): number;
  sontrama_bus_configure(
    pointer: number,
    gain: number,
    pan: number,
    muted: number,
  ): void;
  sontrama_bus_process(
    pointer: number,
    input: number,
    output: number,
    frames: number,
  ): void;
  sontrama_bus_free(pointer: number): void;
  sontrama_clip(input: number, output: number, frames: number): void;
}
export function patchVector(patch: ThreeOscPatch): number[] {
  return [
    ...patch.oscillators.flatMap((osc) =>
      contract.oscillator_fields.map((field) => {
        const value = osc[field as keyof typeof osc];
        return field === "shape"
          ? contract.shapes.indexOf(String(value))
          : Number(value);
      }),
    ),
    ...contract.patch_fields.map((field) =>
      Number(
        field in patch.envelope
          ? patch.envelope[field as keyof typeof patch.envelope]
          : patch[field as keyof ThreeOscPatch],
      ),
    ),
  ];
}
export class WasmCore {
  readonly api: Exports;
  constructor(module: WebAssembly.Module, tables?: Float32Array) {
    this.api = new WebAssembly.Instance(module, {
      env: { emscripten_notify_memory_growth() {} },
    }).exports as Exports;
    this.api._initialize();
    if (tables) {
      const ptr = this.allocate(tables.byteLength);
      this.floats(ptr, tables.length).set(tables);
      this.api.sontrama_install_tables(ptr);
      this.api.free(ptr);
    }
  }
  revision() {
    const pointer = this.api.sontrama_core_revision();
    return String.fromCharCode(
      ...new Uint8Array(this.api.memory.buffer, pointer, 64),
    );
  }
  allocate(bytes: number) {
    const ptr = this.api.malloc(bytes);
    if (!ptr) throw new Error("Shared DSP allocation failed");
    return ptr;
  }
  floats(pointer: number, count: number) {
    return new Float32Array(this.api.memory.buffer, pointer, count);
  }
  doubles(pointer: number, count: number) {
    return new Float64Array(this.api.memory.buffer, pointer, count);
  }
  tables() {
    const pointer = this.api.sontrama_tables();
    if (!pointer) throw new Error("Could not initialize oscillator tables");
    return this.floats(pointer, this.api.sontrama_table_count()).slice();
  }
}
export class WasmOscillator {
  private pointer: number;
  private parameters: number;
  private output: number;
  constructor(
    private core: WasmCore,
    rate: number,
    patch: ThreeOscPatch,
    seed = contract.seed,
  ) {
    this.pointer = core.api.sontrama_osc_create(rate, seed);
    if (!this.pointer)
      throw new Error("Could not initialize oscillator engine");
    this.parameters = core.allocate(34 * 8);
    this.output = core.allocate(4096 * 2 * 4);
    this.configure(patch);
  }
  configure(patch: ThreeOscPatch) {
    this.core.doubles(this.parameters, 34).set(patchVector(patch));
    this.core.api.sontrama_osc_configure(this.pointer, this.parameters);
  }
  midi(data: number[]) {
    this.core.api.sontrama_osc_midi(
      this.pointer,
      data[0],
      data[1],
      data[2] ?? 0,
    );
  }
  panic() {
    this.core.api.sontrama_osc_panic(this.pointer);
  }
  process(left: Float32Array, right: Float32Array) {
    if (left.length > 4096)
      throw new Error("Audio block exceeds shared DSP capacity");
    this.core.api.sontrama_osc_process(this.pointer, this.output, left.length);
    const data = this.core.floats(this.output, left.length * 2);
    for (let i = 0; i < left.length; i++) {
      left[i] = data[i * 2];
      right[i] = data[i * 2 + 1];
    }
  }
  close() {
    this.core.api.sontrama_osc_free(this.pointer);
    this.core.api.free(this.parameters);
    this.core.api.free(this.output);
  }
}
export class WasmEffect {
  private pointer: number;
  private parameters: number;
  constructor(
    private core: WasmCore,
    rate: number,
    kind: string,
    parameters: number[],
  ) {
    this.parameters = core.allocate(12 * 8);
    core.doubles(this.parameters, 12).set(parameters);
    this.pointer = core.api.sontrama_effect_create(
      kinds.indexOf(kind),
      rate,
      this.parameters,
      parameters.length,
    );
    if (!this.pointer) throw new Error("Could not initialize effect");
  }
  configure(parameters: number[]) {
    this.core.doubles(this.parameters, 12).set(parameters);
    this.core.api.sontrama_effect_configure(
      this.pointer,
      this.parameters,
      parameters.length,
    );
  }
  process(pointer: number, frames: number) {
    this.core.api.sontrama_effect_process(
      this.pointer,
      pointer,
      pointer,
      frames,
    );
  }
  close() {
    this.core.api.sontrama_effect_free(this.pointer);
    this.core.api.free(this.parameters);
  }
}
export class WasmPipeline {
  private buffer: number;
  private channel: number;
  private master: number;
  private channelEffects: WasmEffect[] = [];
  private masterEffects: WasmEffect[] = [];
  private channelSignature = "";
  private masterSignature = "";
  constructor(
    readonly core: WasmCore,
    private rate: number,
    state: Session,
  ) {
    this.buffer = core.allocate(4096 * 2 * 4);
    this.channel = core.api.sontrama_bus_create(rate);
    this.master = core.api.sontrama_bus_create(rate);
    if (!this.channel || !this.master)
      throw new Error("Could not initialize mixer");
    this.configure(state);
  }
  private chain(
    specs: Effect[],
    current: WasmEffect[],
    previous: string,
    reset: boolean,
  ): [WasmEffect[], string] {
    const signature = JSON.stringify(
      specs.map(({ id, kind, enabled }) => [id, kind, enabled]),
    );
    const enabled = specs.filter((spec) => spec.enabled);
    if (reset || signature !== previous) {
      current.forEach((effect) => effect.close());
      current = enabled.map(
        (spec) =>
          new WasmEffect(this.core, this.rate, spec.kind, effectVector(spec)),
      );
    } else
      enabled.forEach((spec, index) =>
        current[index].configure(effectVector(spec)),
      );
    return [current, signature];
  }
  configure(state: Session, reset = false) {
    [this.channelEffects, this.channelSignature] = this.chain(
      state.effects,
      this.channelEffects,
      this.channelSignature,
      reset,
    );
    [this.masterEffects, this.masterSignature] = this.chain(
      state.master_effects,
      this.masterEffects,
      this.masterSignature,
      reset,
    );
    this.core.api.sontrama_bus_configure(
      this.channel,
      state.volume,
      state.pan,
      Number(state.mute),
    );
    this.core.api.sontrama_bus_configure(
      this.master,
      state.master,
      state.master_pan,
      Number(state.master_mute),
    );
  }
  process(
    left: Float32Array | undefined,
    right: Float32Array | undefined,
    outputs: Float32Array[][],
  ) {
    const frames = outputs[0][0].length;
    if (frames > 4096)
      throw new Error("Audio block exceeds shared DSP capacity");
    let data = this.core.floats(this.buffer, frames * 2);
    for (let i = 0; i < frames; i++) {
      data[i * 2] = left?.[i] ?? 0;
      data[i * 2 + 1] = right?.[i] ?? left?.[i] ?? 0;
    }
    this.channelEffects.forEach((effect) =>
      effect.process(this.buffer, frames),
    );
    this.core.api.sontrama_bus_process(
      this.channel,
      this.buffer,
      this.buffer,
      frames,
    );
    data = this.core.floats(this.buffer, frames * 2);
    for (let i = 0; i < frames; i++) {
      outputs[1][0][i] = data[i * 2];
      outputs[1][1][i] = data[i * 2 + 1];
    }
    this.masterEffects.forEach((effect) => effect.process(this.buffer, frames));
    this.core.api.sontrama_bus_process(
      this.master,
      this.buffer,
      this.buffer,
      frames,
    );
    for (let i = 0; i < frames; i++) {
      outputs[2][0][i] = data[i * 2];
      outputs[2][1][i] = data[i * 2 + 1];
    }
    this.core.api.sontrama_clip(this.buffer, this.buffer, frames);
    for (let i = 0; i < frames; i++) {
      outputs[0][0][i] = data[i * 2];
      outputs[0][1][i] = data[i * 2 + 1];
    }
  }
  close() {
    [...this.channelEffects, ...this.masterEffects].forEach((effect) =>
      effect.close(),
    );
    this.core.api.sontrama_bus_free(this.channel);
    this.core.api.sontrama_bus_free(this.master);
    this.core.api.free(this.buffer);
  }
}
