import { V86Machine } from "./machine/V86Machine";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const status = $("status");
const buttons = {
  save: $<HTMLButtonElement>("btn-save"),
  restore: $<HTMLButtonElement>("btn-restore"),
  restart: $<HTMLButtonElement>("btn-restart"),
  fullscreen: $<HTMLButtonElement>("btn-fullscreen"),
};

// Phase 0: stock v86 Buildroot kernel (busybox initramfs, boots to a shell).
const machine = new V86Machine({
  screen: $("screen"),
  memoryMB: 128,
  bzimage: `${import.meta.env.BASE_URL}images/buildroot-bzimage68.bin`,
  cmdline: "tsc=reliable mitigations=off random.trust_cpu=on",
});

// Exposed for debugging from the devtools console.
(window as unknown as { machine: V86Machine }).machine = machine;

let savedState: ArrayBuffer | null = null;

machine.on("progress", ({ file, loaded, total }) => {
  const pct = total ? Math.round((loaded / total) * 100) : 0;
  status.textContent = `downloading ${file.split("/").pop()} ${pct}%`;
});

machine.on("state", (state) => {
  status.textContent = state;
  const live = state === "running" || state === "stopped";
  buttons.save.disabled = !live;
  buttons.restart.disabled = !live;
  buttons.fullscreen.disabled = !live;
  buttons.restore.disabled = !live || !savedState;
});

machine.on("screen-size", ({ width, height, graphical }) => {
  if (graphical) status.textContent = `running · ${width}×${height}`;
});

buttons.save.onclick = async () => {
  savedState = await machine.saveState();
  buttons.restore.disabled = false;
  status.textContent = `saved state (${(savedState.byteLength / 1024 / 1024).toFixed(1)} MB)`;
};

buttons.restore.onclick = async () => {
  if (savedState) await machine.restoreState(savedState);
};

buttons.restart.onclick = () => machine.restart();
buttons.fullscreen.onclick = () => machine.goFullscreen();
