import { beforeEach, describe, expect, it, vi } from "vitest";

const listExtraPathsMock = vi.fn();
const addExtraPathMock = vi.fn();
const removeExtraPathMock = vi.fn();

vi.mock("../../services/extra-paths.js", async () => {
  const actual = await vi.importActual<typeof import("../../services/extra-paths.js")>(
    "../../services/extra-paths.js",
  );
  return {
    ...actual,
    listExtraPaths: (...a: unknown[]) => listExtraPathsMock(...a),
    addExtraPath: (...a: unknown[]) => addExtraPathMock(...a),
    removeExtraPath: (...a: unknown[]) => removeExtraPathMock(...a),
  };
});

import { registerExtraPathsTools } from "../../tools/extra-paths.js";

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
  registerExtraPathsTools(server as never);
  return handlers;
}

beforeEach(() => {
  listExtraPathsMock.mockReset();
  addExtraPathMock.mockReset();
  removeExtraPathMock.mockReset();
});

describe("extra paths tools", () => {
  it("registers list/add/remove and maps snake_case args to service options", async () => {
    const handlers = makeServer();
    expect([...handlers.keys()]).toEqual([
      "list_extra_paths",
      "add_extra_path",
      "remove_extra_path",
    ]);

    listExtraPathsMock.mockResolvedValueOnce({ target: "standalone", path: "x", groups: [] });
    const list = await handlers.get("list_extra_paths")!({
      target: "standalone",
      config_path: "x",
    });
    expect(listExtraPathsMock).toHaveBeenCalledWith({
      target: "standalone",
      configPath: "x",
    });
    expect(JSON.parse(list.content[0].text)).toMatchObject({ target: "standalone" });

    addExtraPathMock.mockResolvedValueOnce({ changed: true });
    await handlers.get("add_extra_path")!({
      target: "desktop",
      config_path: "y",
      group: "shared",
      category: "custom_nodes",
      path: "D:/Comfy/custom_nodes",
      is_default: true,
    });
    expect(addExtraPathMock).toHaveBeenCalledWith({
      target: "desktop",
      configPath: "y",
      group: "shared",
      category: "custom_nodes",
      path: "D:/Comfy/custom_nodes",
      isDefault: true,
    });

    removeExtraPathMock.mockResolvedValueOnce({ changed: true });
    await handlers.get("remove_extra_path")!({
      category: "loras",
      path: "D:/Models/loras",
    });
    expect(removeExtraPathMock).toHaveBeenCalledWith({
      target: undefined,
      configPath: undefined,
      group: undefined,
      category: "loras",
      path: "D:/Models/loras",
    });
  });
});
