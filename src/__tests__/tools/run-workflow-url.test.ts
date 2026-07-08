import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

// --- Mock the server-touching dependencies; keep applyOverrides + the SSRF
// guard + isApiFormat real so we exercise real format/override logic. ---
const getObjectInfoMock = vi.fn(async () => ({}));
const backfillObjectInfoMock = vi.fn(async (oi: unknown) => oi);
vi.mock("../../comfyui/client.js", () => ({
  getObjectInfo: (...a: unknown[]) => getObjectInfoMock(...a),
  backfillObjectInfo: (...a: unknown[]) => backfillObjectInfoMock(...a),
}));

vi.mock("../../services/workflow-converter.js", () => ({
  isUiFormat: (o: unknown) =>
    !!o &&
    typeof o === "object" &&
    Array.isArray((o as { nodes?: unknown }).nodes) &&
    Array.isArray((o as { links?: unknown }).links),
  collectNodeTypes: () => ["KSampler"],
  convertUiToApi: () => ({
    workflow: { "1": { class_type: "KSampler", inputs: { seed: 1, cfg: 7 } } },
    warnings: ["converted from UI"],
  }),
}));

const validateWorkflowMock = vi.fn(async () => ({
  valid: true,
  issues: [] as unknown[],
  summary: "0 issues",
}));
vi.mock("../../services/workflow-validator.js", () => ({
  validateWorkflow: (...a: unknown[]) => validateWorkflowMock(...a),
}));

const enqueueWorkflowMock = vi.fn(async () => ({
  prompt_id: "new-prompt-1",
  queue_remaining: 0,
}));
vi.mock("../../services/workflow-executor.js", () => ({
  enqueueWorkflow: (...a: unknown[]) => enqueueWorkflowMock(...a),
}));

// Mock DNS so resolution is deterministic + offline. Default: a public IP.
const lookupMock = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
vi.mock("node:dns/promises", () => ({
  lookup: (...a: unknown[]) => lookupMock(...a),
}));

import { registerWorkflowUrlTools } from "../../tools/workflow-url.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}>;

function getHandler(name: string): ToolHandler {
  let handler: ToolHandler | undefined;
  const server = {
    tool: (n: string, _d: string, _s: unknown, h: ToolHandler) => {
      if (n === name) handler = h;
    },
  };
  registerWorkflowUrlTools(server as never);
  if (!handler) throw new Error(`tool ${name} not registered`);
  return handler;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  getObjectInfoMock.mockClear();
  backfillObjectInfoMock.mockClear();
  validateWorkflowMock.mockClear();
  enqueueWorkflowMock.mockClear();
  fetchMock.mockReset();
  lookupMock.mockReset();
  lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const API_WF = {
  "1": { class_type: "KSampler", inputs: { seed: 1, cfg: 7 } },
  "2": { class_type: "SaveImage", inputs: { images: ["1", 0] } },
};

describe("run_workflow_url", () => {
  it("loads a raw API-format JSON URL (run=false, read-only)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(API_WF));
    const handler = getHandler("run_workflow_url");

    const res = await handler({
      url: "https://example.com/wf.json",
      run: false,
    });

    expect(res.isError).toBeFalsy();
    expect(enqueueWorkflowMock).not.toHaveBeenCalled();
    expect(res.content[0].text).toContain("Workflow loaded");
    expect(res.content[0].text).toContain("Node count: 2");
    // The full workflow JSON is returned as a second content block.
    expect(res.content[1].text).toContain("KSampler");
  });

  it("converts a UI-format export via the converter", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ nodes: [{ id: 1, type: "KSampler" }], links: [] }));
    const handler = getHandler("run_workflow_url");

    const res = await handler({ url: "https://example.com/ui.json" });

    expect(res.isError).toBeFalsy();
    expect(getObjectInfoMock).toHaveBeenCalled();
    expect(res.content[0].text).toContain("converted from UI");
    expect(res.content[0].text).toContain("Node count: 1");
  });

  it("normalizes a GitHub blob URL to raw.githubusercontent.com", async () => {
    fetchMock.mockResolvedValue(jsonResponse(API_WF));
    const handler = getHandler("run_workflow_url");

    await handler({
      url: "https://github.com/owner/repo/blob/main/wf.json",
    });

    const fetchedUrl = String((fetchMock.mock.calls[0][0] as URL).toString());
    expect(fetchedUrl).toBe("https://raw.githubusercontent.com/owner/repo/main/wf.json");
  });

  it("rejects an SSRF attempt (loopback/metadata host) without fetching", async () => {
    const handler = getHandler("run_workflow_url");

    const res = await handler({ url: "http://169.254.169.254/latest/meta-data/" });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/SSRF|internal\/loopback/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects non-http(s) schemes (file://)", async () => {
    const handler = getHandler("run_workflow_url");
    const res = await handler({ url: "file:///etc/passwd" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/http\/https/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks a hostname that DNS-resolves to a private IP (rebinding)", async () => {
    // Host passes the literal check, but resolves to an internal address.
    lookupMock.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    fetchMock.mockResolvedValue(jsonResponse(API_WF));
    const handler = getHandler("run_workflow_url");

    const res = await handler({ url: "https://evil.example.com/wf.json" });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/resolves to internal\/private|DNS-rebinding/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks an IPv6 ULA resolution too", async () => {
    lookupMock.mockResolvedValue([{ address: "fd00::1", family: 6 }]);
    const handler = getHandler("run_workflow_url");
    const res = await handler({ url: "https://evil6.example.com/wf.json" });
    expect(res.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a redirect response instead of following it", async () => {
    fetchMock.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      }),
    );
    const handler = getHandler("run_workflow_url");

    const res = await handler({ url: "https://example.com/redirector" });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/redirect/i);
    expect(enqueueWorkflowMock).not.toHaveBeenCalled();
  });

  it("returns a clear error for an unsupported share host", async () => {
    const handler = getHandler("run_workflow_url");
    const res = await handler({ url: "https://comfyworkflows.com/workflows/abc123" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Unsupported share host/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("errors clearly on invalid JSON", async () => {
    fetchMock.mockResolvedValue(
      new Response("<html>not json</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    const handler = getHandler("run_workflow_url");
    const res = await handler({ url: "https://example.com/page.html" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/did not return valid JSON/i);
  });

  it("rejects JSON that is not a recognized workflow", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ hello: "world" }));
    const handler = getHandler("run_workflow_url");
    const res = await handler({ url: "https://example.com/other.json" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/not a recognized ComfyUI workflow/i);
  });

  it("enqueues and applies overrides when run=true", async () => {
    fetchMock.mockResolvedValue(jsonResponse(API_WF));
    const handler = getHandler("run_workflow_url");

    const res = await handler({
      url: "https://example.com/wf.json",
      run: true,
      inputs: { cfg: 9.5 },
    });

    expect(res.isError).toBeFalsy();
    expect(enqueueWorkflowMock).toHaveBeenCalledTimes(1);
    // Override applied to the node that has a `cfg` input.
    const enqueued = enqueueWorkflowMock.mock.calls[0][0] as typeof API_WF;
    expect(enqueued["1"].inputs.cfg).toBe(9.5);
    const out = JSON.parse(res.content[0].text);
    expect(out.status).toBe("enqueued");
    expect(out.prompt_id).toBe("new-prompt-1");
  });
});
