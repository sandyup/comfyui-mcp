import { describe, expect, it, vi } from "vitest";
import {
  collectClassTypes,
  extractWorkflowDependencies,
  installWorkflowDependencies,
  type WorkflowDepsDeps,
  type ManagerNodePack,
} from "../../services/workflow-deps.js";
import type { WorkflowJSON, ObjectInfo, ComfyUINodeDef } from "../../comfyui/types.js";

/** Build a minimal ObjectInfo node def with a given python_module. */
function def(name: string, pythonModule: string): ComfyUINodeDef {
  return {
    input: {},
    output: [],
    output_is_list: [],
    output_name: [],
    name,
    display_name: name,
    description: "",
    category: "",
    output_node: false,
    python_module: pythonModule,
  };
}

/**
 * Sample workflow: two core nodes (KSampler, CLIPTextEncode), one installed
 * custom node (ImpactSomething), and one missing custom node (RemoteOnlyNode).
 */
const sampleWorkflow: WorkflowJSON = {
  "1": { class_type: "KSampler", inputs: {} },
  "2": { class_type: "CLIPTextEncode", inputs: {} },
  "3": { class_type: "ImpactSomething", inputs: {} },
  "4": { class_type: "RemoteOnlyNode", inputs: {} },
  // duplicate class_type to verify dedupe
  "5": { class_type: "KSampler", inputs: {} },
};

function makeDeps(overrides: Partial<WorkflowDepsDeps> = {}): WorkflowDepsDeps {
  const objectInfo: ObjectInfo = {
    KSampler: def("KSampler", "nodes"),
    CLIPTextEncode: def("CLIPTextEncode", "nodes"),
    // installed custom node, lives under custom_nodes/comfyui-impact-pack
    ImpactSomething: def("ImpactSomething", "custom_nodes.comfyui-impact-pack.impact"),
    // RemoteOnlyNode intentionally absent -> not installed
  };

  const mappings = {
    "https://github.com/ltdrdata/ComfyUI-Impact-Pack": [
      ["ImpactSomething", "ImpactOther"],
      { title: "ComfyUI-Impact-Pack" },
    ],
    "https://github.com/someone/remote-only": [
      ["RemoteOnlyNode"],
      { title: "Remote-Only-Pack" },
    ],
  };

  const list: ManagerNodePack[] = [
    {
      id: "Remote-Only-Pack",
      title: "Remote-Only-Pack",
      reference: "https://github.com/someone/remote-only",
      files: ["https://github.com/someone/remote-only"],
      install_type: "git-clone",
      state: "not-installed",
    },
  ];

  return {
    fetchObjectInfo: vi.fn(async () => objectInfo),
    fetchManagerMappings: vi.fn(async () => mappings as never),
    fetchManagerList: vi.fn(async () => list),
    queueInstall: vi.fn(async () => undefined),
    startQueue: vi.fn(async () => undefined),
    queueStatus: vi.fn(async () => ({
      total_count: 1,
      done_count: 0,
      in_progress_count: 1,
      is_processing: true,
    })),
    comfyuiPath: "/home/user/ComfyUI",
    ...overrides,
  };
}

describe("collectClassTypes", () => {
  it("returns distinct, sorted class_types", () => {
    expect(collectClassTypes(sampleWorkflow)).toEqual([
      "CLIPTextEncode",
      "ImpactSomething",
      "KSampler",
      "RemoteOnlyNode",
    ]);
  });

  it("ignores malformed nodes without class_type", () => {
    const wf = {
      "1": { class_type: "KSampler", inputs: {} },
      "2": { inputs: {} } as never,
    } as WorkflowJSON;
    expect(collectClassTypes(wf)).toEqual(["KSampler"]);
  });
});

