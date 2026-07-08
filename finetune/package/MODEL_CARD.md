# gemma4-12b-abliterated-comfyui-mcp

Gemma 4 12B (abliterated) fine-tuned to be an expert operator of a ComfyUI
server through [comfyui-mcp](https://github.com/artokun/comfyui-mcp)'s FULL
113-tool surface — no compact router mode needed. Runs fully local via Ollama.

- **Base model:** [coder3101/gemma-4-12B-it-heretic](https://huggingface.co/coder3101/gemma-4-12B-it-heretic) (google/gemma-4-12b-it → Heretic abliteration, KL div 0.16)
- **Fine-tune:** QLoRA (r=32) on ~<N> tool-call trajectories generated against a live ComfyUI server via the comfyui-mcp arena harness, mixed with general tool-calling data (Toucan-1.5M, xLAM subsets) and ComfyUI domain Q&A
- **Teachers:** open-weight models only (Kimi K2.5, GLM-5.1, MiMo-v2.5, DeepSeek-v3.2, MiniMax-M3) — no Anthropic/OpenAI/Google/xAI outputs in the training data
- **Context:** 128K (train seq len 48K: the full tool payload is ~30-40K tokens)
- **Prompt format:** Gemma 4 chat template with native tool-calling tokens; use `apply_chat_template(tools=...)` or Ollama ≥ 0.31

## Provided files

| File | Quant | Size | Use case |
| ---- | ----- | ---- | -------- |
| model-q4_k_m.gguf | Q4_K_M | ~7.6 GB | recommended local default (~8 GB VRAM) |
| model-q5_k_m.gguf | Q5_K_M | ~9 GB | higher quality, ~10 GB VRAM |
| model-q8_0.gguf | Q8_0 | ~13 GB | near-lossless |
| merged-16bit/ | f16 safetensors | ~24 GB | further fine-tuning / vLLM |

## Usage (Ollama)

```bash
ollama pull <you>/gemma4-abliterated-comfyui-mcp
# in comfyui-mcp panel: PANEL_AGENT_BACKEND=ollama COMFYUI_MCP_OLLAMA_MODEL=<you>/gemma4-abliterated-comfyui-mcp
```

## Benchmarks

| Model | Arena (full surface, 10 scenarios, server-verified) |
| ----- | --------------------------------------------------- |
| this model | <fill from arena-results-full> |
| gemma4:12b (stock) | <baseline> |
| qwen3:4b | <baseline> |

## Warnings

Inherits the abliterated base's reduced refusals — intended for local research
and personal-workstation use. Outputs are unmoderated; you are responsible for
what you generate. BFCL-subset regression vs the base: <fill>.
