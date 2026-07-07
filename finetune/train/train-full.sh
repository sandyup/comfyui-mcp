#!/usr/bin/env bash
# First REAL training run (not a canary): full QLoRA on the quality-generation
# dataset, exports GGUF. Domain-only for this first pass (fastest read on whether
# the quality data teaches ComfyUI expertise); add --toucan/--xlam for the final
# anti-forgetting run. Same validated recipe as canary.sh (Heretic base, trimmed
# 16K context, ~104s/step). Run on a RunPod A100. Expects HF_TOKEN in env.
set -euo pipefail
SIZE="${1:-12b}"

echo "=== [train] 1/5 deps ==="
pip install -q -U pip
pip install -q -U unsloth trl datasets pyyaml huggingface_hub hf_transfer
pip install -q -U "transformers>=5.10.1"
TORCH_VER=$(python -c "import torch; print(torch.__version__.split('+')[0])")
pip install -q "torchaudio==${TORCH_VER}" --index-url https://download.pytorch.org/whl/cu128 || true
export HF_HUB_ENABLE_HF_TRANSFER=1
python -c "import os; from huggingface_hub import login; login(os.environ['HF_TOKEN'])"

echo "=== [train] 2/5 assemble dataset (domain-only) ==="
cd finetune/train
python prepare_dataset.py --val-frac 0.05

echo "=== [train] 3/5 dry-run (verify template + masking) ==="
python train_qlora.py --size "$SIZE" --dry-run

echo "=== [train] 4/5 FULL train (size=$SIZE, 2 epochs) ==="
python train_qlora.py --size "$SIZE"

echo "=== [train] 5/5 confirm exports ==="
find outputs -name '*.gguf' -exec ls -lah {} \; 2>/dev/null
touch /workspace/train_done 2>/dev/null || true
echo "=== [train] DONE — real ${SIZE} model trained + GGUF exported ==="
