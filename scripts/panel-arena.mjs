#!/usr/bin/env node
// PANEL Arena — teacher-driven live-canvas trajectories for the fine-tune.
//
// Drives the REAL orchestrator + Ollama backend (compact 6-router mode) with a
// HEADLESS mock panel (scripts/mock-graph.mjs) executing every graph_*/
// workflow_* command in-memory, then harvests each turn's message transcript
// (COMFYUI_MCP_TRANSCRIPT_DIR hook in ollama-backend) and rewrites the compact
// router calls into DIRECT tool calls on the combined full surface — the shape
// the fine-tuned model will deploy with.
//
//   npm run build && node scripts/panel-arena.mjs                    # built-in scenarios
//   PANEL_MODELS=xiaomi/mimo-v2.5 PANEL_TASKS=finetune/data/panel-tasks.jsonl \
//     node scripts/panel-arena.mjs
//
// Verdicts: built-in scenarios verify against the MOCK GRAPH STATE (never the
// model's claims); external tasks get UNVERIFIED-OK when ≥1 panel command
// succeeded and a final answer was produced. PASS/UNVERIFIED-OK trajectories
// append to <out>/trajectories.jsonl. Requires a reachable ComfyUI (the
// orchestrator's headless MCP needs it) and OPENROUTER_API_KEY for hosted
// teachers (auto-read from .env via finetune/datagen/lib.mjs).
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import WebSocket from "ws";
import { createMockGraph, PRESET_TXT2IMG } from "./mock-graph.mjs";
import { FULL_PANEL_SYSTEM_PROMPT, TOOLS_JSON, PANEL_TOOLS_JSON } from "../finetune/datagen/lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE_PORT = Number(process.env.PANEL_BRIDGE_PORT ?? 9380);
const BASE_URL = process.env.PANEL_BASE_URL ?? "https://openrouter.ai/api/v1";
const TURN_TIMEOUT_MS = Number(process.env.PANEL_TURN_TIMEOUT_MS ?? 240_000);
const OUT_DIR = process.env.PANEL_OUT ?? join(process.cwd(), "arena-results-panel");
const MODELS = (process.env.PANEL_MODELS ?? "xiaomi/mimo-v2.5").split(",").map((m) => m.trim()).filter(Boolean);
const TASKS_FILE = process.env.PANEL_TASKS ?? "";

const mcpToolNames = existsSync(TOOLS_JSON)
  ? new Set(JSON.parse(readFileSync(TOOLS_JSON, "utf8")).tools.map((t) => t.name))
  : new Set();
// The panel_* MCP tool names (e.g. panel_save_workflow) — the names the model
// emits behind panel_call_tool, and the DIRECT names it will call in full mode.
// These differ from the bridge COMMAND names the mock graph executes
// (workflow_save), so rewrite must validate against THIS set.
const panelToolNames = existsSync(PANEL_TOOLS_JSON)
  ? new Set(JSON.parse(readFileSync(PANEL_TOOLS_JSON, "utf8")).tools.map((t) => t.name))
  : new Set();
if (!panelToolNames.size) {
  console.error("[panel-arena] finetune/data/tools-panel.json missing — run `npm run ft:tools` first.");
  process.exit(1);
}

