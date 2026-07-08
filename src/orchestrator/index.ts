// Panel orchestrator — a standalone, long-lived process that drives the ComfyUI
// sidebar panel with autonomous BACKGROUND agents, so the user's interactive
// Claude session stays free. Launch with `comfyui-mcp --panel-orchestrator`
// (or COMFYUI_MCP_PANEL_ORCHESTRATOR=1).
//
// It owns the UI bridge (port 9101) directly — so it SEES panel messages instead
// of relying on an idle interactive session to notice a channel push — and spawns
// one Claude Agent SDK streaming session per panel tab (src/orchestrator/
// panel-agent.ts). Each agent runs on the user's Claude SUBSCRIPTION with no API
// key. See docs/design/panel-orchestrator.md.

import { existsSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startUiBridge } from "../services/ui-bridge.js";
import { logger } from "../utils/logger.js";
import {
  PanelAgentManager,
  fetchSupportedModels,
  isEffort,
  type Effort,
  type ModelInfo,
  type UsageStatus,
} from "./panel-agent.js";
import { createPanelMcpServer } from "./panel-tools.js";

const PANEL_SYSTEM_APPEND = `You are the autonomous assistant embedded directly in a ComfyUI sidebar panel. The person is working in ComfyUI and talks to you through that panel: their messages arrive as your prompts, and everything you write is shown to them in the panel chat. Write for that reader — lead with the result, keep replies short and concrete, and don't narrate routine internal steps.

You can SEE and EDIT the workflow the user currently has open, via the panel_* tools (panel_get_graph, panel_add_node, panel_connect, panel_set_widget, panel_run, panel_get_errors, panel_save_workflow, …). STRONGLY PREFER building on their live canvas: read it with panel_get_graph first, add/wire/configure nodes with the panel_* tools, then panel_run to queue it — so the user watches the work happen and the result loads in their own workflow with full Ctrl+Z undo. Only fall back to the headless generate_image/enqueue_workflow tools when the user explicitly wants a one-off they don't need on their canvas, or when no panel tab is connected (a panel_* call will error if so).

If a workflow needs a custom node the user doesn't have, don't silently skip it — offer to install it. Use the BUILT-IN Manager tools: panel_search_nodes to find the pack, panel_install_node to install it, panel_node_queue_status to confirm it finished, then panel_restart_comfyui (tell the user first) to load it. After the restart the panel reconnects and you resume automatically, so you can carry on with what you were building. Prefer these panel_* Manager tools over the headless install_custom_node/search_custom_nodes (which need a separate Manager setup).

CRITICAL — never destroy the user's work. When they ask for a "new workflow", a "fresh canvas", or to "start over for a new project", call panel_new_workflow (it opens a NEW TAB and leaves their current workflow intact). NEVER use panel_clear for that — panel_clear wipes the CURRENTLY OPEN graph and is ONLY for an explicit "clear/reset this canvas". You can manage tabs with panel_list_workflows / panel_open_workflow / panel_rename_workflow / panel_close_workflow, and group nodes with panel_select_nodes / panel_create_subgraph.

You also have the comfyui MCP tools to generate images, video, and audio and to inspect, download models for, and manage their ComfyUI instance. Use them to actually do what's asked, then tell them what you did and name or link any output. If a request is ambiguous, make a sensible choice and say what you chose rather than stalling.

You are running in the background on the user's own machine. For routine, reversible actions that follow from the request, act without asking permission.

Do NOT use the AskUserQuestion tool / interactive pickers — they do not render in this panel and get auto-dismissed, which makes you think the user declined. When you genuinely need the user to choose between options, just ASK in your normal chat reply: pose the question and list the choices briefly (e.g. "Want A, B, or C?"), then stop and wait for their typed answer. The panel is a chat, so a plain-text question is the right way to ask.`;

/**
 * Lockfile path for a given bridge port. The orchestrator self-registers its
 * REAL node pid here (not the npx shim's), plus the ComfyUI pid that launched
 * it, so the panel pack can reliably identify and replace a stale orchestrator
 * left over from a previous ComfyUI session (the "orphan on the port" trap).
 */
