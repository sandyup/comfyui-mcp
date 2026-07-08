import { describe, expect, it, vi } from "vitest";
import {
  listApiNodes,
  getApiNodeSchema,
  generateWithApiNode,
  isApiNode,
  type ApiNodesDeps,
} from "../../services/api-nodes.js";
import type { ObjectInfo, WorkflowJSON, ComfyUINodeDef } from "../../comfyui/types.js";

/** Minimal helper to build a node def with sensible defaults. */
function nodeDef(partial: Partial<ComfyUINodeDef>): ComfyUINodeDef {
  return {
    input: {},
    output: [],
    output_is_list: [],
    output_name: [],
    name: "",
    display_name: "",
    description: "",
    category: "",
    output_node: false,
    ...partial,
  };
}

function sampleObjectInfo(): ObjectInfo {
  return {
    // API node flagged via api_node:true AND "api node/" category.
    FluxProImageNode: nodeDef({
      api_node: true,
      category: "api node/image/BFL",
      display_name: "Flux Pro Image",
      description: "Generate an image with BFL Flux Pro.",
      output: ["IMAGE"],
      output_name: ["image"],
      input: {
        required: {
          prompt: ["STRING", { multiline: true }],
          aspect_ratio: [["1:1", "16:9"], { default: "1:1" }],
          seed: ["INT", { default: 0, min: 0, max: 4294967295 }],
        },
        optional: {
          steps: ["INT", { default: 25 }],
        },
        hidden: {
          auth_token_comfy_org: ["AUTH_TOKEN_COMFY_ORG"],
          api_key_comfy_org: ["API_KEY_COMFY_ORG"],
        },
      },
    }),
    // API node detected ONLY via category prefix (older builds without api_node flag).
    KlingVideoNode: nodeDef({
      category: "api node/video/Kling",
      display_name: "Kling Video",
      output: ["VIDEO"],
      input: { required: { prompt: ["STRING", {}] } },
    }),
    // Regular local node — must be excluded.
    KSampler: nodeDef({
      category: "sampling",
      display_name: "KSampler",
      output: ["LATENT"],
    }),
    // Edge case: category mentions "api" but is not the api-node prefix.
    SomeOtherNode: nodeDef({
      category: "utils/api helpers",
      display_name: "API Helpers",
    }),
  };
}

function makeDeps(
  overrides: Partial<ApiNodesDeps> = {},
): { deps: ApiNodesDeps; enqueued: Array<{ wf: WorkflowJSON; opts?: unknown }> } {
  const enqueued: Array<{ wf: WorkflowJSON; opts?: unknown }> = [];
  const deps: ApiNodesDeps = {
    getObjectInfo: async () => sampleObjectInfo(),
    enqueue: async (wf, opts) => {
      enqueued.push({ wf, opts });
      return { prompt_id: "pid-123", queue_remaining: 2 };
    },
    ...overrides,
  };
  return { deps, enqueued };
}

describe("isApiNode", () => {
  it("matches api_node:true flag", () => {
    expect(isApiNode(nodeDef({ api_node: true, category: "whatever" }))).toBe(true);
  });
  it("matches 'api node/' category prefix (case-insensitive)", () => {
    expect(isApiNode(nodeDef({ category: "API node/Image/BFL" }))).toBe(true);
    expect(isApiNode(nodeDef({ category: "api node" }))).toBe(true);
  });
  it("does not match unrelated categories that merely contain 'api'", () => {
    expect(isApiNode(nodeDef({ category: "utils/api helpers" }))).toBe(false);
    expect(isApiNode(nodeDef({ category: "sampling" }))).toBe(false);
  });
});

describe("listApiNodes", () => {
  it("returns only API nodes, sorted by class_type", async () => {
    const { deps } = makeDeps();
    const nodes = await listApiNodes(undefined, deps);
    expect(nodes.map((n) => n.class_type)).toEqual(["FluxProImageNode", "KlingVideoNode"]);
    expect(nodes.find((n) => n.class_type === "KSampler")).toBeUndefined();
    expect(nodes.find((n) => n.class_type === "SomeOtherNode")).toBeUndefined();
  });

  it("includes summary metadata", async () => {
    const { deps } = makeDeps();
    const nodes = await listApiNodes(undefined, deps);
    const flux = nodes.find((n) => n.class_type === "FluxProImageNode")!;
    expect(flux.display_name).toBe("Flux Pro Image");
    expect(flux.category).toBe("api node/image/BFL");
    expect(flux.output).toEqual(["IMAGE"]);
  });

  it("filters case-insensitively across class_type/display/category", async () => {
    const { deps } = makeDeps();
    expect((await listApiNodes("video", deps)).map((n) => n.class_type)).toEqual([
      "KlingVideoNode",
    ]);
    expect((await listApiNodes("BFL", deps)).map((n) => n.class_type)).toEqual([
      "FluxProImageNode",
    ]);
    expect((await listApiNodes("kling", deps)).map((n) => n.class_type)).toEqual([
      "KlingVideoNode",
    ]);
  });

  it("returns an empty list when no API nodes are present", async () => {
    const { deps } = makeDeps({
      getObjectInfo: async () => ({ KSampler: nodeDef({ category: "sampling" }) }),
    });
    expect(await listApiNodes(undefined, deps)).toEqual([]);
  });
});

