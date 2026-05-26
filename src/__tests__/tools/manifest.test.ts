import { beforeEach, describe, expect, it, vi } from "vitest";

const applyManifestMock = vi.fn();

vi.mock("../../services/manifest.js", async () => {
  return {
    manifestSchema: {
      optional: () => ({ describe: () => ({}) }),
    },
    applyManifest: (...a: unknown[]) => applyManifestMock(...a),
  };
});

import { registerManifestTools } from "../../tools/manifest.js";

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
  registerManifestTools(server as never);
  return {
    applyManifest: handlers.get("apply_manifest")!,
  };
}

beforeEach(() => {
  applyManifestMock.mockReset();
});

describe("apply_manifest tool", () => {
  it("passes inline manifests through and returns structured JSON", async () => {
    applyManifestMock.mockResolvedValueOnce({
      success: true,
      summary: { applied: 1, skipped: 0, failed: 0 },
      results: [
        {
          item: "comfyui-impact-pack",
          action: "custom_node",
          status: "applied",
          message: "installed",
        },
      ],
    });

    const { applyManifest } = makeServer();
    const args = { manifest: { custom_nodes: ["comfyui-impact-pack"] } };
    const res = await applyManifest(args);

    expect(applyManifestMock).toHaveBeenCalledWith(args);
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0].text)).toMatchObject({
      success: true,
      summary: { applied: 1 },
    });
  });
});
