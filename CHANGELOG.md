# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org/) and the format follows
[Keep a Changelog](https://keepachangelog.com/).

## [0.6.0] - 2026-05-25

A large feature release that ports much of the [`comfy-cli`](https://github.com/Comfy-Org/comfy-cli)
workflow into MCP tools. New tools operate on the connected ComfyUI (local or a
remote `--comfyui-url` target), preferring the ComfyUI-Manager HTTP API with a
subprocess fallback where the API can't do the job.

### Added — comfy-cli capability port

- **Custom-node management** — `install_custom_node`, `update_custom_node`,
  `reinstall_custom_node`, `fix_custom_node`, `list_installed_nodes`,
  `sync_node_dependencies` (#15)
- **Node snapshots** — `save_node_snapshot`, `restore_node_snapshot`,
  `list_node_snapshots`; honors comfy-cli's `.json`/`.yaml` snapshot contract (#13)
- **Node bisect** — `bisect_start`, `bisect_good`, `bisect_bad`, `bisect_reset`,
  `bisect_status` to isolate a faulty custom node; never re-enables packs you had
  disabled before the session (#14)
- **Workflow dependencies** — `extract_workflow_dependencies`,
  `install_workflow_dependencies` (handles API- and UI-format workflows) (#16)
- **Install ComfyUI** — `install_comfyui`: clones ComfyUI (+ ComfyUI-Manager) and
  installs requirements into a dedicated workspace virtualenv (#17)
- **Update** — `update_comfyui` (core) and `update_all` (all custom nodes) (#18)
- **Models** — `remove_model` (path-safe) and `download_civitai_model` (#19)
- **Workspace & environment** — `get_workspace`, `set_default_workspace`,
  `list_workspaces`, `get_environment` (#20)
- **API / partner nodes** — `list_api_nodes`, `get_api_node_schema`,
  `generate_with_api_node` (#21)
- **ComfyUI-Manager configuration** — `configure_manager` (#22)

### Changed

- Rewrote tool descriptions and parameter docs across the core tool set for
  clearer purpose, usage guidance, and behavioral transparency — improving agent
  tool-selection quality (#23).
- Added a `Dockerfile`, `.dockerignore`, `glama.json`, and Glama quality badges
  for the [glama.ai](https://glama.ai) listing.

### Security

- CivitAI authentication is now sent as an `Authorization: Bearer` header instead
  of a `?token=` query parameter, so the API token no longer leaks into logs,
  errors, or redirect URLs. Model-download filenames are validated to stay within
  the models directory (closes a path-traversal hole shared with `download_model`) (#19).
- `COMFY_API_KEY` is delivered to API nodes via the `/prompt` `extra_data` payload
  rather than being placed in the workflow (#21).

### Notes

- Local-management tools (install/update ComfyUI, custom-node installs, model
  removal) require a local install (`COMFYUI_PATH`) and return a clear error when
  targeting a remote instance where the operation cannot apply.

Earlier releases predate this changelog.

[0.6.0]: https://github.com/artokun/comfyui-mcp/releases/tag/v0.6.0
