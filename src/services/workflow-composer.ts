import type { WorkflowJSON, WorkflowNode } from "../comfyui/types.js";
import { ValidationError } from "../utils/errors.js";

// --- Helpers ---

export function getNextNodeId(workflow: WorkflowJSON): string {
  const ids = Object.keys(workflow).map(Number).filter((n) => !Number.isNaN(n));
  return String(ids.length === 0 ? 1 : Math.max(...ids) + 1);
}

function conn(nodeId: string, outputIndex: number): [string, number] {
  return [nodeId, outputIndex];
}

// --- Template parameter types ---

interface Txt2ImgParams {
  checkpoint?: string;
  positive_prompt?: string;
  negative_prompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfg?: number;
  seed?: number;
  sampler_name?: string;
  scheduler?: string;
}

interface Img2ImgParams extends Txt2ImgParams {
  image_path?: string;
  denoise?: number;
}

interface UpscaleParams {
  upscale_model?: string;
  image_path?: string;
}

interface InpaintParams extends Img2ImgParams {
  mask_path?: string;
}

interface ControlNetParams extends Txt2ImgParams {
  control_image?: string;
  controlnet_model?: string;
  strength?: number;
}

interface IpAdapterParams extends Txt2ImgParams {
  reference_image?: string;
  weight?: number;
  preset?: string;
}

type TemplateParams =
  | Txt2ImgParams
  | Img2ImgParams
  | UpscaleParams
  | InpaintParams
  | ControlNetParams
  | IpAdapterParams;

// --- Templates ---

function buildTxt2Img(p: Txt2ImgParams): WorkflowJSON {
  const ckpt = p.checkpoint ?? "sd_xl_base_1.0.safetensors";
  const positive = p.positive_prompt ?? "";
  const negative = p.negative_prompt ?? "";
  const width = p.width ?? 1024;
  const height = p.height ?? 1024;
  const steps = p.steps ?? 20;
  const cfg = p.cfg ?? 8.0;
  const seed = p.seed ?? Math.floor(Math.random() * 2 ** 48);
  const sampler = p.sampler_name ?? "euler";
  const scheduler = p.scheduler ?? "normal";

  return {
    "1": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: ckpt },
    },
    "2": {
      class_type: "CLIPTextEncode",
      inputs: { text: positive, clip: conn("1", 1) },
      _meta: { title: "Positive Prompt" },
    },
    "3": {
      class_type: "CLIPTextEncode",
      inputs: { text: negative, clip: conn("1", 1) },
      _meta: { title: "Negative Prompt" },
    },
    "4": {
      class_type: "EmptyLatentImage",
      inputs: { width, height, batch_size: 1 },
    },
    "5": {
      class_type: "KSampler",
      inputs: {
        model: conn("1", 0),
        positive: conn("2", 0),
        negative: conn("3", 0),
        latent_image: conn("4", 0),
        seed,
        steps,
        cfg,
        sampler_name: sampler,
        scheduler,
        denoise: 1.0,
      },
    },
    "6": {
      class_type: "VAEDecode",
      inputs: { samples: conn("5", 0), vae: conn("1", 2) },
    },
    "7": {
      class_type: "SaveImage",
      inputs: { images: conn("6", 0), filename_prefix: "ComfyUI" },
    },
  };
}

function buildImg2Img(p: Img2ImgParams): WorkflowJSON {
  const ckpt = p.checkpoint ?? "sd_xl_base_1.0.safetensors";
  const positive = p.positive_prompt ?? "";
  const negative = p.negative_prompt ?? "";
  const steps = p.steps ?? 20;
  const cfg = p.cfg ?? 8.0;
  const seed = p.seed ?? Math.floor(Math.random() * 2 ** 48);
  const sampler = p.sampler_name ?? "euler";
  const scheduler = p.scheduler ?? "normal";
  const denoise = p.denoise ?? 0.75;
  const imagePath = p.image_path ?? "input.png";

  return {
    "1": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: ckpt },
    },
    "2": {
      class_type: "LoadImage",
      inputs: { image: imagePath },
    },
    "3": {
      class_type: "VAEEncode",
      inputs: { pixels: conn("2", 0), vae: conn("1", 2) },
    },
    "4": {
      class_type: "CLIPTextEncode",
      inputs: { text: positive, clip: conn("1", 1) },
      _meta: { title: "Positive Prompt" },
    },
    "5": {
      class_type: "CLIPTextEncode",
      inputs: { text: negative, clip: conn("1", 1) },
      _meta: { title: "Negative Prompt" },
    },
    "6": {
      class_type: "KSampler",
      inputs: {
        model: conn("1", 0),
        positive: conn("4", 0),
        negative: conn("5", 0),
        latent_image: conn("3", 0),
        seed,
        steps,
        cfg,
        sampler_name: sampler,
        scheduler,
        denoise,
      },
    },
    "7": {
      class_type: "VAEDecode",
      inputs: { samples: conn("6", 0), vae: conn("1", 2) },
    },
    "8": {
      class_type: "SaveImage",
      inputs: { images: conn("7", 0), filename_prefix: "ComfyUI" },
    },
  };
}

