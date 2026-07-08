import { beforeEach, describe, expect, it, vi } from "vitest";

const downloadModelMock = vi.fn();
vi.mock("../../services/model-resolver.js", async () => {
  const actual = await vi.importActual<typeof import("../../services/model-resolver.js")>(
    "../../services/model-resolver.js",
  );
  return {
    ...actual,
    downloadModel: (...a: unknown[]) => downloadModelMock(...a),
  };
});

import { registerModelManagementTools } from "../../tools/model-management.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}>;

function makeServer() {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  };
  registerModelManagementTools(server as never);
  return {
    downloadModel: handlers.get("download_model")!,
  };
}

beforeEach(() => {
  downloadModelMock.mockReset();
});

describe("download_model tool", () => {
  it("passes optional auth through to downloadModel", async () => {
    downloadModelMock.mockResolvedValueOnce("/comfy/models/checkpoints/x.safetensors");
    const auth = {
      type: "header",
      header_name: "X-Api-Key",
      header_value: "secret",
    };

    const { downloadModel } = makeServer();
    const res = await downloadModel({
      url: "https://example.com/x.safetensors",
      target_subfolder: "checkpoints",
      filename: "x.safetensors",
      auth,
    });

    expect(downloadModelMock).toHaveBeenCalledWith(
      "https://example.com/x.safetensors",
      "checkpoints",
      "x.safetensors",
      auth,
    );
    expect(res.isError).toBeFalsy();
  });
});