function orchLockPath(port: number): string {
  return join(tmpdir(), `comfyui-mcp-panel-orch-${port}.json`);
}

/**
 * Tie the orchestrator's lifetime to ComfyUI's. The launcher (the panel pack)
 * passes its own PID as COMFYUI_MCP_PARENT_PID; we poll whether that process is
 * still alive and shut down when it's gone. Unlike an atexit/signal handler on
 * the parent, this also covers a ComfyUI crash or hard kill — the child notices
 * the parent disappeared and exits on its own. No-op when no parent PID is set
 * (e.g. when run manually from a terminal).
 */
function startParentWatchdog(onParentGone: () => void): void {
  const raw = process.env.COMFYUI_MCP_PARENT_PID;
  const ppid = raw ? Number(raw) : NaN;
  if (!Number.isInteger(ppid) || ppid <= 0) return;
  const timer = setInterval(() => {
    let alive = true;
    try {
      process.kill(ppid, 0); // signal 0 = existence probe, doesn't actually signal
    } catch (err) {
      // ESRCH = gone; EPERM = exists but not ours to signal (treat as alive).
      alive = (err as NodeJS.ErrnoException).code === "EPERM";
    }
    if (!alive) {
      clearInterval(timer);
      onParentGone();
    }
  }, 5000);
  // Don't let the watchdog alone keep the process alive — the bridge does that.
  timer.unref?.();
  logger.info(`[panel-orchestrator] watching parent process ${ppid}; will shut down when it exits`);
}

/**
 * Run the panel orchestrator. Never resolves — the bridge and agents keep the
 * process alive until SIGINT/SIGTERM or the parent (ComfyUI) exits.
 */
