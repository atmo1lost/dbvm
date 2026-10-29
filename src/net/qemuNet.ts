// Guest networking for the QEMU backend, entirely in the page.
//
// QEMU runs `-netdev socket,connect=...`: a stream of Ethernet frames, each
// prefixed with a 4-byte big-endian length. Emscripten turns that TCP connect
// into `new WebSocket(Module.websocket.url)` on the main thread, so we hand it a
// fake WebSocket that feeds frames straight into v86's virtual router
// (vendored in ./v86): ARP, DHCP, DNS over HTTPS, and a TCP state machine whose
// streams go to our Wisp relay (server/wisp.ts). Same network as the v86 guest:
// router 192.168.86.1, guest 192.168.86.100.

import { WispNetworkAdapter as WispNetworkAdapterFn } from "./v86/browser/wisp_network.js";

// A pre-class constructor function in the vendored JS.
const WispNetworkAdapter = WispNetworkAdapterFn as unknown as new (url: string, bus: Bus, config: object) => unknown;

/** What QEMU's socket netdev connects to; the shim intercepts this URL. */
export const QEMU_NET_URL = "ws://dbvm-net:1/";
/** Must match the virtio-net device's mac= on the QEMU command line. */
export const GUEST_MAC = "52:54:00:12:34:56";

type Handler = (data: unknown) => void;

/** The minimal message bus v86's network adapter expects. */
class Bus {
  private handlers = new Map<string, Handler[]>();

  register(name: string, fn: Handler, ctx?: unknown): void {
    const list = this.handlers.get(name) ?? [];
    list.push(fn.bind(ctx));
    this.handlers.set(name, list);
  }

  send(name: string, data: unknown): void {
    this.handlers.get(name)?.forEach((fn) => fn(data));
  }
}

/** Looks enough like a WebSocket for Emscripten's SOCKFS. */
class FrameSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readyState = FrameSocket.CONNECTING;
  binaryType = "arraybuffer";
  protocol = "binary";
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  private pending = new Uint8Array(0);

  constructor(
    readonly url: string,
    private net: GuestNetwork,
  ) {
    net.attach(this);
    setTimeout(() => {
      this.readyState = FrameSocket.OPEN;
      this.onopen?.({});
    });
  }

  /** Bytes from QEMU: reassemble length-prefixed frames. */
  send(data: ArrayBuffer | ArrayBufferView): void {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const merged = new Uint8Array(this.pending.length + bytes.length);
    merged.set(this.pending);
    merged.set(bytes, this.pending.length);
    let offset = 0;
    while (merged.length - offset >= 4) {
      const len = new DataView(merged.buffer, offset, 4).getUint32(0);
      if (merged.length - offset - 4 < len) break;
      this.net.fromGuest(merged.slice(offset + 4, offset + 4 + len));
      offset += 4 + len;
    }
    this.pending = merged.slice(offset);
  }

  /** A frame for the guest: length-prefix it for QEMU. */
  deliver(frame: Uint8Array): void {
    if (this.readyState !== FrameSocket.OPEN) return;
    const buf = new Uint8Array(4 + frame.length);
    new DataView(buf.buffer).setUint32(0, frame.length);
    buf.set(frame, 4);
    this.onmessage?.({ data: buf.buffer });
  }

  close(): void {
    this.readyState = FrameSocket.CLOSED;
    this.onclose?.({});
  }
}

export class GuestNetwork {
  private bus = new Bus();
  private socket: FrameSocket | null = null;

  constructor(wispUrl: string) {
    new WispNetworkAdapter(wispUrl, this.bus, {});
    this.bus.register("net0-receive", (frame) => this.socket?.deliver(frame as Uint8Array));
    this.bus.send("net0-mac", GUEST_MAC);
  }

  attach(socket: FrameSocket): void {
    this.socket = socket;
  }

  fromGuest(frame: Uint8Array): void {
    this.bus.send("net0-send", frame);
  }

  /**
   * Route `new WebSocket(QEMU_NET_URL)` to this network. Every other URL
   * (the Wisp relay itself, Vite's HMR socket) gets a real WebSocket.
   */
  installWebSocketShim(): void {
    const Real = globalThis.WebSocket;
    const net = this;
    const Shim = function (url: string | URL, protocols?: string | string[]) {
      if (String(url).startsWith(QEMU_NET_URL)) return new FrameSocket(String(url), net);
      return protocols === undefined ? new Real(url) : new Real(url, protocols);
    } as unknown as typeof WebSocket;
    Object.assign(Shim, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    Shim.prototype = Real.prototype;
    globalThis.WebSocket = Shim;
  }
}