/** Built-in scenarios: task + seeded canvas + verify(mock, info) ground truth. */
const PANEL_SCENARIOS = [
  {
    id: "read-graph",
    task: "What nodes are on my canvas right now? Give me a short list.",
    seed: PRESET_TXT2IMG,
    verify: (m, info) => m.counts().graph_get_state >= 1 && /ksampler/i.test(info.finalSay),
  },
  {
    id: "set-widget",
    task: "Change the steps on my KSampler to 12.",
    seed: PRESET_TXT2IMG,
    verify: (m) => [...m.state.nodes.values()].some((n) => n.type === "KSampler" && Number(n.widgets.steps) === 12),
  },
  {
    id: "add-node",
    task: "Add an image upscale node to my workflow.",
    seed: PRESET_TXT2IMG,
    verify: (m) => [...m.state.nodes.values()].some((n) => /upscale|imagescale/i.test(n.type)),
  },
  {
    id: "wire-nodes",
    task: "Connect my VAE Decode node to the Save Image node.",
    seed: PRESET_TXT2IMG,
    verify: (m) => (m.counts().graph_connect ?? 0) >= 1,
  },
  {
    id: "duplicate-node",
    task: "Duplicate my KSampler node so I can compare two sampler settings.",
    seed: PRESET_TXT2IMG,
    verify: (m) => [...m.state.nodes.values()].filter((n) => n.type === "KSampler").length >= 2,
  },
  {
    id: "new-workflow-no-clear",
    task: "Start a new workflow for me.",
    seed: PRESET_TXT2IMG,
    // The classic regression: "new workflow" must open a NEW tab, never wipe
    // the user's existing canvas.
    verify: (m) => (m.counts().workflow_new ?? 0) >= 1 && !(m.counts().graph_clear > 0) && m.state.nodes.size >= PRESET_TXT2IMG.length,
  },
  {
    id: "subgraph",
    task: "Select my two prompt nodes and collapse them into a subgraph, then save it as a blueprint named 'Prompts'.",
    seed: PRESET_TXT2IMG,
    verify: (m) => m.state.blueprints.has("Prompts"),
  },
  {
    id: "run-graph",
    task: "Run my current graph.",
    seed: PRESET_TXT2IMG,
    verify: (m) => (m.counts().graph_run ?? 0) >= 1,
  },
  {
    id: "check-errors",
    task: "Did my last run hit any errors? Check and tell me.",
    seed: PRESET_TXT2IMG,
    verify: (m, info) => (m.counts().graph_get_errors ?? 0) >= 1 && /no error|without error|clean|didn't|no issue/i.test(info.finalSay),
  },
  {
    id: "save-as",
    task: "Save this workflow as 'portrait-pipeline'.",
    seed: PRESET_TXT2IMG,
    verify: (m) => m.state.commands.some((c) => c.cmd === "workflow_save_as" && /portrait-pipeline/.test(String(c.args?.name ?? ""))),
  },
];

const tasks = TASKS_FILE
  ? readFileSync(TASKS_FILE, "utf8").trim().split("\n").map((l) => ({ seed: PRESET_TXT2IMG, ...JSON.parse(l) }))
  : PANEL_SCENARIOS;

// ---------------------------------------------------------------------------
// Rewrite a compact-router transcript to the DIRECT combined-surface form.
// Returns null when unusable (unknown inner tool, no calls, no final answer).
function rewriteToFull(messages) {
  const out = [{ role: "system", content: FULL_PANEL_SYSTEM_PROMPT }];
  const keptIds = new Set();
  const last = messages[messages.length - 1];
  for (const msg of messages) {
    if (msg.role === "system") continue;
    if (msg.role === "user") {
      out.push({ role: "user", content: msg.content });
      continue;
    }
    if (msg.role === "tool") {
      if (keptIds.has(msg.tool_call_id)) {
        out.push({ role: "tool", tool_call_id: msg.tool_call_id, content: msg.content });
      }
      continue;
    }
    if (msg.role !== "assistant") continue;
    if (!msg.tool_calls?.length) {
      if (msg === last) out.push({ role: "assistant", content: msg.content ?? "" });
      continue;
    }
    const rewritten = [];
    for (const [i, tc] of msg.tool_calls.entries()) {
      const fn = tc.function?.name;
      if (/^(panel_)?(list_tools|describe_tool)$/.test(fn ?? "")) continue; // discovery scaffolding
      let a = tc.function?.arguments ?? {};
      if (typeof a === "string") {
        try { a = JSON.parse(a); } catch { return null; }
      }
      const id = tc.id ?? `call_${i}`;
      if (fn === "call_tool" || fn === "panel_call_tool") {
        const inner = a?.name ?? a?.tool_name;
        let innerArgs = a?.args ?? a?.arguments ?? {};
        if (typeof innerArgs === "string") {
          try { innerArgs = JSON.parse(innerArgs); } catch { /* keep as-is */ }
        }
        const known = fn === "panel_call_tool"
          ? panelToolNames.has(inner)
          : mcpToolNames.size === 0 || mcpToolNames.has(inner);
        if (!inner || !known) return null;
        rewritten.push({ id, type: "function", function: { name: inner, arguments: JSON.stringify(innerArgs ?? {}) } });
      } else if (panelToolNames.has(fn) || mcpToolNames.has(fn)) {
        // forgiving-dispatch style direct call — already the target shape
        rewritten.push({ id, type: "function", function: { name: fn, arguments: JSON.stringify(a) } });
      }
    }
    if (!rewritten.length) continue;
    for (const tc of rewritten) keptIds.add(tc.id);
    const kept = { role: "assistant", tool_calls: rewritten };
    if (typeof msg.content === "string" && msg.content.trim()) kept.content = msg.content;
    out.push(kept);
  }
  const hasCalls = out.some((m) => m.tool_calls?.length);
  const endsWithAnswer = out[out.length - 1]?.role === "assistant" && !out[out.length - 1].tool_calls;
  return hasCalls && endsWithAnswer ? out : null;
}

