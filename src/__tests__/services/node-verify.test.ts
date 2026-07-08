import { describe, expect, it, beforeEach, vi } from "vitest";

// Flip comfyuiPath per-test and stub the base-URL helpers so the default fetch
// path is never used (we inject VerifyDeps in every test).
vi.mock("../../config.js", () => {
  const config: { comfyuiPath: string | undefined } = { comfyuiPath: "/fake/comfy" };
  return {
    config,
    getComfyUIApiHost: () => "127.0.0.1:8188",
    getComfyUIProtocol: () => "http",
  };
});

// node-verify imports restartComfyUI at module load; stub it (tests inject deps).
vi.mock("../../services/process-control.js", () => ({
  restartComfyUI: vi.fn(async () => ({ message: "restarted", readiness: { ready: true } })),
}));

import { config } from "../../config.js";
import {
  verifyCustomNode,
  parseClassMappingKeys,
  type VerifyDeps,
} from "../../services/node-verify.js";
import { ProcessControlError, ValidationError } from "../../utils/errors.js";

function makeDeps(over: Partial<VerifyDeps> = {}): VerifyDeps {
  return {
    restart: vi.fn(async () => ({ ready: true, message: "restarted" })),
    fetchObjectInfoKeys: vi.fn(async () => ["FooNode", "BarNode", "KSampler"]),
    readPackInit: vi.fn(() => undefined),
    ...over,
  };
}

describe("parseClassMappingKeys", () => {
  it("extracts quoted keys from a NODE_CLASS_MAPPINGS literal", () => {
    const init = `
from .src.nodes import A, B
NODE_CLASS_MAPPINGS = {
    "FooNode": A,
    'BarNode': B,
}
NODE_DISPLAY_NAME_MAPPINGS = { "FooNode": "Foo" }
`;
    expect(parseClassMappingKeys(init)).toEqual(["FooNode", "BarNode"]);
  });

  it("returns [] when there is no mappings literal", () => {
    expect(parseClassMappingKeys("x = 1")).toEqual([]);
  });

  it("ignores braces inside values and inline nested-dict keys (no truncation)", () => {
    const init = `
NODE_CLASS_MAPPINGS = {
    "FooNode": make({"x": 1}),
    "BarNode": Bar,
}
`;
    expect(parseClassMappingKeys(init)).toEqual(["FooNode", "BarNode"]);
  });
});

describe("verifyCustomNode", () => {
  beforeEach(() => {
    config.comfyuiPath = "/fake/comfy";
  });

  it("reports all node types loaded when present in /object_info", async () => {
    const deps = makeDeps();
    const res = await verifyCustomNode({ classTypes: ["FooNode", "BarNode"] }, deps);
    expect(res.ready).toBe(true);
    expect(res.restarted).toBe(true);
    expect(res.loaded).toEqual(["FooNode", "BarNode"]);
    expect(res.missing).toEqual([]);
    expect(deps.restart).toHaveBeenCalledTimes(1);
  });

  it("reports missing node types (failed import)", async () => {
    const deps = makeDeps();
    const res = await verifyCustomNode({ classTypes: ["FooNode", "GoneNode"] }, deps);
    expect(res.loaded).toEqual(["FooNode"]);
    expect(res.missing).toEqual(["GoneNode"]);
    expect(res.message).toMatch(/NOT registered/);
  });

  it("does not restart when restart:false", async () => {
    const deps = makeDeps();
    const res = await verifyCustomNode({ classTypes: ["FooNode"], restart: false }, deps);
    expect(deps.restart).not.toHaveBeenCalled();
    expect(res.restarted).toBe(false);
    expect(res.loaded).toEqual(["FooNode"]);
  });

  it("returns ready:false (no object_info check) when restart never becomes ready", async () => {
    const deps = makeDeps({
      restart: vi.fn(async () => ({ ready: false, message: "startup timed out" })),
    });
    const res = await verifyCustomNode({ classTypes: ["FooNode"] }, deps);
    expect(res.ready).toBe(false);
    expect(res.missing).toEqual(["FooNode"]);
    expect(deps.fetchObjectInfoKeys).not.toHaveBeenCalled();
  });

  it("infers class_types from the pack __init__.py when not given", async () => {
    const deps = makeDeps({
      readPackInit: vi.fn(() => `NODE_CLASS_MAPPINGS = { "BarNode": X }`),
    });
    const res = await verifyCustomNode({ name: "my-pack" }, deps);
    expect(deps.readPackInit).toHaveBeenCalledWith("my-pack");
    expect(res.expected).toEqual(["BarNode"]);
    expect(res.loaded).toEqual(["BarNode"]);
  });

  it("throws ValidationError when neither class_types nor a readable name is given", async () => {
    const deps = makeDeps();
    await expect(verifyCustomNode({}, deps)).rejects.toThrow(ValidationError);
  });

  it("throws ProcessControlError in remote mode (no comfyuiPath)", async () => {
    config.comfyuiPath = undefined;
    await expect(
      verifyCustomNode({ classTypes: ["FooNode"] }, makeDeps()),
    ).rejects.toThrow(ProcessControlError);
  });
});
