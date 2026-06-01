// Aggregate pre-flight health check for a connected ComfyUI instance.
//
// Originally contributed by João Lucas (github.com/joaolvivas) in
// joaolvivas/comfyui-mcp-byjlucas@de82ecda (2026-05-12). Refactored to
// match this repo's service/tool split.

import { ConnectionError } from "../utils/errors.js";
import { getClient, getQueue, getSystemStats } from "../comfyui/client.js";

const CRITICAL_MODEL_CATS = [
  "checkpoints",
  "diffusion_models",
  "loras",
  "vae",
  "text_encoders",
  "controlnet",
] as const;

export interface HealthCheckOptions {
  modelCategories?: string[];
  recentErrors?: number;
}

export async function runHealthCheck(
  options: HealthCheckOptions = {},
): Promise<string> {
  const categories = options.modelCategories ?? [...CRITICAL_MODEL_CATS];
  const recentErrors = options.recentErrors ?? 20;
  const lines: string[] = ["## Health Check\n"];

  try {
    const stats = (await getSystemStats()) as unknown as Record<string, any>;
    const sys = stats.system ?? {};
    const dev = stats.devices?.[0] ?? {};
    const vramTotalGB = dev.vram_total
      ? (dev.vram_total / 1024 ** 3).toFixed(1)
      : "?";
    const vramFreeGB = dev.vram_free
      ? (dev.vram_free / 1024 ** 3).toFixed(1)
      : "?";
    const ramFreeGB = sys.ram_free
      ? (sys.ram_free / 1024 ** 3).toFixed(1)
      : "?";
    lines.push(
      `**ComfyUI**: ${sys.comfyui_version ?? "?"} | ` +
        `Python ${(sys.python_version ?? "").split(" ")[0] || "?"} | ` +
        `PyTorch ${sys.pytorch_version ?? "?"}`,
    );
    lines.push(
      `**GPU**: ${dev.name ?? "?"} | VRAM free ${vramFreeGB}/${vramTotalGB} GB | RAM free ${ramFreeGB} GB`,
    );
  } catch (err) {
    throw new ConnectionError(
      `ComfyUI unreachable: ${err instanceof Error ? err.message : err}`,
    );
  }

  try {
    const q = await getQueue();
    const running = q.queue_running?.length ?? 0;
    const pending = q.queue_pending?.length ?? 0;
    lines.push(`**Queue**: ${running} running, ${pending} pending`);
  } catch (err) {
    lines.push(
      `**Queue**: ERROR — ${err instanceof Error ? err.message : err}`,
    );
  }

  const client = getClient();
  const modelLines: string[] = [];
  let totalModelsSeen = 0;
  for (const cat of categories) {
    try {
      const res = await client.fetchApi(`/models/${cat}`);
      if (!res.ok) {
        modelLines.push(`- ${cat}: REST ${res.status}`);
        continue;
      }
      const files = (await res.json()) as unknown;
      const count = Array.isArray(files) ? files.length : 0;
      totalModelsSeen += count;
      if (count === 0) {
        modelLines.push(
          `- ${cat}: **EMPTY** ⚠️ (check extra_model_paths.yaml)`,
        );
      } else {
        const preview = (files as string[]).slice(0, 3).join(", ");
        const more = count > 3 ? ` (+${count - 3} more)` : "";
        modelLines.push(`- ${cat}: ${count} — ${preview}${more}`);
      }
    } catch (err) {
      modelLines.push(
        `- ${cat}: ERROR — ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  lines.push(`\n**Models** (${totalModelsSeen} total across ${categories.length} categories):`);
  lines.push(...modelLines);

  // Recent custom-node errors from /internal/logs (best-effort; older
  // ComfyUI versions and remote-only deployments may not expose it).
  try {
    const res = await client.fetchApi("/internal/logs");
    if (res.ok) {
      const text = await res.text();
      const errLines = text
        .split("\n")
        .filter((l) => /traceback|error|exception/i.test(l))
        .slice(-recentErrors);
      if (errLines.length > 0) {
        lines.push(`\n**Recent errors** (last ${errLines.length}):`);
        for (const e of errLines) lines.push(`  ${e.trim()}`);
      } else {
        lines.push(`\n**Recent errors**: none in /internal/logs`);
      }
    }
  } catch {
    // Logs endpoint unavailable — silent.
  }

  return lines.join("\n");
}
