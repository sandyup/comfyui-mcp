---
name: krea2-txt2img
description: Build Krea 2 Turbo txt2img workflows — native krea2 CLIPLoader, Qwen3-VL encoder, Qwen image VAE, 8-step turbo settings, and Ideogram-style JSON prompting
globs:
  - "**/*.json"
---

# Krea 2 Text-to-Image Workflows

## Overview

Krea 2 is a **12B-parameter Diffusion Transformer** from Krea.ai (released June
2026, weights open-sourced under the Krea 2 Community License — free commercial
use up to 50 seats). Two variants:

1. **Krea 2 Raw** — the base checkpoint before extra post-training. For
   fine-tuning / maximum fidelity, more steps.
2. **Krea 2 Turbo** — post-trained + **distilled**; generates in **~8 steps at
   cfg 1**. This is what the krea2 txt2img packs ship.

## Two packs (no group toggles, no bypassed nodes)

The old single `krea2-txt2img` graph (prompt mode toggled by bypassing nodes) is
split into two standalone packs — pick by how you prompt:

- **`krea2-txt2img-manual`** — plain prose prompt (the `MANUAL PROMPT` node).
- **`krea2-txt2img-json`** — Ideogram-4-style structured JSON / area prompting
  (`Ideogram4PromptBuilderKJ`).

Both are single-pipeline graphs with no group toggles — each pack's one prompt
source is active and the other prompt node is removed (no prompt-mode bypass to
flip). `ImageSharpenKJ` runs before `SaveImage`. Two **optional** post-proc nodes
ship **bypassed** in both (see below). Both are render-verified.

Krea 2 has **native ComfyUI support** (`comfy/text_encoders/krea2.py`, ComfyUI ≥
v0.26.0): the `CLIPLoader` uses **`type=krea2`**, with a **Qwen3-VL 4B** text
encoder and the **Qwen image VAE**. The Qwen3-VL encoder drives strong prompt
adherence and structured-JSON prompts.

## Models (all from the `Aitrepreneur/FLX` mirror; official: `krea/Krea-2-Turbo`)

| Slot | File | Notes |
|---|---|---|
| `diffusion_models/` | `krea2_turbo_fp8.safetensors` | 12B Turbo, fp8 — RTX 4000/3000/2000 |
| `diffusion_models/` | `krea2_turbo_mxfp8.safetensors` | RTX 5000 (Blackwell) native fp8 |
| `text_encoders/` | `qwen3vl_4b_fp8_scaled.safetensors` | Qwen3-VL 4B encoder |
| `vae/` | `qwen_image_vae.safetensors` | Qwen image VAE |

## Node stack

- **core**: `UNETLoader` (krea2_turbo) → `CLIPLoader` (type=krea2) → `VAELoader`
  (qwen_image_vae), wired via KJNodes `SetNode`/`GetNode` buses into a subgraph
  (`CLIPTextEncode` → `KSampler` → `VAEDecode`). An rgthree `Any Switch` sits in
  front of the encoder; in each pack only that pack's prompt source is wired to it
  (manual node in `-manual`, JSON builder in `-json`).
- **rgthree-comfy**: Power Lora Loader, Any Switch, Label, Fast Groups.
- **ComfyUI-KJNodes**: Set/Get, `Ideogram4PromptBuilderKJ`, `ImageSharpenKJ`.
- **ComfyUI-RBG-SmartSeedVariance**: `RBG_Smart_Seed_Variance` — **optional**, ships
  **bypassed** in the positive-conditioning loop.
- **ComfyUI-ConditioningKrea2Rebalance**: `ConditioningKrea2Rebalance` — **optional**,
  ships **bypassed** (after seed-variance), in the same loop.

## Settings that matter

- **steps 8, cfg 1** — Turbo is distilled; more steps/higher cfg over-cooks it.
- **sampler `er_sde`, scheduler `simple`** — the verified defaults.
- **1920×1080** default; Krea 2 handles a wide aspect range.
- The prompt source is fixed per pack (manual node vs JSON builder) — no
  prompt-mode bypass to flip.

## Optional post-proc (ship bypassed — un-bypass to use)

Both packs leave these two nodes in the positive-conditioning loop, **bypassed**
(passthrough). Un-bypass on the live canvas with `panel_set_node_mode` (or in the
UI) when you want them:

- **`RBG_Smart_Seed_Variance`** — controlled variations of the same prompt without
  changing the composition. Enable it, set its seed mode to `randomize`, and tune
  the variance mode (e.g. `🌿 Balanced`) / strength widgets. Leave bypassed for a
  deterministic single result.
- **`ConditioningKrea2Rebalance`** — rebalances the per-token conditioning weights
  (the comma-separated weight string, e.g. `1.0,…,2.5,5.0,1.1,4.0,1.0`). The
  upstream author frames it as removing Krea 2's built-in **safety filter**, so
  **leave it bypassed for the model's default safety behavior**; only enable (and
  adjust the weights) with a specific, authorized reason.

## JSON / area prompting

Like Ideogram 4, Krea 2's Qwen3-VL encoder reads structured prompts (per-region
desc + bounding boxes + palettes). For structured prompting just use the
**`krea2-txt2img-json`** pack — its `Ideogram4PromptBuilderKJ` drives the encoder
directly (no bypass to flip). After the render, VERIFY the image matches the JSON
you set (view it) BEFORE continuing; if it doesn't, a field is probably stale —
fix and rerun. Gotchas learned the hard way:

- **Set ALL the builder fields**, not just the prompt/boxes — `background`,
  `technical`, `style`, `lighting` (widgets 3/5/6/7). Leaving stale values leaks
  content (a leftover celebrity portrait bled into a tea still-life).
- **Keep palettes minimal or empty.** A rich top-level palette can render as a
  literal color-swatch strip down the edge of the image. Empty `palette: []`
  (top-level and per-box) gives a clean full-frame result.
- Add "no people / single full-frame photograph" to `style` for object/landscape
  scenes — Krea 2 follows it well.

## Render-verified

Both packs render crisp at 1920×1080 / 8 steps / cfg 1 / er_sde with the optional
loop nodes bypassed (default) — `-manual` on a prose snow-leopard prompt, `-json`
on a tea still-life whose teapot/cup/figs each land in their bbox region.
**Note:** the `ImageSharpenKJ` (rcas 0.55) before `SaveImage` is **active** —
bypassing it drops the image link (a converter gap: bypass-passthrough doesn't
cross a subgraph IMAGE output), and the contrast-adaptive sharpen suits Krea 2's
crisp look anyway.

## Gotchas

- `CLIPLoader: 'krea2' not in list` → ComfyUI too old; update to ≥ v0.26.0.
- `Torch not compiled with CUDA enabled` → reinstall torch for your CUDA tag
  (`--index-url https://download.pytorch.org/whl/cu128`).
