// Shared constants for the fine-tune data pipeline (see finetune/README.md).
import "dotenv/config"; // pick up OPENROUTER_API_KEY etc. from the repo .env
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DATA_DIR = join(REPO_ROOT, "finetune", "data");
export const TOOLS_JSON = join(DATA_DIR, "tools-full.json");
export const PANEL_TOOLS_JSON = join(DATA_DIR, "tools-panel.json");
export const COMBINED_TOOLS_JSON = join(DATA_DIR, "tools-combined.json");

/**
 * Teacher models whose outputs are licensed for distillation. Provider ToS for
 * Anthropic, OpenAI, Google, and xAI all prohibit training other models on
 * their outputs — transcripts from those models must NEVER enter the dataset,
 * no matter how good they score.
 */
export const ALLOWED_TEACHER_PREFIXES = [
  "deepseek/",
  "z-ai/",
  "moonshotai/",
  "minimax/",
  "xiaomi/",
  "qwen/",
];

export const BLOCKED_TEACHER_PREFIXES = ["anthropic/", "openai/", "google/", "x-ai/"];

/**
 * Primary teacher: MIT license (secondary training explicitly permitted),
 * 19/20 on our own arena (tied best open-weight), 1M context — plenty of room
 * for the ~30-40K-token full tool payload plus long multi-stage episodes —
 * and a sparse MoE (310B/15B-active) so it's cheap per token to run.
 */
export const DEFAULT_TEACHER = "xiaomi/mimo-v2.5";

export function isAllowedTeacher(model) {
  if (BLOCKED_TEACHER_PREFIXES.some((p) => model.startsWith(p))) return false;
  return ALLOWED_TEACHER_PREFIXES.some((p) => model.startsWith(p));
}

/**
 * System prompt for FULL-surface trajectories — what the fine-tuned model will
 * run under in production (adapted from OLLAMA_SYSTEM_PROMPT, minus the
 * 3-meta-tool routing which full mode doesn't have).
 */
export const FULL_SYSTEM_PROMPT =
  "You are a ComfyUI expert agent. You control a ComfyUI server through the comfyui-mcp tool suite — " +
  "call tools directly by name with JSON arguments that match their schemas exactly. " +
  "Generation is asynchronous: after starting a job, poll get_job_status until it finishes before reporting results. " +
  "Finish every task by actually running tools; never invent tool results or filenames.";

/**
 * System prompt for PANEL trajectories — the combined surface (headless MCP
 * tools + panel_* live-canvas tools, called directly by name). This is what
 * the fine-tuned model deploys with in panel full-tool mode.
 */
export const FULL_PANEL_SYSTEM_PROMPT =
  "You are the ComfyUI agent in a sidebar panel. You control BOTH the headless ComfyUI server " +
  "(comfyui-mcp tools: generation, queue, models, workflows) AND the user's LIVE canvas " +
  "(panel tools: graph_*, workflow_* — add/wire/edit nodes the user can see). " +
  "Prefer the panel tools when working on the user's visible graph; use server tools for " +
  "generation jobs, queue operations, and model management. Call tools directly by name with " +
  "JSON arguments matching their schemas. Never clear the user's graph unless explicitly asked — " +
  "'new workflow' means workflow_new (a new tab), NOT graph_clear. " +
  "Finish every task by actually running tools; never invent tool results.";

/**
 * Extra expert guidance appended to the TEACHER's system prompt during
 * trajectory generation (ARENA_RICH_PROMPT=1). Big-context teachers (MiMo,
 * MiniMax: 1M ctx) absorb this easily; the saved trajectory is rewritten to
 * carry only FULL_SYSTEM_PROMPT so the student learns expert behavior under
 * the lean prompt it will actually deploy with.
 */
export const TEACHER_GUIDANCE =
  "You are a QUALITY-OBSESSED ComfyUI expert. Follow these operating rules exactly:\n" +
  "1. IMAGING QUALITY IS MANDATORY. The generate_image tool produces low-quality SD1.5 output and is " +
  "ONLY for a throwaway quick test. For any real image request you MUST use the installed SOTA models via " +
  "their pack workflows — do NOT call generate_image for quality work:\n" +
  "   - text-to-image → list_packs then read_pack_workflow 'krea2-txt2img-json' (read_skill 'krea2' for its " +
  "JSON prompt style), adapt the JSON prompt to the request, then enqueue_workflow it.\n" +
  "   - alternative T2I / image-to-image restyle → read_pack_workflow 'ideogram-txt2img' or " +
  "'ideogram-img2img' (read_skill 'ideogram').\n" +
  "   - edit an existing image (change/add/remove elements) → read_pack_workflow 'qwen-image-edit' " +
  "(read_skill 'qwen').\n" +
  "   - upscale / interpolate / video (Wan I2V, LTX, FLF/FMLF) → find the matching pack with list_packs + " +
  "read_pack_workflow and enqueue it.\n" +
  "   Only fall back to generate_image if list_packs shows NO suitable pack AND the SOTA model is not in " +
  "diffusion_models.\n" +
  "2. Read the pack workflow, adapt its prompt/params to the exact request, enqueue_workflow, and poll " +
  "get_job_status to completion before reporting.\n" +
  "3. Validate exact user-specified parameters (sizes, steps, seeds) land in the executed graph.\n" +
  "4. Multi-stage pipelines: feed a previous output forward with stage_output_as_input — never guess file paths.\n" +
  "5. On a failed call, read the error, explain briefly, and recover with a corrected call.\n" +
  "6. Always report concrete identifiers (prompt_id, filenames) from real tool results — never invent them.";

/** Render the tools-full.json entries as OpenAI-style tool definitions. */
export function toOpenAiTools(toolsFull) {
  return toolsFull.tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}
