import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  generateWithControlNet,
  generateWithIpAdapter,
  type ConditionedDeps,
} from "../../services/generate-conditioned.js";
import { DefaultsManager } from "../../services/defaults-manager.js";
import type { WorkflowJSON } from "../../comfyui/types.js";

function makeDeps(overrides: Partial<ConditionedDeps> = {}) {
  const enqueued: WorkflowJSON[] = [];
  const deps: ConditionedDeps = {
    resolveCheckpoint: vi.fn(async () => "auto_model.safetensors"),
    resolveControlNetModel: vi.fn(async () => "auto_controlnet.pth"),
    enqueue: async (wf) => {
      enqueued.push(wf);
      return { prompt_id: "pid-1", queue_remaining: 0 };
    },
    ...overrides,
  };
  return { deps, enqueued };
}

function node(wf: WorkflowJSON, type: string) {
  return Object.values(wf).find((n) => n.class_type === type);
}
function checkpoint(wf: WorkflowJSON) {
  return node(wf, "CheckpointLoaderSimple")!.inputs.ckpt_name;
}

describe("generateWithControlNet", () => {
  beforeEach(() => {
    DefaultsManager.reset();
    DefaultsManager.configure({ configPath: "/tmp/__never__.json", env: {} });
  });

  it("builds a ControlNet graph wired into KSampler", async () => {
    const { deps, enqueued } = makeDeps();
    await generateWithControlNet(
      { prompt: "a knight", control_image: "pose.png", controlnet_model: "openpose.pth", checkpoint: "x.safetensors" },
      deps,
    );
    const wf = enqueued[0];
    expect(node(wf, "ControlNetLoader")!.inputs.control_net_name).toBe("openpose.pth");
    expect(node(wf, "LoadImage")!.inputs.image).toBe("pose.png");
    const apply = node(wf, "ControlNetApplyAdvanced")!;
    expect(apply.inputs.positive).toEqual(["4", 0]);
    expect(apply.inputs.negative).toEqual(["5", 0]);
    // KSampler reads conditioning from the ControlNetApplyAdvanced node (id 6)
    const ks = node(wf, "KSampler")!;
    expect(ks.inputs.positive).toEqual(["6", 0]);
    expect(ks.inputs.negative).toEqual(["6", 1]);
  });

  it("auto-resolves the controlnet model when not provided", async () => {
    const { deps, enqueued } = makeDeps();
    await generateWithControlNet({ prompt: "p", control_image: "c.png" }, deps);
    expect(deps.resolveControlNetModel).toHaveBeenCalledOnce();
    expect(node(enqueued[0], "ControlNetLoader")!.inputs.control_net_name).toBe("auto_controlnet.pth");
  });

  it("applies the strength override", async () => {
    const { deps, enqueued } = makeDeps();
    await generateWithControlNet(
      { prompt: "p", control_image: "c.png", controlnet_model: "m.pth", strength: 0.5 },
      deps,
    );
    expect(node(enqueued[0], "ControlNetApplyAdvanced")!.inputs.strength).toBe(0.5);
  });

  it("backfills checkpoint + params from defaults", async () => {
    await DefaultsManager.set({ checkpoint: "def.safetensors", steps: 28 });
    const { deps, enqueued } = makeDeps();
    await generateWithControlNet({ prompt: "p", control_image: "c.png", controlnet_model: "m.pth" }, deps);
    expect(checkpoint(enqueued[0])).toBe("def.safetensors");
    expect(node(enqueued[0], "KSampler")!.inputs.steps).toBe(28);
  });

  it("throws when no controlnet model can be resolved", async () => {
    const { deps } = makeDeps({ resolveControlNetModel: async () => undefined });
    await expect(
      generateWithControlNet({ prompt: "p", control_image: "c.png" }, deps),
    ).rejects.toThrow(/controlnet_model/i);
  });

  it("throws when control_image is missing", async () => {
    const { deps } = makeDeps();
    await expect(
      generateWithControlNet({ prompt: "p", control_image: "" }, deps),
    ).rejects.toThrow(/control_image/i);
  });
});

describe("generateWithIpAdapter", () => {
  beforeEach(() => {
    DefaultsManager.reset();
    DefaultsManager.configure({ configPath: "/tmp/__never__.json", env: {} });
  });

  it("builds an IP-Adapter graph with the reference image and weight", async () => {
    const { deps, enqueued } = makeDeps();
    await generateWithIpAdapter(
      { prompt: "in this style", reference_image: "style.png", weight: 0.6, checkpoint: "x.safetensors" },
      deps,
    );
    const wf = enqueued[0];
    expect(node(wf, "IPAdapterUnifiedLoader")).toBeDefined();
    const ip = node(wf, "IPAdapter")!;
    expect(ip.inputs.weight).toBe(0.6);
    expect(node(wf, "LoadImage")!.inputs.image).toBe("style.png");
    // KSampler model comes from the IPAdapter node (id 4)
    expect(node(wf, "KSampler")!.inputs.model).toEqual(["4", 0]);
  });

  it("uses the default preset and weight when omitted", async () => {
    const { deps, enqueued } = makeDeps();
    await generateWithIpAdapter({ prompt: "p", reference_image: "r.png", checkpoint: "x.safetensors" }, deps);
    const wf = enqueued[0];
    expect(node(wf, "IPAdapterUnifiedLoader")!.inputs.preset).toBe("PLUS (high strength)");
    expect(node(wf, "IPAdapter")!.inputs.weight).toBe(0.8);
  });

  it("auto-resolves the checkpoint when absent", async () => {
    const { deps, enqueued } = makeDeps();
    await generateWithIpAdapter({ prompt: "p", reference_image: "r.png" }, deps);
    expect(deps.resolveCheckpoint).toHaveBeenCalledOnce();
    expect(checkpoint(enqueued[0])).toBe("auto_model.safetensors");
  });

  it("throws when reference_image is missing", async () => {
    const { deps } = makeDeps();
    await expect(
      generateWithIpAdapter({ prompt: "p", reference_image: "" }, deps),
    ).rejects.toThrow(/reference_image/i);
  });
});
