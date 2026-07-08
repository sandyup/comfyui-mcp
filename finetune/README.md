# Fine-tuning `gemma4-abliterated-comfyui-mcp`

Pipeline to turn [the Heretic-abliterated Gemma 4 ladder](https://huggingface.co/coder3101/gemma-4-12B-it-heretic)
into a local expert that drives the **full 113-tool** comfyui-mcp surface
(no compact router mode). Recipe: TOUCAN-style data synthesis against the real
MCP server → Unsloth QLoRA → arena eval → TheBloke-style GGUF packaging.

Full plan/rationale: `~/.claude/plans/robust-petting-token.md`.

## Hard rules

1. **Teacher ToS.** Only open-weight teachers generate training data (allowlist
   in `datagen/lib.mjs`). Primary teacher: **xiaomi/mimo-v2.5** (MIT, secondary
   training permitted, 19/20 on our arena, 1M ctx); Kimi-K2.5 and GLM-5.1
   (both 19/20) add trajectory diversity.
   Anthropic/OpenAI/Google/xAI outputs must never enter the dataset, including
   their old arena transcripts. Filters enforce this in `convert-seed-transcripts.mjs`,
   `synth-tasks.mjs`, and again in `train/prepare_dataset.py`.
2. **Never hand-roll the chat template.** Gemma 4 tool calls use bespoke tokens
   (`<|tool_call>call:name{...}<tool_call|>`); always render through
   `tokenizer.apply_chat_template(tools=...)` / stock Ollama template.
3. **Deployment needs Ollama ≥ 0.31** (Gemma 4 tool parser fixed June 2026).

## Phase 1 — data (local, cheap)

```bash
npm run build
npm run ft:tools     # dump all 113 tool schemas → finetune/data/tools-full.json
npm run ft:seed      # rewrite ToS-safe PASS arena transcripts → seed-trajectories.jsonl (~87)

# synthesize tasks (OPENROUTER_API_KEY in .env is picked up automatically):
SYNTH_MODEL=xiaomi/mimo-v2.5 SYNTH_PER_CATEGORY=40 npm run ft:tasks

# generate trajectories against a LIVE ComfyUI (teacher runs the agent loop):
ARENA_API=openai ARENA_MODELS=xiaomi/mimo-v2.5,moonshotai/kimi-k2.5,z-ai/glm-5.1 \
ARENA_TASKS=finetune/data/tasks.jsonl \
node scripts/llm-arena-full.mjs        # → arena-results-full/trajectories.jsonl
```

Scale by raising `SYNTH_PER_CATEGORY` and adding teachers. PoC gate: ~3-5k
trajectories. Full run: 20-50k (parallelize with several ComfyUI instances /
a RunPod ComfyUI pod; the harness is one-process-per-ComfyUI).

**Mutating tasks** (custom-nodes / models / server categories install packs,
download models, restart ComfyUI) run against a DISPOSABLE RunPod ComfyUI pod
(template `bnqtkvcer3`), never the daily-driver install: set `COMFYUI_URL` to
the pod proxy and pass the filtered task file.

### Panel (live-canvas) trajectories — the deployment surface

The fine-tune deploys as the PANEL agent, whose full surface is the 113 MCP
tools PLUS the panel_* live-canvas tools. `npm run arena:panel`
(scripts/panel-arena.mjs) generates that half: real orchestrator + Ollama
backend (teacher via OpenRouter), a HEADLESS mock panel (scripts/mock-graph.mjs)
executing graph_*/workflow_* in-memory, verdicts checked against the mock graph
state, transcripts harvested via the `COMFYUI_MCP_TRANSCRIPT_DIR` hook in
ollama-backend and rewritten from the compact 6-router form to direct calls
under `FULL_PANEL_SYSTEM_PROMPT`. Output: `arena-results-panel/trajectories.jsonl`
(records carry `surface: "panel"`).

Target mix: ~45% headless MCP / ~30% panel / ~15% general tool-calling
(Toucan/xLAM) / ~10% domain Q&A.

## Phase 2 — train (RunPod A100 80GB or RTX Pro 6000, spot)

```bash
# on the pod: clone repo (or rsync finetune/ + arena-results-full/), then
pip install -r finetune/train/requirements.txt
cd finetune/train
python prepare_dataset.py --toucan 8000 --xlam 4000   # mix + dedupe + split
python train_qlora.py --dry-run    # VERIFY template markers + tool rendering first!
python train_qlora.py              # QLoRA → merged 16bit + GGUF quants
```

`--dry-run` prints rendered samples — confirm the Gemma 4 turn markers in
`config.yaml` (`template:`) match before burning GPU hours. If 48K seq OOMs on
80GB, drop `max_seq_length` to 32768 or move to RTX Pro 6000 96GB / H200.

## Phase 3 — eval (local, against live ComfyUI)

```bash
# package a candidate into Ollama first (Phase 4), then:
ARENA_MODELS=<you>/gemma4-abliterated-comfyui-mcp,gemma4:12b npm run arena:full
npm run smoke:panel   # panel E2E with PANEL_AGENT_BACKEND=ollama
```

Gates: 100% parseable tool calls; beats stock `gemma4:12b` on the full-surface
arena; no collapse on a BFCL-v3 subset vs the abliterated base.

## Phase 4 — package

```bash
ollama show gemma4:12b --modelfile   # copy TEMPLATE + stop params
# paste into package/Modelfile.template → Modelfile next to the q4_k_m gguf
ollama create <you>/gemma4-abliterated-comfyui-mcp -f Modelfile && ollama push ...
# HF: push merged-16bit + gguf files + package/MODEL_CARD.md (fill the tables)
```

## Layout

```
datagen/lib.mjs                    shared: teacher allowlist, system prompt
datagen/export-tools.ts            npm run ft:tools
datagen/convert-seed-transcripts.mjs  npm run ft:seed
datagen/synth-tasks.mjs            npm run ft:tasks
../scripts/llm-arena-full.mjs      npm run arena:full  (eval) / ARENA_TASKS= (datagen)
train/prepare_dataset.py           mix domain + Toucan/xLAM, dedupe, split
train/train_qlora.py               Unsloth QLoRA + GGUF export
package/Modelfile.template         Ollama packaging
package/MODEL_CARD.md              TheBloke-style card skeleton
data/                              generated artifacts (gitignored)
```
