---
name: wan-lora-trainer
description: Train custom WAN 2.2 LoRAs (people, styles, video motion) with ostris AI-Toolkit — use when the user wants to train a WAN LoRA; covers local (24GB+) and RunPod setup, dataset prep, key params, and using the result in a WAN workflow
globs:
  - "**/*.json"
---

# WAN 2.2 LoRA Trainer (ostris AI-Toolkit)

## Overview

**AI-Toolkit** by **ostris** is "the ultimate training toolkit for finetuning diffusion models" (MIT license) — a **standalone trainer with its own web UI**, NOT a ComfyUI custom node. It runs a Node.js Gradio-style UI front end over a Python (`run.py`) training backend, and trains LoRAs for many model families including **WAN 2.2** and **WAN 2.1** video models.

- Repo: **`https://github.com/ostris/ai-toolkit`** (cloned by both installers).
- Backend: `python run.py config/<job>.yml`. UI: a Node.js app under `ui/` that schedules/monitors jobs (you don't have to keep the UI open while a job runs).
- Output: a standard `.safetensors` LoRA you drop into ComfyUI `models/loras/` and load with `LoraLoaderModelOnly` in a WAN workflow.

**Best for:** training your own WAN LoRAs when the prebuilt ones (lightning, concept LoRAs) aren't enough — e.g. a person/character, an art style, or a specific **camera/video motion**. For *using* WAN, see the sibling skills **wan-t2v-video** (text-to-video) and **wan-flf-video** (first-last-frame). For low-VRAM *image* LoRA training on a different base, see the sibling **anima-lora-trainer**.

**Supported WAN variants** (per the repo): WAN 2.2 14B (t2v), WAN 2.2 I2V 14B (i2v), WAN 2.2 TI2V 5B; WAN 2.1 14B / 1.3B (t2v) and WAN 2.1 I2V 14B 480p/720p.

> Distinguish two LoRA kinds: a **WAN image LoRA** trains on still images (cheaper, ~24GB-class, good for identity/style) and a **WAN video LoRA** trains on short video clips (heavier — best on cloud — good for *motion*). Both produce a `.safetensors` usable in WAN workflows.

## Install

### Windows — `AI-TOOLKIT_AUTO_INSTALL.bat`

CUDA-aware one-click installer. Put it in a folder whose **full path has NO spaces** (e.g. `C:\AI-Toolkit`, not `C:\Users\Me\AI Toolkit`). Prerequisites it expects already in PATH:

- **Git for Windows**
- **Python 3.10.x** (3.10.11 recommended)
- **Node.js 18+** (the repo recommends Node > 20 for the UI)
- **NVIDIA GPU + matching CUDA Toolkit**

It prompts for GPU generation and selects the Torch wheel accordingly:

| Choice | GPU | CUDA Toolkit | Torch index | Torch packages |
|--------|-----|--------------|-------------|----------------|
| 1 | RTX 50-series (Blackwell) | **12.8** | `https://download.pytorch.org/whl/cu128` | `torch==2.7.0 torchvision==0.22.0` |
| 2 | RTX 40 / 30 / 20 and older | **12.6** | `https://download.pytorch.org/whl/cu126` | `torch==2.7.0 torchvision==0.22.0` |

CUDA download links it prints: 12.8 → `https://developer.nvidia.com/cuda-12-8-0-download-archive`, 12.6 → `https://developer.nvidia.com/cuda-12-6-0-download-archive`.

Then it: clones `ostris/ai-toolkit`; downloads two launcher scripts via curl (`LAUNCHER-TOOLKIT.bat` and `SECURE_LAUNCHER-TOOLKIT.bat`, from `https://huggingface.co/Aitrepreneur/FLX/resolve/main/`); creates a `venv`; upgrades pip; installs the Torch wheel from the chosen index; `pip install -r requirements.txt`; then `cd ui && npm run build_and_start` to build and launch the web UI.

> The Torch package string is identical for both choices (only the `--index-url` differs, which is what actually selects the cu128 vs cu126 build).

### RunPod / Linux — `AI-TOOLKIT_AUTO_INSTALL-RUNPOD.sh`

Installs into the persistent volume `/workspace/ai-toolkit`. It is **idempotent**: if an install already exists it just relaunches the UI (`npm run start`, no rebuild) and exits. Use RunPod's **PyTorch 2.8.0** template with a **100GB** disk/volume.

First-time flow: prompts for GPU; installs apt deps (`git python3 python3-venv python3-pip build-essential curl`); clones `ostris/ai-toolkit`; makes a venv; installs Torch; `pip install -r requirements.txt`; installs **nvm + Node 22** (nvm v0.40.3) into `/workspace/.nvm`; then `cd ui && npm install && npm run build_and_start &`.

GPU-specific Torch (note `torchaudio` is added vs Windows):

| Choice | GPU | Stream | Torch spec |
|--------|-----|--------|-----------|
| 1 | RTX 5000-series (Blackwell, sm_120) or newer | `cu128` | `torch==2.7.0+cu128 torchvision==0.22.0+cu128 torchaudio==2.7.0+cu128` |
| 2 | Ada / Hopper / Ampere, etc. (older) | `cu126` | `torch==2.7.0 torchvision==0.22.0 torchaudio==2.7.0` |

**Ports & auth:** the UI exposes **port 8675** (HTTP) and the RunPod template also opens **8888** (Jupyter). Set the **`AI_TOOLKIT_AUTH`** environment variable as the UI password before launch — the web UI requires it. Reach the UI via RunPod's proxy: `https://${RUNPOD_POD_ID}-8675.proxy.runpod.net`.

**GPU recommendations (RunPod):** an **RTX 5090** is enough for text-to-image / text-to-video WAN LoRAs; for heavier jobs (video LoRAs, higher resolution/rank) use an **RTX 6000 Pro (Blackwell)**.

## Launching the web UI

- **Windows:** run `LAUNCHER-TOOLKIT.bat` (local) or `SECURE_LAUNCHER-TOOLKIT.bat` (password-protected) from the `ai-toolkit` folder. The UI builds/starts via `npm run build_and_start`; first run builds, later runs start faster.
- **RunPod:** rerun `AI-TOOLKIT_AUTO_INSTALL-RUNPOD.sh` — it detects the existing install and starts the UI instantly on **:8675**.

In the UI you create a **Job**, point it at a dataset folder, choose the WAN model, set params, and start. Jobs run in the Python backend so you can close the browser. (You can also bypass the UI: copy a file from `config/examples/`, edit it, and run `python run.py config/<yourjob>.yml`.)

## Dataset preparation

AI-Toolkit pairs each training sample with a same-basename `.txt` caption and auto-resizes/buckets aspect ratios (no pre-cropping needed).

### Image LoRA (identity / style)
A flat folder of images + captions:
```
my_dataset/
  001.png   001.txt
  002.jpg   002.txt
  ...
```
- Captions: natural-language descriptions; include a **unique trigger word** for a person/character.
- 15–40 varied images is a good starting range for a person; more for a broad style.

### Video LoRA (motion)
Short **video clips** + a `.txt` caption per clip (same basename):
```
my_motion/
  clip01.mp4   clip01.txt
  clip02.mp4   clip02.txt
  ...
```
- Caption the **motion/camera move** you want to teach (e.g. "orbit shot around the subject").
- Frames per clip is controlled by the job's `num_frames` (e.g. **81**), and clips are bucketed to the chosen resolution(s). Video training is markedly heavier than image training — prefer cloud GPUs.

## Key training params + defaults

WAN 2.2 14B is a Mixture-of-Experts with a **high-noise** expert (early/structure/motion) and a **low-noise** expert (late/detail) — the same hi/lo split used at generation time. AI-Toolkit trains both via **Multi-stage**, alternating which expert is active.

| Param | Sensible default | Notes |
|-------|------------------|-------|
| Linear rank / dim | **16** | 16 for simple styles & motion; 16–32 for complex/cinematic looks |
| Learning rate | **5e-5** (identity) | 7e-5–1e-4 for style. WAN punishes high LR with plasticky skin / loss spikes |
| Steps | **1500–2500** | stop when the look is strong but not overbaked |
| Resolution | **512** (or 768) | bucketed; 768 costs more VRAM |
| `num_frames` (video) | **81** | per-clip frame count for video LoRAs |
| Multi-stage | **High Noise = ON, Low Noise = ON** | trains both WAN experts |
| Switch Every | **10** | raise to 20–50 if low-VRAM offloading makes expert swapping slow |
| Optimizer | AdamW8bit | standard low-VRAM choice |
| Quantization | 4-bit ARA / float8 | reduces VRAM for the 14B models so they fit on consumer cards |
| Trigger word | dataset-specific | use it in captions and at inference |

> These defaults are aggregated from community/training-guide sources, not the literal `config/examples/*.yml` shipping values — treat them as a starting point and tune. See "Unverified" below.

## VRAM / GPU guidance

- **WAN image LoRA (t2i/t2v):** the author notes **24GB+** works **locally** with quantization (4-bit ARA / float8) — e.g. RTX 3090/4090/5090. Below 24GB, train on RunPod.
- **WAN video LoRA / higher res / higher rank:** heavier — use cloud. RunPod recs: **RTX 5090** suffices for t2i/t2v LoRAs; step up to **RTX 6000 Pro (Blackwell)** for the demanding jobs. H100/H200 also work.
- Memory savers: enable quantization, keep batch size 1, raise **Switch Every** so expert offload swaps less often, and prefer 512 over 768.

## Using the trained LoRA in a ComfyUI WAN workflow

1. Copy `<your_lora>.safetensors` from AI-Toolkit's output folder into ComfyUI **`models/loras/`** (or a subfolder).
2. In a WAN 2.2 workflow, load it with **`LoraLoaderModelOnly`** on the model path. Because WAN 2.2 is **dual hi/lo**, apply the LoRA to the **matching pass(es)** — for a full-effect LoRA, load it on **both** the HighNoise and LowNoise model branches (same as lightning/concept LoRAs in the **wan-t2v-video** skill):
   ```json
   { "class_type": "LoraLoaderModelOnly",
     "inputs": { "model": ["<wan_hi_unet>", 0],
                 "lora_name": "<your_lora>.safetensors",
                 "strength_model": 1.0 } }
   ```
   Repeat for the LowNoise branch. Typical strength **0.5–1.0**.
3. Prompt using the **trigger word / caption style** you trained with. For motion LoRAs, describe the same camera/motion you captioned.

## Troubleshooting

- **`self and mat2 must have the same dtype` (ComfyUI-WanVideoWrapper).** Known dtype mismatch in the WanVideoWrapper custom node. **Fix:** delete and **re-clone `ComfyUI-WanVideoWrapper`** in `ComfyUI/custom_nodes/`, then **reinstall its `requirements.txt`** (`pip install -r requirements.txt` in that node's folder), and restart ComfyUI.
- **5000-series (Blackwell) onnxruntime "QuickGelu" / CUDA error.** onnxruntime's bundled CUDA provider mismatches on sm_120. **Fix:** `pip install onnxruntime==1.20.1` (in the active venv — the AI-Toolkit venv for training, or ComfyUI's env if it surfaces there).
- **Path with spaces (Windows).** The installer warns: keep the install path space-free or the build/launch fails.
- **OOM during training.** Enable quantization (4-bit ARA / float8), drop resolution to 512, keep batch 1, raise Switch Every, or move to a bigger RunPod GPU.
- **RunPod UI won't load / asks for a password.** Confirm `AI_TOOLKIT_AUTH` is set and you're hitting the **8675** proxy URL.

## Unverified / verify before relying

- The **default training params table** (rank 16, LR 5e-5, 1500–2500 steps, res 512/768, num_frames 81, Switch Every 10) is synthesized from training-guide/community sources current to 2026, **not** read out of the repo's `config/examples/*.yml`. Open the actual WAN example config in your clone (`config/examples/`) and adjust.
- **Ports:** Windows UI port is whatever `npm run build_and_start` / the downloaded launcher binds (commonly localhost) — the installer does not print it explicitly; check the launcher window. RunPod **8675** (UI) and **8888** (Jupyter) are per the RunPod template, not hard-coded in the `.sh`.
- The two launcher `.bat` files are downloaded from a **third-party HuggingFace repo** (`Aitrepreneur/FLX`); review them before running on a security-sensitive machine.
- WAN model weights are fetched by AI-Toolkit/HF at job time, not by the installer — confirm the model selector in the UI lists your target WAN variant before starting a long run.
