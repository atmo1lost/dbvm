// 64-bit backend: QEMU (qemu-system-x86_64) compiled to WebAssembly, built in
// CI with dbvm's "-display wasm" patch (qemu/patches/0001-ui-wasm-canvas-display.patch).
//
// Display: QEMU converts its console surface to RGBA in shared wasm memory and
// bumps a frame counter (WasmDisplayInfo in ui/wasm.c). We copy new frames onto
// a <canvas> each animation frame.
// Input: keyboard (PC scancode numbers) and absolute pointer events are pushed
// into a ring that QEMU drains on its display refresh.
// Disk: the ext4 image is read lazily over HTTP range requests (see
// mountHttpFile) with QEMU's snapshot=on, so guest writes stay in memory and
// the image is never modified.
//
// Needs cross-origin isolation (COOP/COEP) for SharedArrayBuffer + threads.

import type { Terminal } from "@xterm/xterm";
import { openpty } from "xterm-pty";
import { Emitter, type Machine, type MachineEvents, type MachineState } from "./Machine";

export interface QemuMachineConfig {
  screen: HTMLElement;
  serial: { container: HTMLElement; xterm: typeof Terminal };
  /** Directory with qemu-system-x86_64.{js,wasm,worker.js} and rom/. */
  qemuUrl: string;
  kernel: string;
  initrd: string;
  disk: string;
  cmdline: string;
  memoryMB?: number;
}

// Must match WASM_EV_* in ui/wasm.c.
const EV = { KEY: 1, ABS: 2, BTN: 3 } as const;
// QAPI InputButton order.
const BUTTON = { left: 0, middle: 1, right: 2, wheelUp: 3, wheelDown: 4 } as const;
const ROMS = ["bios-256k.bin", "vgabios-stdvga.bin", "kvmvapic.bin", "linuxboot_dma.bin", "efi-virtio.rom"];

interface EmscriptenModule {
  HEAPU8: Uint8Array;
  FS: {
    mkdir(path: string): void;
    writeFile(path: string, data: Uint8Array): void;
    createFile(parent: string, name: string, properties: object, canRead: boolean, canWrite: boolean): FSNode;
  };
  TTY: { stream_ops: { poll: (stream: unknown, timeout: number) => number } };
  _dbvm_display_info(): number;
  _dbvm_input_push(type: number, a: number, b: number): number;
}

interface FSNode {
  contents: unknown;
  stream_ops: Record<string, unknown>;
}

const DISK_CHUNK = 1 << 20;

/**
 * A read-only file whose bytes are fetched from `url` in 1 MB chunks on first
 * access and cached. This build services filesystem calls on the browser's
 * main thread, where Emscripten's createLazyFile refuses to run (it only allows
 * synchronous binary XHR in workers). Main-thread sync XHR still works when the
 * body is read as text with the x-user-defined charset (one char per byte).
 * Each chunk briefly blocks the page, which is fine for a localhost or CDN disk.
 */
function mountHttpFile(mod: EmscriptenModule, dir: string, name: string, url: string, size: number): void {
  const chunks = new Map<number, Uint8Array>();
  const chunk = (index: number): Uint8Array => {
    let data = chunks.get(index);
    if (data) return data;
    const start = index * DISK_CHUNK;
    const end = Math.min(size, start + DISK_CHUNK) - 1;
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url, false);
    xhr.setRequestHeader("Range", `bytes=${start}-${end}`);
    xhr.overrideMimeType("text/plain; charset=x-user-defined");
    xhr.send();
    if (xhr.status !== 206 && xhr.status !== 200) throw new Error(`${url}: HTTP ${xhr.status}`);
    const text = xhr.responseText;
    data = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) data[i] = text.charCodeAt(i) & 0xff;
    chunks.set(index, data);
    return data;
  };

  const node = mod.FS.createFile(dir, name, { isDevice: false }, true, false);
  // Truthy contents stop Emscripten from trying to "force load" the file.
  node.contents = { length: size };
  Object.defineProperty(node, "usedBytes", { get: () => size });
  node.stream_ops = {
    ...node.stream_ops,
    read(_stream: unknown, buffer: Int8Array, offset: number, length: number, position: number): number {
      if (position >= size) return 0;
      const total = Math.min(length, size - position);
      let done = 0;
      while (done < total) {
        const pos = position + done;
        const data = chunk(Math.floor(pos / DISK_CHUNK));
        const from = pos % DISK_CHUNK;
        const n = Math.min(total - done, data.length - from);
        buffer.set(data.subarray(from, from + n), offset + done);
        done += n;
      }
      return total;
    },
  };
}

