import type { Session } from "./types";
export interface VoiceEngine {
  readonly node: AudioNode;
  readonly ready: boolean;
  configure(state: Session): Promise<void>;
  midi(data: number[]): void;
  panic(): void;
  close(): void;
}
