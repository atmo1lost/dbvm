import { V86, type V86Image } from "v86";
import wasmUrl from "v86/build/v86.wasm?url";
import { Emitter, type Machine, type MachineEvents, type MachineState } from "./Machine";

export interface V86MachineConfig {
  screen: HTMLElement;
  /** Container for an xterm.js serial console on ttyS0. */
  serial?: { container: HTMLElement; xterm: Function };
  memoryMB?: number;
  vgaMemoryMB?: number;
  bzimage?: string;
  initrd?: string;
  cmdline?: string;
  /** Snapshot to resume from: a URL, or an in-memory state (e.g. a saved session). */
  initialState?: string | ArrayBuffer;
  /** Wisp relay for guest networking (virtio-net), e.g. "wisp://host/wisp/". */
  networkRelay?: string;
  /** Lazily-loaded 9p root: fs.json index + directory of content-addressed chunks. */
  rootfs?: { basefs: string; baseurl: string };
}

export class V86Machine implements Machine {
  private emulator: V86;
  private events = new Emitter<MachineEvents>();
  private _state: MachineState = "loading";

  constructor(config: V86MachineConfig) {
    const base = import.meta.env.BASE_URL;
    const image = (url: string): V86Image => ({ url });

    this.emulator = new V86({
      wasm_path: wasmUrl,
      memory_size: (config.memoryMB ?? 128) * 1024 * 1024,
      vga_memory_size: (config.vgaMemoryMB ?? 8) * 1024 * 1024,
      bios: image(`${base}bios/seabios.bin`),
      vga_bios: image(`${base}bios/vgabios.bin`),
      bzimage: config.bzimage ? image(config.bzimage) : undefined,
      initrd: config.initrd ? image(config.initrd) : undefined,
      cmdline: config.cmdline,
      initial_state:
        typeof config.initialState === "string"
          ? image(config.initialState)
          : config.initialState && { buffer: config.initialState },
      net_device: config.networkRelay ? { type: "virtio", relay_url: config.networkRelay } : undefined,
      // ttyS1 carries the guest agent protocol (guest/overlay/usr/libexec/dbvm/agent).
      uart1: true,
      // Without a rootfs this is an empty in-memory 9p share, mounted by the guest at /mnt.
      filesystem: config.rootfs ?? {},
      screen: { container: config.screen },
      serial_console: config.serial
        ? { type: "xtermjs", xterm_lib: config.serial.xterm, container: config.serial.container }
        : undefined,
      autostart: true,
    });

    this.emulator.add_listener("download-progress", (p) => {
      this.events.emit("progress", { file: p.file_name, loaded: p.loaded, total: p.total });
    });
    this.emulator.add_listener("download-error", () => this.setState("error"));
    this.emulator.add_listener("emulator-ready", () => this.setState("ready"));
    this.emulator.add_listener("emulator-started", () => this.setState("running"));
    this.emulator.add_listener("emulator-stopped", () => this.setState("stopped"));
    this.emulator.add_listener("serial0-output-byte", (byte) => {
      this.events.emit("serial-out", String.fromCharCode(byte));
    });
    let agentLine = "";
    this.emulator.add_listener("serial1-output-byte", (byte) => {
      if (byte === 0x0a) {
        this.events.emit("agent", agentLine.replace(/\r$/, ""));
        agentLine = "";
      } else {
        agentLine += String.fromCharCode(byte);
      }
    });
    this.emulator.add_listener("screen-set-size", ([width, height, bpp]) => {
      this.events.emit("screen-size", { width, height, graphical: bpp !== 0 });
    });
  }

  get state(): MachineState {
    return this._state;
  }

  private setState(state: MachineState): void {
    this._state = state;
    this.events.emit("state", state);
  }

  start(): Promise<void> {
    return this.emulator.run();
  }

  stop(): Promise<void> {
    return this.emulator.stop();
  }

  restart(): void {
    this.emulator.restart();
  }

  destroy(): Promise<void> {
    return this.emulator.destroy();
  }

  saveState(): Promise<ArrayBuffer> {
    return this.emulator.save_state();
  }

  restoreState(state: ArrayBuffer): Promise<void> {
    return this.emulator.restore_state(state);
  }

  sendSerial(text: string): void {
    this.emulator.serial0_send(text);
  }

  sendAgent(line: string): void {
    this.emulator.serial_send_bytes(1, new TextEncoder().encode(line + "\n"));
  }

  createFile(path: string, data: Uint8Array): Promise<void> {
    return this.emulator.create_file(path, data);
  }

  sendScancodes(codes: number[]): void {
    this.emulator.keyboard_send_scancodes(codes);
  }

  goFullscreen(): void {
    this.emulator.screen_go_fullscreen();
  }

  on<K extends keyof MachineEvents>(event: K, fn: (value: MachineEvents[K]) => void): () => void {
    return this.events.on(event, fn);
  }
}
