import { describe, expect, it, beforeEach, vi } from "vitest";
import { generateImage, type GenerateImageDeps } from "../../services/generate-image.js";
import { DefaultsManager } from "../../services/defaults-manager.js";
import type { WorkflowJSON } from "../../comfyui/types.js";

function makeDeps(overrides: Partial<GenerateImageDeps> = {}): {
  deps: GenerateImageDeps;
  enqueued: WorkflowJSON[];
  resolveCheckpoint: ReturnType<typeof vi.fn>;
} {
  const enqueued: WorkflowJSON[] = [];
  const resolveCheckpoint = vi.fn(async () => "auto_model.safetensors");
  const deps: GenerateImageDeps = {
    resolveCheckpoint,
    enqueue: async (wf) => {
      enqueued.push(wf);
      return { prompt_id: "pid-1", queue_remaining: 0 };
    },
    ...overrides,
  };
  return { deps, enqueued, resolveCheckpoint };
}

// Helpers to read back the constructed txt2img graph.
function ksampler(wf: WorkflowJSON) {
  return Object.values(wf).find((n) => n.class_type === "KSampler")!.inputs;
}
function positiveText(wf: WorkflowJSON) {
  const node = Object.values(wf).find(
    (n) => n.class_type === "CLIPTextEncode" && n._meta?.title === "Positive Prompt",
  );
  return node?.inputs.text;
}
function negativeText(wf: WorkflowJSON) {
  const node = Object.values(wf).find(
    (n) => n.class_type === "CLIPTextEncode" && n._meta?.title === "Negative Prompt",
  );
  return node?.inputs.text;
}
function checkpoint(wf: WorkflowJSON) {
  return Object.values(wf).find((n) => n.class_type === "CheckpointLoaderSimple")!.inputs.ckpt_name;
}
function latent(wf: WorkflowJSON) {
  return Object.values(wf).find((n) => n.class_type === "EmptyLatentImage")!.inputs;
}

describe("generateImage", () => {
  beforeEach(() => {
    DefaultsManager.reset();
    DefaultsManager.configure({ configPath: "/tmp/__never__.json", env: {} });
  });

  it("enqueues a txt2img workflow with the prompt mapped to the positive node", async () => {
    const { deps, enqueued } = makeDeps();
    const res = await generateImage({ prompt: "a red fox", checkpoint: "x.safetensors" }, deps);
    expect(res.prompt_id).toBe("pid-1");
    expect(enqueued).toHaveLength(1);
    expect(positiveText(enqueued[0])).toBe("a red fox");
  });

  it("backfills unspecified params from DefaultsManager", async () => {
    await DefaultsManager.set({ width: 768, height: 512, steps: 35, cfg: 6.5, sampler: "dpmpp_2m" });
    const { deps, enqueued } = makeDeps();
    await generateImage({ prompt: "p", checkpoint: "x.safetensors" }, deps);
    const wf = enqueued[0];
    expect(latent(wf).width).toBe(768);
    expect(latent(wf).height).toBe(512);
    expect(ksampler(wf).steps).toBe(35);
    expect(ksampler(wf).cfg).toBe(6.5);
    expect(ksampler(wf).sampler_name).toBe("dpmpp_2m");
  });

  it("per-call args override defaults", async () => {
    await DefaultsManager.set({ width: 1024, steps: 20 });
    const { deps, enqueued } = makeDeps();
    await generateImage({ prompt: "p", width: 512, steps: 50, checkpoint: "x.safetensors" }, deps);
    expect(latent(enqueued[0]).width).toBe(512);
    expect(ksampler(enqueued[0]).steps).toBe(50);
  });

  it("uses an explicit checkpoint without calling the resolver", async () => {
    const { deps, enqueued, resolveCheckpoint } = makeDeps();
    await generateImage({ prompt: "p", checkpoint: "explicit.safetensors" }, deps);
    expect(resolveCheckpoint).not.toHaveBeenCalled();
    expect(checkpoint(enqueued[0])).toBe("explicit.safetensors");
  });

  it("uses a checkpoint from defaults when none is passed", async () => {
    await DefaultsManager.set({ checkpoint: "from_defaults.safetensors" });
    const { deps, enqueued, resolveCheckpoint } = makeDeps();
    await generateImage({ prompt: "p" }, deps);
    expect(resolveCheckpoint).not.toHaveBeenCalled();
    expect(checkpoint(enqueued[0])).toBe("from_defaults.safetensors");
  });

  it("auto-resolves a checkpoint when absent from args and defaults", async () => {
    const { deps, enqueued, resolveCheckpoint } = makeDeps();
    await generateImage({ prompt: "p" }, deps);
    expect(resolveCheckpoint).toHaveBeenCalledOnce();
    expect(checkpoint(enqueued[0])).toBe("auto_model.safetensors");
  });

  it("throws a clear error when no checkpoint can be resolved", async () => {
    const { deps } = makeDeps({ resolveCheckpoint: async () => undefined });
    await expect(generateImage({ prompt: "p" }, deps)).rejects.toThrow(/No checkpoint/i);
  });

  it("maps negative_prompt and sampler/scheduler/seed correctly", async () => {
    const { deps, enqueued } = makeDeps();
    await generateImage(
      {
        prompt: "p",
        negative_prompt: "blurry",
        sampler: "euler_a",
        scheduler: "karras",
        seed: 12345,
        checkpoint: "x.safetensors",
      },
      deps,
    );
    const wf = enqueued[0];
    expect(negativeText(wf)).toBe("blurry");
    expect(ksampler(wf).sampler_name).toBe("euler_a");
    expect(ksampler(wf).scheduler).toBe("karras");
    expect(ksampler(wf).seed).toBe(12345);
  });

  it("applies batch_size to the latent node", async () => {
    const { deps, enqueued } = makeDeps();
    await generateImage({ prompt: "p", batch_size: 4, checkpoint: "x.safetensors" }, deps);
    expect(latent(enqueued[0]).batch_size).toBe(4);
  });

  it("defaults batch_size to 1 when not provided", async () => {
    const { deps, enqueued } = makeDeps();
    await generateImage({ prompt: "p", checkpoint: "x.safetensors" }, deps);
    expect(latent(enqueued[0]).batch_size).toBe(1);
  });
});
