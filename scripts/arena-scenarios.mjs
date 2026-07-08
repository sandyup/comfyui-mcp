// Shared arena scenario set — task prompts + harness-side ground-truth
// verification, used by BOTH scripts/llm-arena.mjs (compact 3-tool mode) and
// scripts/llm-arena-full.mjs (full 113-tool surface for the fine-tune
// pipeline). verify(harnessCall, t) receives a direct (toolName, args) → text
// callback in either mode and NEVER trusts the model's claims.
/**
 * Each scenario: task prompt, the underlying tools that count as the "right"
 * primary move, and an optional verify(harnessCall, transcript) ground-truth
 * check the HARNESS runs against ComfyUI itself (never trusts the model).
 */
export const SCENARIOS = [
  {
    id: "health",
    title: "Server health & GPU report",
    task: "Check whether the ComfyUI server is healthy and tell me the GPU name and how much free VRAM it has.",
    primary: ["health_check", "get_system_stats"],
    verify: async (_call, t) => /(cuda|nvidia|rtx|gtx|radeon|vram)/i.test(t.finalAnswer),
  },
  {
    id: "models",
    title: "Installed checkpoint discovery",
    task: "Find out which checkpoint models are installed on the ComfyUI server and tell me the name of one of them.",
    primary: ["list_local_models"],
    verify: async (call, t) => {
      const res = await call("list_local_models", { model_type: "checkpoints" });
      const names = [...res.matchAll(/([\w.-]+)\.(safetensors|ckpt|sft|gguf)/gi)].map((m) =>
        m[1].toLowerCase(),
      );
      const answer = t.finalAnswer.toLowerCase();
      return names.some((n) => answer.includes(n) || answer.includes(n.slice(0, 12)));
    },
  },
  {
    id: "registry",
    title: "Custom-node registry search",
    task: "Find a tool that can search for ComfyUI custom node packs, then use it to search for 'controlnet' and tell me the name of one node pack from its results.",
    primary: ["search_custom_nodes", "search_models"],
    verify: async (_call, t) => t.finalAnswer.trim().length > 0,
  },
  {
    id: "queue",
    title: "Queue inspection",
    task: "How many jobs are currently running or pending in the ComfyUI queue? Answer with the numbers.",
    primary: ["get_queue", "health_check", "get_system_stats"],
    verify: async (_call, t) => /\d/.test(t.finalAnswer),
  },
  {
    id: "generate",
    title: "Text-to-image generation + async polling",
    task:
      "Generate a 512x512 image of a red apple on a wooden table. The generation runs asynchronously — " +
      "after starting it, check its job status until it has finished, then tell me the output filename or asset id.",
    primary: ["generate_image", "enqueue_workflow"],
    // right family but incomplete execution (built a workflow, never enqueued)
    partial: ["create_workflow", "dsl_to_workflow"],
    followup: ["get_job_status", "get_history", "list_output_images", "view_image", "list_assets", "get_queue", "generation_stats"],
    verify: async (call, t) => {
      // ground truth: the prompt_id the model started must be done with outputs
      const ids = [...t.toolText.matchAll(/"prompt_id":\s*"([0-9a-f-]{8,})"/g)].map((m) => m[1]);
      if (!ids.length) return false;
      for (let attempt = 0; attempt < 30; attempt++) {
        const status = await call("get_job_status", { prompt_id: ids[ids.length - 1] });
        if (/"done":\s*true/.test(status) && !/"error"/.test(status)) return true;
        if (/"error":/.test(status)) return false;
        await new Promise((r) => setTimeout(r, 2000));
      }
      return false;
    },
  },
  // ── The GAUNTLET — added when the whole SoTA tier tied 10/10 on the base
  // set. Same server-side verification discipline, but these stress parameter
  // fidelity, error recovery, and multi-render state tracking.
  {
    id: "precision",
    title: "Parameter-exact build + render",
    task:
      "Render a txt2img image with the checkpoint v1-5-pruned-emaonly-fp16.safetensors, EXACTLY 12 sampling steps, " +
      "EXACTLY 384x384 pixels, positive prompt 'a green pear on a table'. Wait until it finishes, then report the prompt_id.",
    primary: ["generate_image", "enqueue_workflow"],
    partial: ["create_workflow", "dsl_to_workflow"],
    verify: async (_call, t) => {
      // ground truth from ComfyUI itself: the EXECUTED graph must carry the
      // exact parameters, and the job must have completed with outputs.
      const ids = [...t.toolText.matchAll(/"prompt_id":\s*"([0-9a-f-]{8,})"/g)].map((m) => m[1]);
      for (const id of ids.reverse()) {
        try {
          const res = await fetch(`${process.env.COMFYUI_URL ?? "http://127.0.0.1:8188"}/history/${id}`);
          const hist = (await res.json())[id];
          if (!hist?.status?.completed) continue;
          const nodes = Object.values(hist.prompt?.[2] ?? {});
          const steps = nodes.some((n) => n.inputs?.steps === 12);
          const size = nodes.some((n) => n.inputs?.width === 384 && n.inputs?.height === 384);
          if (steps && size) return true;
        } catch {
          /* try the next id */
        }
      }
      return false;
    },
  },
  {
    id: "breakfix",
    title: "Deliberate failure → diagnose → recover",
    task:
      "First, try to render an image using a checkpoint named exactly 'nonexistent-model.safetensors'. That will fail — " +
      "read the error and explain in ONE sentence why. Then recover: render 'a blue cube' at 512x512 with a checkpoint " +
      "that IS installed, wait for it to complete, and report its prompt_id.",
    primary: ["generate_image", "enqueue_workflow"],
    partial: ["create_workflow"],
    verify: async (call, t) => {
      // (a) the failure actually happened (the bogus name shows up in an error),
      // (b) a real render then completed.
      const sawFailure = /nonexistent-model\.safetensors/.test(t.toolText) && /error|invalid|not (?:found|in)/i.test(t.toolText);
      if (!sawFailure) return false;
      const ids = [...t.toolText.matchAll(/"prompt_id":\s*"([0-9a-f-]{8,})"/g)].map((m) => m[1]);
      for (const id of ids.reverse()) {
        const status = await call("get_job_status", { prompt_id: id });
        if (/"done":\s*true/.test(status) && !/"error"/.test(status)) return true;
      }
      return false;
    },
  },
  {
    id: "provenance",
    title: "Generate → find asset → regenerate with override",
    task:
      "Render a 512x512 image of 'a red bicycle' and wait for it to complete. Then find the ASSET it produced " +
      "(the asset registry lists recent assets), and regenerate that asset with a steps=8 override, waiting for the " +
      "second render to complete too. Report both prompt_ids.",
    primary: ["generate_image", "enqueue_workflow"],
    partial: ["create_workflow", "list_assets", "get_asset_metadata"],
    verify: async (call, t) => {
      // regenerate must have actually run, and there must be two DISTINCT
      // completed prompts.
      if (!t.calls.some((c) => c.tool === "regenerate" && c.ok)) return false;
      const ids = [...new Set([...t.toolText.matchAll(/"prompt_id":\s*"([0-9a-f-]{8,})"/g)].map((m) => m[1]))];
      if (ids.length < 2) return false;
      let done = 0;
      for (const id of ids) {
        const status = await call("get_job_status", { prompt_id: id });
        if (/"done":\s*true/.test(status) && !/"error"/.test(status)) done++;
      }
      return done >= 2;
    },
  },
  // ── The CRUCIBLE — round 3, added when four models tied the gauntlet at
  // 16/16. Custom graph COMPOSITION (no template covers these): one graph
  // with two piped outputs, and a two-stage pipeline chained through the
  // staging tool. All still SD1.5-only and server-verified.
  {
    id: "multiout",
    title: "One graph, two piped outputs",
    task:
      "Build and enqueue ONE single workflow that renders 'a lighthouse at dusk' at 512x512 AND, in the same graph, " +
      "pipes that image through a 2x upscale so the SAME run saves TWO outputs: the 512x512 original and a 1024x1024 " +
      "version. No template does this — compose the graph yourself. Wait for completion and report the prompt_id.",
    primary: ["enqueue_workflow"],
    partial: ["create_workflow", "dsl_to_workflow", "generate_image", "modify_workflow"],
    verify: async (_call, t) => {
      const base = process.env.COMFYUI_URL ?? "http://127.0.0.1:8188";
      const ids = [...new Set([...t.toolText.matchAll(/"prompt_id":\s*"([0-9a-f-]{8,})"/g)].map((m) => m[1]))];
      for (const id of ids.reverse()) {
        try {
          const hist = (await (await fetch(`${base}/history/${id}`)).json())[id];
          if (!hist?.status?.completed) continue;
          // gather every output image of THIS single prompt and read its real
          // pixel size from the PNG header — need two distinct sizes, 2x apart.
          const dims = new Set();
          for (const out of Object.values(hist.outputs ?? {})) {
            for (const img of out.images ?? []) {
              if (img.type !== "output") continue;
              const u = new URL("/view", base);
              u.searchParams.set("filename", img.filename);
              u.searchParams.set("type", "output");
              if (img.subfolder) u.searchParams.set("subfolder", img.subfolder);
              const buf = Buffer.from(await (await fetch(u)).arrayBuffer());
              if (buf.length > 24 && buf.toString("ascii", 1, 4) === "PNG") {
                dims.add(`${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`);
              }
            }
          }
          if (dims.has("512x512") && dims.has("1024x1024")) return true;
        } catch {
          /* try next id */
        }
      }
      return false;
    },
  },
  {
    id: "pipeline",
    title: "Two-stage pipe via output staging",
    task:
      "Two-stage pipeline. Stage 1: render 'a plain wooden mask' at 512x512 and wait for it to finish. Stage 2: run an " +
      "img2img pass over stage 1's ACTUAL output image with the prompt 'an ornate golden mask' and denoise about 0.55, " +
      "and wait for it too. Do NOT guess file paths — use the staging tool that feeds a previous output into the next " +
      "stage's loader. Report both prompt_ids.",
    primary: ["enqueue_workflow", "generate_image"],
    partial: ["create_workflow", "stage_output_as_input"],
    verify: async (call, t) => {
      // the staging tool must have actually run…
      if (!t.calls.some((c) => c.tool === "stage_output_as_input" && c.ok)) return false;
      const base = process.env.COMFYUI_URL ?? "http://127.0.0.1:8188";
      const ids = [...new Set([...t.toolText.matchAll(/"prompt_id":\s*"([0-9a-f-]{8,})"/g)].map((m) => m[1]))];
      if (ids.length < 2) return false;
      // …and the LAST completed prompt must be a real img2img graph: a
      // LoadImage feeding it and a KSampler with partial denoise.
      for (const id of ids.reverse()) {
        try {
          const hist = (await (await fetch(`${base}/history/${id}`)).json())[id];
          if (!hist?.status?.completed) continue;
          const nodes = Object.values(hist.prompt?.[2] ?? {});
          const hasLoad = nodes.some((n) => n.class_type === "LoadImage");
          const partialDenoise = nodes.some(
            (n) => typeof n.inputs?.denoise === "number" && n.inputs.denoise > 0.2 && n.inputs.denoise < 0.9,
          );
          if (hasLoad && partialDenoise) return true;
          break; // only judge the newest completed prompt as stage 2
        } catch {
          /* try next id */
        }
      }
      return false;
    },
  },
];
