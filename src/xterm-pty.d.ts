// Minimal types for xterm-pty 0.10 (UMD, ships no declarations). Its Slave is
// handed to QEMU-Wasm, whose build links xterm-pty's emscripten-pty.js.
declare module "xterm-pty" {
  import type { ITerminalAddon } from "@xterm/xterm";

  export interface Slave {
    readonly readable: boolean;
    readonly writable: boolean;
  }

  export function openpty(): { master: ITerminalAddon; slave: Slave };
}
