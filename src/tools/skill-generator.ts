import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { generateSkill } from "../services/skill-generator.js";
import { errorToToolResult } from "../utils/errors.js";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export function registerSkillGeneratorTools(server: McpServer): void {
  server.tool(
    "generate_node_skill",
    "Generate a Claude skill (SKILL.md) documenting a ComfyUI custom node pack: its nodes, inputs/outputs, and example workflows. Accepts a ComfyUI Registry ID (resolved via api.comfy.org) or a GitHub repository URL. Fetches the repo README and scans its Python NODE_CLASS_MAPPINGS and example workflows over the network (uses GITHUB_TOKEN if set to avoid rate limits), so internet access is required. If a ComfyUI server is reachable it enriches node input/output types from /object_info, but the server is optional. Returns the SKILL.md markdown; if install_in is set, also creates that directory (recursively) and writes SKILL.md there, overwriting any existing file.",
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
    },
    async (args) => {
      try {
        const markdown = await generateSkill(args.source);

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
          };
        }

        return {
          content: [{ type: "text" as const, text: markdown }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
