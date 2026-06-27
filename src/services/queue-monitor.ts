// Passive ComfyUI render watchdog for the panel orchestrator.
//
// The orchestrator never sees live render progress on its own: panel_run queues
// through the user's BROWSER, and the per-agent comfyui MCP only opens its WS for
// its own generate calls. So a render that wedges (a single sampler step running
// for minutes at high resolution) is invisible here — which is how a stalled job
// once let the agent stack three more behind it before anyone noticed.
//
// This service opens its OWN lightweight WebSocket to COMFYUI_URL. ComfyUI
// broadcasts execution events (status / executing / progress / execution_*) to
// every connected client, so we receive the live stream for ANY job — including
// the browser-queued ones — without touching the panel or the agent subprocess.
// It holds the last-known run state and derives a stall/backlog report the
// orchestrator surfaces to the agent as a turn-start note (the same channel as
// the crash-dump injector).
//
// Everything here is BEST-EFFORT: if the socket can't open or drops, the report
// is simply "inactive" and nothing in the orchestrator changes. It must never
// throw into the main path.

import WebSocket from "ws";
import { logger } from "../utils/logger.js";

interface MonitorState {
  connected: boolean;
  runningPromptId: string | null;
  currentNode: string | null;
  progressValue: number | null;
  progressMax: number | null;
  // ComfyUI's status.exec_info.queue_remaining — the total tasks the server still
  // has (running + pending). Last-known value between status frames.
  queueRemaining: number;
  // Monotonic ms timestamp of the last FORWARD-progress signal (node advanced or
  // progress value ticked up) while a job runs. A stuck step re-emits the same
  // progress value, which must NOT refresh this — that's how we see the stall.
  lastActivityTs: number | null;
}

export interface StallReport {
  /** A job is running but its node + progress have not advanced for >= stallMs. */
  stalled: boolean;
  /** More than one task in flight (running + pending) — a backlog the agent may
   *  not realize it created by re-queuing behind a slow job. */
  backlog: boolean;
  runningPromptId: string | null;
  currentNode: string | null;
  /** running + pending, from ComfyUI's own queue_remaining. */
  queueDepth: number;
  /** ms the running job has been idle (0 when not stalled). */
  stalledForMs: number;
  /** e.g. "0/4" when a progress frame has been seen, else null. */
  progress: string | null;
}

export interface QueueSnapshot {
  connected: boolean;
  running: boolean;
  runningPromptId: string | null;
  queueDepth: number;
}

const RECONNECT_MS = 5000;

class QueueMonitorImpl {
  private ws: WebSocket | null = null;
  private url: string | null = null;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private state: MonitorState = {
    connected: false,
    runningPromptId: null,
    currentNode: null,
    progressValue: null,
    progressMax: null,
    queueRemaining: 0,
    lastActivityTs: null,
  };

  /** Open the watchdog WS to ComfyUI. Idempotent; best-effort (never throws). */
  start(comfyuiUrl: string): void {
    if (this.url) return; // already started
    this.url = comfyuiUrl;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  private wsUrl(): string {
    // http(s)://host:port  →  ws(s)://host:port/ws?clientId=...
    const base = (this.url ?? "http://127.0.0.1:8188").replace(/^http/, "ws").replace(/\/+$/, "");
    return `${base}/ws?clientId=comfyui-mcp-watchdog`;
  }

  private connect(): void {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.wsUrl());
    } catch (err) {
      logger.debug(`[queue-monitor] WS construct failed: ${err instanceof Error ? err.message : String(err)}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.on("open", () => {
      this.state.connected = true;
      logger.debug("[queue-monitor] watchdog WS connected");
    });
    ws.on("message", (raw: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) return; // preview image frames — ignore
      this.onMessage(raw.toString());
    });
    ws.on("close", () => {
      this.state.connected = false;
      this.ws = null;
      this.scheduleReconnect();
    });
    ws.on("error", (err: Error) => {
      logger.debug(`[queue-monitor] WS error: ${err.message}`);
      try {
        ws.close();
      } catch {
        /* close handler schedules the reconnect */
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_MS);
    // Don't keep the process alive solely for the watchdog reconnect.
    this.reconnectTimer.unref?.();
  }

  private touchActivity(): void {
    this.state.lastActivityTs = Date.now();
  }

  private clearRunning(): void {
    this.state.runningPromptId = null;
    this.state.currentNode = null;
    this.state.progressValue = null;
    this.state.progressMax = null;
    this.state.lastActivityTs = null;
  }

  private onMessage(text: string): void {
    let msg: { type?: string; data?: Record<string, unknown> };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    const data = (msg.data ?? {}) as Record<string, unknown>;
    switch (msg.type) {
      case "status": {
        const status = data.status as Record<string, unknown> | undefined;
        const execInfo = status?.exec_info as Record<string, unknown> | undefined;
        const qr = execInfo?.queue_remaining;
        if (typeof qr === "number") this.state.queueRemaining = qr;
        break;
      }
      case "execution_start": {
        this.state.runningPromptId = typeof data.prompt_id === "string" ? data.prompt_id : null;
        this.state.currentNode = null;
        this.state.progressValue = null;
        this.state.progressMax = null;
        this.touchActivity();
        break;
      }
      case "executing": {
        const node = data.node;
        if (node === null || node === undefined) {
          // ComfyUI sends node:null at the end of a prompt's execution.
          this.clearRunning();
        } else {
          const n = String(node);
          if (n !== this.state.currentNode) this.touchActivity(); // a new node = real progress
          this.state.currentNode = n;
          if (typeof data.prompt_id === "string") this.state.runningPromptId = data.prompt_id;
        }
        break;
      }
      case "progress": {
        const value = typeof data.value === "number" ? data.value : null;
        const max = typeof data.max === "number" ? data.max : null;
        // ONLY treat an advancing value as activity — a wedged step re-emits the
        // same value, and that must keep the stall clock running.
        if (value !== null && value !== this.state.progressValue) this.touchActivity();
        this.state.progressValue = value;
        this.state.progressMax = max;
        if (typeof data.node === "string") this.state.currentNode = data.node;
        break;
      }
      case "execution_success":
      case "execution_error":
      case "execution_interrupted": {
        this.clearRunning();
        break;
      }
      default:
        break;
    }
  }

  /** Cheap snapshot for backpressure (panel_run): is anything already in flight? */
  snapshot(): QueueSnapshot {
    return {
      connected: this.state.connected,
      running: this.state.runningPromptId !== null,
      runningPromptId: this.state.runningPromptId,
      queueDepth: Math.max(0, this.state.queueRemaining),
    };
  }

  /** Stall/backlog report for the turn-start injector. */
  report(stallMs: number): StallReport {
    const running = this.state.runningPromptId !== null;
    const queueDepth = Math.max(running ? 1 : 0, this.state.queueRemaining);
    const idleFor = running && this.state.lastActivityTs ? Date.now() - this.state.lastActivityTs : 0;
    const stalled = running && idleFor >= stallMs;
    const progress =
      this.state.progressValue !== null && this.state.progressMax !== null
        ? `${this.state.progressValue}/${this.state.progressMax}`
        : null;
    return {
      stalled,
      backlog: queueDepth > 1,
      runningPromptId: this.state.runningPromptId,
      currentNode: this.state.currentNode,
      queueDepth,
      stalledForMs: stalled ? idleFor : 0,
      progress,
    };
  }
}

/** Process-wide singleton (one ComfyUI per orchestrator). */
export const QueueMonitor = new QueueMonitorImpl();
