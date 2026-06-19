// Panel agent — one persistent Claude Agent SDK streaming session per ComfyUI
// panel tab. This is the autonomous background driver for the sidebar panel: the
// orchestrator (src/orchestrator/index.ts) owns the UI bridge and feeds each
// tab's user messages into that tab's session here; the agent's replies flow
// back out to the panel chat.
//
// Why the Agent SDK (not --sdk-url / CCR-v2): we need a persistent background
// agent with a live "channel in" (push messages over time), interrupt/inject,
// and SUBSCRIPTION auth with no API key — without patching the claude binary.
// `query({ prompt: <async generator> })` is exactly that: the generator stays
// open (the channel in), `Query.interrupt()` stops a live turn, and with
// ANTHROPIC_API_KEY unset the SDK reads the on-disk claude.ai OAuth login
// (verified: the session reports apiKeySource=none on this machine).
//
// The spawned agent runs THIS comfyui-mcp build as its MCP server in normal
// (non-channels) mode, so it talks to the live ComfyUI over COMFYUI_URL and
// never contends for the bridge port the orchestrator owns.

import type {
  Query,
  SDKMessage,
  SDKUserMessage,
  Options,
  ModelInfo,
  McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { logger } from "../utils/logger.js";

export type { ModelInfo };

// The Agent SDK is an OPTIONAL dependency (it pulls in ~100 packages and is only
// needed for the panel orchestrator), so load it lazily and fail with a clear
// message rather than at import time for everyone.
let queryFn: typeof import("@anthropic-ai/claude-agent-sdk").query | null = null;
async function loadQuery(): Promise<NonNullable<typeof queryFn>> {
  if (queryFn) return queryFn;
  try {
    const mod = await import("@anthropic-ai/claude-agent-sdk");
    queryFn = mod.query;
  } catch {
    throw new Error(
      "The panel orchestrator requires the optional dependency @anthropic-ai/claude-agent-sdk. Install it with: npm i @anthropic-ai/claude-agent-sdk",
    );
  }
  return queryFn;
}

function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Ask the SDK which models the current account can actually use — so the panel's
 * picker reflects the live subscription instead of a hardcoded list. This is the
 * only model-enumeration path that works on the subscription/OAuth lane:
 * `query.supportedModels()` (the public Models API and `claude` CLI both require
 * an API key, which we deliberately don't have here).
 *
 * Runs a minimal throwaway session — no MCP servers, no plugins/skills — so it's
 * cheap; the control request resolves right after init, then we tear it down.
 * Returns [] on any failure so the panel can fall back gracefully.
 */
export async function fetchSupportedModels(model: string): Promise<ModelInfo[]> {
  const query = await loadQuery();
  let stop = false;
  let wake: (() => void) | null = null;
  // An idle channel: keeps the control connection open without ever consuming a
  // turn, until we tear it down.
  async function* idle(): AsyncGenerator<SDKUserMessage> {
    while (!stop) {
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }
  const q = query({
    prompt: idle(),
    options: {
      model,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      strictMcpConfig: true,
      mcpServers: {},
    } as Options,
  });
  // The transport is pumped by iterating the query — do it in the background so
  // the control request (supportedModels) gets its response.
  const drain = (async () => {
    try {
      for await (const _ of q) {
        void _;
      }
    } catch {
      // torn down below
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Never hang forever: a stuck probe would leave a permanently-pending
    // cached promise and the panel would never get its model list.
    const models = await Promise.race([
      q.supportedModels(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("supportedModels timed out")), 20000);
      }),
    ]);
    logger.info(`[panel-orchestrator] supportedModels: ${models.map((m) => m.value).join(", ") || "(none)"}`);
    return models;
  } catch (err) {
    logger.warn(`[panel-orchestrator] supportedModels probe failed: ${msgOf(err)}`);
    return [];
  } finally {
    if (timer) clearTimeout(timer);
    stop = true;
    // Cast re-widens: TS narrows the closure-mutated local back to its init value.
    (wake as (() => void) | null)?.();
    try {
      await q.interrupt();
    } catch {
      // already winding down
    }
    void drain;
  }
}

/** Reasoning effort levels the SDK accepts (passed via Options.effort). */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];
export function isEffort(v: unknown): v is Effort {
  return typeof v === "string" && (EFFORTS as string[]).includes(v);
}

/** A turn-usage snapshot pushed to the panel for the context/usage meter. */
export interface UsageStatus {
  /** Fraction of the context window in use after the turn (0..1), if known. */
  contextPct?: number;
  /** Approximate tokens occupying the context window after the turn. */
  used?: number;
  /** Model's total context window size, if reported. */
  contextWindow?: number;
  /** Model id that served the turn. */
  model?: string;
  /** Cumulative session cost in USD, if reported. */
  costUsd?: number;
}

/** A ComfyUI image reference the panel sends so the orchestrator can fetch the
 *  bytes from /view and deliver them to the agent as an inline image block —
 *  saving the agent a fetch round-trip. */
export interface ImageRef {
  filename: string;
  subfolder?: string;
  type?: string; // "input" | "output" | "temp" (ComfyUI /view folder)
}

export interface PanelAgentDeps {
  /** mcpServers config for the spawned agent (the comfyui MCP, non-channels). */
  mcpServers: Options["mcpServers"];
  /** Base URL of the ComfyUI instance, for fetching image bytes (/view). */
  comfyuiUrl?: string;
  /** Persona appended to the claude_code system-prompt preset. */
  systemAppend: string;
  /** Pinned model (e.g. claude-opus-4-8). */
  model: string;
  /** Reasoning effort for the session (low..max). Omitted = SDK default. */
  effort?: Effort;
  /** Route the agent's words into the panel chat for this tab. */
  onSay: (tabId: string, text: string) => void;
  /** Report per-turn usage (context meter) for this tab. */
  onStatus?: (tabId: string, status: UsageStatus) => void;
  /** Report the SDK session id once known, so the panel can persist/resume it. */
  onSession?: (tabId: string, sessionId: string) => void;
  /** Report turn lifecycle so the panel shows a "working" indicator that stays
   *  up through silent tool work and clears when the turn ends. */
  onTurn?: (tabId: string, state: "working" | "done") => void;
  /** Live extended-thinking token count, for a "thinking… (N)" indicator. */
  onThinking?: (tabId: string, tokens: number) => void;
  /** In-process MCP server giving the agent LIVE control of this tab's graph. */
  panelServer?: McpSdkServerConfigWithInstance;
  /**
   * Absolute path to the bundled comfyui-mcp plugin dir. When set, its skills
   * (IDEOGRAM/WAN/LTX/etc. expertise) are loaded into the agent so it's an
   * expert out of the box. Omitted if the plugin can't be found.
   */
  pluginPath?: string;
}

/**
 * One persistent streaming session for a single panel tab. Messages typed in
 * the panel are queued via `send()` and yielded into the live `query()` session
 * as user turns; the session never closes until `stop()`.
 */
export class PanelAgent {
  readonly tabId: string;
  private deps: PanelAgentDeps;
  private q: Query | null = null;
  private queue: Array<{ text: string; images?: ImageRef[] }> = [];
  private waiting: (() => void) | null = null;
  private closed = false;
  /** Mutable so the model/effort picker can change them at runtime. */
  private model: string;
  private effort?: Effort;
  /** Captured from the session's init message; enables resume across restarts. */
  sessionId: string | null = null;
  title: string | undefined;
  /** Usage from the most recent assistant API response — the CURRENT context
   *  size (input + cache), as opposed to result.usage which sums every internal
   *  call in the turn and wildly overstates context fill. */
  private lastUsage: Record<string, number> | null = null;
  /** Context window for the active model, cached from result.modelUsage. */
  private contextWindow = 0;
  /** Last status pushed — re-sent on reconnect so the meter isn't blank. */
  lastStatus: UsageStatus | null = null;

  constructor(tabId: string, deps: PanelAgentDeps) {
    this.tabId = tabId;
    this.deps = deps;
    this.model = deps.model;
    this.effort = deps.effort;
  }

  private short(): string {
    return this.tabId.slice(0, 8);
  }

  /** Queue a panel message and wake the streaming generator (the "channel in").
   *  `images` are ComfyUI refs delivered inline as image blocks (vision). */
  send(text: string, opts?: { title?: string; images?: ImageRef[] }): void {
    if (opts?.title) this.title = opts.title;
    this.queue.push({ text, images: opts?.images });
    const wake = this.waiting;
    this.waiting = null;
    wake?.();
  }

  /**
   * Inject a ComfyUI execution event (run finished / errored) as a turn, so the
   * agent learns its render landed and can comment — solving "the asset never
   * reached the agent." Only meaningful when a session is live (the manager only
   * calls this for an existing agent, so we never spawn one just for an event).
   */
  injectEvent(ev: { kind?: string; images?: ImageRef[]; error?: string }): void {
    let text: string | null = null;
    let images: ImageRef[] | undefined;
    if (ev.kind === "executed") {
      const imgs = ev.images ?? [];
      const names = imgs.map((i) => i.filename).filter(Boolean).join(", ") || "(unnamed)";
      text =
        `[panel event] A run on the user's canvas just finished and produced ${imgs.length} output image(s): ${names}. ` +
        `The image(s) are attached below and already shown to the user in the panel. ` +
        `Reply with ONE short sentence acknowledging the result and suggesting a sensible next step — you do NOT need to call any tools. Don't repeat an earlier comment.`;
      // Attach the outputs inline so the agent SEES the render (no fetch needed).
      images = imgs.filter((i) => i.filename).map((i) => ({ ...i, type: i.type ?? "output" }));
    } else if (ev.kind === "run_error") {
      text =
        `[panel event] The user's workflow run just ERRORED: ${ev.error ?? "unknown error"}. ` +
        `If it relates to what you were doing, diagnose it (panel_get_errors has the details) and offer a fix.`;
    }
    if (!text) return;
    this.deps.onTurn?.(this.tabId, "working"); // event triggers a turn — show working
    this.queue.push({ text, images });
    const wake = this.waiting;
    this.waiting = null;
    wake?.();
  }

  /** Fetch a ComfyUI image and wrap it as an Anthropic base64 image block, or
   *  null on any failure (the text reference still names it as a fallback). */
  private async fetchImageBlock(ref: ImageRef): Promise<unknown | null> {
    if (!this.deps.comfyuiUrl || !ref?.filename) return null;
    try {
      const u = new URL("/view", this.deps.comfyuiUrl);
      u.searchParams.set("filename", ref.filename);
      u.searchParams.set("type", ref.type || "input");
      if (ref.subfolder) u.searchParams.set("subfolder", ref.subfolder);
      const res = await fetch(u, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return null;
      let mt = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mt)) {
        mt = "image/png"; // Anthropic-supported set; ComfyUI outputs are PNG by default
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 12 * 1024 * 1024) return null; // keep context sane
      return { type: "image", source: { type: "base64", media_type: mt, data: buf.toString("base64") } };
    } catch {
      return null;
    }
  }

  /** Switch the model live (the SDK applies it to the next turn). */
  async setModel(model: string): Promise<void> {
    if (model === this.model) return;
    this.model = model;
    try {
      // setModel is live: no session restart, the next turn uses it.
      await (this.q as unknown as { setModel?: (m: string) => Promise<void> })?.setModel?.(model);
      logger.info(`[panel-agent ${this.short()}] model → ${model}`);
    } catch (err) {
      logger.debug(`[panel-agent ${this.short()}] setModel: ${msgOf(err)}`);
    }
  }

  /**
   * Record a new effort. The SDK takes effort as a session option, so this only
   * affects the live session if the caller restarts it (the manager recreates
   * the agent with resume so the conversation continues). Returns true if it
   * changed.
   */
  setEffortPending(effort: Effort | undefined): boolean {
    if (effort === this.effort) return false;
    this.effort = effort;
    return true;
  }

  /** True once stop() was called — distinguishes an intentional shutdown from
   *  an SDK session that ended on its own (so the manager can self-heal). */
  get isStopped(): boolean {
    return this.closed;
  }

  get currentModel(): string {
    return this.model;
  }
  get currentEffort(): Effort | undefined {
    return this.effort;
  }

  /** Stop the current turn without ending the session (a "stop" button). */
  async interrupt(): Promise<void> {
    try {
      await this.q?.interrupt();
    } catch (err) {
      logger.debug(`[panel-agent ${this.short()}] interrupt: ${msgOf(err)}`);
    }
  }

  /** End the session and release the agent (tab closed / orchestrator shutdown). */
  async stop(): Promise<void> {
    this.closed = true;
    const wake = this.waiting;
    this.waiting = null;
    wake?.(); // let the generator observe `closed` and return
    try {
      await this.q?.interrupt();
    } catch {
      // already winding down
    }
  }

  // The streaming "channel in": an async generator that stays open and yields a
  // user turn whenever the panel sends one. The session idles between messages
  // and wakes the moment send() pushes — solving "can't wake an idle session".
  private async *channel(): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      if (this.queue.length === 0) {
        await new Promise<void>((resolve) => {
          this.waiting = resolve;
        });
      }
      if (this.closed) return;
      const item = this.queue.shift();
      if (item === undefined) continue;
      // Resolve any image refs to inline base64 blocks so the agent SEES the
      // image in this turn (no view_image/get_image round-trip).
      let content: unknown = item.text;
      if (item.images?.length) {
        const blocks: unknown[] = [];
        for (const ref of item.images) {
          const b = await this.fetchImageBlock(ref);
          if (b) blocks.push(b);
        }
        if (blocks.length) content = [{ type: "text", text: item.text }, ...blocks];
      }
      if (this.closed) return;
      yield {
        type: "user",
        message: { role: "user", content } as SDKUserMessage["message"],
        parent_tool_use_id: null,
      };
    }
  }

  private buildOptions(resume?: string): Options {
    return {
      model: this.model,
      permissionMode: "bypassPermissions",
      // Required alongside bypassPermissions (intentional, isolated background agent).
      allowDangerouslySkipPermissions: true,
      mcpServers: {
        ...this.deps.mcpServers,
        // Live-graph control of THIS tab's open workflow (in-process; talks to
        // the bridge). Lets the agent build on what the user sees.
        ...(this.deps.panelServer ? { panel: this.deps.panelServer } : {}),
      },
      // Only our comfyui MCP — never inherit the user's project/user MCP config
      // (which may run a second comfyui in --channels mode that grabs the port).
      strictMcpConfig: true,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: this.deps.systemAppend,
      },
      // Reasoning effort, when the picker has set one.
      ...(this.effort ? { effort: this.effort } : {}),
      // Load the bundled comfyui-mcp plugin so the agent has model expertise
      // (IDEOGRAM/WAN/LTX/Qwen/… skills) out of the box — "install the package
      // = expert agent". Omitted if the plugin dir can't be found.
      ...(this.deps.pluginPath
        ? {
            plugins: [{ type: "local" as const, path: this.deps.pluginPath }],
            skills: "all" as const,
          }
        : {}),
      ...(resume ? { resume } : {}),
    } as Options;
  }

  /**
   * Run the persistent session, SELF-RESTARTING when the SDK session ends on its
   * own (idle/error). The input queue (`this.queue`) and `sessionId` survive
   * across restarts, so pending messages aren't lost and context resumes — this
   * is the durable fix for the "connected but dead" wedge (previously a session
   * that ended left a dead agent and every later message queued into a channel
   * that was never read). Resolves only on stop() or after repeated immediate
   * failures (gives up + tells the user). Safe to call once.
   */
  async start(resumeSessionId?: string): Promise<void> {
    const query = await loadQuery();
    let quickRestarts = 0;
    while (!this.closed) {
      const resume = this.sessionId ?? resumeSessionId;
      const startedAt = Date.now();
      this.q = query({ prompt: this.channel(), options: this.buildOptions(resume) });
      try {
        for await (const message of this.q) this.route(message);
      } catch (err) {
        if (this.closed) break;
        logger.error(`[panel-agent ${this.short()}] stream error: ${msgOf(err)}`);
      }
      if (this.closed) break;
      // Session ended on its own — bound rapid failure loops so a persistently
      // broken SDK doesn't spin forever or black-hole each message.
      quickRestarts = Date.now() - startedAt < 5000 ? quickRestarts + 1 : 0;
      if (quickRestarts >= 4) {
        logger.error(`[panel-agent ${this.short()}] session keeps ending immediately — giving up`);
        this.sessionId = null; // don't resume a session that won't stay up
        this.deps.onSay(
          this.tabId,
          "⚠️ The agent session keeps dropping. Click Disconnect → Connect, and make sure you're signed in (run `claude` once).",
        );
        break;
      }
      logger.warn(
        `[panel-agent ${this.short()}] session ended — restarting${this.sessionId ? " (resume)" : ""}`,
      );
      await new Promise((r) => setTimeout(r, 250));
    }
    logger.info(`[panel-agent ${this.short()}] stopped`);
  }

  private route(message: SDKMessage): void {
    switch (message.type) {
      case "system":
        if (message.subtype === "init") {
          this.sessionId = message.session_id;
          if (message.model) this.model = message.model;
          this.deps.onSession?.(this.tabId, message.session_id);
          logger.info(
            `[panel-agent ${this.short()}] init model=${message.model} session=${message.session_id.slice(0, 8)} apiKeySource=${message.apiKeySource} effort=${this.effort ?? "default"} skills=${message.skills?.length ?? 0}`,
          );
        } else if (message.subtype === "thinking_tokens") {
          // Live extended-thinking token count → drives a "thinking… (N)" meter
          // so the user can see the agent reasoning (not stuck) before any text.
          const t = (message as unknown as { estimated_tokens?: number }).estimated_tokens;
          if (typeof t === "number") {
            this.deps.onTurn?.(this.tabId, "working");
            this.deps.onThinking?.(this.tabId, t);
          }
        }
        break;
      case "assistant": {
        // Still working — keep the panel's indicator alive through the turn.
        this.deps.onTurn?.(this.tabId, "working");
        // Each assistant API response carries the CURRENT context size — report
        // it live so the meter updates throughout the turn, not just at the end.
        const u = (message.message as unknown as { usage?: Record<string, number> })?.usage;
        if (u) {
          this.lastUsage = u;
          this.reportStatus(u);
        }
        // Relay each text block into the panel chat — progress and final reply.
        const content = (message.message?.content ?? []) as Array<{
          type: string;
          text?: string;
        }>;
        for (const block of content) {
          if (block.type === "text" && typeof block.text === "string") {
            const text = block.text.trim();
            if (text) this.deps.onSay(this.tabId, text);
          }
        }
        break;
      }
      case "result": {
        // Cache the context window + cost from the result, then re-report using
        // the last assistant usage (the true current context).
        const m = message as unknown as {
          modelUsage?: Record<string, { contextWindow?: number }>;
          total_cost_usd?: number;
        };
        for (const mu of Object.values(m.modelUsage ?? {})) {
          if (mu?.contextWindow && mu.contextWindow > this.contextWindow) {
            this.contextWindow = mu.contextWindow;
          }
        }
        if (this.lastUsage) this.reportStatus(this.lastUsage, m.total_cost_usd);
        this.deps.onTurn?.(this.tabId, "done");
        logger.info(
          `[panel-agent ${this.short()}] turn done (subtype=${message.subtype})`,
        );
        break;
      }
      default:
        break;
    }
  }

  /** Push a context/usage snapshot derived from a single API response's usage.
   *  `used` is that response's PROMPT size (fresh + cached input) = the current
   *  context fill — NOT cumulative, and NOT including output tokens. */
  private reportStatus(usage: Record<string, number>, costUsd?: number): void {
    if (!this.deps.onStatus) return;
    try {
      const used =
        (usage.input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0);
      const status: UsageStatus = {
        used,
        model: this.model,
        ...(this.contextWindow
          ? { contextWindow: this.contextWindow, contextPct: used / this.contextWindow }
          : {}),
        ...(typeof costUsd === "number" ? { costUsd } : {}),
      };
      this.lastStatus = status;
      this.deps.onStatus(this.tabId, status);
    } catch (err) {
      logger.debug(`[panel-agent ${this.short()}] usage report failed: ${msgOf(err)}`);
    }
  }
}

