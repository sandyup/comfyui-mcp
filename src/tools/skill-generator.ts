import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { generateSkillCached } from "../services/skill-cache.js";
import { errorToToolResult } from "../utils/errors.js";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export function registerSkillGeneratorTools(server: McpServer): void {
  server.tool(
    "generate_node_skill",
    "Generate a Claude skill (SKILL.md) documenting a ComfyUI custom node pack: its nodes, inputs/outputs, and example workflows. Accepts a ComfyUI Registry ID (resolved via api.comfy.org) or a GitHub repository URL. Uses a read-through cache under ~/.comfyui-mcp/skill-cache (override COMFYUI_SKILL_CACHE_DIR); set refresh:true to bypass it. On cache miss, fetches the repo README and scans its Python NODE_CLASS_MAPPINGS and example workflows over the network (uses GITHUB_TOKEN if set to avoid rate limits), so internet access is required. If a ComfyUI server is reachable it enriches node input/output types from /object_info, but the server is optional. Returns the SKILL.md markdown with structured cache metadata; if install_in is set, also creates that directory (recursively) and writes SKILL.md there, overwriting any existing file.",
    {
      source: z
        .string()
        .describe(
          "ComfyUI Registry node ID (e.g. 'comfyui-impact-pack') or GitHub repository URL",
        ),
      install_in: z
        .string()
        .optional()
        .describe(
          "Optional directory to write the generated SKILL.md into. Created recursively if missing; an existing SKILL.md is overwritten. Omit to only return the markdown without touching disk.",
        ),
      refresh: z
        .boolean()
        .optional()
        .describe("Bypass the read-through cache and regenerate the SKILL.md, overwriting the cached entry."),
    },
    async (args) => {
      try {
        const result = await generateSkillCached(args.source, { refresh: args.refresh });
        const markdown = result.markdown;
        const structuredContent = {
          cache_hit: result.cacheHit,
          cache_key: result.safeKey,
          cache_dir: result.cacheDir,
          version: result.metadata.version,
        };

        // Optionally write to disk
        if (args.install_in) {
          const dir = args.install_in;
          await mkdir(dir, { recursive: true });
          const filePath = join(dir, "SKILL.md");
          await writeFile(filePath, markdown, "utf-8");
          return {
            content: [
              {
                type: "text" as const,
                text: `Skill file written to ${filePath}\n\n${markdown}`,
              },
            ],
            structuredContent,
          };
        }

        return {
          content: [{ type: "text" as const, text: markdown }],
          structuredContent,
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
