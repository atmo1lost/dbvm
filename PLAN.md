# dbvm — desktop browser virtual machine

Goal: open a URL, get a real Linux desktop (window manager, terminal, file manager, a few apps) running **entirely client-side** in the browser, with persistence, clipboard, and optional networking.

Disk budget for this repo: **5 GB max** (refs + images + build outputs). Currently ~0.9 GB of reference clones.

---

## 1. Approaches considered

| Approach | How it works | Verdict |
|---|---|---|
| **v86** (`refs/emulators/v86`) | x86 (32-bit, ~P4/SSE3) emulator, JIT to Wasm. VGA/VBE framebuffer, PS/2, SB16, virtio-9p/net, save/restore state. BSD-2. | **Primary.** Open source, mature, proven to run Arch/Buildroot with X. Snapshots give instant boot. |
| **QEMU-Wasm** (`refs/emulators/qemu-wasm`) | Real QEMU compiled with Emscripten, TCG JIT, multithreaded. x86_64 guests. | **Experimental track.** More capable (64-bit, SMP) but heavy, needs COOP/COEP + SharedArrayBuffer, complex build. |
| **container2wasm** (`refs/emulators/container2wasm`) | Packages a container image + emulator (Bochs/TinyEMU/QEMU) into Wasm. | Reference for packaging + browser network stack (`c2w-net-proxy` via gvisor-tap-vsock). |
| **Linux/Wasm native** (`refs/emulators/linux-wasm`) | Linux kernel compiled *to* Wasm, no CPU emulation. No MMU yet, userspace must be recompiled. | **Watch.** Fastest in theory, not desktop-ready (no MMU/ELF/virtio). |
| **TinyEMU** (`refs/emulators/TinyEMU`) | Bellard's RISC-V/x86 emulator, small and clean. | Reference only. |
| **WebVM / CheerpX** (`refs/emulators/webvm`) | Proprietary x86 JIT; WebVM already ships an Alpine+Xorg desktop. | **Reference only** — CheerpX can't be self-hosted or used by orgs without a commercial licence. Great UX benchmark. |
| **Browsix** (`refs/emulators/browsix`) | Unix-in-JS processes. | Historical reference; no real desktop path. |

**Decision:** build the MVP on v86 with a small 32-bit x86 Linux guest running X11 + a lightweight WM. Keep the guest/host interface abstract (`Machine` interface) so QEMU-Wasm can be swapped in later for 64-bit/SMP.

---

## 2. Architecture

```
┌──────────────────────────── Browser tab ────────────────────────────┐
│  dbvm web app (TypeScript + Vite)                                   │
│  ┌───────────────┐  ┌────────────────┐  ┌────────────────────────┐  │
│  │ Display layer │  │ Host shell UI  │  │ Storage                │  │
│  │ canvas from   │  │ boot screen,   │  │ - base image: HTTP     │  │
│  │ VGA/VBE fb,   │  │ settings, file │  │   range/chunked, cache │  │
│  │ scaling, HiDPI│  │ drop, snapshots│  │   in Cache API         │  │
│  └──────▲────────┘  └──────┬─────────┘  │ - writes: overlay in   │  │
│         │                  │            │   IndexedDB / OPFS     │  │
│  ┌──────┴──────────────────▼──────┐     │ - state snapshots      │  │
│  │ Machine (Web Worker)           │◄───►│   (zstd) in OPFS       │  │
│  │  v86 core (Wasm JIT)           │     └────────────────────────┘  │
│  │  devices: VBE, PS/2, SB16,     │                                 │
│  │  virtio-9p, virtio-net, serial │     ┌────────────────────────┐  │
│  └──────┬─────────────────────────┘     │ Network backend        │  │
│         │ virtio-serial / ttyS1         │ inbrowser | fetch |    │  │
│  ┌──────▼─────────────────────────┐     │ wisp (WebSocket→TCP)   │  │
│  │ Guest agent protocol (JSON-RPC)│     └───────────┬────────────┘  │
│  │ clipboard, resize, open-file,  │                 │               │
│  │ notifications, time sync       │                 │               │
│  └────────────────────────────────┘                 │               │
└─────────────────────────────────────────────────────┼───────────────┘
                                                      ▼ (optional)
                                    wisp-server-node / websockproxy
```

### Guest image ("dbvm-os")
- **Base:** Alpine Linux x86 (32-bit, musl) — small, has Xorg + apk. Buildroot as fallback for the absolute smallest image.
- **Kernel:** i686, virtio (9p, net, console), `bochs`/`vesafb` framebuffer, SB16, PS/2. No initrd bloat.
- **Display:** Xorg with `fbdev`/`modesetting` driver on the VBE framebuffer (TinyX/Xfbdev if Xorg is too heavy).
- **Desktop:** JWM or IceWM (cheap, looks like a desktop) — i3 as alt. Apps: xterm/st, PCManFM, Leafpad/mousepad, a light browser (Netsurf/Dillo), htop, a game or two.
- **Rootfs delivery:** v86's 9p "fs.json + content-addressed chunks" so files are fetched lazily — boot touches only a few MB, not the whole image.
- **Target size:** < 300 MB uncompressed rootfs, < 120 MB served.

### Boot speed
v86 `save_state()` after X + WM are up → ship that snapshot (zstd) → page load restores straight into a running desktop (~1–3 s), exactly how copy.sh's Arch demo works. Cold boot stays available as a fallback.

