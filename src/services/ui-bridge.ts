// UI bridge: a loopback WebSocket server the comfyui-mcp-panel pack connects
// to. MCP tool handlers (src/tools/panel.ts) call `send(cmd)` and await the
// panel's rid-correlated reply — the user's own Claude Code session drives the
// live ComfyUI graph through its MCP connection, with zero LLM API keys.
//
// Design ported from node-lab's mcp/bridge.ts (same author): every request is
// `{ rid, cmd, ...args }`; the panel replies `{ rid, ok, result }` or
// `{ rid, ok: false, error }`. One panel connection at a time (last writer
// wins). If the port is taken, another comfyui-mcp session owns the panel and
// tools surface a clear, actionable error.
//
// Inbound frames WITHOUT a rid are panel-initiated events (e.g.
// `{ type: "user_message", text }`) and are forwarded to `onPanelMessage` —
// the channels half of the design (see registerChannels in index.ts).

import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { logger } from "../utils/logger.js";

export const DEFAULT_BRIDGE_PORT = 9101;

export interface PanelEvent {
  type: string;
  text?: string;
  [key: string]: unknown;
}

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export interface BridgeCommand {
  cmd: string;
  [key: string]: unknown;
}

export class UiBridge {
  private wss: WebSocketServer | null = null;
  private sock: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private portInUse = false;
  private port: number;

  /** Called for panel-initiated frames (no rid): user messages, hellos. */
  onPanelMessage: ((event: PanelEvent) => void) | null = null;

  constructor(port = DEFAULT_BRIDGE_PORT) {
    this.port = port;
  }

  start(): void {
    // Loopback only — this drives the user's live editor and must never be
    // reachable from the LAN.
    const wss = new WebSocketServer({ port: this.port, host: "127.0.0.1" });
    wss.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        this.portInUse = true;
        logger.warn(
          `[ui-bridge] port ${this.port} in use — another comfyui-mcp session likely owns the panel`,
        );
      } else {
        logger.error(`[ui-bridge] server error: ${err.message}`);
      }
    });
    wss.on("connection", (sock) => {
      // Last writer wins: a reconnecting panel replaces the stale socket.
      if (this.sock && this.sock !== sock) {
        try {
          this.sock.close();
        } catch {
          // Already gone.
        }
      }
      this.sock = sock;
      logger.info("[ui-bridge] panel connected");
      sock.on("message", (buf) => this.onMessage(buf.toString()));
      sock.on("close", () => {
        if (this.sock === sock) this.sock = null;
        // Fail in-flight commands immediately rather than letting them hang
        // to timeout.
        for (const [rid, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error("panel disconnected mid-command"));
          this.pending.delete(rid);
        }
        logger.info("[ui-bridge] panel disconnected");
      });
    });
    this.wss = wss;
    logger.info(`[ui-bridge] listening on ws://127.0.0.1:${this.port}`);
  }

  connected(): boolean {
    return !!this.sock && this.sock.readyState === WebSocket.OPEN;
  }

  status(): string {
    if (this.portInUse) {
      return `port ${this.port} is held by another comfyui-mcp session — close it or free the port (lsof -ti:${this.port} | xargs kill)`;
    }
    return this.connected()
      ? "panel connected"
      : "no panel connected — open ComfyUI with the comfyui-mcp-panel pack installed and check the Agent sidebar tab";
  }

  send(cmd: BridgeCommand, timeoutMs = 6000): Promise<unknown> {
    if (!this.connected()) {
      return Promise.reject(new Error(`Panel not reachable: ${this.status()}`));
    }
    const rid = randomUUID();
    const sock = this.sock as WebSocket;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(
          new Error(
            `Panel did not reply to "${cmd.cmd}" within ${timeoutMs} ms — the ComfyUI tab may be backgrounded or frozen`,
          ),
        );
      }, timeoutMs);
      this.pending.set(rid, { resolve, reject, timer });
      try {
        sock.send(JSON.stringify({ rid, ...cmd }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(rid);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private onMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      logger.warn("[ui-bridge] dropping malformed frame from panel");
      return;
    }

    const rid = typeof msg.rid === "string" ? msg.rid : undefined;
    if (rid) {
      const p = this.pending.get(rid);
      if (!p) return; // late reply for a timed-out command
      clearTimeout(p.timer);
      this.pending.delete(rid);
      if (msg.ok) {
        p.resolve(msg.result);
      } else {
        p.reject(new Error(String(msg.error ?? "panel reported an error")));
      }
      return;
    }

    // Panel-initiated event (user message, hello, etc.).
    if (typeof msg.type === "string") {
      this.onPanelMessage?.(msg as PanelEvent);
    }
  }

  /** Push a fire-and-forget frame to the panel (no reply expected). */
  push(frame: Record<string, unknown>): void {
    if (!this.connected()) return;
    try {
      this.sock?.send(JSON.stringify(frame));
    } catch {
      // Panel mid-disconnect — drop.
    }
  }

  async stop(): Promise<void> {
    for (const [rid, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("bridge stopped"));
      this.pending.delete(rid);
    }
    this.sock?.close();
    this.sock = null;
    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
    });
    this.wss = null;
  }
}

// Module-level singleton, started by --channels in src/index.ts.
let bridgeInstance: UiBridge | null = null;

export function startUiBridge(port?: number): UiBridge {
  if (!bridgeInstance) {
    bridgeInstance = new UiBridge(
      port ??
        (Number(process.env.COMFYUI_MCP_BRIDGE_PORT) || DEFAULT_BRIDGE_PORT),
    );
    bridgeInstance.start();
  }
  return bridgeInstance;
}

export function getUiBridge(): UiBridge | null {
  return bridgeInstance;
}
