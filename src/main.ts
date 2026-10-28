import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { HostAgent } from "./agent";
import { V86Machine } from "./machine/V86Machine";
import { selectedProfile } from "./profiles";
import { clearSession, loadSession, saveSession } from "./session";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const status = $("status");
const buttons = {
  save: $<HTMLButtonElement>("btn-save"),
  reset: $<HTMLButtonElement>("btn-reset"),
  restart: $<HTMLButtonElement>("btn-restart"),
  fullscreen: $<HTMLButtonElement>("btn-fullscreen"),
};

// Screen / Serial tabs.
const views = { screen: $("screen"), serial: $("serial") };
document.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((tab) => {
  tab.onclick = () => {
    const view = tab.dataset.view as keyof typeof views;
    for (const [name, el] of Object.entries(views)) el.hidden = name !== view;
    document.querySelectorAll("[data-view]").forEach((t) => t.classList.toggle("active", t === tab));
  };
});

let statusTimer = 0;
function notify(msg: string, ms = 4000): void {
  status.textContent = msg;
  clearTimeout(statusTimer);
  if (ms) statusTimer = window.setTimeout(() => (status.textContent = machine?.state ?? ""), ms);
}

const [profileId, profile] = selectedProfile();
$("profile").textContent = profile.name;

// A saved session (if any, and taken on this image build) replaces the shipped snapshot.
const imageVersion = profile.versionUrl
  ? await fetch(profile.versionUrl, { cache: "no-store" }).then((r) => (r.ok ? r.text() : null)).catch(() => null)
  : null;
let session: ArrayBuffer | null = null;
if (imageVersion) {
  notify("checking for a saved session…", 0);
  session = await loadSession(profileId, imageVersion).catch(() => null);
}

const machine = new V86Machine({
  ...profile,
  initialState: session ?? profile.initialState,
  screen: views.screen,
  serial: { container: views.serial, xterm: Terminal },
});
const agent = new HostAgent(machine, notify);
if (session) notify("resumed saved session");

// Exposed for debugging from the devtools console.
Object.assign(window, { machine, agent, profileId });

machine.on("progress", ({ file, loaded, total }) => {
  const pct = total ? Math.round((loaded / total) * 100) : 0;
  notify(`downloading ${file.split("/").pop()} ${pct}%`, 0);
});

machine.on("state", (state) => {
  notify(state, 0);
  const live = state === "running" || state === "stopped";
  buttons.save.disabled = !live || !imageVersion;
  buttons.reset.disabled = !imageVersion;
  buttons.restart.disabled = !live;
  buttons.fullscreen.disabled = !live;
});

machine.on("screen-size", ({ width, height, graphical }) => {
  if (graphical) notify(`running · ${width}×${height}`, 0);
});

// --- sessions -----------------------------------------------------------------

let saving: Promise<void> | null = null;
function save(reason: string): Promise<void> {
  if (!imageVersion || machine.state !== "running" || saving) return saving ?? Promise.resolve();
  notify(`saving session (${reason})…`, 0);
  saving = machine
    .saveState()
    .then((state) => saveSession(profileId, imageVersion, state))
    .then((info) => notify(`session saved · ${(info.bytes / 1048576).toFixed(0)} MB`))
    .catch((err) => notify(`saving failed: ${err instanceof Error ? err.message : err}`, 8000))
    .finally(() => (saving = null));
  return saving;
}

buttons.save.onclick = () => save("manual");
buttons.reset.onclick = async () => {
  if (!confirm("Discard the saved session and start from a fresh desktop?")) return;
  await clearSession(profileId);
  location.reload();
};

// Autosave every 5 minutes and whenever the tab is hidden (switching away, closing).
setInterval(() => save("auto"), 5 * 60_000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") save("tab hidden");
});

// --- file drop ----------------------------------------------------------------

const dropTarget = $("screen");
dropTarget.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropTarget.classList.add("dropping");
});
dropTarget.addEventListener("dragleave", () => dropTarget.classList.remove("dropping"));
dropTarget.addEventListener("drop", async (e) => {
  e.preventDefault();
  dropTarget.classList.remove("dropping");
  const dropped = [...(e.dataTransfer?.files ?? [])];
  for (const file of dropped) {
    const name = file.name.replace(/[/\0]/g, "_");
    notify(`copying ${name} into the VM…`, 0);
    await machine.createFile(`/root/Downloads/${name}`, new Uint8Array(await file.arrayBuffer()));
  }
  if (dropped.length) {
    agent.rescan();
    notify(`${dropped.length} file${dropped.length > 1 ? "s" : ""} copied to ~/Downloads`);
  }
});

buttons.restart.onclick = () => machine.restart();
buttons.fullscreen.onclick = () => machine.goFullscreen();
