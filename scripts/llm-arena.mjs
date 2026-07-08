#!/usr/bin/env node
// ComfyUI LLM Arena — run a field of local/hosted models through the same
// real-ComfyUI task set over compact-mode MCP, and produce a leaderboard.
//
//   node scripts/llm-arena.mjs                         # default local field via Ollama
//   ARENA_MODELS=gemma4:e4b,qwen3:4b node scripts/llm-arena.mjs
//   OLLAMA_HOST=http://127.0.0.1:11434                 # endpoint override
//
// Hosted models (any OpenAI-compatible API — DeepSeek, GLM, MiniMax, MiMo,
// or all of them through OpenRouter):
//   ARENA_API=openai ARENA_BASE_URL=https://openrouter.ai/api/v1 \
//   ARENA_API_KEY=sk-... ARENA_MODELS="deepseek/deepseek-chat,z-ai/glm-4.7" \
//   node scripts/llm-arena.mjs
// ARENA_OUT=<dir> redirects output (default ./arena-results, results merge).
//
// Requirements: `npm run build`, a running ComfyUI with at least one txt2img
// checkpoint, Ollama with the models pulled. Results land in arena-results/
// (JSON + share-ready markdown report).
//
// TIP: generate_image auto-selects the FIRST local checkpoint when none is
// set. If your checkpoints folder leads with a non-txt2img model (video/SAM),
// pin one for the whole arena: COMFYUI_DEFAULT_CHECKPOINT=<file>.safetensors
//
// Scoring per scenario: PASS = 2 (task done, verified against ComfyUI),
// PARTIAL = 1 (right tool ran, outcome incomplete), FAIL = 0.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SCENARIOS } from "./arena-scenarios.mjs";

const OLLAMA = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
const MODELS = (process.env.ARENA_MODELS ?? "gemma4:e4b,gemma4:e2b,qwen3:8b,qwen3:4b,llama3.1:8b")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
const MAX_ROUNDS = Number(process.env.ARENA_MAX_ROUNDS ?? 22);
/** Tier label recorded on this run's models (e.g. "SoTA", "B-tier", "local")
 *  so the merged leaderboard can compare classes. */
const TIER = process.env.ARENA_TIER ?? "local";
const SCENARIO_TIMEOUT_MS = Number(process.env.ARENA_SCENARIO_TIMEOUT_MS ?? 360_000);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.ARENA_OUT ?? join(process.cwd(), "arena-results");

const SYSTEM =
  "You control a ComfyUI MCP server through exactly three tools: list_tools (catalog), " +
  "describe_tool (one tool's parameters), call_tool (run a tool by name with args). " +
  "Always look up a tool with describe_tool before running it with call_tool. " +
  "Catalog entries are tool NAMES, not data — complete every task by actually running tools with call_tool.";

/**
 * Two API dialects, one arena:
 * - ARENA_API=ollama (default): Ollama-native /api/chat — lets us pin num_ctx.
 * - ARENA_API=openai: any OpenAI-compatible /v1/chat/completions — hosted
 *   models (DeepSeek, GLM, MiniMax, MiMo, OpenRouter, ...). Set ARENA_BASE_URL
 *   and ARENA_API_KEY. Tool results carry tool_call_id per the OpenAI shape.
 */
const API = process.env.ARENA_API ?? "ollama";
const BASE_URL = process.env.ARENA_BASE_URL ?? `${OLLAMA}/v1`;
const API_KEY = process.env.ARENA_API_KEY ?? "";

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
      options: { num_ctx: 16384, temperature: 0 },
    }),
  });
  if (!res.ok) throw new Error(`ollama http ${res.status}: ${await res.text()}`);
  return (await res.json()).message;
}

/** Tool-result message in the active dialect. */
function toolResultMessage(toolCall, toolName, content) {
  if (API === "openai") {
    return { role: "tool", tool_call_id: toolCall.id ?? "call_0", content };
  }
  return { role: "tool", tool_name: toolName, content };
}

