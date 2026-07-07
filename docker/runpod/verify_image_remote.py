#!/usr/bin/env python3
"""Verify a PUSHED comfyui-mcp RunPod image straight from its registry.

Downloads only the manifest, config, and the one layer produced by the
`mv custom_nodes -> custom_nodes_seed` build step (a few MB — not the 20 GB
image) and asserts the load-bearing files are present with real contents.
This checks what the registry ACTUALLY serves, after any build cache,
compression, or push step had a chance to mangle it.

    python3 verify_image_remote.py ghcr.io/artokun/comfyui-mcp-runpod:cu128-lean
    python3 verify_image_remote.py docker.io/artokun/comfyui-mcp-runpod:1.6

Exit 0 = verified; exit 1 = FAILED (do not point the RunPod template at it).
Anonymous pull only — works for public repos, no credentials needed.
"""
import io
import json
import gzip
import sys
import tarfile
import urllib.request

KEY_FILES = [
    "opt/ComfyUI/custom_nodes_seed/comfyui-mcp-panel/__init__.py",
    "opt/ComfyUI/custom_nodes_seed/comfyui-mcp-panel/pyproject.toml",
    "opt/ComfyUI/custom_nodes_seed/comfyui-mcp-panel/web/js/comfyui-mcp-panel.js",
]
ACCEPT = ", ".join([
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
])


def fetch(url, token=None, accept=None, raw=False):
    req = urllib.request.Request(url)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    if accept:
        req.add_header("Accept", accept)
    with urllib.request.urlopen(req, timeout=120) as r:
        data = r.read()
    return data if raw else json.loads(data)


def registry_parts(ref):
    host, _, rest = ref.partition("/")
    if host in ("docker.io", "index.docker.io"):
        host = "registry-1.docker.io"
    repo, _, tag = rest.rpartition(":")
    if not repo:  # no tag given
        repo, tag = rest, "latest"
    return host, repo, tag


def get_token(host, repo):
    if host == "registry-1.docker.io":
        url = f"https://auth.docker.io/token?service=registry.docker.io&scope=repository:{repo}:pull"
    elif host == "ghcr.io":
        url = f"https://ghcr.io/token?scope=repository:{repo}:pull"
    else:
        return None
    return fetch(url)["token"]


def main(ref):
    host, repo, tag = registry_parts(ref)
    token = get_token(host, repo)
    base = f"https://{host}/v2/{repo}"

    manifest = fetch(f"{base}/manifests/{tag}", token, ACCEPT)
    if "manifests" in manifest:  # index/manifest-list -> pick linux/amd64
        digest = next(
            m["digest"] for m in manifest["manifests"]
            if m.get("platform", {}).get("architecture") == "amd64"
        )
        manifest = fetch(f"{base}/manifests/{digest}", token, ACCEPT)

    config = fetch(f"{base}/blobs/{manifest['config']['digest']}", token)

    # Map non-empty history entries onto layers; find the mv-seed step's layer.
    layers = manifest["layers"]
    idx, seed_layer = 0, None
    for entry in config.get("history", []):
        if entry.get("empty_layer"):
            continue
        created_by = entry.get("created_by", "")
        if "custom_nodes_seed" in created_by and " mv " in f" {created_by} ":
            seed_layer = layers[idx]
        idx += 1
    if seed_layer is None:
        print("FAIL: no layer matches the `mv custom_nodes -> custom_nodes_seed` step")
        return 1

    print(f"seed layer: {seed_layer['digest']} ({seed_layer['size'] / 1e6:.1f} MB) — downloading…")
    blob = fetch(f"{base}/blobs/{seed_layer['digest']}", token, raw=True)
    tf = tarfile.open(fileobj=io.BytesIO(gzip.decompress(blob)))

    sizes = {m.name: m.size for m in tf if m.isfile()}
    failures = []
    for f in KEY_FILES:
        size = sizes.get(f)
        if not size:
            failures.append(f"{f}: {'MISSING' if size is None else '0 BYTES'}")
        else:
            print(f"  ok: {f} ({size} bytes)")
    empty = [n for n, s in sizes.items()
             if s == 0 and "/.git/" not in n and not n.split("/")[-1].startswith(".wh.")]
    if empty:
        failures.append(f"{len(empty)} zero-byte files in seed, e.g. {empty[:5]}")

    if failures:
        print("FAIL: the registry is serving a broken image:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print(f"VERIFIED: {ref} serves a healthy custom_nodes_seed ({len(sizes)} files)")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
