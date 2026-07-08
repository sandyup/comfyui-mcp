#!/usr/bin/env node
// Panel smoke test for LLM backends: for each model, spawn a dedicated panel
// orchestrator (on its own bridge port so a live one is untouched), speak the
// panel's bridge protocol (hello → ready → user turn), and verify the model
// completes a real tool-using turn without choking.
//
//   npm run build && node scripts/panel-smoke.mjs
//   SMOKE_MODELS="gemma4:e4b,qwen3:4b" node scripts/panel-smoke.mjs
//   SMOKE_MODELS="xiaomi/mimo-v2.5,deepseek/deepseek-v3.2" OPENROUTER_API_KEY=sk-... \
//     node scripts/panel-smoke.mjs
//
// Model spec: an Ollama tag (has ":", e.g. gemma4:e4b) runs via local Ollama;
// a vendor slug (has "/", e.g. xiaomi/mimo-v2.5) runs via the OpenAI-compatible
// dialect against SMOKE_BASE_URL (default OpenRouter) with OPENROUTER_API_KEY.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import WebSocket from "ws";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE_PORT = Number(process.env.SMOKE_BRIDGE_PORT ?? 9280);
const BASE_URL = process.env.SMOKE_BASE_URL ?? "https://openrouter.ai/api/v1";
const TURN_TIMEOUT_MS = Number(process.env.SMOKE_TURN_TIMEOUT_MS ?? 240_000);
const MODELS = (process.env.SMOKE_MODELS ?? "gemma4:e4b")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
const PROMPT =
  "Check whether the ComfyUI server is healthy and tell me the GPU name and free VRAM. Keep it short.";

function envFor(model) {
  const hosted = model.includes("/");
  return {
    ...process.env,
    PANEL_AGENT_BACKEND: "ollama",
    COMFYUI_MCP_BRIDGE_PORT: String(BRIDGE_PORT),
    COMFYUI_MCP_OLLAMA_MODEL: model,
    ...(hosted
      ? {
          COMFYUI_MCP_OLLAMA_API: "openai",
          COMFYUI_MCP_OLLAMA_BASE_URL: BASE_URL,
          ...(process.env.OPENROUTER_API_KEY
            ? { COMFYUI_MCP_OLLAMA_API_KEY: process.env.OPENROUTER_API_KEY }
            : {}),
        }
      : {}),
  };
}

function startOrchestrator(model) {
  const child = spawn(process.execPath, [join(ROOT, "dist", "index.js"), "--panel-orchestrator"], {
    env: envFor(model),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  return { child, log: () => log };
}

function waitForPort(port, timeoutMs = 30_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      ws.on("open", () => {
        ws.close();
        resolve(undefined);
      });
      ws.on("error", () => {
        if (Date.now() - started > timeoutMs) reject(new Error(`bridge :${port} never came up`));
        else setTimeout(tryOnce, 500);
      });
    };
    tryOnce();
  });
}