async function connectMcp() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, "dist", "index.js")],
    env: {
      ...process.env,
      COMFYUI_MCP_TOOL_MODE: "compact",
      COMFYUI_MCP_PANEL_AUTOINSTALL: "0",
      COMFYUI_MCP_AUTOUPDATE: "0",
      LOG_LEVEL: "error",
    },
  });
  const mcp = new Client({ name: "llm-arena", version: "0.0.0" });
  await mcp.connect(transport);
  return mcp;
}

function textOf(result) {
  return (result.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

async function runScenario(mcp, ollamaTools, model, scenario) {
  const messages = [
    { role: "system", content: SYSTEM },
    { role: "user", content: scenario.task },
  ];
  const t = { calls: [], toolText: "", finalAnswer: "", rounds: 0, nudges: 0 };
  const started = Date.now();

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (Date.now() - started > SCENARIO_TIMEOUT_MS) break;
    t.rounds = round + 1;
    let msg;
    try {
      msg = await chat(model, messages, ollamaTools);
    } catch (err) {
      t.finalAnswer = `(harness error: ${err.message})`;
      break;
    }
    messages.push(msg);

    if (!msg.tool_calls?.length) {
      if (!t.calls.some((c) => c.ok) && t.nudges < 2) {
        t.nudges++;
        messages.push({
          role: "user",
          content:
            "You have not successfully run a tool yet. Use describe_tool then call_tool to actually do the task.",
        });
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
      if (name === "call_tool") {
        const inner = args?.name ?? args?.tool_name ?? "?";
        t.calls.push({ tool: inner, ok });
        console.log(`      ${inner} ${ok ? "ok" : "ERR"}`);
      }
      t.toolText += `\n${text}`;
      messages.push(toolResultMessage(tc, name, text.slice(0, 12000)));
    }
  }

  const okTools = [...new Set(t.calls.filter((c) => c.ok).map((c) => c.tool))];
  const primaryOk = scenario.primary.some((p) => okTools.includes(p));
  const followupOk = !scenario.followup || scenario.followup.some((p) => okTools.includes(p));

  // harness-side ground truth, via a direct call_tool (never trusts the model)
  const harnessCall = async (toolName, toolArgs) => {
    const res = await mcp.callTool({ name: "call_tool", arguments: { name: toolName, args: toolArgs } });
    return textOf(res);
  };
  let verified = false;
  if (primaryOk) {
    try {
      verified = await scenario.verify(harnessCall, t);
    } catch {
      verified = false;
    }
  }

  const partialOk = primaryOk || (scenario.partial ?? []).some((p) => okTools.includes(p));
  const score = primaryOk && followupOk && verified ? 2 : partialOk ? 1 : 0;
  return {
    scenario: scenario.id,
    score,
    verdict: score === 2 ? "PASS" : score === 1 ? "PARTIAL" : "FAIL",
    rounds: t.rounds,
    nudges: t.nudges,
    seconds: Math.round((Date.now() - started) / 1000),
    okTools,
    finalAnswer: t.finalAnswer.slice(0, 400),
    transcript: messages,
  };
}

// ---------------------------------------------------------------------------
console.log(`ComfyUI LLM Arena — models: ${MODELS.join(", ")}`);
const mcp = await connectMcp();
const { tools } = await mcp.listTools();
if (tools.length !== 3) {
  console.error(`expected 3 compact meta-tools, got ${tools.length}`);
  process.exit(1);
}
const ollamaTools = tools.map((t) => ({
  type: "function",
  function: { name: t.name, description: t.description, parameters: t.inputSchema },
}));

// preflight: ComfyUI reachable?
const preflight = await mcp.callTool({ name: "call_tool", arguments: { name: "get_system_stats", args: {} } });
if (preflight.isError) {
  console.error(`ComfyUI is not reachable: ${textOf(preflight).slice(0, 300)}`);
  process.exit(1);
}
let gpu = "unknown GPU";
try {
  const stats = JSON.parse(textOf(preflight));
  gpu = stats?.devices?.[0]?.name ?? gpu;
} catch {
  // non-JSON stats — leave the placeholder
}

const all = [];
for (const model of MODELS) {
  console.log(`\n════════ ${model} ════════`);
  const results = [];
  for (const scenario of SCENARIOS) {
    console.log(`  ▸ ${scenario.id}`);
    const r = await runScenario(mcp, ollamaTools, model, scenario);
    console.log(`    ${r.verdict} (${r.seconds}s, ${r.rounds} rounds, nudges=${r.nudges})`);
    results.push(r);
  }
  const total = results.reduce((s, r) => s + r.score, 0);
  // full transcripts go to their own files; keep the leaderboard JSON light
  mkdirSync(join(OUT_DIR, "transcripts"), { recursive: true });
  for (const r of results) {
    writeFileSync(
      join(OUT_DIR, "transcripts", `${model.replace(/[:/]/g, "_")}-${r.scenario}.json`),
      JSON.stringify(r.transcript, null, 2),
    );
    delete r.transcript;
  }
  all.push({ model, tier: TIER, total, max: SCENARIOS.length * 2, results });
  console.log(`  Σ ${model}: ${total}/${SCENARIOS.length * 2}`);
}

await mcp.close();
await new Promise((r) => setTimeout(r, 250));

// ---------------------------------------------------------------------------
// merge with prior runs so the field can be run one model at a time
mkdirSync(OUT_DIR, { recursive: true });
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
// Tie-breakers, in order: score, fewer nudges (didn't need correcting),
// fewer rounds (efficient tool use), less wall time. All already recorded.
const nudgesOf = (m) => m.results.reduce((s, r) => s + (r.nudges ?? 0), 0);
const roundsOf = (m) => m.results.reduce((s, r) => s + (r.rounds ?? 0), 0);
const secondsOf = (m) => m.results.reduce((s, r) => s + (r.seconds ?? 0), 0);
all.sort(
  (a, b) =>
    b.total - a.total ||
    nudgesOf(a) - nudgesOf(b) ||
    roundsOf(a) - roundsOf(b) ||
    secondsOf(a) - secondsOf(b),
);
writeFileSync(resultsPath, JSON.stringify({ gpu, scenarios: SCENARIOS.map((s) => ({ id: s.id, title: s.title, task: s.task })), leaderboard: all }, null, 2));

const md = [];
md.push(`# ComfyUI LLM Arena`);
md.push("");
md.push(
  `Local models driving a real ComfyUI (${gpu}) through [comfyui-mcp](https://github.com/artokun/comfyui-mcp)'s ` +
    `compact tool mode — 3 meta-tools instead of ~200 schemas, so even small models can play. ` +
    `Each model gets the identical task set; results are verified against the ComfyUI server, not the model's claims.`,
);
md.push("");
const header = ["Model", "Tier", ...SCENARIOS.map((s) => s.id), "Score", "Nudges", "Rounds", "Time"];
md.push(`| ${header.join(" | ")} |`);
md.push(`|${header.map(() => "---").join("|")}|`);
const icon = { 2: "✅", 1: "🟡", 0: "❌" };
for (const m of all) {
  const cells = m.results.map((r) => icon[r.score]);
  md.push(
    `| \`${m.model}\` | ${m.tier ?? "local"} | ${cells.join(" | ")} | **${m.total}/${m.max}** | ${nudgesOf(m)} | ${roundsOf(m)} | ${secondsOf(m)}s |`,
  );
}
md.push("");
md.push(`Scenarios: ${SCENARIOS.map((s) => `**${s.id}** (${s.title.toLowerCase()})`).join(" · ")}`);
md.push("");
md.push(`✅ task completed & verified · 🟡 right tool, incomplete outcome · ❌ failed`);
md.push("");
md.push("Reproduce: `npm run build && node scripts/llm-arena.mjs` — bring your own models via `ARENA_MODELS=...`");
writeFileSync(join(OUT_DIR, "arena-report.md"), `${md.join("\n")}\n`);

console.log(`\n══════ LEADERBOARD ══════`);
for (const m of all) console.log(`${String(m.total).padStart(2)}/${m.max}  ${m.model}`);
console.log(`\nreport: ${join(OUT_DIR, "arena-report.md")}`);
