#!/usr/bin/env node
// ComfyUI LLM Arena — FULL tool surface. Same real-ComfyUI task set and
// server-side verification as llm-arena.mjs, but the model sees all ~113 tool
// schemas up front and calls tools directly by name (no compact routers).
//
// Two jobs, one harness (see finetune/README.md):
//   EVAL   — score a model (e.g. the fine-tuned gemma4) on the arena scenarios:
//              ARENA_MODELS=gemma4-comfyui:12b npm run arena:full
//   DATAGEN — run a ToS-safe open-weight teacher over synthesized tasks and
//             harvest full-surface trajectories for SFT:
//              ARENA_API=openai ARENA_BASE_URL=https://openrouter.ai/api/v1 \
//              ARENA_API_KEY=sk-... ARENA_MODELS=moonshotai/kimi-k2.5 \
//              ARENA_TASKS=finetune/data/tasks.jsonl node scripts/llm-arena-full.mjs
//
// Verified-PASS runs (and, for ARENA_TASKS without verify fns, runs that made
// ≥1 successful call and produced a final answer) are appended to
// <out>/trajectories.jsonl ready for the training mix.
//
// Defaults: ARENA_OUT=./arena-results-full, ARENA_NUM_CTX=65536 (the full
// schema payload alone is ~30-40K tokens), ARENA_MAX_ROUNDS=30.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SCENARIOS } from "./arena-scenarios.mjs";
import { FULL_SYSTEM_PROMPT, TEACHER_GUIDANCE } from "../finetune/datagen/lib.mjs";

const OLLAMA = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
const MODELS = (process.env.ARENA_MODELS ?? "gemma4:12b")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
// 40 (was 30): the expert pack-based flows (read_pack_workflow → inspect nodes →
// adapt → enqueue → poll to completion) legitimately need 24+ rounds, and a
// quality render (krea2 etc.) is slow enough that polling eats several more.
const MAX_ROUNDS = Number(process.env.ARENA_MAX_ROUNDS ?? 40);
const TIER = process.env.ARENA_TIER ?? "local";
const SCENARIO_TIMEOUT_MS = Number(process.env.ARENA_SCENARIO_TIMEOUT_MS ?? 360_000);
const NUM_CTX = Number(process.env.ARENA_NUM_CTX ?? 65536);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.ARENA_OUT ?? join(process.cwd(), "arena-results-full");
const TASKS_FILE = process.env.ARENA_TASKS ?? "";

const API = process.env.ARENA_API ?? "ollama";
const BASE_URL =
  process.env.ARENA_BASE_URL ??
  (API === "openai" && process.env.OPENROUTER_API_KEY ? "https://openrouter.ai/api/v1" : `${OLLAMA}/v1`);
const API_KEY = process.env.ARENA_API_KEY ?? (API === "openai" ? process.env.OPENROUTER_API_KEY ?? "" : "");

const NUDGE =
  "You have not successfully run a tool yet. Call the tools directly by name to actually do the task.";

// ARENA_RICH_PROMPT=1: teacher runs with expert guidance appended, but saved
// trajectories carry only the student's lean FULL_SYSTEM_PROMPT (distillation:
// expert behavior, deployable prompt). Use for big-context teachers.
const RICH_PROMPT = process.env.ARENA_RICH_PROMPT === "1";
const RUN_SYSTEM = RICH_PROMPT ? `${FULL_SYSTEM_PROMPT}\n\n${TEACHER_GUIDANCE}` : FULL_SYSTEM_PROMPT;