export async function runPanelOrchestrator(): Promise<void> {
  // Crash guard: the orchestrator is a long-lived background process the user
  // can't see. A stray rejection (e.g. a fire-and-forget push to a tab that
  // vanished mid-flight, or an SDK hiccup) must never silently kill it —
  // otherwise the panel goes dead with no explanation. Log and keep running.
  process.on("unhandledRejection", (reason) => {
    logger.error(
      `[panel-orchestrator] unhandled rejection (ignored): ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`,
    );
  });
  process.on("uncaughtException", (err) => {
    logger.error(`[panel-orchestrator] uncaught exception (ignored): ${err.stack ?? err.message}`);
  });

  // Subscription lane: the background agent must authenticate against the user's
  // claude.ai login, never an API key. Unset the key for the SDK subprocess.
  delete process.env.ANTHROPIC_API_KEY;

  const bridge = startUiBridge();

  // Owning the bridge port is the orchestrator's whole job — if another process
  // holds it (e.g. an interactive comfyui-mcp running with --channels), fail
  // loudly instead of running uselessly. (This also avoids the case where a
  // failed bind leaves the process with no live handles and it exits silently.)
  const bound = await bridge.whenReady();
  if (!bound) {
    logger.error(
      `[panel-orchestrator] could not bind the panel bridge port — another process owns it (often an interactive comfyui-mcp started with --channels). Free that port (or stop the --channels session) and restart the orchestrator. Override the port with COMFYUI_MCP_BRIDGE_PORT.`,
    );
    process.exit(1);
  }

  // We own the port — register our REAL pid + the launching ComfyUI pid so the
  // panel pack can detect and replace us if we're ever orphaned across a Comfy
  // restart. Written only after a successful bind (so the file always names the
  // process that actually holds the port).
  const lockPort = Number(process.env.COMFYUI_MCP_BRIDGE_PORT) || 9101;
  const lockPath = orchLockPath(lockPort);
  try {
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        parent: Number(process.env.COMFYUI_MCP_PARENT_PID) || null,
        port: lockPort,
        startedAt: new Date().toISOString(),
      }),
    );
  } catch (err) {
    logger.debug(`[panel-orchestrator] could not write lockfile ${lockPath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // The spawned agent runs THIS comfyui-mcp build as its MCP server, in normal
  // (non-channels) mode — so it generates against the live ComfyUI over
  // COMFYUI_URL and never tries to bind the bridge port we own here.
  const mcpEntry = fileURLToPath(new URL("../index.js", import.meta.url));
  const comfyuiUrl = process.env.COMFYUI_URL ?? "http://127.0.0.1:8188";
  // ComfyUI install path — when set, the spawned agent's MCP runs in LOCAL mode,
  // so download_model / apply_manifest / installer-pack / model-scan tools work
  // instead of degrading to remote-only. The panel pack supplies this.
  const comfyuiPath = process.env.COMFYUI_PATH;
  const model = process.env.COMFYUI_MCP_PANEL_MODEL ?? "claude-opus-4-8";
  const envEffort = process.env.COMFYUI_MCP_PANEL_EFFORT;
  const effort: Effort | undefined = isEffort(envEffort) ? envEffort : undefined;
  const bridgePort = Number(process.env.COMFYUI_MCP_BRIDGE_PORT) || 9101;

  // The bundled plugin (skills) ships alongside dist/ in the package root. Load
  // it so the background agents are ComfyUI experts out of the box.
  const pluginPath = fileURLToPath(new URL("../../plugin", import.meta.url));
  const pluginAvailable = existsSync(pluginPath);
  if (!pluginAvailable) {
    logger.warn(
      `[panel-orchestrator] bundled plugin not found at ${pluginPath} — agents run without model-expertise skills.`,
    );
  }

  // Build an agent_status frame from a usage snapshot — used both live (per
  // assistant response) and to re-push the last value when a tab reconnects.
  function pushStatus(tabId: string, status: UsageStatus): void {
    bridge.push(
      {
        type: "agent_status",
        ...(typeof status.contextPct === "number" ? { context_pct: status.contextPct } : {}),
        ...(typeof status.used === "number" ? { used: status.used } : {}),
        ...(typeof status.contextWindow === "number" ? { context_window: status.contextWindow } : {}),
        ...(status.model ? { model: status.model } : {}),
        ...(typeof status.costUsd === "number" ? { cost_usd: status.costUsd } : {}),
      },
      tabId,
    );
  }

  const manager = new PanelAgentManager({
    model,
    effort,
    systemAppend: PANEL_SYSTEM_APPEND,
    pluginPath: pluginAvailable ? pluginPath : undefined,
    // Live-graph control of the user's open workflow, per tab (in-process).
    makePanelServer: (tabId) => createPanelMcpServer(bridge, tabId),
    mcpServers: {
      comfyui: {
        type: "stdio",
        command: process.execPath, // node
        args: [mcpEntry], // dist/index.js, no --channels
        env: {
          COMFYUI_URL: comfyuiUrl,
          // Local mode → enables download_model, apply_manifest (installer packs),
          // and model scans so the agent installs the right way instead of curl.
          ...(comfyuiPath ? { COMFYUI_PATH: comfyuiPath } : {}),
        },
      },
    },
    onSay: (tabId, text) => {
      bridge.push({ type: "say", text }, tabId);
    },
    // Per-response usage → the panel's context/usage meter (updates live).
    onStatus: pushStatus,
    // Report the SDK session id so the panel can persist it and resume on reload.
    onSession: (tabId, sessionId) => {
      bridge.push({ type: "session", session_id: sessionId }, tabId);
    },
  });

  // Debounce the connect ack: the panel re-sends `hello` on reconnect and on
  // workflow-title changes, which would otherwise stack duplicate greetings.
  const lastAckAt = new Map<string, number>();
  const ACK_DEBOUNCE_MS = 4000;

  // The account's real model list — probed once from the SDK (the only way that
  // works on the subscription lane) and cached. Pushed to each tab so the
  // panel's model/effort picker reflects what's actually available, with each
  // model's supported effort levels, instead of a hardcoded list.
  let modelsPromise: Promise<ModelInfo[]> | null = null;
  function ensureModels(): Promise<ModelInfo[]> {
    if (!modelsPromise) {
      modelsPromise = fetchSupportedModels(model).then((list) => {
        // Don't cache an empty/failed probe forever — let the next hello retry.
        if (!list.length) modelsPromise = null;
        return list;
      });
    }
    return modelsPromise;
  }
  function pushModels(tabId: string): void {
    void ensureModels()
      .then((models) => {
        if (models.length) {
          bridge.push({ type: "models", models, current: model }, tabId);
        }
      })
      .catch(() => {
        /* probe already logged; panel keeps its fallback list */
      });
  }

  bridge.onPanelMessage = (event) => {
    // Connect ack: the instant a panel tab connects, the orchestrator announces
    // itself so "connected" means "a real agent is attending" — not merely "a
    // socket is open." A bare/undriven bridge stays silent, so the panel can
    // tell the difference (and warn if no ack arrives).
    if (event.type === "hello" && event.tab_id) {
      // Reload restore: the panel re-sends the last session id it saw so the
      // agent's memory continues. Only honored before the tab's agent spawns.
      const resume = typeof event.resume === "string" ? event.resume : undefined;
      if (resume) manager.setResume(event.tab_id, resume);
      // Send the live model list so the picker reflects the real subscription.
      pushModels(event.tab_id);
      // Re-push the last usage so the context meter isn't blank after a reload.
      const lastStatus = manager.lastStatusFor(event.tab_id);
      if (lastStatus) pushStatus(event.tab_id, lastStatus);
      const tabId = event.tab_id;
      const now = Date.now();
      if (now - (lastAckAt.get(tabId) ?? 0) < ACK_DEBOUNCE_MS) return;
      lastAckAt.set(tabId, now);
      // TRUTHFUL "connected": only claim ready after PROVING the SDK can run, by
      // probing the model list (same machinery the agent uses to spawn). If the
      // probe fails — the "connected but dead" wedge — say so and send a degraded
      // ack instead of a green ready, so the panel can show the real state.
      void ensureModels()
        .then((models) => {
          if (models.length) {
            bridge.push(
              { type: "say", text: `🟢 comfyui-mcp agent ready — ${model} on your Claude subscription. Ask away.` },
              tabId,
            );
            bridge.push({ type: "ack", ok: true, kind: "ready", agent: model }, tabId);
            logger.info(`[panel-orchestrator] tab ${tabId.slice(0, 8)} connected — agent healthy, sent ready ack`);
          } else {
            bridge.push(
              {
                type: "say",
                text: "⚠️ The background agent isn't responding — the Claude Agent SDK couldn't start. Make sure you're signed in (run `claude` once), then Disconnect → Connect to retry.",
              },
              tabId,
            );
            bridge.push({ type: "ack", ok: false, kind: "degraded" }, tabId);
            logger.warn(`[panel-orchestrator] tab ${tabId.slice(0, 8)} connected but model probe empty — sent degraded ack`);
          }
        })
        .catch(() => {
          bridge.push({ type: "ack", ok: false, kind: "degraded" }, tabId);
        });
      return;
    }
    // Model / effort picker: apply and confirm. Model switches live; an effort
    // change restarts the session (resumed) so the conversation carries over.
    if (event.type === "set_options" && event.tab_id) {
      const tabId = event.tab_id;
      const reqModel = typeof event.model === "string" ? event.model : undefined;
      const nextEffort: Effort | null | undefined =
        event.effort === null
          ? null
          : isEffort(event.effort)
            ? event.effort
            : undefined;
      void (async () => {
        let nextModel = reqModel;
        // Guard: never switch to a model the account can't use — an unknown id
        // makes the SDK session hang on init. (Defense in depth; the panel only
        // sends ids from the live catalog.)
        if (nextModel) {
          const known = await ensureModels().catch(() => [] as ModelInfo[]);
          if (known.length && !known.some((m) => m.value === nextModel)) {
            logger.warn(`[panel-orchestrator] ignoring unknown model "${nextModel}" — keeping current`);
            nextModel = undefined;
          }
        }
        const applied = await manager.setOptions(tabId, { model: nextModel, effort: nextEffort });
        bridge.push(
          {
            type: "ack",
            ok: true,
            kind: "options",
            model: applied.model,
            effort: applied.effort ?? null,
            restarted: applied.restarted,
          },
          tabId,
        );
      })().catch((err) => {
        bridge.push(
          { type: "say", text: `⚠️ Could not change model/effort: ${err?.message ?? err}` },
          tabId,
        );
      });
      return;
    }

    // Execution event from the panel (run finished / errored). Feed it to the
    // tab's live agent so it knows its render landed and can comment/iterate.
    // Dropped silently if no agent is attending the tab (we don't spawn one).
    if (event.type === "agent_event" && event.tab_id) {
      const delivered = manager.injectEvent(event.tab_id, event as {
        kind?: string;
        images?: Array<{ filename?: string }>;
        error?: string;
      });
      if (delivered) {
        logger.info(`[panel-orchestrator] tab ${event.tab_id.slice(0, 8)} event → agent: ${event.kind}`);
      }
      return;
    }

    // Interrupt: stop the current turn without ending the session (Ctrl+C in
    // the panel). The session stays open for the next message.
    if (event.type === "interrupt" && event.tab_id) {
      const tabId = event.tab_id;
      void manager.interrupt(tabId);
      bridge.push({ type: "ack", ok: true, kind: "interrupt" }, tabId);
      logger.info(`[panel-orchestrator] tab ${tabId.slice(0, 8)} interrupted`);
      return;
    }

    // New chat: forget this tab's session so the next message starts fresh (no
    // memory of the prior conversation). Tell the panel to drop its stored id.
    if (event.type === "new_session" && event.tab_id) {
      const tabId = event.tab_id;
      // reset() is synchronous (map cleared now), so no concurrent send() can
      // spawn an agent before we report the cleared session.
      manager.reset(tabId);
      bridge.push({ type: "session", session_id: null }, tabId);
      bridge.push({ type: "ack", ok: true, kind: "new_session" }, tabId);
      return;
    }

    // Switch to a historical chat: drop the live agent and arm a resume so the
    // next message continues THAT conversation. Both calls are synchronous, so
    // the resume is armed before any later message can spawn a fresh agent.
    if (event.type === "resume_session" && event.tab_id) {
      const tabId = event.tab_id;
      const sid = typeof event.session_id === "string" ? event.session_id : undefined;
      manager.reset(tabId);
      if (sid) manager.setResume(tabId, sid);
      bridge.push({ type: "ack", ok: true, kind: "resume_session" }, tabId);
      return;
    }

    if (
      event.type !== "user_message" ||
      typeof event.text !== "string" ||
      !event.tab_id
    ) {
      return;
    }
    // Echo so the user immediately sees their own message land in the chat.
    bridge.push({ type: "echo", text: event.text }, event.tab_id);
    // Per-message ack: a live server-side signal that the agent received this
    // turn and is working — distinct from the panel's own optimistic spinner.
    bridge.push({ type: "ack", ok: true, kind: "working" }, event.tab_id);
    logger.info(
      `[panel-orchestrator] tab ${event.tab_id.slice(0, 8)} → agent: ${event.text.slice(0, 80)}`,
    );
    manager.send(event.tab_id, event.text, { title: event.title });
  };

  logger.info(
    `[panel-orchestrator] ready — bridge on ws://127.0.0.1:${bridgePort}; an agent spawns per ComfyUI tab on its first message (model=${model}, comfyui=${comfyuiUrl}${comfyuiPath ? `, path=${comfyuiPath}` : " — no COMFYUI_PATH, local install/pack tools limited"})`,
  );

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("[panel-orchestrator] shutting down — stopping agents…");
    await manager.stopAll();
    await bridge.stop();
    // Only remove the lockfile if it still names us — avoid clobbering a fresh
    // orchestrator that may have replaced us.
    try {
      const cur = JSON.parse(readFileSync(lockPath, "utf8"));
      if (cur?.pid === process.pid) unlinkSync(lockPath);
    } catch {
      // No lockfile / unreadable — nothing to clean up.
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Beacon: when ComfyUI (the launcher) exits — cleanly or by crash/kill —
  // shut down rather than linger as an orphan holding the bridge port.
  startParentWatchdog(() => {
    logger.info("[panel-orchestrator] parent (ComfyUI) process exited — shutting down.");
    void shutdown();
  });

  // Keep the process alive; the bridge + agents drive everything from here.
  await new Promise<void>(() => {});
}