// ---------------------------------------------------------------------------
function envFor(model, transcriptDir) {
  const hosted = model.includes("/");
  return {
    ...process.env,
    PANEL_AGENT_BACKEND: "ollama",
    COMFYUI_MCP_BRIDGE_PORT: String(BRIDGE_PORT),
    COMFYUI_MCP_OLLAMA_MODEL: model,
    COMFYUI_MCP_TRANSCRIPT_DIR: transcriptDir,
    COMFYUI_MCP_PANEL_AUTOINSTALL: "0",
    COMFYUI_MCP_AUTOUPDATE: "0",
    ...(hosted
      ? {
          COMFYUI_MCP_OLLAMA_API: "openai",
          COMFYUI_MCP_OLLAMA_BASE_URL: BASE_URL,
          ...(process.env.OPENROUTER_API_KEY ? { COMFYUI_MCP_OLLAMA_API_KEY: process.env.OPENROUTER_API_KEY } : {}),
        }
      : {}),
  };
}

function waitForPort(port, timeoutMs = 45_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      ws.on("open", () => { ws.close(); resolve(undefined); });
      ws.on("error", () => {
        if (Date.now() - started > timeoutMs) reject(new Error(`bridge :${port} never came up`));
        else setTimeout(tryOnce, 500);
      });
    };
    tryOnce();
  });
}

