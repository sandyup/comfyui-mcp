import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";

vi.mock("../../config.js", () => ({
  config: { comfyuiPath: "/fake/comfy" },
}));

import {
  scaffoldCustomNode,
  buildPublishWorkflowYml,
  buildComfyignore,
  buildGitignore,
  type AuthoringDeps,
} from "../../services/node-authoring.js";

function captureDeps(): { deps: AuthoringDeps; files: string[] } {
  const files: string[] = [];
  const deps: AuthoringDeps = {
    existsSync: () => false,
    mkdirp: () => {},
    writeFile: (p: string) => {
      files.push(p);
    },
    readFile: () => "",
    isNonEmptyDir: () => false,
    hasCommand: () => true,
    run: () => "",
  };
  return { deps, files };
}

describe("scaffold CI + ignore files (C5)", () => {
  it("always writes .comfyignore and .gitignore, and not the CI workflow by default", () => {
    const { deps, files } = captureDeps();
    const res = scaffoldCustomNode({ name: "my-pack", displayName: "My Pack" }, deps);
    expect(res.files).toContain(".comfyignore");
    expect(res.files).toContain(".gitignore");
    expect(res.files).not.toContain(join(".github", "workflows", "publish_action.yml"));
  });

  it("emits the publish workflow when withCi is true", () => {
    const { deps } = captureDeps();
    const res = scaffoldCustomNode(
      { name: "my-pack", displayName: "My Pack", withCi: true },
      deps,
    );
    expect(res.files).toContain(join(".github", "workflows", "publish_action.yml"));
  });

  it("publish workflow references the action + the token secret", () => {
    const yml = buildPublishWorkflowYml();
    expect(yml).toMatch(/Comfy-Org\/publish-node-action@main/);
    expect(yml).toMatch(/secrets\.REGISTRY_ACCESS_TOKEN/);
    expect(yml).toMatch(/paths:\s*\n\s*- "pyproject\.toml"/);
  });

  it("ignore files exclude common dev cruft", () => {
    expect(buildComfyignore()).toMatch(/__pycache__/);
    expect(buildComfyignore()).toMatch(/\.github\//);
    expect(buildGitignore()).toMatch(/__pycache__/);
  });
});
