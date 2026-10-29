# Vendored v86 network stack

`browser/fake_network.js` and `browser/wisp_network.js` are copied unchanged from
[copy/v86](https://github.com/copy/v86) at `cc37f35` (BSD-2-Clause, see `LICENSE`).
They give a guest a virtual router in the page: ARP, DHCP, DNS over HTTPS, and a
TCP state machine whose streams go to a Wisp relay (`server/wisp.ts`).

dbvm uses them for the QEMU backend (`src/net/qemuNet.ts`). The v86 backend uses
the same code from the npm package. The files next to this README (`const.js`,
`log.js`, `lib.js`, `bus.js`) are minimal stand-ins for the v86 modules those
two files import.
