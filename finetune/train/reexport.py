#!/usr/bin/env python3
"""Robust re-export of a trained LoRA adapter → merged 16-bit → GGUF.

Recovery path for when Unsloth's in-place `save_pretrained_merged`
(merge_and_overwrite_lora) fails mid-write on the Gemma-4 *unified* arch
(text+vision+audio), leaving a truncated single-file model.safetensors
("incomplete metadata, file not fully covered"). Training already produced a
valid `checkpoint-*/adapter_model.safetensors`; this reloads the base cleanly
with transformers+PEFT, merges, and writes a properly SHARDED 16-bit model
(no single-file overwrite), then converts to GGUF via llama.cpp.

Usage (on the training pod):
  python reexport.py \
    --base coder3101/gemma-4-12B-it-heretic \
    --adapter outputs/gemma4-12b-comfyui-mcp/checkpoint-144 \
    --out     outputs/gemma4-12b-comfyui-mcp/merged-16bit-clean \
    --gguf-quants q8_0 q4_k_m \
    --llama-cpp /workspace/llama.cpp
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


def load_base(base: str):
    import torch

    # gemma4_unified registers under image-text-to-text; fall back to the
    # concrete class if the Auto mapping isn't wired in this transformers build.
    kw = dict(torch_dtype=torch.bfloat16, low_cpu_mem_usage=True, device_map="auto")
    try:
        from transformers import AutoModelForImageTextToText

        return AutoModelForImageTextToText.from_pretrained(base, **kw)
    except Exception as e:  # noqa: BLE001
        print(f"[reexport] AutoModelForImageTextToText failed ({e}); trying concrete class")
        from transformers.models.gemma4_unified.modeling_gemma4_unified import (
            Gemma4UnifiedForConditionalGeneration,
        )

        return Gemma4UnifiedForConditionalGeneration.from_pretrained(base, **kw)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--adapter", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--gguf-quants", nargs="*", default=["q8_0", "q4_k_m"])
    ap.add_argument("--llama-cpp", default="/workspace/llama.cpp",
                    help="path to a built llama.cpp checkout (uses convert_hf_to_gguf.py + llama-quantize)")
    ap.add_argument("--shard-size", default="5GB")
    args = ap.parse_args()

    from peft import PeftModel
    from transformers import AutoProcessor, AutoTokenizer

    adapter = Path(args.adapter)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    print(f"[reexport] loading base {args.base} …")
    model = load_base(args.base)
    print(f"[reexport] attaching adapter {adapter} …")
    model = PeftModel.from_pretrained(model, str(adapter))
    print("[reexport] merge_and_unload …")
    model = model.merge_and_unload()
    print(f"[reexport] saving SHARDED 16-bit → {out} (max_shard_size={args.shard_size})")
    model.save_pretrained(str(out), safe_serialization=True, max_shard_size=args.shard_size)

    # tokenizer/processor: prefer the adapter dir (has the trained chat_template),
    # fall back to the base.
    try:
        AutoTokenizer.from_pretrained(str(adapter)).save_pretrained(str(out))
    except Exception:
        AutoTokenizer.from_pretrained(args.base).save_pretrained(str(out))
    try:
        AutoProcessor.from_pretrained(str(adapter)).save_pretrained(str(out))
    except Exception as e:  # noqa: BLE001
        print(f"[reexport] no processor saved ({e}) — fine for a text-only GGUF")
    # carry the trained jinja template through explicitly if present
    ct = adapter / "chat_template.jinja"
    if ct.exists():
        (out / "chat_template.jinja").write_bytes(ct.read_bytes())

    # verify the sharded merge actually loads back (catches truncation NOW)
    print("[reexport] verifying merged shards deserialize …")
    from safetensors import safe_open

    shards = sorted(out.glob("model*.safetensors"))
    total = 0
    for s in shards:
        with safe_open(str(s), framework="pt") as f:
            total += len(f.keys())
    print(f"[reexport] OK — {len(shards)} shard(s), {total} tensors")

    if not args.gguf_quants:
        print("[reexport] no GGUF quants requested; done.")
        return

    convert = Path(args.llama_cpp) / "convert_hf_to_gguf.py"
    if not convert.exists():
        print(f"[reexport] WARNING: {convert} not found — skipping GGUF. "
              f"Merged 16-bit is ready at {out}; run llama.cpp convert separately.")
        return

    f16 = out / "model-f16.gguf"
    print(f"[reexport] llama.cpp convert → {f16}")
    subprocess.run([sys.executable, str(convert), str(out),
                    "--outfile", str(f16), "--outtype", "f16"], check=True)
    quantize = Path(args.llama_cpp) / "build" / "bin" / "llama-quantize"
    for q in args.gguf_quants:
        target = out / f"model-{q}.gguf"
        print(f"[reexport] quantize → {target}")
        subprocess.run([str(quantize), str(f16), str(target), q], check=True)
    print(f"[reexport] done → {out}")


if __name__ == "__main__":
    main()