export interface PanelAgentManagerOptions {
  mcpServers: Options["mcpServers"];
  systemAppend: string;
  model: string;
  effort?: Effort;
  /** ComfyUI base URL, for fetching image bytes to inline into agent turns. */
  comfyuiUrl?: string;
  onSay: (tabId: string, text: string) => void;
  onStatus?: (tabId: string, status: UsageStatus) => void;
  onSession?: (tabId: string, sessionId: string) => void;
  onTurn?: (tabId: string, state: "working" | "done") => void;
  /** Live extended-thinking token count, for a "thinking… (N)" indicator. */
  onThinking?: (tabId: string, tokens: number) => void;
  /** Build the per-tab live-graph MCP server (bound to the tab id). */
  makePanelServer?: (tabId: string) => McpSdkServerConfigWithInstance;
  /** Bundled plugin dir whose skills make the agent an expert (optional). */
  pluginPath?: string;
}

/** Owns one PanelAgent per tab id, spawned lazily on the tab's first message. */
export class PanelAgentManager {
  private agents = new Map<string, PanelAgent>();
  private opts: PanelAgentManagerOptions;
  /** Per-tab session id to resume on the next spawn (reload restore). */
  private pendingResume = new Map<string, string>();
  /** Default model/effort for newly-spawned agents (mutated by the picker). */
  private model: string;
  private effort?: Effort;