### Persistence
- Writes to the 9p fs go to an overlay stored in IndexedDB/OPFS.
- "Save session" = full machine snapshot in OPFS; "Reset" wipes the overlay.
- Export/import home dir as a `.tar`.

### Integration (guest agent)
A tiny daemon in the guest talking over a serial/virtio-console channel:
- clipboard sync (host `navigator.clipboard` ⇄ `xclip`)
- display resize (browser window → `xrandr` VBE mode)
- drag-and-drop files from host → `~/Downloads` via 9p
- time sync, "open URL in host browser", notifications

### Input
- Keyboard: v86 scancode mapping; trap shortcuts (Ctrl+W etc.) in fullscreen/Keyboard Lock API.
- Mouse: v86 PS/2 is relative, but v86 already emulates the **VMware absolute mouse** (`vmware-absolute-mouse` event). Enable `vmmouse` in the guest (kernel `CONFIG_MOUSE_PS2_VMMOUSE` + xf86-input-vmmouse/libinput) so the cursor tracks the host pointer without Pointer Lock.

### Networking
Off by default. Options, in order of effort:
1. `fetch` backend — HTTP(S) only, CORS limited, zero server.
2. `wisp` backend + self-hosted `wisp-server-node` — real TCP; `epoxy-tls` for TLS in browser.
3. `wsproxy` (`websockproxy`) — raw Ethernet over WebSocket.

---

## 3. Roadmap

### Phase 0 — Setup (day 1–2)
- [x] `git init`, Vite + TypeScript app scaffold, `refs/` in `.gitignore`.
- [x] Use v86 from npm (`v86@0.5.472`); building from `refs/emulators/v86` deferred until we need to patch it.
- [x] Boot the stock v86 Buildroot 6.8 kernel in our page. It boots to a shell in about 10 s, the 9p share mounts at `/mnt`, keyboard input works, and save/restore round-trips (51 MB state at 128 MB RAM, before zstd).

### Phase 1 — Text-mode Linux (week 1)
- [ ] Docker build for an Alpine i686 rootfs + kernel config.
- [ ] Convert rootfs to v86 9p format (`tools/copy-to-sha256.py`, `fs2json.py` in v86).
- [ ] Serial console in xterm.js; boot to shell.

### Phase 2 — Desktop MVP (week 2–3)
- [ ] Xorg + JWM + xterm + file manager in the image; auto-login to X.
- [ ] Canvas display with scaling; keyboard/mouse with pointer lock.
- [ ] Save-state snapshot → instant boot.
- [ ] Hosted static build (any static host with correct MIME + compression).

### Phase 3 — Feels like a real desktop (week 4–6)
- [ ] Guest agent: clipboard, resize, file drop, time.
- [ ] IndexedDB/OPFS overlay persistence + reset/export.
- [ ] Audio via SB16.
- [ ] Absolute pointer via v86's existing vmmouse emulation.
- [ ] Optional networking via wisp.

### Phase 4 — Stretch
- [ ] QEMU-Wasm backend behind the same `Machine` interface (x86_64, SMP).
- [ ] "Seamless" mode: guest windows as separate browser-side windows (Xpra-style rootless; see `refs/display/xpra-html5`) inside a web desktop shell (ideas from `refs/shell/daedalOS`, `refs/shell/puter`).
- [ ] Wayland path via Greenfield (`refs/display/greenfield`) for Wasm-native apps.
- [ ] Linux/Wasm native backend once it has MMU + virtio.

---

## 4. Risks
| Risk | Mitigation |
|---|---|
| v86 speed (single core, 32-bit, no GPU) makes X sluggish | Light WM, no compositor, 16-bit/1024×768 default, snapshot boot; QEMU-Wasm track for heavier use |
| Big image downloads | Lazy 9p chunks, zstd, Cache API, tiny boot set |
| 32-bit x86 package availability shrinking | Alpine x86 still maintained; Buildroot as fallback |
| Relative mouse is awkward | v86 already has vmmouse; guest just needs the driver |
| COOP/COEP needed for QEMU-Wasm threads | Only on the experimental track; host config documented |
| CheerpX licensing | Never depend on it; reference only |
| 5 GB disk limit | Build images in Docker volumes, prune; no kernel/Buildroot source checkouts locally (fetched inside Docker) |

---

## 5. Reference repos (`refs/`, shallow clones)

| Path | Why it's here |
|---|---|
| `emulators/v86` | Core emulator; docs on 9p images, networking, Arch setup (`docs/`) |
| `emulators/webvm` | UX benchmark, Alpine+Xorg desktop config, Dockerfiles for images |
| `emulators/container2wasm` | Image packaging, browser network stack |
| `emulators/qemu-wasm` | 64-bit/SMP experimental backend |
| `emulators/linux-wasm` | Native-Wasm Linux kernel (future) |
| `emulators/TinyEMU` | Small reference emulator |
| `emulators/browsix` | Historical Unix-in-browser reference |
| `display/noVNC` | Canvas rendering, input handling, clipboard patterns |
| `display/xpra-html5` | Seamless/rootless window ideas |
| `display/greenfield` | Wayland compositor in the browser |
| `shell/daedalOS`, `shell/puter` | Web desktop shell UX |
| `terminal/xterm.js` | Serial console |
| `net/wisp-server-node`, `net/epoxy-tls`, `net/websockproxy` | Network backends |

Not cloned (too big for the budget): Linux kernel, Buildroot, Emscripten, LLVM — pulled inside Docker builds when needed.
