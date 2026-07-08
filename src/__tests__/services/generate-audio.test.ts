import { describe, expect, it, beforeEach, vi } from "vitest";
import { generateAudio, type GenerateAudioDeps } from "../../services/generate-audio.js";
import { DefaultsManager } from "../../services/defaults-manager.js";
import type { WorkflowJSON } from "../../comfyui/types.js";

// Models the dependency injection generateAudio expects: a per-type model
// resolver and an enqueue sink that records the constructed graph.
function makeDeps(
  models: Record<string, string | undefined> = {
    diffusion_models: "ace.safetensors",
    vae: "ace_vae.safetensors",
    text_encoders: "qwen.safetensors",
    checkpoints: "stable_audio.safetensors",
  },
): {
  deps: GenerateAudioDeps;
  enqueued: WorkflowJSON[];
  resolveFirstModel: ReturnType<typeof vi.fn>;
} {
  const enqueued: WorkflowJSON[] = [];
  const resolveFirstModel = vi.fn(async (type: string) => models[type]);
  const deps: GenerateAudioDeps = {
    resolveFirstModel,
    enqueue: async (wf) => {
      enqueued.push(wf);
      return { prompt_id: "pid-audio", queue_remaining: 0 };
    },
  };
  return { deps, enqueued, resolveFirstModel };
}

function byClass(wf: WorkflowJSON, classType: string) {
  return Object.values(wf).find((n) => n.class_type === classType);
}

describe("generateAudio", () => {
  beforeEach(() => {
    DefaultsManager.reset();
    DefaultsManager.configure({ configPath: "/tmp/__never__.json", env: {} });
  });

  describe("ACE Step 1.5", () => {
    it("builds an ACE audio graph with the prompt and duration wired in", async () => {
      const { deps, enqueued } = makeDeps();
      const res = await generateAudio(
        {
          model_family: "ace_step_1.5",
          prompt: "lofi piano loop",
          duration: 30,
          unet: "ace.safetensors",
        },
        deps,
      );

      expect(res.prompt_id).toBe("pid-audio");
      expect(res.model_family).toBe("ace_step_1.5");
      expect(enqueued).toHaveLength(1);

      const wf = enqueued[0];
      expect(byClass(wf, "TextEncodeAceStepAudio1.5")?.inputs.text).toBe("lofi piano loop");
      expect(byClass(wf, "EmptyAceStep1.5LatentAudio")?.inputs.seconds).toBe(30);
      // The decode/save tail must exist so the run produces a file.
      expect(byClass(wf, "VAEDecodeAudio")).toBeDefined();
      expect(byClass(wf, "SaveAudioMP3")).toBeDefined();
    });

    it("auto-resolves UNet/VAE/CLIP from local models when not specified", async () => {
      const { deps, resolveFirstModel } = makeDeps();
      await generateAudio({ model_family: "ace_step_1.5", prompt: "p", duration: 10 }, deps);
      expect(resolveFirstModel).toHaveBeenCalledWith("diffusion_models");
      expect(resolveFirstModel).toHaveBeenCalledWith("vae");
      expect(resolveFirstModel).toHaveBeenCalledWith("text_encoders");
    });

    it("throws a helpful error when no UNet is available", async () => {
      const { deps } = makeDeps({ diffusion_models: undefined });
      await expect(
        generateAudio({ model_family: "ace_step_1.5", prompt: "p", duration: 10 }, deps),
      ).rejects.toThrow(/no unet/i);
    });
  });

  describe("Stable Audio 3", () => {
    it("builds a Stable Audio 3 graph with the prompt and duration wired in", async () => {
      const { deps, enqueued } = makeDeps();
      const res = await generateAudio(
        {
          model_family: "stable_audio_3",
          prompt: "rain on a tin roof",
          duration: 45,
          checkpoint: "stable_audio.safetensors",
        },
        deps,
      );

      expect(res.model_family).toBe("stable_audio_3");
      const wf = enqueued[0];
      expect(byClass(wf, "CheckpointLoaderSimple")?.inputs.ckpt_name).toBe(
        "stable_audio.safetensors",
      );
      const positive = Object.values(wf).find(
        (n) => n.class_type === "CLIPTextEncode" && n._meta?.title === "Positive Prompt",
      );
      expect(positive?.inputs.text).toBe("rain on a tin roof");
      expect(byClass(wf, "EmptyLatentAudio")?.inputs.seconds).toBe(45);
    });

    it("throws a helpful error when no checkpoint is available", async () => {
      const { deps } = makeDeps({ checkpoints: undefined });
      await expect(
        generateAudio({ model_family: "stable_audio_3", prompt: "p", duration: 10 }, deps),
      ).rejects.toThrow(/no checkpoint/i);
    });
  });

  describe("validation", () => {
    it("rejects an empty prompt", async () => {
      const { deps } = makeDeps();
      await expect(
        generateAudio({ model_family: "ace_step_1.5", prompt: "", duration: 10 }, deps),
      ).rejects.toThrow(/prompt is required/i);
    });

    it("rejects a non-positive duration", async () => {
      const { deps } = makeDeps();
      await expect(
        generateAudio({ model_family: "ace_step_1.5", prompt: "p", duration: 0 }, deps),
      ).rejects.toThrow(/duration must be a positive number/i);
    });
  });

  it("backfills unspecified params from DefaultsManager", async () => {
    await DefaultsManager.set({ steps: 12, cfg: 4.5 });
    const { deps, enqueued } = makeDeps();
    await generateAudio(
      { model_family: "ace_step_1.5", prompt: "p", duration: 10, unet: "ace.safetensors" },
      deps,
    );
    const ksampler = byClass(enqueued[0], "KSampler");
    expect(ksampler?.inputs.steps).toBe(12);
    expect(ksampler?.inputs.cfg).toBe(4.5);
  });
});