describe("extractWorkflowDependencies", () => {
  it("classifies built-in, installed-custom, and missing nodes", async () => {
    const deps = makeDeps();
    const result = await extractWorkflowDependencies(sampleWorkflow, deps);

    const byType = Object.fromEntries(
      result.dependencies.map((d) => [d.class_type, d]),
    );

    // core nodes -> builtin, no pack
    expect(byType.KSampler).toMatchObject({ builtin: true, pack: null, installed: true });
    expect(byType.CLIPTextEncode).toMatchObject({ builtin: true, installed: true });

    // installed custom node -> resolved to Manager title, installed=true
    expect(byType.ImpactSomething).toMatchObject({
      builtin: false,
      installed: true,
      pack: "ComfyUI-Impact-Pack",
    });

    // missing custom node -> resolved via mappings, installed=false
    expect(byType.RemoteOnlyNode).toMatchObject({
      builtin: false,
      installed: false,
      pack: "Remote-Only-Pack",
      source: "manager_mappings",
    });

    expect(result.requiredPacks).toEqual(["ComfyUI-Impact-Pack", "Remote-Only-Pack"]);
    expect(result.missingPacks).toEqual(["Remote-Only-Pack"]);
    expect(result.unresolved).toEqual([]);
  });

  it("falls back to python_module when Manager mappings are unavailable", async () => {
    const deps = makeDeps({
      fetchManagerMappings: vi.fn(async () => {
        throw new Error("manager down");
      }),
    });
    const result = await extractWorkflowDependencies(sampleWorkflow, deps);
    const byType = Object.fromEntries(result.dependencies.map((d) => [d.class_type, d]));

    // installed custom node resolves via python_module directory name
    expect(byType.ImpactSomething).toMatchObject({
      pack: "comfyui-impact-pack",
      source: "object_info",
      installed: true,
    });
    // missing node cannot be resolved without mappings
    expect(byType.RemoteOnlyNode).toMatchObject({
      pack: null,
      installed: false,
      source: "unresolved",
    });
    expect(result.unresolved).toEqual(["RemoteOnlyNode"]);
  });

  it("reports all-builtin workflows as needing no packs", async () => {
    const wf: WorkflowJSON = {
      "1": { class_type: "KSampler", inputs: {} },
      "2": { class_type: "CLIPTextEncode", inputs: {} },
    };
    const result = await extractWorkflowDependencies(wf, makeDeps());
    expect(result.requiredPacks).toEqual([]);
    expect(result.missingPacks).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });

  it("matches class_types via nodename_pattern regex", async () => {
    const deps = makeDeps({
      fetchManagerMappings: vi.fn(
        async () =>
          ({
            "https://github.com/x/pattern-pack": [
              [],
              { title: "Pattern-Pack", nodename_pattern: "^Was.*" },
            ],
          }) as never,
      ),
      fetchObjectInfo: vi.fn(async () => ({}) as ObjectInfo),
    });
    const wf: WorkflowJSON = { "1": { class_type: "WasImageThing", inputs: {} } };
    const result = await extractWorkflowDependencies(wf, deps);
    expect(result.dependencies[0]).toMatchObject({
      pack: "Pattern-Pack",
      installed: false,
      source: "manager_mappings",
    });
  });
});

describe("installWorkflowDependencies", () => {
  it("rejects installs in remote mode (no local path)", async () => {
    const deps = makeDeps({ comfyuiPath: undefined });
    await expect(installWorkflowDependencies(sampleWorkflow, deps)).rejects.toThrow(
      /no local ComfyUI path/i,
    );
  });

  it("queues missing packs and starts the Manager queue", async () => {
    const deps = makeDeps();
    const result = await installWorkflowDependencies(sampleWorkflow, deps);

    expect(deps.queueInstall).toHaveBeenCalledTimes(1);
    expect(deps.queueInstall).toHaveBeenCalledWith(
      expect.objectContaining({ id: "Remote-Only-Pack" }),
    );
    expect(deps.startQueue).toHaveBeenCalledTimes(1);

    expect(result.installed).toEqual(["Remote-Only-Pack"]);
    expect(result.alreadyInstalled).toEqual(["ComfyUI-Impact-Pack"]);
    expect(result.queue).toMatchObject({ is_processing: true });
  });

  it("does nothing when no packs are missing", async () => {
    // Only built-ins + an installed custom node.
    const wf: WorkflowJSON = {
      "1": { class_type: "KSampler", inputs: {} },
      "2": { class_type: "ImpactSomething", inputs: {} },
    };
    const deps = makeDeps();
    const result = await installWorkflowDependencies(wf, deps);

    expect(deps.queueInstall).not.toHaveBeenCalled();
    expect(deps.startQueue).not.toHaveBeenCalled();
    expect(result.installed).toEqual([]);
    expect(result.alreadyInstalled).toEqual(["ComfyUI-Impact-Pack"]);
  });

  it("reports packs missing from the Manager list as unresolved (not already-installed)", async () => {
    const deps = makeDeps({ fetchManagerList: vi.fn(async () => []) });
    const result = await installWorkflowDependencies(sampleWorkflow, deps);
    expect(result.installed).toEqual([]);
    expect(result.unresolved).toContain("Remote-Only-Pack");
    // A missing pack that could not be resolved must NOT leak into alreadyInstalled.
    expect(result.alreadyInstalled).not.toContain("Remote-Only-Pack");
    expect(result.alreadyInstalled).toEqual(["ComfyUI-Impact-Pack"]);
    expect(deps.queueInstall).not.toHaveBeenCalled();
  });
});
