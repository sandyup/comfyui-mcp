import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Safe-by-default issue reporting: returns a PREFILLED GitHub "new issue" URL
// rather than auto-filing. No auth, no network, no surprise posts — the user
// reviews and submits with one click. (A future opt-in could auto-file via gh
// or a CF Worker; intentionally not the default.)

const DEFAULT_REPO = "artokun/comfyui-mcp";

export function registerReportIssueTools(server: McpServer): void {
  server.tool(
    "report_issue",
    "Build a ready-to-open GitHub issue link for a bug/problem you hit (ComfyUI, a workflow, a model, custom nodes, or comfyui-mcp itself). Returns a URL with the title and body prefilled — SHARE it with the user so they can review and submit it in one click. It does NOT auto-file. Use it when you encounter an error you can't resolve so the user can report it upstream. For panel-specific bugs pass repo='artokun/comfyui-mcp-panel'.",
    {
      title: z.string().min(1).describe("Short, specific issue title."),
      body: z
        .string()
        .min(1)
        .describe(
          "Issue body: what happened, steps to reproduce, the exact error text, and environment (GPU/VRAM, ComfyUI version, OS) if known.",
        ),
      repo: z
        .string()
        .optional()
        .describe("owner/repo (default 'artokun/comfyui-mcp'; use 'artokun/comfyui-mcp-panel' for the sidebar panel)."),
      labels: z.array(z.string()).optional().describe("Optional GitHub label names to prefill."),
    },
    async (args) => {
      try {
        const repo = (args.repo || DEFAULT_REPO)
          .trim()
          .replace(/^https?:\/\/github\.com\//i, "")
          .replace(/\.git$/i, "")
          .replace(/^\/+|\/+$/g, "");
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
          throw new Error(`invalid repo "${repo}" — expected owner/name`);
        }
        const params = new URLSearchParams({ title: args.title, body: args.body });
        if (args.labels?.length) params.set("labels", args.labels.join(","));
        const url = `https://github.com/${repo}/issues/new?${params.toString()}`;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  url,
                  repo,
                  note: "Prefilled issue link (not auto-filed). Share it with the user to review and submit.",
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            { type: "text" as const, text: `Error building issue link: ${err instanceof Error ? err.message : String(err)}` },
          ],
          isError: true,
        };
      }
    },
  );
}
