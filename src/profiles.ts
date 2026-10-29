import type { QemuMachineConfig } from "./machine/QemuMachine";
import type { V86MachineConfig } from "./machine/V86Machine";

export type V86Profile = Omit<V86MachineConfig, "screen" | "serial"> & {
  backend?: "v86";
  name: string;
  /** Text file whose content identifies the image build; enables saved sessions. */
  versionUrl?: string;
};

export type QemuProfile = Omit<QemuMachineConfig, "screen" | "serial"> & {
  backend: "qemu";
  name: string;
};

type Profile = V86Profile | QemuProfile;

const images = `${import.meta.env.BASE_URL}images`;
const v86Cmdline = "tsc=reliable mitigations=off random.trust_cpu=on";
const params = new URLSearchParams(location.search);

// Guest networking through the dev server's Wisp relay (server/wisp.ts). ?net=0 disables it.
const networkRelay =
  params.get("net") === "0"
    ? undefined
    : `${location.protocol === "https:" ? "wisps" : "wisp"}://${location.host}/wisp/`;

// dbvm's own Alpine i686 guest (tools/build-image.sh), root on lazy-loaded 9p.
// Keep in sync with tools/build-state.mjs, which snapshots this exact machine.
const alpineCold: V86Profile = {
  name: "Alpine Linux (cold boot)",
  memoryMB: 512,
  bzimage: `${images}/alpine/vmlinuz-virt`,
  initrd: `${images}/alpine/initramfs.img`,
  cmdline: `console=tty0 console=ttyS0,115200 quiet video=1024x768 ${v86Cmdline}`,
  rootfs: { basefs: `${images}/alpine/fs.json`, baseurl: `${images}/alpine/rootfs/` },
  networkRelay,
  versionUrl: `${images}/alpine/version`,
};

export const profiles: Record<string, Profile> = {
  // Restores the snapshot from tools/build-state.mjs: lands on the running desktop.
  alpine: { ...alpineCold, name: "Alpine Linux", initialState: `${images}/alpine/state.bin.zst` },
  "alpine-cold": alpineCold,
  // 64-bit Alpine (x86_64) with Flatpak on QEMU-Wasm. Built in CI; fetch with
  // tools/fetch-qemu-artifacts.sh.
  alpine64: {
    backend: "qemu",
    name: "Alpine Linux 64-bit (QEMU)",
    qemuUrl: `${images}/qemu`,
    kernel: `${images}/alpine64/vmlinuz-virt`,
    initrd: `${images}/alpine64/initramfs.img`,
    disk: `${images}/alpine64/disk.img`,
    cmdline: "console=ttyS0,115200 quiet video=1024x768 random.trust_cpu=on",
    memoryMB: 768,
  },
  // Stock v86 Buildroot kernel with a busybox initramfs (Phase 0 smoke test).
  buildroot: {
    name: "Buildroot (v86 stock)",
    memoryMB: 128,
    bzimage: `${images}/buildroot-bzimage68.bin`,
    cmdline: v86Cmdline,
  },
};

export function selectedProfile(): [string, Profile] {
  const id = params.get("profile") ?? "alpine";
  return id in profiles ? [id, profiles[id]] : ["alpine", profiles.alpine];
}