async function chat(model, messages, tools) {
  if (API === "openai") {
    const res = await fetch(`${BASE_URL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(API_KEY ? { authorization: `Bearer ${API_KEY}` } : {}),
      },
      body: JSON.stringify({ model, messages, tools, tool_choice: "auto", temperature: 0 }),
    });
    if (!res.ok) throw new Error(`${BASE_URL} http ${res.status}: ${await res.text()}`);
    const msg = (await res.json()).choices?.[0]?.message;
    if (!msg) throw new Error("openai-compatible response had no choices[0].message");
    return msg;
  }
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      tools,
      stream: false,
      options: { num_ctx: NUM_CTX, temperature: 0 },
    }),
  });
  if (!res.ok) throw new Error(`ollama http ${res.status}: ${await res.text()}`);
  return (await res.json()).message;
}

function toolResultMessage(toolCall, toolName, content) {
  if (API === "openai") {
    return { role: "tool", tool_call_id: toolCall.id ?? "call_0", content };
  }
  return { role: "tool", tool_name: toolName, content };
}

async function connectMcp() {
  const env = { ...process.env };
  delete env.COMFYUI_MCP_TOOL_MODE; // force FULL mode regardless of shell env
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, "dist", "index.js")],
    env: {
      ...env,
      COMFYUI_MCP_PANEL_AUTOINSTALL: "0",
      COMFYUI_MCP_AUTOUPDATE: "0",
      LOG_LEVEL: "error",
    },
  });
  const mcp = new Client({ name: "llm-arena-full", version: "0.0.0" });
  await mcp.connect(transport);
  return mcp;
}

function textOf(result) {
  return (result.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/** Strip harness nudges (and the stalled turn before each) for SFT output;
 *  rewrite the system turn to the student's lean prompt (see RICH_PROMPT). */
function cleanForTraining(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === "system") {
      out.push({ role: "system", content: FULL_SYSTEM_PROMPT });
      continue;
    }
    if (m.role === "user" && m.content === NUDGE) {
      if (out[out.length - 1]?.role === "assistant" && !out[out.length - 1].tool_calls) out.pop();
      continue;
    }
    out.push(m);
  }
  return out;
}

async function runTask(mcp, openAiTools, model, task) {
  const messages = [
    { role: "system", content: RUN_SYSTEM },
    { role: "user", content: task.task },
  ];
  const t = { calls: [], toolText: "", finalAnswer: "", rounds: 0, nudges: 0 };
  const started = Date.now();

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (Date.now() - started > SCENARIO_TIMEOUT_MS) break;
    t.rounds = round + 1;
    let msg;
    try {
      msg = await chat(model, messages, openAiTools);
    } catch (err) {
      t.finalAnswer = `(harness error: ${err.message})`;
      break;
    }
    messages.push(msg);

    if (!msg.tool_calls?.length) {
      if (!t.calls.some((c) => c.ok) && t.nudges < 2) {
        t.nudges++;
        messages.push({ role: "user", content: NUDGE });
        continue;
      }
      t.finalAnswer = msg.content ?? "";
      break;
    }

    for (const tc of msg.tool_calls) {
      const name = tc.function.name;
      let args = tc.function.arguments;
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          args = {};
        }
      }
      let text = "";
      let ok = false;
      try {
        const result = await mcp.callTool({ name, arguments: args });
        text = textOf(result);
        ok = !result.isError;
      } catch (err) {
        text = `MCP error: ${err.message}`;
      }
      t.calls.push({ tool: name, ok });
      console.log(`      ${name} ${ok ? "ok" : "ERR"}`);
      t.toolText += `\n${text}`;
      messages.push(toolResultMessage(tc, name, text.slice(0, 12000)));
    }
  }

  const okTools = [...new Set(t.calls.filter((c) => c.ok).map((c) => c.tool))];
  const harnessCall = async (toolName, toolArgs) => {
    const res = await mcp.callTool({ name: toolName, arguments: toolArgs });
    return textOf(res);
  };

  let score = null;
  let verdict = "UNVERIFIED";
  if (task.verify) {
    const primaryOk = task.primary.some((p) => okTools.includes(p));
    const followupOk = !task.followup || task.followup.some((p) => okTools.includes(p));
    let verified = false;
    if (primaryOk) {
      try {
        verified = await task.verify(harnessCall, t);
      } catch {
        verified = false;
      }
    }
    const partialOk = primaryOk || (task.partial ?? []).some((p) => okTools.includes(p));
    score = primaryOk && followupOk && verified ? 2 : partialOk ? 1 : 0;
    verdict = score === 2 ? "PASS" : score === 1 ? "PARTIAL" : "FAIL";
  } else if (okTools.length && t.finalAnswer.trim() && !t.finalAnswer.startsWith("(harness error")) {
    verdict = "UNVERIFIED-OK"; // candidate for the LLM-judge filter stage
  }

  return {
    scenario: task.id,
    score,
    verdict,
    rounds: t.rounds,
    nudges: t.nudges,
    seconds: Math.round((Date.now() - started) / 1000),
    okTools,
    finalAnswer: t.finalAnswer.slice(0, 400),
    transcript: messages,
  };
}

// ---------------------------------------------------------------------------
const tasks = TASKS_FILE
  ? readFileSync(TASKS_FILE, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
  : SCENARIOS;
console.log(
  `ComfyUI LLM Arena (FULL surface) — models: ${MODELS.join(", ")} · ${tasks.length} tasks${TASKS_FILE ? ` from ${TASKS_FILE}` : ""}`,
);

const mcp = await connectMcp();
const allTools = [];
let cursor;
do {
  const page = await mcp.listTools(cursor ? { cursor } : {});
  allTools.push(...page.tools);
  cursor = page.nextCursor;
} while (cursor);
if (allTools.length < 100) {
  console.error(`expected the full ~113-tool surface, got ${allTools.length} — is compact mode forced somewhere?`);
  process.exit(1);
}
console.log(`full surface: ${allTools.length} tools`);
const openAiTools = allTools.map((t) => ({
  type: "function",
  function: { name: t.name, description: t.description, parameters: t.inputSchema },
}));

const preflight = await mcp.callTool({ name: "get_system_stats", arguments: {} });
if (preflight.isError) {
  console.error(`ComfyUI is not reachable: ${textOf(preflight).slice(0, 300)}`);
  process.exit(1);
}

mkdirSync(join(OUT_DIR, "transcripts"), { recursive: true });
const trajPath = join(OUT_DIR, "trajectories.jsonl");
const all = [];
for (const model of MODELS) {
  console.log(`\n════════ ${model} ════════`);
  const results = [];
  for (const task of tasks) {
    console.log(`  ▸ ${task.id}`);
    const r = await runTask(mcp, openAiTools, model, task);
    console.log(`    ${r.verdict} (${r.seconds}s, ${r.rounds} rounds, nudges=${r.nudges})`);
    results.push(r);

    const fileBase = `${model.replace(/[:/]/g, "_")}-${task.id}`;
    writeFileSync(
      join(OUT_DIR, "transcripts", `${fileBase}.json`),
      JSON.stringify({ model, task: task.id, verdict: r.verdict, messages: r.transcript }, null, 2),
    );
    if (r.verdict === "PASS" || r.verdict === "UNVERIFIED-OK") {
      appendFileSync(
        trajPath,
        JSON.stringify({
          id: `arena-full/${fileBase}`,
          teacher: model,
          scenario: task.id,
          verdict: r.verdict,
          source: "arena-full",
          messages: cleanForTraining(r.transcript),
        }) + "\n",
      );
    }
    delete r.transcript;
  }
  const scored = results.filter((r) => r.score !== null);
  const total = scored.reduce((s, r) => s + r.score, 0);
  all.push({ model, tier: TIER, total, max: scored.length * 2, results });
  console.log(`  Σ ${model}: ${total}/${scored.length * 2} scored · ${results.length} tasks`);
}

await mcp.close();
await new Promise((r) => setTimeout(r, 250));

// Leaderboard only makes sense for the verified scenario set.
if (!TASKS_FILE) {
  const resultsPath = join(OUT_DIR, "arena-results.json");
  if (existsSync(resultsPath)) {
    try {
      const prior = JSON.parse(readFileSync(resultsPath, "utf8"));
      for (const p of prior.leaderboard ?? []) {
        if (!all.some((m) => m.model === p.model)) all.push({ tier: "local", ...p });
      }
    } catch {
      // corrupt prior results — overwrite
    }
  }
  all.sort((a, b) => b.total - a.total);
  writeFileSync(
    resultsPath,
    JSON.stringify(
      { mode: "full", scenarios: SCENARIOS.map((s) => ({ id: s.id, title: s.title, task: s.task })), leaderboard: all },
      null,
      2,
    ),
  );
  console.log(`\n══════ LEADERBOARD (full-surface) ══════`);
  for (const m of all) console.log(`${String(m.total).padStart(2)}/${m.max}  ${m.model}`);
}
console.log(`\ntrajectories: ${trajPath}`);