function runTurn(model) {
  return new Promise((resolve) => {
    const tab = `smoke-${Math.random().toString(36).slice(2, 8)}`;
    let helloTimer = null;
    const ws = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}`);
    const r = {
      model,
      ready: false,
      degraded: false,
      streamed: 0,
      toolChips: 0,
      sayText: "",
      turnDone: false,
      error: "",
      seconds: 0,
    };
    const started = Date.now();
    let sent = false;
    const finish = () => {
      r.seconds = Math.round((Date.now() - started) / 1000);
      try {
        ws.close();
      } catch {
        /* closing */
      }
      if (helloTimer) clearInterval(helloTimer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      r.error ||= `timeout after ${TURN_TIMEOUT_MS / 1000}s`;
      finish();
    }, TURN_TIMEOUT_MS);

    // The bridge LISTENS before the orchestrator finishes wiring its message
    // handler (~1s gap) — a single early hello is dropped silently. The real
    // panel re-sends hello; do the same until the orchestrator answers.
    ws.on("open", () => {
      const hello = JSON.stringify({ type: "hello", tab_id: tab, backend: "ollama", title: "smoke" });
      ws.send(hello);
      helloTimer = setInterval(() => {
        if (!r.ready && !sent) ws.send(hello);
        else clearInterval(helloTimer);
      }, 2000);
    });
    ws.on("error", (err) => {
      r.error = `ws: ${err.message}`;
      clearTimeout(timer);
      finish();
    });
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === "ack" && msg.kind === "ready" && !sent) {
        r.ready = true;
        sent = true;
        ws.send(JSON.stringify({ type: "user_message", tab_id: tab, mid: "m1", text: PROMPT }));
      } else if (msg.type === "ack" && msg.kind === "degraded") {
        r.degraded = true;
        r.error = "degraded ack (backend could not enumerate models)";
        clearTimeout(timer);
        finish();
      } else if (msg.type === "stream") {
        r.streamed++;
      } else if (msg.type === "agent_event" && msg.event?.type === "tool_call") {
        r.toolChips++;
      } else if (msg.type === "say" && sent && !String(msg.text).startsWith("🟢")) {
        r.sayText = String(msg.text).slice(0, 200);
      } else if (msg.type === "turn" && msg.state === "done" && sent) {
        r.turnDone = true;
        clearTimeout(timer);
        setTimeout(finish, 300);
      } else if (msg.type === "run_error") {
        r.error = String(msg.message ?? "run_error").slice(0, 200);
      }
    });
  });
}

// Refuse to run against a squatter: if something already listens on the smoke
// port, waitForPort would "succeed" against a foreign/stale orchestrator and
// every verdict would be meaningless.
try {
  await new Promise((resolve, reject) => {
    const probe = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}`);
    probe.on("open", () => {
      probe.close();
      reject(new Error(`port ${BRIDGE_PORT} is already in use — stop that process or set SMOKE_BRIDGE_PORT`));
    });
    probe.on("error", () => resolve(undefined)); // connection refused = free
  });
} catch (err) {
  console.error(String(err.message ?? err));
  process.exit(1);
}

mkdirSync(join(process.cwd(), "arena-results"), { recursive: true });
const results = [];
for (const model of MODELS) {
  process.stdout.write(`\n══ smoke: ${model} ══\n`);
  const orch = startOrchestrator(model);
  let r;
  try {
    await waitForPort(BRIDGE_PORT);
    r = await runTurn(model);
  } catch (err) {
    r = { model, ready: false, error: err.message, turnDone: false };
  }
  // Windows SIGTERM doesn't reap a node process tree — a survivor squats the
  // bridge port and every later model silently talks to STALE code. Tree-kill.
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(orch.child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      /* already gone */
    }
  } else {
    orch.child.kill("SIGTERM");
  }
  await new Promise((res) => {
    orch.child.once("exit", res);
    setTimeout(res, 3000);
  });
  const verdict = r.turnDone && r.sayText && !r.error ? "PASS" : r.ready ? "CHOKED" : "NO-START";
  r.verdict = verdict;
  results.push(r);
  process.stdout.write(
    `${verdict}: ready=${r.ready} turnDone=${r.turnDone} streams=${r.streamed ?? 0} say="${(r.sayText ?? "").slice(0, 80).replace(/\n/g, " ")}" ${r.error ? `error=${r.error}` : ""} (${r.seconds ?? "?"}s)\n`,
  );
}

writeFileSync(join(process.cwd(), "arena-results", "panel-smoke.json"), JSON.stringify(results, null, 2));
process.stdout.write(`\n══ PANEL SMOKE ══\n`);
for (const r of results) process.stdout.write(`${String(r.verdict).padEnd(9)} ${r.model}\n`);
process.exit(results.every((r) => r.verdict === "PASS") ? 0 : 1);
