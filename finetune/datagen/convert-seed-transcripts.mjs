#!/usr/bin/env node
// Convert existing compact-mode arena transcripts into FULL-surface seed
// trajectories for SFT.
//
//   node finetune/datagen/convert-seed-transcripts.mjs [--include-partial]
//
// What it does, per transcript in arena-results/**/transcripts/*.json:
//   1. keeps only ToS-safe teacher models (see lib.mjs) with a verified PASS
//      (or PARTIAL with --include-partial) in that dir's arena-results.json;
//   2. rewrites call_tool(name=X, args={...}) → a direct X({...}) tool call,
//      exactly what the model will emit in full-tool mode;
//   3. drops the compact-mode scaffolding (list_tools/describe_tool round
//      trips, harness nudges, chatty no-tool stalls) — full mode has all
//      schemas up front, so discovery steps must not be learned;
//   4. swaps the compact system prompt for FULL_SYSTEM_PROMPT and validates
//      every rewritten call name against finetune/data/tools-full.json.
//
// Output: finetune/data/seed-trajectories.jsonl (OpenAI chat format, one
// trajectory per line: {id, teacher, scenario, verdict, messages}).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, DATA_DIR, TOOLS_JSON, FULL_SYSTEM_PROMPT, isAllowedTeacher } from "./lib.mjs";

const INCLUDE_PARTIAL = process.argv.includes("--include-partial");
const RUN_DIRS = ["arena-results", "arena-results/bo3-run2", "arena-results/bo3-run3"];
const NUDGE_RE = /^You have not successfully run a tool yet\./;

if (!existsSync(TOOLS_JSON)) {
  console.error("[ft:seed] finetune/data/tools-full.json missing — run `npm run ft:tools` first.");
  process.exit(1);
}
const toolNames = new Set(JSON.parse(readFileSync(TOOLS_JSON, "utf8")).tools.map((t) => t.name));

const stats = { kept: 0, skippedModel: 0, skippedVerdict: 0, dropped: {} };
const drop = (reason) => {
  stats.dropped[reason] = (stats.dropped[reason] ?? 0) + 1;
  return null;
};

/** Rewrite one compact transcript to full-surface; null = not usable. */
function convert(messages) {
  const out = [];
  const keptCallIds = new Set();
  const last = messages[messages.length - 1];

  for (const msg of messages) {
    if (msg.role === "system") {
      if (!out.length) out.push({ role: "system", content: FULL_SYSTEM_PROMPT });
      continue;
    }
    if (msg.role === "user") {
      if (NUDGE_RE.test(msg.content ?? "")) {
        // nudge means the previous assistant turn stalled — unlearn both
        if (out[out.length - 1]?.role === "assistant" && !out[out.length - 1].tool_calls) out.pop();
        continue;
      }
      out.push({ role: "user", content: msg.content });
      continue;
    }
    if (msg.role === "tool") {
      if (msg.tool_call_id === undefined) return drop("ollama-dialect");
      if (keptCallIds.has(msg.tool_call_id)) {
        out.push({ role: "tool", tool_call_id: msg.tool_call_id, content: msg.content });
      }
      continue;
    }
    if (msg.role !== "assistant") continue;

    if (!msg.tool_calls?.length) {
      // In the arena loop a toolless assistant turn either ends the scenario
      // (final answer — keep) or precedes a nudge (stall — dropped above).
      if (msg === last) out.push({ role: "assistant", content: msg.content ?? "" });
      continue;
    }

    const rewritten = [];
    for (const tc of msg.tool_calls) {
      const fn = tc.function?.name;
      if (fn === "list_tools" || fn === "describe_tool") continue; // scaffolding
      if (fn === "call_tool") {
        let a = tc.function.arguments;
        if (typeof a === "string") {
          try { a = JSON.parse(a); } catch { return drop("unparseable-call_tool-args"); }
        }
        const inner = a?.name ?? a?.tool_name;
        let innerArgs = a?.args ?? a?.arguments ?? {};
        if (typeof innerArgs === "string") {
          try { innerArgs = JSON.parse(innerArgs); } catch { /* leave as string-typed arg blob */ }
        }
        if (!inner || !toolNames.has(inner)) return drop("unknown-inner-tool");
        rewritten.push({
          id: tc.id,
          type: "function",
          function: { name: inner, arguments: JSON.stringify(innerArgs ?? {}) },
        });
      } else if (toolNames.has(fn)) {
        rewritten.push(tc); // model already called the real name directly
      }
      // hallucinated names fall through: call + its error result vanish
    }

    if (!rewritten.length) continue; // pure discovery turn — drop entirely
    for (const tc of rewritten) keptCallIds.add(tc.id);
    const kept = { role: "assistant", tool_calls: rewritten };
    if (msg.content?.trim()) kept.content = msg.content;
    out.push(kept);
  }

  const calls = out.filter((m) => m.tool_calls?.length).length;
  if (!calls) return drop("no-tool-calls-left");
  if (out[out.length - 1]?.role !== "assistant" || out[out.length - 1].tool_calls) {
    return drop("no-final-answer");
  }
  return out;
}

const lines = [];
for (const dir of RUN_DIRS) {
  const resultsPath = join(REPO_ROOT, dir, "arena-results.json");
  const transcriptsDir = join(REPO_ROOT, dir, "transcripts");
  if (!existsSync(resultsPath) || !existsSync(transcriptsDir)) continue;
  const { leaderboard } = JSON.parse(readFileSync(resultsPath, "utf8"));

  for (const entry of leaderboard) {
    if (!isAllowedTeacher(entry.model)) {
      stats.skippedModel += entry.results?.length ?? 0;
      continue;
    }
    const fileModel = entry.model.replace(/[:/]/g, "_");
    for (const r of entry.results ?? []) {
      const ok = r.verdict === "PASS" || (INCLUDE_PARTIAL && r.verdict === "PARTIAL");
      if (!ok) {
        stats.skippedVerdict++;
        continue;
      }
      const file = join(transcriptsDir, `${fileModel}-${r.scenario}.json`);
      if (!existsSync(file)) {
        drop("transcript-missing");
        continue;
      }
      const converted = convert(JSON.parse(readFileSync(file, "utf8")));
      if (!converted) continue;
      stats.kept++;
      lines.push(JSON.stringify({
        id: `${dir.replace(/[\\/]/g, "_")}/${fileModel}/${r.scenario}`,
        teacher: entry.model,
        scenario: r.scenario,
        verdict: r.verdict,
        source: "arena-compact-rewrite",
        messages: converted,
      }));
    }
  }
}

mkdirSync(DATA_DIR, { recursive: true });
const outPath = join(DATA_DIR, "seed-trajectories.jsonl");
writeFileSync(outPath, lines.join("\n") + (lines.length ? "\n" : ""));
console.log(`[ft:seed] kept ${stats.kept} trajectories → ${outPath}`);
console.log(`[ft:seed] skipped: ${stats.skippedModel} (ToS-blocked/unlisted model), ${stats.skippedVerdict} (verdict)`);
for (const [reason, n] of Object.entries(stats.dropped)) console.log(`  dropped ${n}: ${reason}`);