function buildUpscale(p: UpscaleParams): WorkflowJSON {
  const model = p.upscale_model ?? "RealESRGAN_x4plus.pth";
  const imagePath = p.image_path ?? "input.png";

  return {
    "1": {
      class_type: "LoadImage",
      inputs: { image: imagePath },
    },
    "2": {
      class_type: "UpscaleModelLoader",
      inputs: { model_name: model },
    },
    "3": {
      class_type: "ImageUpscaleWithModel",
      inputs: { upscale_model: conn("2", 0), image: conn("1", 0) },
    },
    "4": {
      class_type: "SaveImage",
      inputs: { images: conn("3", 0), filename_prefix: "ComfyUI_upscale" },
    },
  };
}

function buildInpaint(p: InpaintParams): WorkflowJSON {
  const ckpt = p.checkpoint ?? "sd_xl_base_1.0.safetensors";
  const positive = p.positive_prompt ?? "";
  const negative = p.negative_prompt ?? "";
  const steps = p.steps ?? 20;
  const cfg = p.cfg ?? 8.0;
  const seed = p.seed ?? Math.floor(Math.random() * 2 ** 48);
  const sampler = p.sampler_name ?? "euler";
  const scheduler = p.scheduler ?? "normal";
  const denoise = p.denoise ?? 0.85;
  const imagePath = p.image_path ?? "input.png";
  const maskPath = p.mask_path ?? "mask.png";

  return {
    "1": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: ckpt },
    },
    "2": {
      class_type: "LoadImage",
      inputs: { image: imagePath },
      _meta: { title: "Input Image" },
    },
    "3": {
      class_type: "LoadImage",
      inputs: { image: maskPath },
      _meta: { title: "Mask" },
    },
    "4": {
      class_type: "VAEEncode",
      inputs: { pixels: conn("2", 0), vae: conn("1", 2) },
    },
    "5": {
      class_type: "SetLatentNoiseMask",
      inputs: { samples: conn("4", 0), mask: conn("3", 1) },
    },
    "6": {
      class_type: "CLIPTextEncode",
      inputs: { text: positive, clip: conn("1", 1) },
      _meta: { title: "Positive Prompt" },
    },
    "7": {
      class_type: "CLIPTextEncode",
      inputs: { text: negative, clip: conn("1", 1) },
      _meta: { title: "Negative Prompt" },
    },
    "8": {
      class_type: "KSampler",
      inputs: {
        model: conn("1", 0),
        positive: conn("6", 0),
        negative: conn("7", 0),
        latent_image: conn("5", 0),
        seed,
        steps,
        cfg,
        sampler_name: sampler,
        scheduler,
        denoise,
      },
    },
    "9": {
      class_type: "VAEDecode",
      inputs: { samples: conn("8", 0), vae: conn("1", 2) },
    },
    "10": {
      class_type: "SaveImage",
      inputs: { images: conn("9", 0), filename_prefix: "ComfyUI_inpaint" },
    },
  };
}

function buildControlNet(p: ControlNetParams): WorkflowJSON {
  const ckpt = p.checkpoint ?? "sd_xl_base_1.0.safetensors";
  const positive = p.positive_prompt ?? "";
  const negative = p.negative_prompt ?? "";
  const width = p.width ?? 1024;
  const height = p.height ?? 1024;
  const steps = p.steps ?? 20;
  const cfg = p.cfg ?? 8.0;
  const seed = p.seed ?? Math.floor(Math.random() * 2 ** 48);
  const sampler = p.sampler_name ?? "euler";
  const scheduler = p.scheduler ?? "normal";
  const controlNet = p.controlnet_model ?? "control_v11p_sd15_canny.pth";
  const controlImage = p.control_image ?? "control.png";
  const strength = p.strength ?? 1.0;

  return {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: ckpt } },
    "2": {
      class_type: "LoadImage",
      inputs: { image: controlImage },
      _meta: { title: "Control Image" },
    },
    "3": { class_type: "ControlNetLoader", inputs: { control_net_name: controlNet } },
    "4": {
      class_type: "CLIPTextEncode",
      inputs: { text: positive, clip: conn("1", 1) },
      _meta: { title: "Positive Prompt" },
    },
    "5": {
      class_type: "CLIPTextEncode",
      inputs: { text: negative, clip: conn("1", 1) },
      _meta: { title: "Negative Prompt" },
    },
    "6": {
      class_type: "ControlNetApplyAdvanced",
      inputs: {
        positive: conn("4", 0),
        negative: conn("5", 0),
        control_net: conn("3", 0),
        image: conn("2", 0),
        strength,
        start_percent: 0.0,
        end_percent: 1.0,
      },
    },
    "7": {
      class_type: "EmptyLatentImage",
      inputs: { width, height, batch_size: 1 },
    },
    "8": {
      class_type: "KSampler",
      inputs: {
        model: conn("1", 0),
        positive: conn("6", 0),
        negative: conn("6", 1),
        latent_image: conn("7", 0),
        seed,
        steps,
        cfg,
        sampler_name: sampler,
        scheduler,
        denoise: 1.0,
      },
    },
    "9": { class_type: "VAEDecode", inputs: { samples: conn("8", 0), vae: conn("1", 2) } },
    "10": {
      class_type: "SaveImage",
      inputs: { images: conn("9", 0), filename_prefix: "ComfyUI_controlnet" },
    },
  };
}