  constructor(opts: PanelAgentManagerOptions) {
    this.opts = opts;
    this.model = opts.model;
    this.effort = opts.effort;
  }

  private makeAgent(tabId: string): PanelAgent {
    return new PanelAgent(tabId, {
      mcpServers: this.opts.mcpServers,
      comfyuiUrl: this.opts.comfyuiUrl,
      systemAppend: this.opts.systemAppend,
      model: this.model,
      effort: this.effort,
      onSay: this.opts.onSay,
      onStatus: this.opts.onStatus,
      onSession: this.opts.onSession,
      onTurn: this.opts.onTurn,
      onThinking: this.opts.onThinking,
      panelServer: this.opts.makePanelServer?.(tabId),
      pluginPath: this.opts.pluginPath,
    });
  }

  /** Last usage snapshot for a tab's agent (for re-pushing the meter on connect). */
  lastStatusFor(tabId: string): UsageStatus | null {
    return this.agents.get(tabId)?.lastStatus ?? null;
  }

  /** Feed a ComfyUI execution event to an EXISTING agent (no-op if none — we
   *  never spawn an agent just to react to an event). Returns whether delivered. */
  injectEvent(tabId: string, ev: { kind?: string; images?: ImageRef[]; error?: string }): boolean {
    const agent = this.agents.get(tabId);
    if (!agent || agent.isStopped) return false; // best-effort; don't enqueue into a closed agent
    agent.injectEvent(ev);
    return true;
  }

