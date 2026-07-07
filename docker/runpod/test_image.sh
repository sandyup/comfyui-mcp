#!/usr/bin/env bash
#
# test_image.sh — post-build integrity + boot test for the comfyui-mcp RunPod
# image. Run this against a LOCALLY BUILT (or pulled) image BEFORE pushing it
# to any registry; deploy-dockerhub.sh refuses to push unless this passes.
#
#   ./test_image.sh <image-ref>            # static checks + 2-boot volume test
#   ./test_image.sh <image-ref> --static   # static checks only (~seconds)
#
# What it catches (all real, all shipped at least once):
#   * 0-byte / missing panel or config files in the image  (field report: an
#     entire panel file tree of empty husks)
#   * post_start.sh syntax errors or a broken venv
#   * custom_nodes NOT persisting across a redeploy (symlink regression)
#   * the ENOSPC self-heal failing to repair a corrupted volume
#
# Needs: docker. No GPU required — everything under test runs before ComfyUI
# needs CUDA (the boot test only asserts volume/panel state, not inference).
set -euo pipefail
# Git Bash (Windows) rewrites /container/paths in args into C:/... host paths,
# silently breaking -v/--tmpfs mounts. Disabling conversion is a no-op elsewhere.
export MSYS_NO_PATHCONV=1

IMAGE="${1:?usage: test_image.sh <image-ref> [--static]}"
MODE="${2:-full}"
FAILURES=0

say()  { echo "[test_image] $*"; }
pass() { echo "[test_image]   PASS: $*"; }
fail() { echo "[test_image]   FAIL: $*"; FAILURES=$((FAILURES + 1)); }

drun() { MSYS_NO_PATHCONV=1 docker run --rm --entrypoint bash "$IMAGE" -c "$1"; }

# -----------------------------------------------------------------------------
# 1. STATIC CHECKS — file presence, non-emptiness, syntax, venv imports.
# -----------------------------------------------------------------------------
say "static checks on ${IMAGE}…"

if drun '
  set -e
  CH="${COMFY_HOME:-/opt/ComfyUI}"
  for f in "$CH/custom_nodes_seed/comfyui-mcp-panel/__init__.py" \
           "$CH/custom_nodes_seed/comfyui-mcp-panel/pyproject.toml" \
           "$CH/custom_nodes_seed/comfyui-mcp-panel/web/js/comfyui-mcp-panel.js" \
           "$CH/extra_model_paths.yaml" \
           "$CH/config.ini.seed" \
           "$CH/main.py" \
           /post_start.sh /etc/nginx/nginx.conf; do
    [ -s "$f" ] || { echo "MISSING/EMPTY: $f"; exit 1; }
  done
  EMPTY="$(find "$CH/custom_nodes_seed" -type f -size 0 | head -20)"
  [ -z "$EMPTY" ] || { echo "0-BYTE FILES IN SEED:"; echo "$EMPTY"; exit 1; }
  [ -x /post_start.sh ] || { echo "/post_start.sh not executable"; exit 1; }
  bash -n /post_start.sh
  "$CH/venv/bin/python" -c "import torch; import importlib.metadata as m; m.version(\"comfyui-manager\")"
  command -v aria2c >/dev/null || { echo "aria2c missing (fast model downloads)"; exit 1; }
  "$CH/venv/bin/python" -c "import aria2p" || { echo "aria2p not importable in venv"; exit 1; }
  "$CH/venv/bin/python" -c "import hf_transfer" || { echo "hf_transfer not importable in venv (HF_HUB_ENABLE_HF_TRANSFER=1 baked)"; exit 1; }
  grep -q "^security_level" "$CH/config.ini.seed" || { echo "config.ini.seed lacks security_level"; exit 1; }
'; then
  pass "baked files present + non-empty, post_start.sh parses, venv imports torch/comfyui_manager, aria2 baked"
else
  fail "static checks (see output above)"
fi

if [ "$MODE" = "--static" ]; then
  [ "$FAILURES" -eq 0 ] && { say "STATIC OK"; exit 0; } || { say "FAILED"; exit 1; }
fi

