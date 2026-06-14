---
name: civitai
description: Pair the official Civitai MCP (https://mcp.civitai.com/mcp) with comfyui-mcp to discover models on Civitai and install/generate them locally. Use when the user wants to find a checkpoint/LoRA/embedding on Civitai, browse Civitai images for inspiration, or download a Civitai model into their ComfyUI. comfyui-mcp does NOT proxy Civitai — it hands version ids to the local download/wire/generate loop.
---

# Civitai + comfyui-mcp

Civitai ships an **official remote MCP server** — discovery and the whole
community surface — and comfyui-mcp owns the **local machine**: download,
wire, queue, tag. They compose. comfyui-mcp deliberately does **not** proxy
or re-expose Civitai's tools; MCP clients connect to both servers at once, so
the right pattern is *pairing*, not wrapping.

## Is the Civitai MCP connected?

Look for `mcp__civitai__*` tools in your session (e.g. `mcp__civitai__search_models`).

**The `comfy` plugin bundles it** — its `.mcp.json` declares the Civitai
remote server alongside comfyui, so plugin users get `mcp__civitai__*`
automatically with **no manual setup and no key required** (the
`Authorization` header defaults to an empty Bearer, which Civitai accepts for
its read/browse tools). It just works headless.

- **Present** → use it for discovery (this skill's main path).
- **Absent** (standalone MCP install, not the plugin) → either install the
  plugin, or add the server once:

  ```bash
  claude mcp add --transport http civitai https://mcp.civitai.com/mcp \
    --header "Authorization: Bearer YOUR_CIVITAI_API_KEY"
  ```

  Until then, fall back to `search_models` (HuggingFace) +
  `download_civitai_model` by id/URL.

**API key (optional).** Browsing/search needs none. To unlock the user's
account context (favorites, posting, **gated/early-access downloads**), set
`CIVITAI_API_TOKEN` (from civitai.com/user/account) in the environment — the
**same** variable comfyui-mcp uses for its own downloads, so one secret powers
both the Civitai MCP header and `download_civitai_model`.

## The handoff that makes this work

Civitai's discovery tools return a **model id** and a **model-version id** —
exactly what comfyui-mcp's `download_civitai_model` takes. No URL scraping:

```
mcp__civitai__search_models  ──▶  pick a result, read modelVersions[].id
        │
        ▼
download_civitai_model({ model_version_id, target_subfolder })   # local fetch
        │
        ▼
list_local_models  →  panel_add_node loader / generate_image      # use it
```

`target_subfolder` must match the model type: `checkpoints`, `loras`, `vae`,
`controlnet`, `embeddings`, `upscale_models`, etc. (see the `model-registry`
and `model-compatibility` skills). Prefer `model_version_id` — a Civitai page
can list several versions and the user usually means a specific one.

## Recipes

**"Find me a good anime LoRA for Flux and install it"**
1. `mcp__civitai__search_models` with the query + a type/base-model filter
   (use `mcp__civitai__list_enums` to get valid filter values).
2. Present the top 3–5 with name, creator, base model, downloads, and the
   version id. Let the user pick (base-model match matters — a Flux LoRA
   will not load on an SDXL checkpoint; see `model-compatibility`).
3. `download_civitai_model({ model_version_id, target_subfolder: "loras" })`.
4. In the panel: `panel_add_node` a `LoraLoader`, `panel_set_widget` the
   `lora_name`, wire it between checkpoint and sampler. Headless:
   `generate_image` / build the workflow.

**"What's trending on Civitai for product photography?"**
- `mcp__civitai__search_models` sorted by trending + `search_images` for
  example outputs and their embedded generation params. Summarize; offer to
  install any the user likes via the handoff above.

**"Download this Civitai page for me"** (user pastes a URL)
- Parse the `modelVersionId` from the URL if present; otherwise
  `mcp__civitai__get_model` to resolve the latest version id, then
  `download_civitai_model`. (You can also pass a raw
  `civitai.com/api/download/...` URL straight to `download_model` with
  `CIVITAI_API_TOKEN` set.)

## In the sidebar panel

The panel's agent **is** the user's Claude Code session, so if both servers
are connected the panel already has every `mcp__civitai__*` tool next to the
`panel_*` tools — discover on Civitai and wire onto the live graph in one
turn, no extra setup. If only comfyui-mcp is connected, suggest adding the
Civitai MCP, then proceed with the HF/id fallback.

## Boundaries — what to confirm before doing

Civitai's MCP also exposes **write/social** tools (post, comment, review,
direct message, follow, bounties). Those publish on the user's behalf — treat
them like any outward-facing action: surface what you're about to post and
get an explicit yes first. This skill is about **discovery → local install →
generation**; don't post or message without being asked.

## See also

- `model-registry` — curated direct download URLs (HF + Civitai notes)
- `model-compatibility` — base-model / VAE / CLIP pairing (why a LoRA won't load)
- `prompt-engineering` — Civitai image params are a prompt goldmine
