#!/usr/bin/env node
// Boot the Alpine guest headlessly in Node, wait until the desktop (X + JWM) is up,
// and save a v86 state snapshot so the browser restores straight into it.
// The first boot also runs the deferred package scripts, so the snapshot includes them.
//
// Must use the same v86 build as the browser (both come from node_modules/v86).
// Output: $DBVM_CACHE/images/alpine/state.bin.zst

import { execFileSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import url from "node:url";
import { V86 } from "v86";

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const CACHE = process.env.DBVM_CACHE ?? path.join(homedir(), "Library/Caches/dbvm");
const IMAGES = path.join(CACHE, "images/alpine");
const OUT = path.join(IMAGES, "state.bin");

// Keep in sync with the "alpine" profile in src/profiles.ts.
const emulator = new V86({
  wasm_path: path.join(ROOT, "node_modules/v86/build/v86.wasm"),
  memory_size: 512 * 1024 * 1024,
  vga_memory_size: 8 * 1024 * 1024,
  bios: { url: path.join(ROOT, "public/bios/seabios.bin") },
  vga_bios: { url: path.join(ROOT, "public/bios/vgabios.bin") },
  bzimage: { url: path.join(IMAGES, "vmlinuz-virt") },
  initrd: { url: path.join(IMAGES, "initramfs.img") },
  cmdline: "console=tty0 console=ttyS0,115200 quiet video=1024x768 tsc=reliable mitigations=off random.trust_cpu=on",
  filesystem: { basefs: path.join(IMAGES, "fs.json"), baseurl: path.join(IMAGES, "rootfs") + "/" },
  // Same devices as the browser (state is device-specific). The browser uses the
  // wisp relay; here the fetch backend just answers the guest's DHCP.
  net_device: { type: "virtio", relay_url: "fetch" },
  uart1: true,
  autostart: true,
});

const started = Date.now();
const timeout = setTimeout(() => {
  console.error("timed out waiting for the shell prompt");
  process.exit(1);
}, 600_000);

let serial = "";
let booted = false;
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;

emulator.add_listener("serial0-output-byte", (byte) => {
  serial += String.fromCharCode(byte);
  if (!booted && serial.endsWith("root@dbvm:~# ")) {
    booted = true;
    console.log(`shell prompt after ${elapsed()}, waiting for the desktop…`);
    // The marker is computed so the echoed command line doesn't match it.
    emulator.serial0_send("while ! pgrep -x jwm >/dev/null; do sleep 1; done; sleep 8; echo DESKTOP-$((6*7))\n");
    return;
  }
  if (!booted || !serial.endsWith("DESKTOP-42\r\n")) return;
  console.log(`desktop up after ${elapsed()}, settling…`);

  // Drop page cache so the snapshot is small, and clear the serial screen for a clean restore.
  emulator.serial0_send("sync; echo 3 > /proc/sys/vm/drop_caches; clear\n");
  setTimeout(async () => {
    const state = await emulator.save_state();
    await emulator.destroy();
    clearTimeout(timeout);
    writeFileSync(OUT, new Uint8Array(state));
    rmSync(`${OUT}.zst`, { force: true });
    execFileSync("nice", ["-n", "10", "zstd", "-q", "-15", "-T2", "--rm", OUT], { stdio: "inherit" });
    console.log(`saved ${OUT}.zst (${(state.byteLength / 1048576).toFixed(1)} MB raw)`);
    process.exit(0);
  }, 5000);
});
