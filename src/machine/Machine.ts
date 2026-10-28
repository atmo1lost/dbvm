// Backend-agnostic VM interface. v86 is the first implementation; QEMU-Wasm
// and Linux/Wasm backends should be able to slot in behind the same surface.

export type MachineState = "loading" | "ready" | "running" | "stopped" | "error";

export interface MachineEvents {
  state: MachineState;
  progress: { file: string; loaded: number; total: number };
  "serial-out": string;
  "screen-size": { width: number; height: number; graphical: boolean };
  /** One line received from the guest agent channel (without the newline). */
  agent: string;
}

export interface Machine {
  readonly state: MachineState;

  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): void;
  destroy(): Promise<void>;

  saveState(): Promise<ArrayBuffer>;
  restoreState(state: ArrayBuffer): Promise<void>;

  sendSerial(text: string): void;
  /** Send one line to the guest agent. */
  sendAgent(line: string): void;
  /** Write a file into the guest filesystem (absolute guest path). */
  createFile(path: string, data: Uint8Array): Promise<void>;
  /** Press and release keys, given as PS/2 set 1 scancode sequences. */
  sendScancodes(codes: number[]): void;
  goFullscreen(): void;

  on<K extends keyof MachineEvents>(event: K, fn: (value: MachineEvents[K]) => void): () => void;
}

export class Emitter<E> {
  private listeners = new Map<keyof E, Set<(value: never) => void>>();

  on<K extends keyof E>(event: K, fn: (value: E[K]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(fn as (value: never) => void);
    return () => set.delete(fn as (value: never) => void);
  }

  emit<K extends keyof E>(event: K, value: E[K]): void {
    this.listeners.get(event)?.forEach((fn) => (fn as (value: E[K]) => void)(value));
  }
}
