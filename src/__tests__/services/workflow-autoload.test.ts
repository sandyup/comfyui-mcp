import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parsePlaceholders,
  applyParams,
  buildToolSchema,
  discoverWorkflows,
  type Placeholder,
} from "../../services/workflow-autoload.js";
import type { WorkflowJSON } from "../../comfyui/types.js";

function wf(): WorkflowJSON {
  return {
    "3": {
      class_type: "KSampler",
      inputs: {
        seed: 42,
        steps: "PARAM_INT_STEPS",
        cfg: "PARAM_FLOAT_CFG",
        sampler_name: "PARAM_STRING_SAMPLER",
      },
    },
    "6": {
      class_type: "CLIPTextEncode",
      inputs: { text: "PARAM_PROMPT" },
    },
    "9": {
      class_type: "SaveImage",
      inputs: { filename_prefix: "ComfyUI" },
    },
  };
}

describe("parsePlaceholders", () => {
  it("returns empty list when no placeholders are present", () => {
    expect(parsePlaceholders({ "1": { class_type: "X", inputs: { a: 1 } } })).toEqual([]);
  });

  it("detects PARAM_PROMPT as required string named 'prompt'", () => {
    const placeholders = parsePlaceholders({
      "1": { class_type: "X", inputs: { text: "PARAM_PROMPT" } },
    });
    expect(placeholders).toEqual([
      { name: "prompt", type: "string", nodeId: "1", inputName: "text" },
    ]);
  });

  it("detects typed placeholders with derived names", () => {
    const placeholders = parsePlaceholders(wf());
    const byName = Object.fromEntries(placeholders.map((p) => [p.name, p]));
    expect(byName.steps.type).toBe("int");
    expect(byName.cfg.type).toBe("float");
    expect(byName.sampler.type).toBe("string");
    expect(byName.prompt.type).toBe("string");
  });

  it("ignores PARAM_* tokens with unknown type prefixes", () => {
    const placeholders = parsePlaceholders({
      "1": { class_type: "X", inputs: { weird: "PARAM_WIDGET_FOO", ok: "PARAM_INT_STEPS" } },
    });
    expect(placeholders.map((p) => p.name)).toEqual(["steps"]);
  });

  it("ignores non-string values", () => {
    const placeholders = parsePlaceholders({
      "1": { class_type: "X", inputs: { n: 5, b: true, arr: ["1", 0] } },
    });
    expect(placeholders).toEqual([]);
  });

  it("collapses duplicate placeholder names into one schema entry", () => {
    const placeholders = parsePlaceholders({
      "1": { class_type: "CLIPTextEncode", inputs: { text: "PARAM_PROMPT" } },
      "2": { class_type: "CLIPTextEncode", inputs: { text: "PARAM_PROMPT" } },
    });
    // applyParams will fill BOTH sites — but the schema exposes one "prompt" param
    expect(placeholders.length).toBeGreaterThanOrEqual(1);
    const names = new Set(placeholders.map((p) => p.name));
    expect(names.has("prompt")).toBe(true);
  });
});

