# dbvm — desktop browser virtual machine

Goal: open a URL, get a real Linux desktop (window manager, terminal, file manager, a few apps) running **entirely client-side** in the browser, with persistence, clipboard, and optional networking.

Disk budget for this repo: **5 GB max** (refs + images + build outputs). Currently ~1.4 GB (0.9 GB reference clones, 0.37 GB images and build cache in `~/Library/Caches/dbvm`).

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

**Decision:** build the MVP on v86 with a small 32-bit x86 Linux guest running X11 + a lightweight WM. Keep the guest/host interface abstract (`Machine` interface) so QEMU-Wasm can be added as a second backend for 64-bit/SMP. That's now planned (Phase 4) because Flatpak support (Phase 5) needs x86_64.

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

### Phase 1 — Text-mode Linux (week 1) ✅
- [x] Docker-free Alpine 3.21 i686 image builder (`tools/mkimage.py`): minirootfs + packages unpacked into an in-memory tar, stock `linux-virt` kernel, custom busybox initramfs that loads the 9p modules and `switch_root`s onto `host9p`.
- [x] Converted to v86 lazy 9p format (`tools/build-image.sh`, v86's `fs2json.py` + `copy-to-sha256.py`): 42 MB served.
- [x] xterm.js serial console with autologin on ttyS0. A cold boot reaches the shell in about 15–20 s.
- [x] Boot snapshot (`tools/build-state.mjs`): 19 MB zstd, so page load restores straight to a root shell. `?profile=alpine-cold` still does a full boot.
- Build outputs live in `~/Library/Caches/dbvm` (outside iCloud) and are served by a Vite middleware at `/images`.

### Phase 2 — Desktop MVP (week 2–3) ✅ (except hosting)
- [x] Xorg (`fbdev` driver on the `bochs-drm` framebuffer, 1024×768×24, shadow FB, no GL) + JWM + xterm + PCManFM + Mousepad + Dillo, eudev + libinput, dbus. Root autologin on tty1 runs `startx`. Guest config lives in `guest/overlay/`.
- [x] Mesa and LLVM are excluded (~300 MB of software GL that v86 can't use), leaving 176 packages and 152 MB installed (85 MB served, loaded lazily).
- [x] Deferred apk maintainer scripts and triggers (users/groups, GSettings schemas, icon/pixbuf/font caches) run once in the guest via the `dbvm-firstboot` OpenRC service.
- [x] Canvas scales to fit the window. The absolute pointer works through v86's vmmouse emulation (kernel `psmouse` vmmouse + libinput), with no pointer lock and accurate mapping when scaled.
- [x] Desktop snapshot: 43 MB zstd (133 MB raw). Page load restores straight to the running desktop, while a cold first boot reaches it in about 38 s.
- [ ] Hosted static build (any static host with correct MIME + compression).
- Known issue: instant bursts of more than ~10 keystrokes overflow the guest's evdev buffer (`SYN_DROPPED`) and drop keys. Human-speed typing is fine. Paste must go through the agent's clipboard, not simulated keys, or be paced.

**Direction from here:** the goal is a 64-bit guest that can install Flatpak apps. Flathub publishes only x86_64 and aarch64 builds, with nothing for 32-bit x86, so Flatpak *requires* the 64-bit backend. It also needs real networking (Flathub is HTTPS) and persistent, disk-backed storage, because runtimes are 0.3–1 GB each. Phases 3–5 build those in order. v86 stays as the fast, light 32-bit option.

### Phase 3 — Networking, persistence, guest agent (Flatpak prerequisites) ✅
- [x] **Networking:** our own minimal Wisp v1 relay (`server/wisp.ts`, MIT-clean instead of AGPL `wisp-server-node`) runs inside the Vite dev server at `/wisp/`. v86's wisp backend provides DHCP (guest `192.168.86.100`), DNS over HTTPS and NTP. The relay only carries TCP to **public IPv4**: loopback, private, link-local, CGNAT and multicast are refused, so the guest can't reach the Mac's own services or LAN. HTTPS from the guest works (Alpine CDN: HTTP 200 in 1.2 s). Disable with `?net=0`.
- [x] **Guest agent** (`guest/overlay/usr/libexec/dbvm/agent`, line protocol on ttyS1 ⇄ `src/agent.ts`):
  - time sync on start, every 60 s and when the tab becomes visible (the guest clock is within ~3 s of the host).
  - clipboard both ways via `xclip`, byte-exact UTF-8. Guest→host polls every 2 s. Host→guest: Cmd+V (or Ctrl+Shift+V) is intercepted, the text is set as CLIPBOARD+PRIMARY, then Shift+Insert is sent, so long pastes don't drop keys.
  - `rescan` after file drops.
- [x] **File drop:** drop files on the screen and they're written into the 9p root at `~/Downloads`, visible to the guest immediately.
- [x] **Sessions:** Save session / Reset / autosave (every 5 min and when the tab is hidden). A full machine snapshot, gzip'd into OPFS (≈43–45 MB, ~2 s). On load a matching session replaces the shipped snapshot; it resumes in ~0.4 s with files intact. Sessions are tied to the image build via `images/alpine/version`.
  - Limitation: changed files still live in guest/tab RAM until saved, and the whole machine is rewritten on each save. That's fine for documents and settings but **not for Flatpak runtimes** (0.3–1 GB). Phase 5 needs a disk-backed 9p storage (v86 FileStorage on OPFS) or a block device on OPFS.
- Deferred to *Later*: display resize, `~` export/import, snapshot shrinking, audio.

### Phase 4 — 64-bit (QEMU-Wasm backend)
- [x] **Benchmark (2026-10-28)**, one VM at a time, 1 vCPU each, same busybox `sh` loop (100,000 iterations), on the same Mac (10 cores):

  | | QEMU-Wasm (ktock demo, x86_64, single-thread TCG) | v86 (dbvm, i686) |
  |---|---|---|
  | CPU loop | **15.2 s** | **3.6 s** (≈4.3× faster) |
  | Boot | text-only login at ~43 s guest time (~85 s from page load incl. download) | full X desktop, cold, ~38 s; restored snapshot ~0.4 s |
  | Host CPU while busy | ~2 cores | ~1 core |

  Caveats: a single quick run each, and the demo is a generic build (ASYNCIFY, no tuning). Multi-threaded TCG with more vCPUs helps parallel work, not per-thread speed, and costs more host CPU.
  **Verdict:** a 64-bit guest works, but it's about 4× slower than v86, which is already the slow part. Flatpak's GTK4/Qt6 apps on top of that would be very sluggish. Decision pending (see below).
- [ ] Build QEMU-Wasm (`qemu-system-x86_64`, multi-threaded TCG, Emscripten) in **GitHub Actions**, not on the Mac: it needs Docker + Emscripten and several GB of space (see the 5 GB budget and iCloud notes).
- [ ] `QemuMachine` implementing the existing `Machine` interface, selected per profile.
- [ ] COOP/COEP headers (SharedArrayBuffer for threads) in Vite and later in hosting.
- [ ] x86_64 guest: `tools/mkimage.py` with `ARCH=x86_64` (same package list and overlay). The display driver depends on QEMU's emulated GPU (`bochs-display`/`virtio-gpu`).
- [ ] Disk delivery for QEMU: lazy-loaded block image or 9p via Emscripten FS. It replaces v86's `fs.json` chunks, and the Phase 3 OPFS layer has to back it.
- [ ] Snapshot/instant boot for QEMU (savevm/migration to a file) if feasible. Otherwise optimise cold boot.

### Phase 5 — Flatpak
- [ ] Add `flatpak` + `bubblewrap` to the x86_64 image. The Alpine kernel already has user namespaces, seccomp, cgroups, FUSE and overlayfs (checked).
- [ ] Flathub remote preconfigured, reached through the Phase 3 wisp proxy.
- [ ] Flatpak installation (`/var/lib/flatpak`) on persistent OPFS-backed storage, with a size readout and an uninstall/cleanup UI so the browser's storage doesn't grow unbounded.
- [ ] Validate with a few light GTK apps first (e.g. a text editor, calculator). Heavy GL apps (Firefox, LibreOffice) will be slow under software rendering. Document which apps are usable.
- [ ] Optional: pre-install one runtime (`org.freedesktop.Platform`) in a separate lazily-loaded image layer, so the first app install doesn't download ~500 MB.

### Later
- [ ] Display resize from the browser window (fbdev X can't change mode; needs the `modesetting` driver or xrandr via bochs KMS).
- [ ] Export/import `~` as `.tar`.
- [ ] Shrink the desktop snapshot (currently 42 MB): more aggressive cache dropping, less RAM, or ship first-boot output as files.
- [ ] Audio via SB16.
- [ ] Hosted static build (correct MIME types, compression, COOP/COEP).
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
| COOP/COEP needed for QEMU-Wasm threads | Set in Vite now; document for hosting |
| QEMU-Wasm too slow for a usable desktop | Benchmark before building anything (Phase 4 step 1); v86 remains the default |
| Flatpak runtimes are huge (0.3–1 GB) | OPFS-backed storage, a size readout and cleanup UI, optional pre-installed runtime layer |
| Flathub needs real HTTPS | wisp proxy (a server we run); without one, Flatpak can't install anything |
| Flatpak GL apps slow under software rendering | Target light GTK apps; document what's usable |
| CheerpX licensing | Never depend on it; reference only |
| 5 GB disk limit | Build QEMU-Wasm in GitHub Actions; generated images in `~/Library/Caches/dbvm`; no kernel/Buildroot/Emscripten checkouts locally |
| Project folder is iCloud-synced (and iCloud is full) | Many-file outputs live outside it; `refs.nosync`, `node_modules` flagged as iCloud-ignored |

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
