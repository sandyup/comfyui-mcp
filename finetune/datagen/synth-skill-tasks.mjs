#!/usr/bin/env node
// Skill/pack-grounded task synthesis — the SYLLABUS pass. Where synth-tasks.mjs
// stratifies over tool categories, this walks the real expertise corpus
// (plugin/skills/*/SKILL.md + packs/*/manifest.yaml) and has the teacher write
// user tasks that exercise each capability: krea2/ideogram JSON prompting,
// qwen-edit-2511 edits, upscaling, frame interpolation, LoRA loading, Wan
// I2V / FLF / FMLF, LTX video, detailers, etc.
//
//   SYNTH_MODEL=xiaomi/mimo-v2.5 [SYNTH_PER_SKILL=8] node finetune/datagen/synth-skill-tasks.mjs
//
// Output: finetune/data/skill-tasks.jsonl ({id, category: "skill:<name>",
// difficulty, task}) — consumable by ARENA_TASKS= in scripts/llm-arena-full.mjs.
// Video/interpolation tasks are LONG renders: run those batches with
// ARENA_SCENARIO_TIMEOUT_MS=900000 and expect single-digit tasks/hour.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, REPO_ROOT, isAllowedTeacher } from "./lib.mjs";

const MODEL = process.env.SYNTH_MODEL ?? "";
const BASE_URL = (
  process.env.SYNTH_BASE_URL ?? (process.env.OPENROUTER_API_KEY ? "https://openrouter.ai/api/v1" : "")
).replace(/\/$/, "");
const API_KEY = process.env.SYNTH_API_KEY ?? process.env.OPENROUTER_API_KEY ?? "";
const PER_SKILL = Number(process.env.SYNTH_PER_SKILL ?? 8);

if (!MODEL || !BASE_URL) {
  console.error("[ft:skill-tasks] set SYNTH_MODEL (and SYNTH_BASE_URL unless OPENROUTER_API_KEY is in .env).");
  process.exit(1);
}
if (!isAllowedTeacher(MODEL) && !process.env.SYNTH_ALLOW_ANY) {
  console.error(`[ft:skill-tasks] '${MODEL}' is not on the ToS-safe teacher allowlist.`);
  process.exit(1);
}

/** Collect capability briefs: skills (SKILL.md excerpt) + packs (manifest header). */
function collectBriefs() {
  const briefs = [];
  const skillsDir = join(REPO_ROOT, "plugin", "skills");
  for (const name of readdirSync(skillsDir)) {
    const p = join(skillsDir, name, "SKILL.md");
    if (!existsSync(p)) continue;
    const text = readFileSync(p, "utf8");
    briefs.push({ kind: "skill", name, brief: text.slice(0, 1400) });
  }
  const packsDir = join(REPO_ROOT, "packs");
  for (const name of readdirSync(packsDir)) {
    const p = join(packsDir, name, "manifest.yaml");
    if (!existsSync(p)) continue;
    // The header comment block describes what the pack does.
    const header = readFileSync(p, "utf8").split("\n").filter((l) => l.startsWith("#")).slice(0, 10).join("\n");
    if (header.length > 60) briefs.push({ kind: "pack", name, brief: header });
  }
  return briefs;
}

async function complete(prompt, attempt = 0) {
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(180_000),
      headers: {
        "content-type": "application/json",
        ...(API_KEY ? { authorization: `Bearer ${API_KEY}` } : {}),
      },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: prompt }], temperature: 0.9 }),
    });
    if (!res.ok) throw new Error(`http ${res.status}: ${await res.text()}`);
    return (await res.json()).choices?.[0]?.message?.content ?? "";
  } catch (err) {
    if (attempt < 1) return complete(prompt, attempt + 1);
    throw err;
  }
}

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

const briefs = collectBriefs();
console.log(`[ft:skill-tasks] ${briefs.length} capability briefs (skills + packs)`);
const seen = new Set();
const out = [];
for (const b of briefs) {
  const prompt =
    `You write realistic user requests for an AI agent that operates a ComfyUI server. ` +
    `Below is documentation for ONE capability the server has ("${b.name}", a ${b.kind}):\n\n` +
    `${b.brief}\n\n---\n` +
    `Write ${PER_SKILL} DIVERSE user tasks that exercise THIS capability — a mix of simple requests, ` +
    `multi-step jobs (e.g. generate then refine/upscale/interpolate/animate), parameter-precise asks, and ` +
    `one where something plausibly goes wrong first. Real-user phrasing, concrete subjects and parameters; ` +
    `NEVER mention tool names, pack names, or file paths from the docs. ` +
    `Answer with ONLY a JSON array of ${PER_SKILL} strings.`;
  process.stdout.write(`[ft:skill-tasks] ${b.kind}:${b.name} ... `);
  try {
    const tasks = parseTasks(await complete(prompt));
    let added = 0;
    for (const task of tasks) {
      const key = task.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: `${b.kind}-${b.name}-${String(out.length).padStart(4, "0")}`,
        category: `${b.kind}:${b.name}`,
        difficulty: "skill",
        task: task.trim(),
      });
      added++;
    }
    console.log(`${added}`);
  } catch (err) {
    console.log(`FAILED: ${err.message}`);
  }
}

mkdirSync(DATA_DIR, { recursive: true });
const outPath = join(DATA_DIR, "skill-tasks.jsonl");
writeFileSync(outPath, out.map((t) => JSON.stringify(t)).join("\n") + (out.length ? "\n" : ""));
console.log(`[ft:skill-tasks] wrote ${out.length} tasks → ${outPath}`);