// Requires the ComfyUI_IPAdapter_plus custom node pack (IPAdapterUnifiedLoader, IPAdapter).
function buildIpAdapter(p: IpAdapterParams): WorkflowJSON {
  const ckpt = p.checkpoint ?? "sd_xl_base_1.0.safetensors";
  const positive = p.positive_prompt ?? "";
  const negative = p.negative_prompt ?? "";
  const width = p.width ?? 1024;
  const height = p.height ?? 1024;
  const steps = p.steps ?? 20;
  const cfg = p.cfg ?? 8.0;
  const seed = p.seed ?? Math.floor(Math.random() * 2 ** 48);
  const sampler = p.sampler_name ?? "euler";
  const scheduler = p.scheduler ?? "normal";
  const refImage = p.reference_image ?? "reference.png";
  const weight = p.weight ?? 0.8;
  const preset = p.preset ?? "PLUS (high strength)";

  return {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: ckpt } },
    "2": {
      class_type: "LoadImage",
      inputs: { image: refImage },
      _meta: { title: "Reference Image" },
    },
    "3": {
      class_type: "IPAdapterUnifiedLoader",
      inputs: { model: conn("1", 0), preset },
    },
    "4": {
      class_type: "IPAdapter",
      inputs: {
        model: conn("3", 0),
        ipadapter: conn("3", 1),
        image: conn("2", 0),
        weight,
        start_at: 0.0,
        end_at: 1.0,
      },
    },
    "5": {
      class_type: "CLIPTextEncode",
      inputs: { text: positive, clip: conn("1", 1) },
      _meta: { title: "Positive Prompt" },
    },
    "6": {
      class_type: "CLIPTextEncode",
      inputs: { text: negative, clip: conn("1", 1) },
      _meta: { title: "Negative Prompt" },
    },
    "7": {
      class_type: "EmptyLatentImage",
      inputs: { width, height, batch_size: 1 },
    },
    "8": {
      class_type: "KSampler",
      inputs: {
        model: conn("4", 0),
        positive: conn("5", 0),
        negative: conn("6", 0),
        latent_image: conn("7", 0),
        seed,
        steps,
        cfg,
        sampler_name: sampler,
        scheduler,
        denoise: 1.0,
      },
    },
    "9": { class_type: "VAEDecode", inputs: { samples: conn("8", 0), vae: conn("1", 2) } },
    "10": {
      class_type: "SaveImage",
      inputs: { images: conn("9", 0), filename_prefix: "ComfyUI_ipadapter" },
    },
  };
}

const TEMPLATES: Record<string, (params: Record<string, unknown>) => WorkflowJSON> = {
  txt2img: (p) => buildTxt2Img(p as Txt2ImgParams),
  img2img: (p) => buildImg2Img(p as Img2ImgParams),
  upscale: (p) => buildUpscale(p as UpscaleParams),
  inpaint: (p) => buildInpaint(p as InpaintParams),
  controlnet: (p) => buildControlNet(p as ControlNetParams),
  ip_adapter: (p) => buildIpAdapter(p as IpAdapterParams),
};

export const TEMPLATE_NAMES = Object.keys(TEMPLATES);

export function createWorkflow(
  template: string,
  params: Record<string, unknown> = {},
): WorkflowJSON {
  const builder = TEMPLATES[template];
  if (!builder) {
    throw new ValidationError(
      `Unknown template "${template}". Available: ${TEMPLATE_NAMES.join(", ")}`,
    );
  }
  return builder(params);
}

// --- Modification operations ---