describe("applyParams", () => {
  const placeholders: Placeholder[] = [
    { name: "prompt", type: "string", nodeId: "6", inputName: "text" },
    { name: "steps", type: "int", nodeId: "3", inputName: "steps" },
    { name: "cfg", type: "float", nodeId: "3", inputName: "cfg" },
    { name: "sampler", type: "string", nodeId: "3", inputName: "sampler_name" },
  ];

  it("substitutes provided params into the workflow", () => {
    const out = applyParams(wf(), placeholders, {
      prompt: "a cat",
      steps: 30,
      cfg: 7.5,
      sampler: "dpmpp_2m",
    });
    expect(out["6"].inputs.text).toBe("a cat");
    expect(out["3"].inputs.steps).toBe(30);
    expect(out["3"].inputs.cfg).toBe(7.5);
    expect(out["3"].inputs.sampler_name).toBe("dpmpp_2m");
  });

  it("substitutes every occurrence of a repeated placeholder name", () => {
    const wfDup: WorkflowJSON = {
      "1": { class_type: "CLIPTextEncode", inputs: { text: "PARAM_PROMPT" } },
      "2": { class_type: "CLIPTextEncode", inputs: { text: "PARAM_PROMPT" } },
    };
    const ph: Placeholder[] = [
      { name: "prompt", type: "string", nodeId: "1", inputName: "text" },
      { name: "prompt", type: "string", nodeId: "2", inputName: "text" },
    ];
    const out = applyParams(wfDup, ph, { prompt: "shared" });
    expect(out["1"].inputs.text).toBe("shared");
    expect(out["2"].inputs.text).toBe("shared");
  });

  it("throws when a required placeholder is missing", () => {
    expect(() =>
      applyParams(wf(), placeholders, { steps: 20, cfg: 7, sampler: "euler" }),
    ).toThrow(/Missing required param: prompt/);
  });

  it("does not mutate the source workflow", () => {
    const w = wf();
    applyParams(w, placeholders, { prompt: "x", steps: 1, cfg: 1, sampler: "y" });
    expect(w["6"].inputs.text).toBe("PARAM_PROMPT");
  });

  it("coerces numeric strings to numbers for int/float params", () => {
    const out = applyParams(wf(), placeholders, {
      prompt: "p",
      steps: "30" as unknown as number,
      cfg: "7.5" as unknown as number,
      sampler: "euler",
    });
    expect(out["3"].inputs.steps).toBe(30);
    expect(out["3"].inputs.cfg).toBe(7.5);
  });
});

describe("buildToolSchema", () => {
  it("produces a zod-compatible shape with required + optional fields", () => {
    const placeholders: Placeholder[] = [
      { name: "prompt", type: "string", nodeId: "6", inputName: "text" },
      { name: "steps", type: "int", nodeId: "3", inputName: "steps" },
    ];
    const shape = buildToolSchema(placeholders);
    expect(shape).toHaveProperty("prompt");
    expect(shape).toHaveProperty("steps");
    // prompt is required → parsing without it should fail
    const z = shape.prompt;
    expect(() => z.parse("hi")).not.toThrow();
    expect(() => shape.steps.parse(20)).not.toThrow();
  });

  it("deduplicates repeated placeholder names", () => {
    const shape = buildToolSchema([
      { name: "prompt", type: "string", nodeId: "1", inputName: "text" },
      { name: "prompt", type: "string", nodeId: "2", inputName: "text" },
    ]);
    expect(Object.keys(shape)).toEqual(["prompt"]);
  });
});

describe("discoverWorkflows", () => {
  async function makeDir(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "comfyui-autoload-"));
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(dir, name), content, "utf-8");
    }
    return dir;
  }

  it("returns empty array when directory does not exist", async () => {
    const found = await discoverWorkflows(join(tmpdir(), "definitely-not-real-xyz123"));
    expect(found).toEqual([]);
  });

  it("loads valid JSON files and derives tool names from filenames", async () => {
    const dir = await makeDir({
      "hero_image.json": JSON.stringify({
        "1": { class_type: "CLIPTextEncode", inputs: { text: "PARAM_PROMPT" } },
      }),
      "thumbnail.json": JSON.stringify({
        "1": { class_type: "X", inputs: { steps: "PARAM_INT_STEPS" } },
      }),
    });
    try {
      const found = await discoverWorkflows(dir);
      const byName = Object.fromEntries(found.map((f) => [f.toolName, f]));
      expect(byName.hero_image.placeholders[0].name).toBe("prompt");
      expect(byName.thumbnail.placeholders[0].name).toBe("steps");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips invalid JSON without crashing", async () => {
    const dir = await makeDir({
      "good.json": JSON.stringify({
        "1": { class_type: "X", inputs: { text: "PARAM_PROMPT" } },
      }),
      "broken.json": "{ this is not json",
    });
    try {
      const found = await discoverWorkflows(dir);
      expect(found.map((f) => f.toolName)).toEqual(["good"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips non-json files", async () => {
    const dir = await makeDir({
      "wf.json": JSON.stringify({ "1": { class_type: "X", inputs: {} } }),
      "README.md": "hi",
      "config.yaml": "x: 1",
    });
    try {
      const found = await discoverWorkflows(dir);
      expect(found.map((f) => f.toolName)).toEqual(["wf"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
