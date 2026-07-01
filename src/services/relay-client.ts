// Relay client: the comfyui-mcp side of the comfyui-mcp-relay Worker/Durable
// Object (github.com/artokun/comfyui-mcp-relay, private). Dials OUT to the relay
// as the session's single "orchestrator" connection and wraps each
// relay-multiplexed panel-tab connection in a BridgeSocket shim so it can be fed
// straight into UiBridge.attachRelayConnection — from there it's indistinguishable
// from a directly-connected loopback socket.
//
// See that repo's README for the full wire protocol. Summary: the orchestrator's
// one physical socket carries a small {t,id,d} envelope (open/data/close per
// panel connection id); the panel leg itself carries raw, un-enveloped bridge
// frames, so comfyui-mcp-panel needs no changes to speak through the relay.

import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { logger } from "../utils/logger.js";
import type { BridgeSocket } from "./ui-bridge.js";

const OPEN = 1;
const CLOSED = 3;

interface Envelope {
  t: "open" | "data" | "close" | "ping" | "pong";
  id?: string;
  d?: string;
}

/** A relay-multiplexed panel connection, shaped to satisfy BridgeSocket. */
class RelaySocketShim extends EventEmitter implements BridgeSocket {
  readyState = OPEN;

  constructor(
    private readonly connId: string,
    private readonly sendUp: (connId: string, data: string) => void,
  ) {
    super();
  }

  send(data: string): void {
    if (this.readyState !== OPEN) return;
    this.sendUp(this.connId, data);
  }

  close(): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.emit("close");
  }

  terminate(): void {
    this.close();
  }

  /** No-op: per-connection ping/pong isn't plumbed through the relay envelope in
   *  v1 (see the relay README's "known limitations"). Liveness of the whole
   *  relay connection is handled by RelayClient's own ping/pong below. */
  ping(): void {}
}

export interface RelayClientOptions {
  /** e.g. wss://comfyui-mcp-relay.<subdomain>.workers.dev */
  relayUrl: string;
  sessionId: string;
  token: string;
  accessKey?: string;
  /** UiBridge.attachRelayConnection, called once per new panel tab. */
  onAttach: (sock: BridgeSocket) => void;
}

const PING_INTERVAL_MS = 25_000;
const RECONNECT_MAX_MS = 30_000;

export class RelayClient {
  private ws: WebSocket | null = null;
  private shims = new Map<string, RelaySocketShim>();
  private stopped = false;
  private reconnectAttempt = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: RelayClientOptions) {}

  start(): void {
    this.connect();
  }

  /** Resolves once the control connection is open (or rejects on the first
   *  connect attempt's error) — lets the caller confirm the relay is actually
   *  reachable before advertising its URL to the pod. */
  waitUntilOpen(timeoutMs = 15_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("relay connect timed out")), timeoutMs);
      const sock = this.ws;
      if (sock?.readyState === WebSocket.OPEN) {
        clearTimeout(timer);
        resolve();
        return;
      }
      sock?.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      sock?.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  private controlUrl(): string {
    const u = new URL(`${this.opts.relayUrl.replace(/\/+$/, "")}/s/${this.opts.sessionId}`);
    u.searchParams.set("role", "orchestrator");
    u.searchParams.set("token", this.opts.token);
    if (this.opts.accessKey) u.searchParams.set("key", this.opts.accessKey);
    return u.toString();
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.controlUrl());
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectAttempt = 0;
      logger.info("[relay-client] connected to relay control channel");
      this.startPing();
    });

    ws.on("message", (buf: unknown) => {
      let msg: Envelope;
      try {
        msg = JSON.parse(String(buf)) as Envelope;
      } catch {
        return;
      }
      if (msg.t === "open" && msg.id) {
        const shim = new RelaySocketShim(msg.id, (id, data) => this.sendData(id, data));
        this.shims.set(msg.id, shim);
        this.opts.onAttach(shim);
      } else if (msg.t === "data" && msg.id) {
        this.shims.get(msg.id)?.emit("message", msg.d ?? "");
      } else if (msg.t === "close" && msg.id) {
        const shim = this.shims.get(msg.id);
        this.shims.delete(msg.id);
        shim?.close();
      }
      // "pong" needs no handling — receiving ANY message is itself proof of life.
    });

    ws.on("close", () => {
      this.stopPing();
      // Every relay-mediated panel connection dies with the control channel —
      // they'll reappear (with fresh connection ids) once the panel's own
      // reconnect logic redials and this client re-establishes the session.
      for (const shim of this.shims.values()) shim.close();
      this.shims.clear();
      if (this.stopped) return;
      logger.warn("[relay-client] relay control channel closed — reconnecting");
      this.scheduleReconnect();
    });

    ws.on("error", (err: Error) => {
      logger.warn(`[relay-client] relay error: ${err.message}`);
    });
  }

  private sendData(connId: string, data: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ t: "data", id: connId, d: data } satisfies Envelope));
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ t: "ping" } satisfies Envelope));
      }
    }, PING_INTERVAL_MS);
    this.pingTimer.unref?.();
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect(): void {
    const delay = Math.min(RECONNECT_MAX_MS, 1000 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    setTimeout(() => this.connect(), delay);
  }

  stop(): void {
    this.stopped = true;
    this.stopPing();
    for (const shim of this.shims.values()) shim.close();
    this.shims.clear();
    try {
      this.ws?.close();
    } catch {
      // already gone
    }
  }
}
