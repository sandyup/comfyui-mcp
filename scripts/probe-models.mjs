// One-off: what does the Agent SDK report for supportedModels() on THIS
// machine's Claude subscription? Run: node scripts/probe-models.mjs
import { fetchSupportedModels } from "../dist/orchestrator/panel-agent.js";

delete process.env.ANTHROPIC_API_KEY;
const t0 = Date.now();
try {
  const models = await fetchSupportedModels(process.argv[2] || "claude-opus-4-8");
  console.log(`got ${models.length} model(s) in ${Date.now() - t0}ms:`);
  for (const m of models) {
    console.log(
      `  ${m.value}  —  ${m.displayName}  (effort: ${m.supportsEffort ? (m.supportedEffortLevels?.join("/") ?? "yes") : "no"})`,
    );
  }
} catch (err) {
  console.error("FAILED:", err?.message ?? err);
}
process.exit(0);
