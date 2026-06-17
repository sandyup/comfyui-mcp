#!/usr/bin/env bash
# Linux/RunPod equivalent of fix-ltxvideo-kornia.bat.
# ComfyUI-LTXVideo fails to import on kornia 0.8.3+ because `pad` is no longer
# exported from kornia.geometry.transform.pyramid. This removes the broken
# `pad,` import line and adds `pad = F.pad` after the torch.nn.functional import.
#
# Usage:
#   ./fix-ltxvideo-kornia.sh                 # auto-locate from ComfyUI root
#   ./fix-ltxvideo-kornia.sh /path/to/pyramid_blending.py
set -euo pipefail

echo "====================================================="
echo " Fixing ComfyUI-LTXVideo Kornia compatibility issue"
echo "====================================================="

# Resolve the target file: explicit arg, else common layouts.
TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  for c in \
    "custom_nodes/ComfyUI-LTXVideo/pyramid_blending.py" \
    "ComfyUI/custom_nodes/ComfyUI-LTXVideo/pyramid_blending.py" \
    "./pyramid_blending.py"; do
    if [ -f "$c" ]; then TARGET="$c"; break; fi
  done
fi

if [ -z "$TARGET" ] || [ ! -f "$TARGET" ]; then
  echo "[ERROR] Could not find ComfyUI-LTXVideo/pyramid_blending.py."
  echo "        Run from your ComfyUI root, or pass the path as an argument."
  exit 1
fi
echo "Target: $TARGET"

PY="${PYTHON:-python3}"
command -v "$PY" >/dev/null 2>&1 || { echo "[ERROR] $PY not found in PATH."; exit 1; }

"$PY" - "$TARGET" <<'PYEOF'
import re, shutil, sys

path = sys.argv[1]
with open(path, "r", encoding="utf-8") as f:
    original = f.read()
text = original

backup = path + ".bak_kornia_fix"
import os
if not os.path.exists(backup):
    shutil.copyfile(path, backup)
    print(f"[OK] Backup created: {backup}")
else:
    print(f"[OK] Backup already exists: {backup}")

# Drop the standalone `pad,` line inside the kornia pyramid import block.
pattern = re.compile(
    r"(from kornia\.geometry\.transform\.pyramid import \(\s*.*?)(^\s*pad,\s*$)(.*?^\s*\))",
    re.M | re.S,
)
text = pattern.sub(lambda m: m.group(1) + m.group(3), text, count=1)

# Ensure `pad = F.pad` exists after the torch.nn.functional import.
if not re.search(r"pad\s*=\s*F\.pad", text):
    target = "import torch.nn.functional as F"
    if target in text:
        text = text.replace(
            target,
            target
            + "\n\n# Compatibility fix for Kornia 0.8.3+ where pad is no longer exported here\npad = F.pad",
            1,
        )
    else:
        sys.exit("[ERROR] Could not find 'import torch.nn.functional as F'.")

if text == original:
    print("[OK] File already appears to be patched.")
else:
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    print("[OK] LTXVideo Kornia compatibility patch applied.")

# Verify.
with open(path, "r", encoding="utf-8") as f:
    patched = f.read()
if not re.search(r"pad\s*=\s*F\.pad", patched):
    sys.exit("[ERROR] Patch check failed: pad = F.pad was not added.")
blk = re.search(r"from kornia\.geometry\.transform\.pyramid import \((.*?)\)", patched, re.M | re.S)
if blk and re.search(r"(?m)^\s*pad,\s*$", blk.group(1)):
    sys.exit("[ERROR] Patch check failed: broken Kornia pad import still present.")
print("[OK] Patch verification passed.")
PYEOF

echo "DONE. Restart ComfyUI."
