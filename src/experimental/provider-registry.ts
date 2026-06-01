import type { LanguageModel } from "ai";
import { requireOptionalDep } from "../utils/optional-dep.js";

// ---------------------------------------------------------------------------
// Provider registry for the experimental embedded-agent-panel POC.
//
// Picks the language model per request from a single registry, keyed by a
// `provider:model` string (the AI SDK default separator). Default is Anthropic
// with the model from COMFYUI_MCP_AGENT_MODEL. Provider API keys are read from
// the usual env vars by each provider package (ANTHROPIC_API_KEY, etc.).
//
// Not part of the default MCP server — only used behind COMFYUI_MCP_AGENT_POC.
// All four AI SDK packages are optional dependencies; resolveModel() builds
// the registry lazily so a slim install (no @ai-sdk/*) still parses.
// ---------------------------------------------------------------------------

type AiModule = typeof import("ai");
type AnthropicModule = typeof import("@ai-sdk/anthropic");
type GoogleModule = typeof import("@ai-sdk/google");
type OpenAiModule = typeof import("@ai-sdk/openai");

let registryPromise: Promise<ReturnType<AiModule["createProviderRegistry"]>> | null = null;

export async function getRegistry() {
  if (!registryPromise) {
    registryPromise = (async () => {
      const [ai, anthropic, google, openai] = await Promise.all([
        requireOptionalDep<AiModule>("ai", {
          feature: "embedded-agent-panel POC",
          installHint: "npm install ai @ai-sdk/anthropic @ai-sdk/google @ai-sdk/openai",
        }),
        requireOptionalDep<AnthropicModule>("@ai-sdk/anthropic", {
          feature: "Anthropic provider for the agent POC",
          installHint: "npm install @ai-sdk/anthropic",
        }),
        requireOptionalDep<GoogleModule>("@ai-sdk/google", {
          feature: "Google provider for the agent POC",
          installHint: "npm install @ai-sdk/google",
        }),
        requireOptionalDep<OpenAiModule>("@ai-sdk/openai", {
          feature: "OpenAI provider for the agent POC",
          installHint: "npm install @ai-sdk/openai",
        }),
      ]);
      return ai.createProviderRegistry({
        anthropic: anthropic.anthropic,
        openai: openai.openai,
        google: google.google,
      });
    })();
  }
  return registryPromise;
}

const DEFAULT_MODEL = "anthropic:claude-sonnet-4-5";

function allowedModels(): Set<string> {
  const set = new Set<string>([DEFAULT_MODEL]);
  const envDefault = process.env.COMFYUI_MCP_AGENT_MODEL?.trim();
  if (envDefault) set.add(envDefault);
  const extra = process.env.COMFYUI_MCP_AGENT_ALLOWED_MODELS;
  if (extra) {
    for (const m of extra.split(",")) {
      const t = m.trim();
      if (t) set.add(t);
    }
  }
  return set;
}

export async function resolveModel(id?: string): Promise<LanguageModel> {
  const registry = await getRegistry();
  const fallback = process.env.COMFYUI_MCP_AGENT_MODEL?.trim() || DEFAULT_MODEL;
  const requested = id?.trim();
  const modelId =
    requested && allowedModels().has(requested) ? requested : fallback;
  // languageModel()'s strict template-literal type doesn't cover arbitrary
  // ids; we widen at the call site since we already gated by allowlist.
  return registry.languageModel(modelId as Parameters<typeof registry.languageModel>[0]);
}
