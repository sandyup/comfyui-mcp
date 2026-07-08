import { describe, it, expect } from "vitest";
import { convertUiToApi } from "../../services/workflow-converter.js";

// Minimal object_info for the node types used below.
const OBJECT_INFO = {
  LoadImage: { input: { required: { image: ["IMAGE_UPLOAD"] } } },
  ImageBlur: { input: { required: { image: ["IMAGE"], blur_radius: ["INT"] } } },
  SaveImage: {
    input: { required: { images: ["IMAGE"], filename_prefix: ["STRING"] } },
  },
} as never;

// LoadImage(1) -> [Blur(2)] -> SaveImage(3), where Blur's mode is parameterised.
function chain(blurMode: number) {
  return {
    nodes: [
      {
        id: 1,
        type: "LoadImage",
        mode: 0,
        inputs: [],
        outputs: [{ name: "IMAGE", type: "IMAGE", links: [1] }],
        widgets_values: ["in.png"],
      },
      {
        id: 2,
        type: "ImageBlur",
        mode: blurMode,
        inputs: [{ name: "image", type: "IMAGE", link: 1 }],
        outputs: [{ name: "IMAGE", type: "IMAGE", links: [2] }],
        widgets_values: [5],
      },
      {
        id: 3,
        type: "SaveImage",
        mode: 0,
        inputs: [{ name: "images", type: "IMAGE", link: 2 }],
        outputs: [],
        widgets_values: ["out"],
      },
    ],
    links: [
      [1, 1, 0, 2, 0, "IMAGE"],
      [2, 2, 0, 3, 0, "IMAGE"],
    ],
  } as never;
}

describe("convertUiToApi — bypass / mute resolution", () => {
  it("bypassed (mode 4) node is excluded and its consumer passes through to the upstream source", () => {
    const { workflow } = convertUiToApi(chain(4), OBJECT_INFO);
    expect(workflow["2"]).toBeUndefined(); // bypassed node not in the prompt
    // SaveImage's images reconnects through the bypassed blur to LoadImage(1).
    expect(workflow["3"].inputs.images).toEqual(["1", 0]);
    expect(workflow["1"]).toBeDefined();
  });

  it("muted (mode 2) node is excluded and drops the downstream connection", () => {
    const { workflow } = convertUiToApi(chain(2), OBJECT_INFO);
    expect(workflow["2"]).toBeUndefined();
    expect(workflow["3"].inputs.images).toBeUndefined(); // connection dropped
  });

  it("active (mode 0) node is kept and wired normally", () => {
    const { workflow } = convertUiToApi(chain(0), OBJECT_INFO);
    expect(workflow["2"]).toBeDefined();
    expect(workflow["3"].inputs.images).toEqual(["2", 0]);
    expect(workflow["2"].inputs.image).toEqual(["1", 0]);
  });

  it("virtual Set/Get bus nodes are dropped and consumers resolve through the bus", () => {
    // LoadImage(1) -> SetNode(2,'BUS');  GetNode(3,'BUS') -> SaveImage(4)
    const ui = {
      nodes: [
        {
          id: 1,
          type: "LoadImage",
          mode: 0,
          inputs: [],
          outputs: [{ name: "IMAGE", type: "IMAGE", links: [1] }],
          widgets_values: ["in.png"],
        },
        {
          id: 2,
          type: "SetNode",
          mode: 0,
          inputs: [{ name: "IMAGE", type: "IMAGE", link: 1 }],
          outputs: [],
          widgets_values: ["BUS"],
        },
        {
          id: 3,
          type: "GetNode",
          mode: 0,
          inputs: [],
          outputs: [{ name: "IMAGE", type: "IMAGE", links: [2] }],
          widgets_values: ["BUS"],
        },
        {
          id: 4,
          type: "SaveImage",
          mode: 0,
          inputs: [{ name: "images", type: "IMAGE", link: 2 }],
          outputs: [],
          widgets_values: ["out"],
        },
      ],
      links: [
        [1, 1, 0, 2, 0, "IMAGE"],
        [2, 3, 0, 4, 0, "IMAGE"],
      ],
    } as never;
    const { workflow } = convertUiToApi(ui, OBJECT_INFO);
    expect(workflow["2"]).toBeUndefined(); // SetNode dropped
    expect(workflow["3"]).toBeUndefined(); // GetNode dropped
    expect(workflow["4"].inputs.images).toEqual(["1", 0]); // resolved through the bus
  });
});