  private spawn(tabId: string, resume?: string): PanelAgent {
    const agent = this.makeAgent(tabId);
    this.agents.set(tabId, agent);
    logger.info(
      `[panel-orchestrator] spawning agent for tab ${tabId.slice(0, 8)}${resume ? " (resume)" : ""} (${this.agents.size} active)`,
    );
    // start() now SELF-RESTARTS internally on session-end, so it only settles on
    // an intentional stop() or after it gives up (repeated immediate failures),
    // or it rejects on a hard start failure. In the give-up / reject cases, drop
    // the dead agent (if still mapped and not stopped on purpose) so the next
    // user message spawns a fresh one.
    const settle = (err?: unknown) => {
      if (this.agents.get(tabId) !== agent || agent.isStopped) return;
      this.agents.delete(tabId);
      if (err) {
        const m = msgOf(err);
        logger.error(`[panel-agent ${tabId.slice(0, 8)}] failed to start: ${m}`);
        this.opts.onSay(tabId, `⚠️ The panel agent could not start: ${m}`);
      }
    };
    void agent.start(resume).then(
      () => settle(),
      (err) => settle(err),
    );
    return agent;
  }

  /** Record a session id to resume when this tab next spawns (reload restore). */
  setResume(tabId: string, sessionId: string): void {
    if (this.agents.has(tabId)) return; // a live agent already owns the session
    this.pendingResume.set(tabId, sessionId);
  }

