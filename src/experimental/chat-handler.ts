import type {
  LanguageModel,
  ToolSet,
  UIMessage,
} from "ai";
import { z } from "zod";

import { resolveModel } from "./provider-registry.js";
import { requireOptionalDep } from "../utils/optional-dep.js";

// ---------------------------------------------------------------------------
// Experimental AI SDK chat handler for the embedded-agent-panel POC.
//
// `POST /api/chat` -> streamText({ model, messages, tools }).toUIMessageStreamResponse()
//
// Includes ONE server-side tool end-to-end (`generate_image`) which, for the
// POC, returns a stub result. Wiring the real comfyui-mcp generate tools is a
// later phase (see design/embedded-agent-panel.md, build order step 5).
//
// This module is only reached behind COMFYUI_MCP_AGENT_POC. `ai` is an
// optional dependency, so we build the tool registry lazily — a slim install
// without `ai` still imports this module without crashing; the optional-dep
// error only surfaces when handleChatRequest() is actually called.
// ---------------------------------------------------------------------------

type AiModule = typeof import("ai");

async function loadAi(): Promise<AiModule> {
  return requireOptionalDep<AiModule>("ai", {
    feature: "embedded-agent-panel POC",
    installHint: "npm install ai @ai-sdk/anthropic @ai-sdk/google @ai-sdk/openai",
  });
}

export function buildTools(toolFn: AiModule["tool"]): ToolSet {
  return {
    generate_image: toolFn({
      description:
        "Generate an image from a text prompt using ComfyUI. (POC stub — returns a placeholder result instead of running a real workflow.)",
      inputSchema: z.object({
        prompt: z.string().describe("The text prompt to generate an image from."),
        width: z.number().int().positive().optional().describe("Image width in pixels."),
        height: z.number().int().positive().optional().describe("Image height in pixels."),
      }),
      execute: async ({ prompt, width, height }) => {
        // POC stub: real implementation will enqueue a ComfyUI workflow and
        // return the resulting asset id / image URL.
        return {
          status: "stubbed",
          prompt,
          width: width ?? 1024,
          height: height ?? 1024,
          imageUrl: "https://example.invalid/poc-placeholder.png",
          note: "Placeholder result from the POC. No real workflow was executed.",
        };
      },
    }),
  } satisfies ToolSet;
}

export interface ChatHandlerOptions {
  /** Override the model (mainly for tests). Defaults to the provider registry. */
  model?: LanguageModel;
  /** Optional `provider:model` id forwarded to the registry. */
  modelId?: string;
  /** System prompt for the agent. */
  system?: string;
  /** Override the tool set (mainly for tests). Defaults to the POC tools. */
  tools?: ToolSet;
}

const DEFAULT_SYSTEM =
  "You are an assistant embedded in ComfyUI. You can generate images with the generate_image tool.";

/**
 * Handle a chat request. Accepts a Fetch-style `Request` whose JSON body is
 * `{ messages: UIMessage[], model?: string }` and returns a streaming
 * `Response` (UI message stream protocol).
 */
export async function handleChatRequest(
  req: Request,
  options: ChatHandlerOptions = {},
): Promise<Response> {
  const body = (await req.json()) as {
    messages?: UIMessage[];
    model?: string;
  };
  const messages = body.messages ?? [];

  const ai = await loadAi();
  const model =
    options.model ?? (await resolveModel(options.modelId ?? body.model));
  const tools = options.tools ?? buildTools(ai.tool);

  const result = ai.streamText({
    model,
    system: options.system ?? DEFAULT_SYSTEM,
    messages: await ai.convertToModelMessages(messages),
    tools,
    stopWhen: ai.stepCountIs(5),
  });

  return result.toUIMessageStreamResponse();
}
