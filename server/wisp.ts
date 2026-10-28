// Minimal Wisp v1 relay (https://github.com/MercuryWorkshop/wisp-protocol) for
// v86's `wisp://` network backend. v86 terminates the guest's TCP and does DNS
// (over HTTPS) itself, so this only relays TCP streams to IPv4 addresses.
//
// The guest must not reach the host's own services or LAN, so loopback,
// private, link-local and multicast ranges are refused.

import type { Server as HttpServer } from "node:http";
import net from "node:net";
import { WebSocketServer, type WebSocket } from "ws";

const PACKET = { CONNECT: 0x01, DATA: 0x02, CONTINUE: 0x03, CLOSE: 0x04 } as const;
const CLOSE_REASON = { VOLUNTARY: 0x02, NETWORK_ERROR: 0x03, INVALID: 0x41, UNREACHABLE: 0x42, BLOCKED: 0x48 };
const STREAM_TCP = 0x01;
// Packets the client may send per stream before it must wait for CONTINUE.
const BUFFER_PACKETS = 128;

const BLOCKED_V4: Array<[number, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16], ["224.0.0.0", 3],
].map(([ip, bits]) => [ipv4ToInt(ip as string), bits as number]);

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((n, octet) => (n << 8) + Number(octet), 0) >>> 0;
}

export function isPublicIPv4(host: string): boolean {
  if (net.isIPv4(host) === false) return false;
  const ip = ipv4ToInt(host);
  return !BLOCKED_V4.some(([base, bits]) => (ip >>> (32 - bits)) === (base >>> (32 - bits)));
}

function packet(type: number, streamId: number, payload: Uint8Array = new Uint8Array()): Buffer {
  const buf = Buffer.alloc(5 + payload.length);
  buf[0] = type;
  buf.writeUInt32LE(streamId, 1);
  buf.set(payload, 5);
  return buf;
}

const continuePacket = (streamId: number) => {
  const p = Buffer.alloc(4);
  p.writeUInt32LE(BUFFER_PACKETS);
  return packet(PACKET.CONTINUE, streamId, p);
};

const closePacket = (streamId: number, reason: number) =>
  packet(PACKET.CLOSE, streamId, Uint8Array.of(reason));

function handleClient(ws: WebSocket, log: (msg: string) => void): void {
  const streams = new Map<number, { socket: net.Socket; received: number }>();
  const send = (buf: Buffer) => ws.readyState === ws.OPEN && ws.send(buf);

  send(continuePacket(0));

  ws.on("message", (raw: Buffer, isBinary: boolean) => {
    if (!isBinary || raw.length < 5) return;
    const type = raw[0];
    const streamId = raw.readUInt32LE(1);
    const payload = raw.subarray(5);

    if (type === PACKET.CONNECT) {
      const port = payload.readUInt16LE(1);
      const host = payload.subarray(3).toString();
      if (payload[0] !== STREAM_TCP) return send(closePacket(streamId, CLOSE_REASON.INVALID));
      if (!isPublicIPv4(host)) {
        log(`blocked guest connection to ${host}:${port}`);
        return send(closePacket(streamId, CLOSE_REASON.BLOCKED));
      }
      const socket = net.connect({ host, port });
      streams.set(streamId, { socket, received: 0 });
      socket.setNoDelay(true);
      socket.on("data", (data) => send(packet(PACKET.DATA, streamId, data)));
      socket.on("error", () => streams.has(streamId) && send(closePacket(streamId, CLOSE_REASON.UNREACHABLE)));
      socket.on("close", () => {
        if (streams.delete(streamId)) send(closePacket(streamId, CLOSE_REASON.VOLUNTARY));
      });
    } else if (type === PACKET.DATA) {
      const stream = streams.get(streamId);
      if (!stream) return;
      stream.socket.write(payload);
      if (++stream.received >= BUFFER_PACKETS / 2) {
        stream.received = 0;
        send(continuePacket(streamId));
      }
    } else if (type === PACKET.CLOSE) {
      const stream = streams.get(streamId);
      streams.delete(streamId);
      stream?.socket.destroy();
    }
  });

  ws.on("close", () => {
    for (const { socket } of streams.values()) socket.destroy();
    streams.clear();
  });
}

/** Serve Wisp on `path` (e.g. "/wisp/") of an existing HTTP server. */
export function attachWisp(server: HttpServer, path: string, log: (msg: string) => void = () => {}): void {
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (!req.url?.startsWith(path)) return;
    wss.handleUpgrade(req, socket, head, (ws) => handleClient(ws, log));
  });
}
