#!/usr/bin/env node
// Synthesize diverse ComfyUI tasks for trajectory generation (TOUCAN-style
// stage 2), stratified across the tool categories in tools-full.json.
//
//   SYNTH_BASE_URL=https://openrouter.ai/api/v1 SYNTH_API_KEY=sk-... \
//   SYNTH_MODEL=moonshotai/kimi-k2.5 [SYNTH_PER_CATEGORY=40] npm run ft:tasks
//
// The synthesizer MUST be a ToS-safe open-weight model (lib.mjs allowlist) —
// task text lands verbatim in the training set. Output: finetune/data/tasks.jsonl
// ({id, category, difficulty, task}) consumed by scripts/llm-arena-full.mjs
// via ARENA_TASKS.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, TOOLS_JSON, isAllowedTeacher } from "./lib.mjs";

// OpenRouter is the default provider when its key is in .env (same key the
// arena runs used); SYNTH_* overrides still win.
const MODEL = process.env.SYNTH_MODEL ?? "";
const API_KEY = process.env.SYNTH_API_KEY ?? process.env.OPENROUTER_API_KEY ?? "";
const BASE_URL = (
  process.env.SYNTH_BASE_URL ?? (process.env.OPENROUTER_API_KEY ? "https://openrouter.ai/api/v1" : "")
).replace(/\/$/, "");
const PER_CATEGORY = Number(process.env.SYNTH_PER_CATEGORY ?? 40);
// Override the tool source/output to synthesize for OTHER surfaces — e.g.
// SYNTH_TOOLS_FILE=finetune/data/tools-panel.json SYNTH_OUT=panel-tasks.jsonl
// generates live-canvas tasks for scripts/panel-arena.mjs.
const TOOLS_FILE = process.env.SYNTH_TOOLS_FILE ?? TOOLS_JSON;
const OUT_NAME = process.env.SYNTH_OUT ?? "tasks.jsonl";

if (!MODEL || !BASE_URL) {
  console.error("[ft:tasks] set SYNTH_MODEL and SYNTH_BASE_URL (OpenAI-compatible).");
  process.exit(1);
}
if (!isAllowedTeacher(MODEL) && !process.env.SYNTH_ALLOW_ANY) {
  console.error(
    `[ft:tasks] '${MODEL}' is not on the ToS-safe teacher allowlist (finetune/datagen/lib.mjs). ` +
      "Task text becomes training data — synthesize with an open-weight model.",
  );
  process.exit(1);
}

const { tools } = JSON.parse(readFileSync(TOOLS_FILE, "utf8"));
const byCategory = new Map();
for (const t of tools) {
  if (!byCategory.has(t.category)) byCategory.set(t.category, []);
  byCategory.get(t.category).push(t);
}

const DIFFICULTIES = [
  ["atomic", "a single clear request one tool call can satisfy"],
  ["multi-step", "requires 3-8 tool calls: compose/enqueue/poll, chain outputs between stages, or configure-then-verify"],
  ["debugging", "something is wrong or will fail first (bad model name, broken node, stuck queue) — diagnose, explain, and recover"],
];

async function complete(prompt, attempt = 0) {
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      // A hung upstream must not wedge the whole run — abort and retry once.
      signal: AbortSignal.timeout(180_000),
      headers: {
        "content-type": "application/json",
        ...(API_KEY ? { authorization: `Bearer ${API_KEY}` } : {}),
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.9,
      }),
    });
    if (!res.ok) throw new Error(`${BASE_URL} http ${res.status}: ${await res.text()}`);
    return (await res.json()).choices?.[0]?.message?.content ?? "";
  } catch (err) {
    if (attempt < 1) return complete(prompt, attempt + 1);
    throw err;
  }
}

/** Pull a JSON array out of a chatty completion. */
function parseTasks(text) {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const arr = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(arr) ? arr.filter((t) => typeof t === "string" && t.trim().length > 20) : [];
  } catch {
    return [];
  }
}

const seen = new Set();
const out = [];
for (const [category, catTools] of byCategory) {
  const toolLines = catTools
    .map((t) => `- ${t.name}: ${t.description.split(/(?<=[.!?])\s/)[0].slice(0, 160)}`)
    .join("\n");
  for (const [difficulty, spec] of DIFFICULTIES) {
    const n = Math.ceil(PER_CATEGORY / DIFFICULTIES.length);
    const prompt =
      `You write realistic user requests for an AI agent that operates a ComfyUI server (image/video/audio generation) via tools.\n\n` +
      `Tool area "${category}":\n${toolLines}\n\n` +
      `Write ${n} DIVERSE tasks of difficulty "${difficulty}" (${spec}).\n` +
      `Rules: phrase each as a real user would (imperative, concrete parameters like sizes/steps/prompts/filenames where natural); ` +
      `NEVER mention tool names; vary subjects, styles, and phrasing; each task must be verifiable by observable server state.\n` +
      `Answer with ONLY a JSON array of ${n} strings.`;
    process.stdout.write(`[ft:tasks] ${category}/${difficulty} ... `);
    try {
      const tasks = parseTasks(await complete(prompt));
      let added = 0;
      for (const task of tasks) {
        const key = task.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          id: `${category}-${difficulty}-${String(out.length).padStart(4, "0")}`,
          category,
          difficulty,
          task: task.trim(),
        });
        added++;
      }
      console.log(`${added} tasks`);
    } catch (err) {
      console.log(`FAILED: ${err.message}`);
    }
  }
}

mkdirSync(DATA_DIR, { recursive: true });
const outPath = join(DATA_DIR, OUT_NAME);
writeFileSync(outPath, out.map((t) => JSON.stringify(t)).join("\n") + (out.length ? "\n" : ""));
console.log(`[ft:tasks] wrote ${out.length} tasks → ${outPath}`);
