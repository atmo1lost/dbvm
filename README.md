# dbvm — desktop browser virtual machine

A Linux desktop running entirely in the browser, on top of the [v86](https://github.com/copy/v86) x86 emulator. See [PLAN.md](PLAN.md) for the architecture and roadmap.

## Run

```sh
npm install
npm run assets   # downloads the guest kernel image into public/images/
npm run dev      # http://localhost:5173
```

In the devtools console, `machine` is the live `V86Machine`.

## Layout

- `src/machine/Machine.ts` — backend-agnostic VM interface
- `src/machine/V86Machine.ts` — v86 implementation
- `src/main.ts` — page wiring (toolbar, status, save/restore)
- `public/bios/` — SeaBIOS + VGA BIOS from copy/v86 (LGPL, see `COPYING.LESSER`)
- `public/images/` — guest images (git-ignored, fetched by `npm run assets`)
- `refs/` — shallow clones of related projects (git-ignored)
