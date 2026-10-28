# dbvm — desktop browser virtual machine

A Linux desktop running entirely in the browser, on top of the [v86](https://github.com/copy/v86) x86 emulator. See [PLAN.md](PLAN.md) for the architecture and roadmap.

## Run

```sh
npm install
npm run image              # build the Alpine guest (no Docker needed, ~20 s)
node tools/build-state.mjs # optional: boot snapshot for instant start
npm run dev                # http://localhost:5173
```

Profiles: `?profile=alpine` (default, restores the desktop snapshot), `?profile=alpine-cold`, `?profile=buildroot` (needs `npm run assets`).

Guest images are written to `~/Library/Caches/dbvm` (override with `DBVM_CACHE`). They're kept outside the project because the project folder is iCloud-synced and the images are thousands of small files. Vite serves them at `/images` without watching them.

## Using it

- **Clipboard:** copy in the guest (selecting text in xterm copies it) and it reaches your clipboard within ~2 s. Press **Cmd+V** (macOS) or **Ctrl+Shift+V** to paste host text into the focused guest app.
- **Files:** drop files on the screen and they appear in `~/Downloads`.
- **Network:** the guest has internet through the dev server's Wisp relay (public addresses only). `?net=0` turns it off.
- **Sessions:** *Save session* stores the whole machine in this browser (OPFS). It also autosaves every 5 minutes and when the tab is hidden. *Reset* discards it.

In the devtools console, `machine` is the live `V86Machine` and `agent` the host side of the guest agent.

## Layout

- `src/machine/Machine.ts` — backend-agnostic VM interface
- `src/machine/V86Machine.ts` — v86 implementation
- `src/profiles.ts` — guest profiles
- `src/main.ts` — page wiring (toolbar, Screen/Serial tabs, sessions, file drop)
- `src/agent.ts` — host side of the guest agent (time sync, clipboard, paste)
- `src/session.ts` — saved sessions in OPFS
- `server/wisp.ts` — minimal Wisp relay for guest networking (public IPv4 only)
- `tools/mkimage.py` — Alpine i686 image builder (packages → in-memory rootfs tar, kernel, 9p initramfs)
- `tools/build-image.sh` — runs mkimage and converts to v86's lazy 9p format
- `tools/build-state.mjs` — headless boot in Node; snapshots the running desktop
- `guest/overlay/` — files copied into the guest (Xorg config, JWM, xinitrc, first-boot service, agent, network config)
- `public/bios/` — SeaBIOS + VGA BIOS from copy/v86 (LGPL, see `COPYING.LESSER`)
- `refs` → `refs.nosync/` — shallow clones of related projects (git-ignored, not iCloud-synced)