  /** Route a panel message to its tab's agent, creating the agent if needed.
   *  Never routes into a stopped agent (whose channel is closed) — respawns so
   *  the message reaches a live session. */
  send(tabId: string, text: string, meta?: { title?: string; images?: ImageRef[] }): void {
    let agent = this.agents.get(tabId);
    if (agent?.isStopped) {
      this.agents.delete(tabId);
      agent = undefined;
    }
    if (!agent) {
      const resume = this.pendingResume.get(tabId);
      this.pendingResume.delete(tabId);
      agent = this.spawn(tabId, resume);
    }
    agent.send(text, { title: meta?.title, images: meta?.images });
  }

  /**
   * Apply a model/effort change for a tab. Model switches live; effort requires
   * a session restart, so we recreate the agent with resume to continue the
   * conversation seamlessly. Returns a human summary of what changed.
   */
  async setOptions(
    tabId: string,
    next: { model?: string; effort?: Effort | null },
  ): Promise<{ model: string; effort?: Effort; restarted: boolean }> {
    const changes: string[] = [];
    let restarted = false;

    if (typeof next.model === "string" && next.model && next.model !== this.model) {
      this.model = next.model;
      changes.push(`model=${next.model}`);
    }

    // null clears effort back to the SDK default; undefined leaves it untouched.
    let effortChanged = false;
    if (next.effort !== undefined) {
      const nextEffort = next.effort ?? undefined;
      if (nextEffort !== this.effort) {
        this.effort = nextEffort;
        effortChanged = true;
        changes.push(`effort=${nextEffort ?? "default"}`);
      }
    }

    const agent = this.agents.get(tabId);
    if (agent) {
      if (effortChanged) {
        // Effort is a session option → recreate the agent (new effort + model),
        // resuming so the conversation carries over. Swap the map SYNCHRONOUSLY
        // (spawn before the async stop) so a concurrent send() can't interleave
        // and spawn a competing agent in the gap.
        const resume = agent.sessionId ?? undefined;
        this.spawn(tabId, resume); // new agent (uses updated this.model/effort) owns the tab
        void agent.stop(); // retire the old one; it's no longer mapped
        restarted = true;
      } else if (typeof next.model === "string" && next.model) {
        // Model-only change applies live to the existing session.
        await agent.setModel(next.model);
      }
    }

    if (changes.length) {
      logger.info(`[panel-orchestrator] tab ${tabId.slice(0, 8)} options: ${changes.join(" ")}`);
    }
    return { model: this.model, effort: this.effort, restarted };
  }

  /** Forget a tab's agent so the next message starts a brand-new session. The
   *  map mutation is synchronous and the old agent is stopped fire-and-forget,
   *  so the caller (e.g. resume_session) can set a new pendingResume right after
   *  without a concurrent send() spawning a non-resumed agent in an await gap. */
  reset(tabId: string): void {
    const agent = this.agents.get(tabId);
    this.agents.delete(tabId);
    this.pendingResume.delete(tabId);
    if (agent) {
      logger.info(`[panel-orchestrator] tab ${tabId.slice(0, 8)} reset — new session next message`);
      void agent.stop();
    }
  }

  async interrupt(tabId: string): Promise<void> {
    await this.agents.get(tabId)?.interrupt();
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.agents.values()].map((a) => a.stop()));
    this.agents.clear();
  }

  count(): number {
    return this.agents.size;
  }

  get defaults(): { model: string; effort?: Effort } {
    return { model: this.model, effort: this.effort };
  }
}
