// Browser side of the guest agent protocol (see guest/overlay/usr/libexec/dbvm/agent).
// Keeps the guest clock in sync and bridges the clipboard both ways.

import type { Machine } from "./machine/Machine";

const encodeB64 = (text: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text)));
const decodeB64 = (b64: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));

// PS/2 set 1: Shift down, Insert down/up (extended), Shift up. Shift+Insert
// pastes in xterm and GTK apps alike.
const SHIFT_INSERT = [0x2a, 0xe0, 0x52, 0xe0, 0xd2, 0xaa];

export class HostAgent {
  private pendingHostCopy: string | null = null;

  constructor(
    private machine: Machine,
    private notify: (msg: string) => void,
  ) {
    machine.on("agent", (line) => this.onLine(line));
    machine.on("state", (s) => s === "running" && setTimeout(() => this.syncTime(), 500));

    // Snapshots resume with the clock they were taken at; keep it current.
    setInterval(() => this.syncTime(), 60_000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.syncTime();
    });

    // Writing to the host clipboard needs focus; retry a pending copy on the next interaction.
    const flush = () => this.pendingHostCopy !== null && this.copyToHost(this.pendingHostCopy);
    window.addEventListener("focus", flush);
    window.addEventListener("pointerdown", flush);

    this.interceptPaste();
  }

  syncTime(): void {
    if (this.machine.state === "running") this.machine.sendAgent(`time ${Math.floor(Date.now() / 1000)}`);
  }

  rescan(): void {
    this.machine.sendAgent("rescan");
  }

  /** Put text on the guest clipboard (and PRIMARY selection). */
  setGuestClipboard(text: string): void {
    this.machine.sendAgent(`clip ${encodeB64(text)}`);
  }

  private onLine(line: string): void {
    const [cmd, arg = ""] = line.split(" ", 2);
    if (cmd === "clip") this.copyToHost(decodeB64(arg));
  }

  private async copyToHost(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.pendingHostCopy = null;
    } catch {
      this.pendingHostCopy = text;
    }
  }

  // v86 swallows every key, so the browser never fires "paste" for Cmd+V.
  // Catch Cmd+V (macOS) / Ctrl+Shift+V first, let the paste event happen, then
  // hand the text to the guest and press Shift+Insert there. Going through the
  // clipboard avoids typing it as keystrokes, which overflows the guest's input
  // buffer for anything longer than a few characters.
  private interceptPaste(): void {
    window.addEventListener(
      "keydown",
      (e) => {
        const isPaste = e.key.toLowerCase() === "v" && (e.metaKey || (e.ctrlKey && e.shiftKey));
        if (isPaste && this.machine.state === "running") e.stopImmediatePropagation();
      },
      { capture: true },
    );
    window.addEventListener("paste", (e) => {
      const text = e.clipboardData?.getData("text/plain");
      if (!text || this.machine.state !== "running") return;
      e.preventDefault();
      this.setGuestClipboard(text);
      setTimeout(() => this.machine.sendScancodes(SHIFT_INSERT), 400);
      this.notify(`pasted ${text.length} characters`);
    });
  }
}