# -----------------------------------------------------------------------------
# 2. BOOT TEST — the pod lifecycle against a scratch volume:
#      boot 1 (fresh volume)  -> panel healthy on the volume, symlink correct
#      simulated user install -> a marker "custom node" written via the symlink
#      boot 2 (fresh CONTAINER, same volume == RunPod redeploy)
#                             -> user node still there, panel still healthy
#      corruption + boot 3    -> 0-byte panel (the ENOSPC aftermath) self-heals
# -----------------------------------------------------------------------------
VOL="cmcp-test-$$"
CN="/workspace/custom_nodes"
PANEL="$CN/comfyui-mcp-panel"
cleanup() { docker rm -f "cmcp-t1-$$" "cmcp-t2-$$" "cmcp-t3-$$" >/dev/null 2>&1 || true
            docker volume rm "$VOL" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker volume create "$VOL" >/dev/null

boot() {  # $1 = container name — waits until post_start reaches the ComfyUI launch
  docker run -d --name "$1" -v "$VOL:/workspace" -e MIN_DRIVER=0 "$IMAGE" >/dev/null
  for _ in $(seq 1 60); do
    if docker logs "$1" 2>&1 | grep -q 'launching ComfyUI:'; then return 0; fi
    if docker logs "$1" 2>&1 | grep -q 'FATAL'; then docker logs "$1" 2>&1 | tail -20; return 1; fi
    sleep 5
  done
  echo "timed out waiting for post_start"; docker logs "$1" 2>&1 | tail -20; return 1
}

panel_check() {  # $1 = container name, $2 = label
  if docker exec "$1" bash -c "
      set -e
      [ \"\$(readlink -f \${COMFY_HOME:-/opt/ComfyUI}/custom_nodes)\" = \"$CN\" ]
      [ -s $PANEL/__init__.py ] && [ -s $PANEL/pyproject.toml ] && [ -s $PANEL/web/js/comfyui-mcp-panel.js ]
      [ -z \"\$(find $CN -type f -size 0 -not -path '*/.git/*' | head -1)\" ]
    "; then pass "$2"; else fail "$2"; fi
}

say "boot 1: fresh volume…"
if boot "cmcp-t1-$$"; then
  panel_check "cmcp-t1-$$" "boot 1: symlink -> volume, panel non-empty, no 0-byte files"
  # aria2 sidecar: the daemon must be up and the launch env wired, or Manager
  # model downloads silently fall back to the <1-4 MB/s built-in downloader.
  if docker logs "cmcp-t1-$$" 2>&1 | grep -q 'aria2 RPC sidecar up' \
     && docker exec "cmcp-t1-$$" bash -c "pgrep -x aria2c >/dev/null"; then
    pass "boot 1: aria2 RPC sidecar running (fast model downloads)"
  else
    fail "boot 1: aria2 sidecar not running — Manager would use the slow built-in downloader"
  fi
  docker exec "cmcp-t1-$$" bash -c "mkdir -p /opt/ComfyUI/custom_nodes/user-test-node && echo 'MARKER = 1' > /opt/ComfyUI/custom_nodes/user-test-node/__init__.py"
else
  fail "boot 1 did not reach ComfyUI launch"
fi
docker rm -f "cmcp-t1-$$" >/dev/null

say "boot 2: redeploy (fresh container, same volume)…"
if boot "cmcp-t2-$$"; then
  panel_check "cmcp-t2-$$" "boot 2: panel still healthy after redeploy"
  if docker exec "cmcp-t2-$$" bash -c "grep -q 'MARKER = 1' $CN/user-test-node/__init__.py"; then
    pass "boot 2: user-installed node SURVIVED the redeploy"
  else
    fail "boot 2: user-installed node LOST on redeploy (persistence regression)"
  fi
else
  fail "boot 2 did not reach ComfyUI launch"
fi
docker rm -f "cmcp-t2-$$" >/dev/null

say "boot 3: self-heal after simulated ENOSPC corruption (0-byte panel)…"
# Truncate EVERY panel file (worktree AND .git — exactly what a full volume
# leaves behind), and hide the image seed behind an empty bind-mount so the
# routine seed refresh can't repair it — this forces the §4.5(b.2) last-resort
# re-clone, the path that saves a pod whose volume corrupted while the image
# seed is stale/unavailable.
docker run --rm -v "$VOL:/workspace" --entrypoint bash "$IMAGE" -c \
  "find $PANEL -type f -exec truncate -s 0 {} +" >/dev/null
boot3() {
  docker run -d --name "cmcp-t3-$$" -v "$VOL:/workspace" -e MIN_DRIVER=0 \
    --tmpfs /opt/ComfyUI/custom_nodes_seed "$IMAGE" >/dev/null
  for _ in $(seq 1 60); do
    if docker logs "cmcp-t3-$$" 2>&1 | grep -q 'launching ComfyUI:'; then return 0; fi
    sleep 5
  done
  echo "timed out"; docker logs "cmcp-t3-$$" 2>&1 | tail -20; return 1
}
if boot3; then
  panel_check "cmcp-t3-$$" "boot 3: 0-byte panel was self-healed at boot"
  docker logs "cmcp-t3-$$" 2>&1 | grep -q 'self-healing' \
    && pass "boot 3: §4.5(b.2) self-heal path was taken and logged" \
    || fail "boot 3: self-heal log line missing"
else
  fail "boot 3 did not reach ComfyUI launch"
fi
docker rm -f "cmcp-t3-$$" >/dev/null

if [ "$FAILURES" -eq 0 ]; then
  say "ALL CHECKS PASSED — image is safe to push"
else
  say "FAILED: $FAILURES check(s) — DO NOT PUSH THIS IMAGE"
  exit 1
fi