interface SetInputOp {
  op: "set_input";
  node_id: string;
  input_name: string;
  value: unknown;
}

interface AddNodeOp {
  op: "add_node";
  class_type: string;
  inputs?: Record<string, unknown>;
  id?: string;
}

interface RemoveNodeOp {
  op: "remove_node";
  node_id: string;
}

interface ConnectOp {
  op: "connect";
  source_id: string;
  output_index: number;
  target_id: string;
  input_name: string;
}

interface InsertBetweenOp {
  op: "insert_between";
  source_id: string;
  output_index: number;
  target_id: string;
  input_name: string;
  new_class_type: string;
  new_inputs?: Record<string, unknown>;
}

export type ModifyOperation =
  | SetInputOp
  | AddNodeOp
  | RemoveNodeOp
  | ConnectOp
  | InsertBetweenOp;

function applySetInput(wf: WorkflowJSON, op: SetInputOp): void {
  const node = wf[op.node_id];
  if (!node) throw new ValidationError(`Node "${op.node_id}" not found`);
  node.inputs[op.input_name] = op.value;
}

function applyAddNode(wf: WorkflowJSON, op: AddNodeOp): string {
  const id = op.id ?? getNextNodeId(wf);
  if (wf[id]) throw new ValidationError(`Node ID "${id}" already exists`);
  wf[id] = {
    class_type: op.class_type,
    inputs: op.inputs ?? {},
  };
  return id;
}

function applyRemoveNode(wf: WorkflowJSON, op: RemoveNodeOp): void {
  if (!wf[op.node_id]) throw new ValidationError(`Node "${op.node_id}" not found`);
  delete wf[op.node_id];

  // Clean up any connections pointing to the removed node
  for (const node of Object.values(wf)) {
    for (const [key, val] of Object.entries(node.inputs)) {
      if (
        Array.isArray(val) &&
        val.length === 2 &&
        typeof val[0] === "string" &&
        val[0] === op.node_id
      ) {
        delete node.inputs[key];
      }
    }
  }
}

function applyConnect(wf: WorkflowJSON, op: ConnectOp): void {
  if (!wf[op.source_id]) throw new ValidationError(`Source node "${op.source_id}" not found`);
  if (!wf[op.target_id]) throw new ValidationError(`Target node "${op.target_id}" not found`);
  wf[op.target_id].inputs[op.input_name] = [op.source_id, op.output_index];
}

function applyInsertBetween(wf: WorkflowJSON, op: InsertBetweenOp): string {
  if (!wf[op.source_id]) throw new ValidationError(`Source node "${op.source_id}" not found`);
  if (!wf[op.target_id]) throw new ValidationError(`Target node "${op.target_id}" not found`);

  const newId = getNextNodeId(wf);
  const newInputs: Record<string, unknown> = { ...(op.new_inputs ?? {}) };

  // Connect the new node's first input to the original source
  // Find the first input name that isn't already set -- use a convention-based approach
  // The new node receives the source output on its primary input
  // We'll figure out the right input name by looking for common patterns
  const primaryInputNames = ["model", "clip", "samples", "latent_image", "image", "conditioning", "pixels"];
  let connected = false;
  for (const name of primaryInputNames) {
    if (!(name in newInputs)) {
      newInputs[name] = [op.source_id, op.output_index];
      connected = true;
      break;
    }
  }
  if (!connected) {
    // Fallback: add as first unused slot
    newInputs["input"] = [op.source_id, op.output_index];
  }

  wf[newId] = {
    class_type: op.new_class_type,
    inputs: newInputs,
  };

  // Rewire: target's input now points to the new node's output 0
  wf[op.target_id].inputs[op.input_name] = [newId, 0];

  return newId;
}

export function modifyWorkflow(
  workflow: WorkflowJSON,
  operations: ModifyOperation[],
): { workflow: WorkflowJSON; added_ids: string[] } {
  // Deep clone to avoid mutating the original
  const wf: WorkflowJSON = JSON.parse(JSON.stringify(workflow));
  const addedIds: string[] = [];

  for (const op of operations) {
    switch (op.op) {
      case "set_input":
        applySetInput(wf, op);
        break;
      case "add_node": {
        const id = applyAddNode(wf, op);
        addedIds.push(id);
        break;
      }
      case "remove_node":
        applyRemoveNode(wf, op);
        break;
      case "connect":
        applyConnect(wf, op);
        break;
      case "insert_between": {
        const id = applyInsertBetween(wf, op);
        addedIds.push(id);
        break;
      }
      default:
        throw new ValidationError(`Unknown operation: ${(op as { op: string }).op}`);
    }
  }

  return { workflow: wf, added_ids: addedIds };
}
