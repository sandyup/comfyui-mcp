import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const convertImageMock = vi.fn();
vi.mock("../../services/image-convert.js", () => ({
  convertImage: (...a: unknown[]) => convertImageMock(...a),
}));

import { registerImageConvertTools } from "../../tools/image-convert.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
}>;

function makeServer() {
  const handlers = new Map<string, ToolHandler>();
  let schemaShape: z.ZodRawShape | undefined;
  const server = {
    tool: (
      name: string,
      _desc: string,
      schema: z.ZodRawShape,
      handler: ToolHandler,
    ) => {
      handlers.set(name, handler);
      if (name === "convert_image") schemaShape = schema;
    },
  };
  registerImageConvertTools(server as never);
  return {
    convertImage: handlers.get("convert_image")!,
    schema: z.object(schemaShape!),
  };
}

beforeEach(() => {
  convertImageMock.mockReset();
});

describe("convert_image tool", () => {
  it("passes conversion options through and returns inline image content", async () => {
    convertImageMock.mockResolvedValueOnce({
      content: [
        { type: "text", text: "{\"output_bytes\":5}" },
        { type: "image", data: "c21hbGw=", mimeType: "image/webp" },
      ],
    });

    const { convertImage } = makeServer();
    const args = {
      asset_id: "a_123",
      format: "webp",
      quality: 70,
      lossless: false,
      effort: 5,
      out_path: "small.webp",
    };
    const result = await convertImage(args);

    expect(convertImageMock).toHaveBeenCalledWith(args);
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([
      { type: "text", text: "{\"output_bytes\":5}" },
      { type: "image", data: "c21hbGw=", mimeType: "image/webp" },
    ]);
  });

  it("validates quality and webp effort ranges in the tool schema", () => {
    const { schema } = makeServer();
    expect(schema.safeParse({ asset_id: "a", format: "jpeg", quality: 101 }).success)
      .toBe(false);
    expect(schema.safeParse({ asset_id: "a", format: "webp", effort: 7 }).success)
      .toBe(false);
    expect(schema.safeParse({ asset_id: "a", format: "webp", quality: 80, effort: 6 }).success)
      .toBe(true);
  });
});