describe("getApiNodeSchema", () => {
  it("extracts required + optional inputs with types and config", async () => {
    const { deps } = makeDeps();
    const schema = await getApiNodeSchema("FluxProImageNode", deps);

    expect(schema.is_api_node).toBe(true);
    expect(schema.output).toEqual(["IMAGE"]);

    const byName = Object.fromEntries(schema.inputs.map((i) => [i.name, i]));
    expect(byName.prompt.required).toBe(true);
    expect(byName.prompt.type).toBe("STRING");
    expect(byName.aspect_ratio.type).toEqual(["1:1", "16:9"]);
    expect(byName.aspect_ratio.config).toEqual({ default: "1:1" });
    expect(byName.steps.required).toBe(false);
    expect(byName.seed.config).toMatchObject({ min: 0, max: 4294967295 });
  });

  it("exposes hidden auth inputs separately from visible inputs", async () => {
    const { deps } = makeDeps();
    const schema = await getApiNodeSchema("FluxProImageNode", deps);
    expect(schema.hidden_inputs).toEqual(["auth_token_comfy_org", "api_key_comfy_org"]);
    expect(schema.inputs.map((i) => i.name)).not.toContain("auth_token_comfy_org");
  });

  it("throws a clear error for unknown nodes", async () => {
    const { deps } = makeDeps();
    await expect(getApiNodeSchema("DoesNotExist", deps)).rejects.toThrow(/was not found/i);
  });

  it("throws when the node exists but is not an API node", async () => {
    const { deps } = makeDeps();
    await expect(getApiNodeSchema("KSampler", deps)).rejects.toThrow(/not an API\/partner node/i);
  });
});

describe("generateWithApiNode", () => {
  it("builds a minimal single-node workflow and enqueues it", async () => {
    const { deps, enqueued } = makeDeps();
    const result = await generateWithApiNode(
      { class_type: "FluxProImageNode", inputs: { prompt: "a cat", aspect_ratio: "16:9" } },
      deps,
    );

    expect(result.prompt_id).toBe("pid-123");
    expect(result.queue_remaining).toBe(2);
    expect(enqueued).toHaveLength(1);

    const wf = enqueued[0].wf;
    expect(Object.keys(wf)).toEqual(["1"]);
    expect(wf["1"].class_type).toBe("FluxProImageNode");
    expect(wf["1"].inputs).toEqual({ prompt: "a cat", aspect_ratio: "16:9" });
    expect(wf["1"]._meta?.title).toBe("Flux Pro Image");
  });

  it("strips hidden auth inputs the caller mistakenly supplied", async () => {
    const { deps, enqueued } = makeDeps();
    const result = await generateWithApiNode(
      {
        class_type: "FluxProImageNode",
        inputs: { prompt: "x", aspect_ratio: "1:1", seed: 1, auth_token_comfy_org: "leaked" },
      },
      deps,
    );
    expect(enqueued[0].wf["1"].inputs).not.toHaveProperty("auth_token_comfy_org");
    expect(result.notes.some((n) => /hidden input/i.test(n))).toBe(true);
  });

  it("notes missing required inputs but still enqueues", async () => {
    const { deps, enqueued } = makeDeps();
    const result = await generateWithApiNode(
      { class_type: "FluxProImageNode", inputs: { prompt: "x" } },
      deps,
    );
    expect(enqueued).toHaveLength(1);
    expect(result.notes.some((n) => /Missing required input/i.test(n))).toBe(true);
    expect(result.notes.some((n) => /aspect_ratio/.test(n))).toBe(true);
  });

  it("notes unknown inputs but passes them through", async () => {
    const { deps, enqueued } = makeDeps();
    const result = await generateWithApiNode(
      { class_type: "FluxProImageNode", inputs: { prompt: "x", aspect_ratio: "1:1", seed: 0, bogus: 1 } },
      deps,
    );
    expect(enqueued[0].wf["1"].inputs).toHaveProperty("bogus", 1);
    expect(result.notes.some((n) => /Unknown input "bogus"/.test(n))).toBe(true);
  });

  it("always includes an auth-reminder note", async () => {
    const { deps } = makeDeps();
    const result = await generateWithApiNode(
      { class_type: "FluxProImageNode", inputs: { prompt: "x", aspect_ratio: "1:1", seed: 0 } },
      deps,
    );
    expect(result.notes.some((n) => /API key/i.test(n))).toBe(true);
  });

  it("forwards disable_random_seed to enqueue", async () => {
    const enqueue = vi.fn(async () => ({ prompt_id: "p", queue_remaining: 0 }));
    const { deps } = makeDeps({ enqueue });
    await generateWithApiNode(
      { class_type: "KlingVideoNode", inputs: { prompt: "x" }, disable_random_seed: true },
      deps,
    );
    expect(enqueue).toHaveBeenCalledWith(expect.any(Object), { disable_random_seed: true });
  });

  it("rejects when the target node is not an API node", async () => {
    const { deps, enqueued } = makeDeps();
    await expect(
      generateWithApiNode({ class_type: "KSampler", inputs: {} }, deps),
    ).rejects.toThrow(/not an API\/partner node/i);
    expect(enqueued).toHaveLength(0);
  });
});
