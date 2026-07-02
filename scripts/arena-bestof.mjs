#!/usr/bin/env node
// Fold extra arena run dirs into the main results as BEST-OF-N per model.
//
//   node scripts/arena-bestof.mjs arena-results arena-results/bo3-run2 arena-results/bo3-run3
//
// For every model present in an extra dir, the better run (score, then fewer
// nudges → rounds → seconds) replaces the main entry, and runs.totals records
// every observed total so reports can show the range (e.g. "best of 3, 19–20").
// Regenerates arena-report.md afterward.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [baseDir, ...runDirs] = process.argv.slice(2);
if (!baseDir) {
  console.error("usage: arena-bestof.mjs <base-results-dir> [extra-run-dir...]  (no dirs = re-sort + regenerate only)");
  process.exit(1);
}

const nudgesOf = (m) => m.results.reduce((s, r) => s + (r.nudges ?? 0), 0);
const roundsOf = (m) => m.results.reduce((s, r) => s + (r.rounds ?? 0), 0);
const secondsOf = (m) => m.results.reduce((s, r) => s + (r.seconds ?? 0), 0);
const better = (a, b) =>
  b.total - a.total || nudgesOf(a) - nudgesOf(b) || roundsOf(a) - roundsOf(b) || secondsOf(a) - secondsOf(b);

const basePath = join(baseDir, "arena-results.json");
const base = JSON.parse(readFileSync(basePath, "utf8"));

for (const dir of runDirs) {
  const p = join(dir, "arena-results.json");
  if (!existsSync(p)) {
    console.warn(`skip ${p} (missing)`);
    continue;
  }
  const extra = JSON.parse(readFileSync(p, "utf8"));
  for (const candidate of extra.leaderboard ?? []) {
    const i = base.leaderboard.findIndex((m) => m.model === candidate.model);
    if (i < 0) continue;
    const current = base.leaderboard[i];
    const totals = [...(current.runs?.totals ?? [current.total]), candidate.total];
    const winner = better(current, candidate) > 0 ? candidate : current;
    base.leaderboard[i] = { ...winner, tier: current.tier, runs: { totals } };
    console.log(`${candidate.model}: run=${candidate.total} → keeping ${winner.total} (all: ${totals.join(", ")})`);
  }
}

// Rank: best total, then CONSISTENCY (worst run across best-of-N — a model
// that is perfect every time outranks one that peaked once), then efficiency.
const worstRun = (m) => Math.min(...(m.runs?.totals ?? [m.total]));
base.leaderboard.sort(
  (a, b) =>
    b.total - a.total ||
    worstRun(b) - worstRun(a) ||
    nudgesOf(a) - nudgesOf(b) ||
    roundsOf(a) - roundsOf(b) ||
    secondsOf(a) - secondsOf(b),
);
writeFileSync(basePath, JSON.stringify(base, null, 2));

// regenerate the share-ready markdown (kept in sync with llm-arena.mjs)
const icon = { 2: "✅", 1: "🟡", 0: "❌" };
const scen = base.scenarios ?? [];
const md = [];
md.push("# ComfyUI LLM Arena", "");
md.push(
  `Models driving a real ComfyUI (${base.gpu}) through [comfyui-mcp](https://github.com/artokun/comfyui-mcp)'s ` +
    `compact tool mode — 6 router tools instead of ~200 schemas, so every model class can play. ` +
    `Each model gets the identical task set; results are verified against the ComfyUI server, not the model's claims. ` +
    `Top-cluster models are best-of-N (range shown).`,
  "",
);
const header = ["Model", "Tier", ...scen.map((s) => s.id), "Score", "Nudges", "Rounds", "Time"];
md.push(`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`);
for (const m of base.leaderboard) {
  const cells = m.results.map((r) => icon[r.score]);
  const totals = m.runs?.totals;
  const score =
    totals && totals.length > 1
      ? `**${m.total}/${m.max}** (best of ${totals.length}: ${Math.min(...totals)}–${Math.max(...totals)})`
      : `**${m.total}/${m.max}**`;
  md.push(
    `| \`${m.model}\` | ${m.tier ?? "local"} | ${cells.join(" | ")} | ${score} | ${nudgesOf(m)} | ${roundsOf(m)} | ${secondsOf(m)}s |`,
  );
}
md.push("", `Scenarios: ${scen.map((s) => `**${s.id}** (${s.title.toLowerCase()})`).join(" · ")}`, "");
md.push(`✅ completed & server-verified · 🟡 right tool family, incomplete outcome · ❌ failed`, "");
md.push("Reproduce: `npm run arena` — bring your own models via `ARENA_MODELS=...` (see docs/arena)");
writeFileSync(join(baseDir, "arena-report.md"), `${md.join("\n")}\n`);
console.log("report regenerated");
