import { z } from "zod";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve, join } from "path";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { parseComfyUIUrl, type ComfyUITarget } from "./transport/comfyui-url.js";

// Resolve .env from the package root, not process.cwd()
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = resolve(__dirname, "..");
dotenv.config({ path: resolve(packageRoot, ".env") });

/**
 * Auto-detect ComfyUI installation directories.
 * Checks common locations on macOS, Linux, and Windows.
 * Returns all found paths sorted by preference.
 */
function detectComfyUIPaths(): string[] {
  const home = homedir();
  const candidates: string[] = [];

  // macOS: ComfyUI Desktop app stores data here
  candidates.push(join(home, "Documents", "ComfyUI"));

  // macOS: Application Support
  candidates.push(join(home, "Library", "Application Support", "ComfyUI"));

  // Common manual install locations
  candidates.push(join(home, "ComfyUI"));
  candidates.push(join(home, "code", "ComfyUI"));
  candidates.push(join(home, "projects", "ComfyUI"));
  candidates.push(join(home, "src", "ComfyUI"));

  // Linux common paths
  candidates.push("/opt/ComfyUI");
  candidates.push(join(home, ".local", "share", "ComfyUI"));

  // Windows common paths
  candidates.push(join(home, "AppData", "Local", "ComfyUI"));
  candidates.push(join(home, "Desktop", "ComfyUI"));

  // Windows: ComfyUI Desktop app installs here
  candidates.push(
    join(home, "AppData", "Local", "Programs", "ComfyUI", "resources", "ComfyUI"),
  );

  // Scan ~/Documents and ~/My Documents for any ComfyUI-named directories
  const documentsDirs = [
    join(home, "Documents"),
    join(home, "My Documents"),
  ];
  for (const dir of documentsDirs) {
    try {
      if (!existsSync(dir)) continue;
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.toLowerCase().includes("comfyui")) {
          const fullPath = join(dir, entry.name);
          if (!candidates.includes(fullPath)) {
            candidates.push(fullPath);
          }
        }
      }
    } catch {
      // Ignore permission errors
    }
  }

  // Filter to paths that exist and look like actual ComfyUI installations
  // (must have a models/ or custom_nodes/ subdirectory, or be a known install path)
  return candidates.filter((p) => {
    if (!existsSync(p)) return false;
    // Known install paths are trusted without marker check
    if (!p.includes("Documents")) return true;
    // For scanned directories, verify it's a real ComfyUI install
    return existsSync(join(p, "models")) || existsSync(join(p, "custom_nodes"));
  });
}

/**
 * Resolve the ComfyUI path, with auto-detection fallback.
 * Priority: COMFYUI_PATH env var > auto-detected paths.
 * Logs a warning if multiple installations found.
 */
function resolveComfyUIPath(envPath?: string): string | undefined {
  if (envPath) return envPath;

  const detected = detectComfyUIPaths();
  if (detected.length === 0) return undefined;

  if (detected.length > 1) {
    console.error(
      `[comfyui-mcp] Multiple ComfyUI installations detected:\n` +
        detected.map((p, i) => `  ${i + 1}. ${p}`).join("\n") +
        `\nUsing: ${detected[0]}\n` +
        `Set COMFYUI_PATH to override.`,
    );
  }

  return detected[0];
}

/**
 * Auto-detect which port ComfyUI is running on.
 * Tries common ports: 8000 (Desktop app default), 8188 (repo/CLI default).
 * Returns the first port that responds, or the default if none found.
 */
async function detectComfyUIPort(host: string): Promise<number> {
  const ports = [8188, 8000];

  for (const port of ports) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1000);
      const protocol = parsedConfig.comfyuiSsl ? "https" : "http";
      const res = await fetch(`${protocol}://${host}:${port}/system_stats`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (res.ok) {
        console.error(`[comfyui-mcp] Found ComfyUI on port ${port}`);
        return port;
      }
    } catch {
      // Port not responding, try next
    }
  }

  console.error(
    `[comfyui-mcp] ComfyUI not detected on ports ${ports.join(", ")}. Defaulting to 8188.`,
  );
  return 8188;
}

/**
 * Resolve a ComfyUI target from --comfyui-url (argv) or COMFYUI_URL (env).
 * Takes precedence over COMFYUI_HOST/PORT/SSL and skips port auto-detection.
 */
function resolveUrlOverride(): ComfyUITarget | undefined {
  const argv = process.argv.slice(2);
  let raw: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--comfyui-url") {
      raw = argv[i + 1];
      break;
    }
    if (a.startsWith("--comfyui-url=")) {
      raw = a.slice("--comfyui-url=".length);
      break;
    }
  }
  raw = raw ?? process.env.COMFYUI_URL;
  if (!raw) return undefined;
  try {
    return parseComfyUIUrl(raw);
  } catch (err) {
    console.error(
      `[comfyui-mcp] Ignoring invalid --comfyui-url/COMFYUI_URL "${raw}": ${
        err instanceof Error ? err.message : err
      }`,
    );
    return undefined;
  }
}

const configSchema = z.object({
  comfyuiHost: z.string().default("127.0.0.1"),
  comfyuiPort: z.coerce.number().int().positive().optional(),
  comfyuiSsl: z.coerce.boolean().default(false),
  comfyuiPath: z.string().optional(),
  huggingfaceToken: z.string().optional(),
  githubToken: z.string().optional(),
  civitaiApiToken: z.string().optional(),
  comfyApiKey: z.string().optional(),
});

export type Config = z.infer<typeof configSchema> & { resolvedPort: number };

const urlOverride = resolveUrlOverride();

const parsedConfig = configSchema.parse({
  comfyuiHost: urlOverride?.host ?? process.env.COMFYUI_HOST,
  comfyuiPort: urlOverride?.port ?? (process.env.COMFYUI_PORT || undefined),
  comfyuiSsl: urlOverride?.ssl ?? process.env.COMFYUI_SSL,
  comfyuiPath: resolveComfyUIPath(process.env.COMFYUI_PATH),
  huggingfaceToken: process.env.HUGGINGFACE_TOKEN,
  githubToken: process.env.GITHUB_TOKEN,
  civitaiApiToken: process.env.CIVITAI_API_TOKEN,
  comfyApiKey: process.env.COMFY_API_KEY,
});

// Resolve port: explicit url/env wins, otherwise auto-detect.
// A --comfyui-url/COMFYUI_URL override always carries a port, so detection is skipped.
const resolvedPort = parsedConfig.comfyuiPort
  ?? (urlOverride ? urlOverride.port : await detectComfyUIPort(parsedConfig.comfyuiHost));

export const config: Config = { ...parsedConfig, resolvedPort };

export function getComfyUIApiHost(): string {
  return `${config.comfyuiHost}:${config.resolvedPort}`;
}

export function getComfyUIProtocol(): "http" | "https" {
  return config.comfyuiSsl ? "https" : "http";
}