export class QemuMachine implements Machine {
  private events = new Emitter<MachineEvents>();
  private _state: MachineState = "loading";
  private module: EmscriptenModule | null = null;
  private canvas = document.createElement("canvas");
  private ctx = this.canvas.getContext("2d")!;
  private term: Terminal;
  private frame = -1;
  private image: ImageData | null = null;

  constructor(private config: QemuMachineConfig) {
    this.term = new config.serial.xterm({ convertEol: false });
    this.term.open(config.serial.container);

    // Replace the v86 screen contents with our canvas.
    config.screen.replaceChildren(this.canvas);
    this.canvas.tabIndex = 0;
    this.canvas.style.display = "block";
    this.canvas.style.outline = "none";
    this.bindInput();
    this.boot().catch((err) => {
      console.error(err);
      this.term.write(`\r\n[dbvm] QEMU failed to start: ${err instanceof Error ? err.message : err}\r\n`);
      this.setState("error");
    });
  }

  get state(): MachineState {
    return this._state;
  }

  private setState(state: MachineState): void {
    this._state = state;
    this.events.emit("state", state);
  }

  private async fetchBytes(url: string): Promise<Uint8Array> {
    this.events.emit("progress", { file: url, loaded: 0, total: 0 });
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  private async boot(): Promise<void> {
    if (!crossOriginIsolated) throw new Error("page is not cross-origin isolated (COOP/COEP headers missing)");
    const { qemuUrl, kernel, initrd, disk, cmdline } = this.config;

    const diskUrl = new URL(disk, location.href).href;
    const diskHead = await fetch(diskUrl, { method: "HEAD" });
    const diskSize = Number(diskHead.headers.get("Content-Length"));
    if (!diskHead.ok || !diskSize) throw new Error(`${disk}: can't determine size (HTTP ${diskHead.status})`);

    const [kernelData, initrdData, ...roms] = await Promise.all([
      this.fetchBytes(kernel),
      this.fetchBytes(initrd),
      ...ROMS.map((rom) => this.fetchBytes(`${qemuUrl}/rom/${rom}`)),
    ]);

    // xterm-pty bridges QEMU's stdio (serial console) to the Serial tab.
    const { master, slave } = openpty();
    this.term.loadAddon(master);

    const scriptUrl = new URL(`${qemuUrl}/qemu-system-x86_64.js`, location.href).href;
    const moduleConfig = {
      pty: slave,
      mainScriptUrlOrBlob: scriptUrl,
      locateFile: (path: string) => new URL(`${qemuUrl}/${path}`, location.href).href,
      arguments: [
        "-M", "pc", "-m", `${this.config.memoryMB ?? 1024}M`,
        "-accel", "tcg,tb-size=500",
        "-L", "/rom",
        "-display", "wasm", "-vga", "std",
        "-serial", "stdio", "-monitor", "none", "-parallel", "none",
        "-nic", "none",
        "-kernel", "/boot/vmlinuz-virt",
        "-initrd", "/boot/initramfs.img",
        "-append", cmdline,
        "-drive", "id=root,file=/disk/disk.img,format=raw,if=none,snapshot=on",
        "-device", "virtio-blk-pci,drive=root",
        "-device", "virtio-tablet-pci",
      ],
      preRun: [
        (mod: EmscriptenModule) => {
          mod.FS.mkdir("/rom");
          ROMS.forEach((rom, i) => mod.FS.writeFile(`/rom/${rom}`, roms[i]));
          mod.FS.mkdir("/boot");
          mod.FS.writeFile("/boot/vmlinuz-virt", kernelData);
          mod.FS.writeFile("/boot/initramfs.img", initrdData);
          // snapshot=on keeps the guest's disk writes in a temp overlay under /var/tmp.
          for (const dir of ["/var", "/var/tmp"]) {
            try {
              mod.FS.mkdir(dir);
            } catch {
              // already exists
            }
          }
          mod.FS.mkdir("/disk");
          mountHttpFile(mod, "/disk", "disk.img", diskUrl, diskSize);
        },
      ],
    };

    this.events.emit("progress", { file: "qemu-system-x86_64.wasm", loaded: 0, total: 0 });
    const { default: init } = await import(/* @vite-ignore */ scriptUrl);
    const mod: EmscriptenModule = await init(moduleConfig);
    this.module = mod;

    // From ktock's examples: don't block on the TTY while the pty has no input.
    const poll = mod.TTY.stream_ops.poll;
    mod.TTY.stream_ops.poll = (stream, timeout) =>
      slave.readable ? poll.call(mod.TTY.stream_ops, stream, timeout) : (slave.writable ? 4 : 0);

    this.setState("running");
    requestAnimationFrame(() => this.draw());
  }

  private draw(): void {
    const mod = this.module;
    if (!mod) return;
    const info = new Uint32Array(mod.HEAPU8.buffer, mod._dbvm_display_info(), 4);
    const frame = Atomics.load(info, 0);
    const [width, height, ptr] = [info[1], info[2], info[3]];
    if (frame !== this.frame && width && height && ptr) {
      this.frame = frame;
      if (!this.image || this.image.width !== width || this.image.height !== height) {
        this.canvas.width = width;
        this.canvas.height = height;
        this.image = this.ctx.createImageData(width, height);
        this.events.emit("screen-size", { width, height, graphical: true });
      }
      // ImageData can't wrap shared memory, so copy the frame out.
      this.image.data.set(mod.HEAPU8.subarray(ptr, ptr + width * height * 4));
      this.ctx.putImageData(this.image, 0, 0);
    }
    requestAnimationFrame(() => this.draw());
  }

  private push(type: number, a: number, b: number): void {
    this.module?._dbvm_input_push(type, a, b);
  }

  private bindInput(): void {
    const c = this.canvas;
    const point = (e: MouseEvent) => {
      const r = c.getBoundingClientRect();
      const x = Math.round(((e.clientX - r.left) / r.width) * c.width);
      const y = Math.round(((e.clientY - r.top) / r.height) * c.height);
      this.push(EV.ABS, Math.max(0, Math.min(c.width - 1, x)), Math.max(0, Math.min(c.height - 1, y)));
    };
    c.addEventListener("mousemove", point);
    c.addEventListener("mousedown", (e) => {
      c.focus();
      point(e);
      this.push(EV.BTN, e.button, 1);
      e.preventDefault();
    });
    c.addEventListener("mouseup", (e) => {
      point(e);
      this.push(EV.BTN, e.button, 0);
      e.preventDefault();
    });
    c.addEventListener("contextmenu", (e) => e.preventDefault());
    c.addEventListener(
      "wheel",
      (e) => {
        const btn = e.deltaY < 0 ? BUTTON.wheelUp : BUTTON.wheelDown;
        this.push(EV.BTN, btn, 1);
        this.push(EV.BTN, btn, 0);
        e.preventDefault();
      },
      { passive: false },
    );

    const key = (down: boolean) => (e: KeyboardEvent) => {
      const num = KEY_NUMBERS[e.code];
      if (num === undefined) return;
      this.push(EV.KEY, num, down ? 1 : 0);
      e.preventDefault();
    };
    c.addEventListener("keydown", key(true));
    c.addEventListener("keyup", key(false));
    // Release everything if focus leaves mid-press, so no key sticks down.
    c.addEventListener("blur", () => {
      for (const num of Object.values(KEY_NUMBERS)) this.push(EV.KEY, num, 0);
    });
  }

  start(): Promise<void> {
    return Promise.resolve();
  }

  stop(): Promise<void> {
    return Promise.reject(new Error("pausing the QEMU backend isn't supported yet"));
  }

  restart(): void {
    location.reload();
  }

  destroy(): Promise<void> {
    return Promise.reject(new Error("destroying the QEMU backend isn't supported yet"));
  }

  saveState(): Promise<ArrayBuffer> {
    return Promise.reject(new Error("saved sessions aren't supported on the QEMU backend yet"));
  }

  restoreState(): Promise<void> {
    return Promise.reject(new Error("saved sessions aren't supported on the QEMU backend yet"));
  }

  // Feed serial input a few bytes at a time: a burst larger than the emulated
  // UART's 16-byte FIFO makes xterm-pty's blocking read stall QEMU's main loop.
  private serialQueue = Promise.resolve();
  sendSerial(text: string): void {
    for (let i = 0; i < text.length; i += 8) {
      const piece = text.slice(i, i + 8);
      this.serialQueue = this.serialQueue
        .then(() => this.term.input(piece, true))
        .then(() => new Promise((r) => setTimeout(r, 60)));
    }
  }

  sendAgent(): void {
    // No agent channel on the QEMU backend yet.
  }

  createFile(): Promise<void> {
    return Promise.reject(new Error("file drop isn't supported on the QEMU backend yet"));
  }

  sendScancodes(): void {
    // Not needed without the agent's paste path.
  }

  goFullscreen(): void {
    this.canvas.requestFullscreen().catch(() => {});
  }

  on<K extends keyof MachineEvents>(event: K, fn: (value: MachineEvents[K]) => void): () => void {
    return this.events.on(event, fn);
  }
}

// KeyboardEvent.code -> QEMU key number (PC scan code set 1; 0x80 | code for E0-prefixed keys).
const KEY_NUMBERS: Record<string, number> = {
  Escape: 0x01, Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05, Digit5: 0x06,
  Digit6: 0x07, Digit7: 0x08, Digit8: 0x09, Digit9: 0x0a, Digit0: 0x0b, Minus: 0x0c,
  Equal: 0x0d, Backspace: 0x0e, Tab: 0x0f, KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13,
  KeyT: 0x14, KeyY: 0x15, KeyU: 0x16, KeyI: 0x17, KeyO: 0x18, KeyP: 0x19, BracketLeft: 0x1a,
  BracketRight: 0x1b, Enter: 0x1c, ControlLeft: 0x1d, KeyA: 0x1e, KeyS: 0x1f, KeyD: 0x20,
  KeyF: 0x21, KeyG: 0x22, KeyH: 0x23, KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26, Semicolon: 0x27,
  Quote: 0x28, Backquote: 0x29, ShiftLeft: 0x2a, Backslash: 0x2b, KeyZ: 0x2c, KeyX: 0x2d,
  KeyC: 0x2e, KeyV: 0x2f, KeyB: 0x30, KeyN: 0x31, KeyM: 0x32, Comma: 0x33, Period: 0x34,
  Slash: 0x35, ShiftRight: 0x36, NumpadMultiply: 0x37, AltLeft: 0x38, Space: 0x39,
  CapsLock: 0x3a, F1: 0x3b, F2: 0x3c, F3: 0x3d, F4: 0x3e, F5: 0x3f, F6: 0x40, F7: 0x41,
  F8: 0x42, F9: 0x43, F10: 0x44, NumLock: 0x45, ScrollLock: 0x46, Numpad7: 0x47,
  Numpad8: 0x48, Numpad9: 0x49, NumpadSubtract: 0x4a, Numpad4: 0x4b, Numpad5: 0x4c,
  Numpad6: 0x4d, NumpadAdd: 0x4e, Numpad1: 0x4f, Numpad2: 0x50, Numpad3: 0x51,
  Numpad0: 0x52, NumpadDecimal: 0x53, IntlBackslash: 0x56, F11: 0x57, F12: 0x58,
  NumpadEnter: 0x9c, ControlRight: 0x9d, NumpadDivide: 0xb5, PrintScreen: 0xb7,
  AltRight: 0xb8, Home: 0xc7, ArrowUp: 0xc8, PageUp: 0xc9, ArrowLeft: 0xcb,
  ArrowRight: 0xcd, End: 0xcf, ArrowDown: 0xd0, PageDown: 0xd1, Insert: 0xd2,
  Delete: 0xd3, MetaLeft: 0xdb, MetaRight: 0xdc, ContextMenu: 0xdd,
};