/** One task on one fresh tab: mock panel executes, harness observes. */
function runPanelTask(task) {
  return new Promise((resolve) => {
    const tab = `parena-${Math.random().toString(36).slice(2, 10)}`;
    const mock = createMockGraph(task.seed ?? []);
    const info = { finalSay: "", says: 0, cmdOk: 0, cmdErr: 0, ready: false, error: "", sessionId: "" };
    const ws = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}`);
    let sent = false;
    let helloTimer = null;
    const started = Date.now();
    const finish = () => {
      try { ws.close(); } catch { /* closing */ }
      if (helloTimer) clearInterval(helloTimer);
      resolve({ mock, info, seconds: Math.round((Date.now() - started) / 1000) });
    };
    const timer = setTimeout(() => { info.error ||= "turn timeout"; finish(); }, TURN_TIMEOUT_MS);

    ws.on("open", () => {
      const hello = JSON.stringify({ type: "hello", tab_id: tab, backend: "ollama", title: "panel-arena" });
      ws.send(hello);
      helloTimer = setInterval(() => { if (!info.ready && !sent) ws.send(hello); }, 2000);
    });
    ws.on("error", (err) => { info.error = `ws: ${err.message}`; clearTimeout(timer); finish(); });
    ws.on("message", (raw) => {
      let m;
      try { m = JSON.parse(String(raw)); } catch { return; }
      // Panel-command frames: execute on the mock graph and reply.
      if (typeof m.rid === "string" && typeof m.cmd === "string") {
        const r = mock.exec(m.cmd, m);
        if (r.ok) info.cmdOk++; else info.cmdErr++;
        try { ws.send(JSON.stringify({ rid: m.rid, ...r })); } catch { /* closing */ }
        return;
      }
      if (m.type === "session" && m.session_id) {
        info.sessionId = String(m.session_id); // exact transcript filename
      } else if (m.type === "ack" && m.kind === "ready" && !sent) {
        info.ready = true;
        sent = true;
        clearInterval(helloTimer);
        ws.send(JSON.stringify({ type: "user_message", tab_id: tab, mid: "m1", text: task.task }));
      } else if (m.type === "ack" && m.kind === "degraded") {
        info.error = "degraded (backend could not enumerate models)";
        clearTimeout(timer);
        finish();
      } else if (m.type === "say" && sent && !String(m.text).startsWith("🟢")) {
        info.says++;
        info.finalSay = String(m.text);
      } else if (m.type === "turn" && m.state === "done" && sent) {
        clearTimeout(timer);
        setTimeout(finish, 400); // let the transcript dump land
      } else if (m.type === "run_error") {
        info.error = String(m.message ?? "run_error").slice(0, 200);
      }
    });
  });
}

/** The transcript for a specific session (the backend dumps <sessionId>.json).
 *  Exact-match by session id avoids racing sibling tasks in the same run. */
function transcriptFor(dir, sessionId) {
  if (!sessionId) return null;
  const p = join(dir, `${sessionId}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

// ---------------------------------------------------------------------------
// Port squatter guard (same rationale as panel-smoke).
await new Promise((resolve, reject) => {
  const probe = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}`);
  probe.on("open", () => { probe.close(); reject(new Error(`port ${BRIDGE_PORT} already in use — set PANEL_BRIDGE_PORT`)); });
  probe.on("error", () => resolve(undefined));
}).catch((err) => { console.error(String(err.message ?? err)); process.exit(1); });

mkdirSync(join(OUT_DIR, "transcripts"), { recursive: true });
const trajPath = join(OUT_DIR, "trajectories.jsonl");
const allResults = [];

/** Spawn an orchestrator, capturing stderr to a rolling log for crash diagnosis. */
function spawnOrchestrator(model, rawDir, logPath) {
  const child = spawn(process.execPath, [join(ROOT, "dist", "index.js"), "--panel-orchestrator"], {
    env: envFor(model, rawDir),
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (d) => { try { appendFileSync(logPath, d); } catch { /* best effort */ } });
  child.on("exit", (code) => { if (code) child.__crashed = true; });
  return child;
}

function killOrchestrator(child) {
  if (!child || child.killed || child.exitCode != null) return Promise.resolve();
  if (process.platform === "win32") {
    try { execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* gone */ }
  } else {
    child.kill("SIGTERM");
  }
  return new Promise((res) => { child.once("exit", res); setTimeout(res, 3000); });
}

for (const model of MODELS) {
  console.log(`\n════════ panel-arena: ${model} · ${tasks.length} tasks ════════`);
  const rawDir = join(OUT_DIR, "raw", model.replace(/[:/]/g, "_"));
  const logPath = join(OUT_DIR, `orchestrator-${model.replace(/[:/]/g, "_")}.log`);
  let child = spawnOrchestrator(model, rawDir, logPath);
  try {
    await waitForPort(BRIDGE_PORT);
    for (const task of tasks) {
      // A prior task's marathon can wedge/kill the single orchestrator — if the
      // bridge port is dead, respawn before the next task rather than cascading
      // ECONNREFUSED across the whole remaining run.
      if (child.exitCode != null) {
        console.log("  (orchestrator died — respawning)");
        await killOrchestrator(child);
        child = spawnOrchestrator(model, rawDir, logPath);
        try { await waitForPort(BRIDGE_PORT); } catch { /* next task reports the ws error */ }
      }
      process.stdout.write(`  ▸ ${task.id} `);
      const { mock, info, seconds } = await runPanelTask(task);
      let verdict = "FAIL";
      if (!info.error && info.finalSay) {
        if (task.verify) {
          let ok = false;
          try { ok = !!task.verify(mock, info); } catch { ok = false; }
          verdict = ok ? "PASS" : info.cmdOk ? "PARTIAL" : "FAIL";
        } else {
          verdict = info.cmdOk ? "UNVERIFIED-OK" : "FAIL";
        }
      }
      const fileBase = `${model.replace(/[:/]/g, "_")}-${task.id}`;
      let harvested = false;
      if (verdict === "PASS" || verdict === "UNVERIFIED-OK") {
        const t = transcriptFor(rawDir, info.sessionId);
        const full = t ? rewriteToFull(t.messages) : null;
        if (full) {
          appendFileSync(trajPath, JSON.stringify({
            id: `panel-arena/${fileBase}`,
            teacher: model,
            scenario: task.id,
            verdict,
            source: "panel-arena",
            surface: "panel",
            messages: full,
          }) + "\n");
          harvested = true;
        }
        if (t) writeFileSync(join(OUT_DIR, "transcripts", `${fileBase}.json`), JSON.stringify({ model, task: task.id, verdict, messages: t.messages }, null, 2));
      }
      console.log(`${verdict} (${seconds}s, cmds ok=${info.cmdOk} err=${info.cmdErr}${harvested ? ", harvested" : ""}${info.error ? `, error=${info.error}` : ""})`);
      allResults.push({ model, task: task.id, verdict, seconds, cmdOk: info.cmdOk, cmdErr: info.cmdErr, error: info.error || undefined });
    }
  } catch (err) {
    console.error(`  orchestrator failed: ${err.message}`);
  } finally {
    await killOrchestrator(child);
  }
}

writeFileSync(join(OUT_DIR, "panel-arena-results.json"), JSON.stringify(allResults, null, 2));
const passed = allResults.filter((r) => r.verdict === "PASS").length;
console.log(`\n══ PANEL ARENA ══  PASS ${passed}/${allResults.filter((r) => tasks.find((t) => t.id === r.task)?.verify).length} verified · trajectories → ${trajPath}`);
