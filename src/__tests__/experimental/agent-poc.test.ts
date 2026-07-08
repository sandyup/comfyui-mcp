import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handleChatRequest: vi.fn(async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: hello\n\n"));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }),
  startQuickTunnel: vi.fn(),
}));

vi.mock("../../experimental/chat-handler.js", () => ({
  handleChatRequest: mocks.handleChatRequest,
}));

vi.mock("../../services/tunnel.js", () => ({
  startQuickTunnel: mocks.startQuickTunnel,
}));

import { startAgentPoc, type AgentPocHandle } from "../../experimental/agent-poc.js";
import { registry, resolveModel } from "../../experimental/provider-registry.js";

const TOKEN = "test-token";

describe("startAgentPoc HTTP layer", () => {
  let handle: AgentPocHandle | null = null;

  beforeEach(() => {
    mocks.handleChatRequest.mockClear();
    mocks.startQuickTunnel.mockClear();
  });

  afterEach(async () => {
    if (handle) {
      await handle.stop();
      handle = null;
    }
  });

  async function start(maxBodyBytes = 1024) {
    handle = await startAgentPoc({
      host: "127.0.0.1",
      port: 0,
      token: TOKEN,
      maxBodyBytes,
    });
    return handle;
  }

  function chatHeaders(token = TOKEN, contentType = "application/json") {
    return {
      authorization: `Bearer ${token}`,
      "content-type": contentType,
    };
  }

  it("returns 401 when Authorization is missing or the bearer token is wrong", async () => {
    const h = await start();
    const body = JSON.stringify({ messages: [] });

    const missing = await fetch(`${h.localUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(missing.status).toBe(401);

    const wrong = await fetch(`${h.localUrl}/api/chat`, {
      method: "POST",
      headers: chatHeaders("wrong-token"),
      body,
    });
    expect(wrong.status).toBe(401);
    expect(mocks.handleChatRequest).not.toHaveBeenCalled();
  });

  it("streams chat responses when the bearer token is correct", async () => {
    const h = await start();

    const res = await fetch(`${h.localUrl}/api/chat`, {
      method: "POST",
      headers: chatHeaders(),
      body: JSON.stringify({ messages: [] }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(await res.text()).toContain("hello");
    expect(mocks.handleChatRequest).toHaveBeenCalledTimes(1);
  });

  it("returns 413 when the request body exceeds maxBodyBytes", async () => {
    const h = await start(16);

    const res = await fetch(`${h.localUrl}/api/chat`, {
      method: "POST",
      headers: chatHeaders(),
      body: JSON.stringify({ messages: [], padding: "x".repeat(64) }),
    });

    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining("16-byte limit"),
    });
    expect(mocks.handleChatRequest).not.toHaveBeenCalled();
  });

  it("returns 415 when content-type is not application/json", async () => {
    const h = await start();

    const res = await fetch(`${h.localUrl}/api/chat`, {
      method: "POST",
      headers: chatHeaders(TOKEN, "text/plain"),
      body: "not json",
    });

    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({
      error: "Expected content-type: application/json",
    });
    expect(mocks.handleChatRequest).not.toHaveBeenCalled();
  });

  it("serves GET /health without auth", async () => {
    const h = await start();

    const res = await fetch(`${h.localUrl}/health`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

describe("resolveModel allowlist", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...OLD_ENV };
  });

  afterEach(() => {
    process.env = OLD_ENV;
    vi.restoreAllMocks();
  });

  it("falls back to the server default for non-allowlisted model ids", () => {
    process.env.COMFYUI_MCP_AGENT_MODEL = "openai:gpt-4.1-mini";
    process.env.COMFYUI_MCP_AGENT_ALLOWED_MODELS = "google:gemini-2.5-flash";
    const spy = vi
      .spyOn(registry, "languageModel")
      .mockImplementation((id) => ({ modelId: String(id) }) as never);

    resolveModel("anthropic:expensive-model");

    expect(spy).toHaveBeenCalledWith("openai:gpt-4.1-mini");
  });

  it("honors allowlisted model ids", () => {
    process.env.COMFYUI_MCP_AGENT_MODEL = "openai:gpt-4.1-mini";
    process.env.COMFYUI_MCP_AGENT_ALLOWED_MODELS = "google:gemini-2.5-flash";
    const spy = vi
      .spyOn(registry, "languageModel")
      .mockImplementation((id) => ({ modelId: String(id) }) as never);

    resolveModel("google:gemini-2.5-flash");

    expect(spy).toHaveBeenCalledWith("google:gemini-2.5-flash");
  });
});
