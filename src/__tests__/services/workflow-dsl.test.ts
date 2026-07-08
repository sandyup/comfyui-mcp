import { describe, expect, it } from "vitest";
import { workflowToDsl, dslToWorkflow } from "../../services/workflow-dsl.js";
import { createWorkflow } from "../../services/workflow-composer.js";
import type { WorkflowJSON } from "../../comfyui/types.js";

function roundTrip(wf: WorkflowJSON): WorkflowJSON {
  return dslToWorkflow(workflowToDsl(wf));
}

describe("workflow-dsl round-trip", () => {
  it("round-trips the txt2img template losslessly", () => {
    const wf = createWorkflow("txt2img", {
      positive_prompt: "a cat",
      negative_prompt: "blurry",
      steps: 25,
      cfg: 7.5,
    });
    expect(roundTrip(wf)).toEqual(wf);
  });

  it("round-trips the controlnet template losslessly", () => {
    const wf = createWorkflow("controlnet", {
      positive_prompt: "a knight",
      controlnet_model: "openpose.pth",
      control_image: "pose.png",
      strength: 0.8,
    });
    expect(roundTrip(wf)).toEqual(wf);
  });

  it("round-trips the ip_adapter template losslessly", () => {
    const wf = createWorkflow("ip_adapter", { positive_prompt: "p", reference_image: "r.png" });
    expect(roundTrip(wf)).toEqual(wf);
  });

  it("preserves _meta.title", () => {
    const wf: WorkflowJSON = {
      "2": { class_type: "CLIPTextEncode", inputs: { text: "hi" }, _meta: { title: "Positive Prompt" } },
    };
    const back = roundTrip(wf);
    expect(back["2"]._meta?.title).toBe("Positive Prompt");
  });

  it("emits connections with <- and literals with =", () => {
    const wf: WorkflowJSON = {
      "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "x.safetensors" } },
      "2": { class_type: "KSampler", inputs: { seed: 42, model: ["1", 0] } },
    };
    const dsl = workflowToDsl(wf);
    expect(dsl).toContain("model <- 1.0");
    expect(dsl).toContain('ckpt_name = "x.safetensors"');
    expect(dsl).toContain("seed = 42");
  });

  it("keeps a literal [string,int] array that is NOT a known node id as a literal", () => {
    const wf: WorkflowJSON = {
      "1": { class_type: "SomeNode", inputs: { pair: ["label", 3] } },
    };
    // "label" is not a node id, so it must stay a literal array, not a connection
    const dsl = workflowToDsl(wf);
    expect(dsl).toContain('pair = ["label",3]');
    expect(roundTrip(wf)).toEqual(wf);
  });

  it("round-trips floats, bools, ints, and nested objects", () => {
    const wf: WorkflowJSON = {
      "1": {
        class_type: "Node",
        inputs: { f: 7.5, b: true, n: 0, s: "txt", arr: [1, 2, 3], obj: { a: 1, b: "x" } },
      },
    };
    expect(roundTrip(wf)).toEqual(wf);
  });

  it("round-trips multiline / escaped string values", () => {
    const wf: WorkflowJSON = {
      "1": { class_type: "CLIPTextEncode", inputs: { text: 'line1\nline2 with "quotes"' } },
    };
    expect(roundTrip(wf)).toEqual(wf);
  });

  it("ignores comments and blank lines", () => {
    const dsl = `# a comment\n\n1: CheckpointLoaderSimple\n  ckpt_name = "x.safetensors"\n\n# trailing\n`;
    const wf = dslToWorkflow(dsl);
    expect(wf["1"]).toEqual({ class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "x.safetensors" } });
  });

  it("preserves non-numeric node ids", () => {
    const wf: WorkflowJSON = {
      "10": { class_type: "A", inputs: { x: ["3b", 1] } },
      "3b": { class_type: "B", inputs: {} },
    };
    expect(roundTrip(wf)).toEqual(wf);
  });

  it("throws on an invalid node header", () => {
    expect(() => dslToWorkflow("this is not valid")).toThrow(/node header/i);
  });

  it("throws on an indented input with no preceding node", () => {
    expect(() => dslToWorkflow("  key = 1")).toThrow(/no preceding node/i);
  });

  it("throws on a malformed JSON literal", () => {
    expect(() => dslToWorkflow('1: Node\n  k = {bad json')).toThrow(/Invalid JSON/i);
  });
});
