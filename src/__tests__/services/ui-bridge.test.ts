import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { UiBridge } from "../../services/ui-bridge.js";

let bridge: UiBridge;
let port: number;

function connectPanel(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(`ws://127.0.0.1:${port}`);
    sock.on("open", () => resolve(sock));
    sock.on("error", reject);
  });
}

beforeEach(() => {
  // Random high port per test to avoid cross-test EADDRINUSE.
  port = 20000 + Math.floor(Math.random() * 20000);
  bridge = new UiBridge(port);
  bridge.start();
});

afterEach(async () => {
  await bridge.stop();
  vi.restoreAllMocks();
});

describe("UiBridge", () => {
  it("correlates a command with its rid'd reply", async () => {
    const sock = await connectPanel();
    sock.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      expect(msg.cmd).toBe("graph_get_state");
      sock.send(JSON.stringify({ rid: msg.rid, ok: true, result: { node_count: 3 } }));
    });
    await vi.waitFor(() => expect(bridge.connected()).toBe(true));
    const result = await bridge.send({ cmd: "graph_get_state" });
    expect(result).toEqual({ node_count: 3 });
    sock.close();
  });

  it("rejects with the panel's error string on ok:false", async () => {
    const sock = await connectPanel();
    sock.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      sock.send(JSON.stringify({ rid: msg.rid, ok: false, error: "no widget named steps" }));
    });
    await vi.waitFor(() => expect(bridge.connected()).toBe(true));
    await expect(bridge.send({ cmd: "graph_set_widget" })).rejects.toThrow(
      "no widget named steps",
    );
    sock.close();
  });

  it("times out when the panel never replies", async () => {
    const sock = await connectPanel();
    await vi.waitFor(() => expect(bridge.connected()).toBe(true));
    await expect(bridge.send({ cmd: "graph_get_state" }, 100)).rejects.toThrow(
      /did not reply/,
    );
    sock.close();
  });

  it("rejects in-flight commands immediately when the panel disconnects", async () => {
    const sock = await connectPanel();
    await vi.waitFor(() => expect(bridge.connected()).toBe(true));
    const promise = bridge.send({ cmd: "graph_get_state" }, 5000);
    sock.close();
    await expect(promise).rejects.toThrow(/disconnected mid-command/);
  });

  it("fails fast with status guidance when no panel is connected", async () => {
    await expect(bridge.send({ cmd: "graph_get_state" })).rejects.toThrow(
      /no panel connected/,
    );
  });

  it("forwards rid-less user_message frames to onPanelMessage", async () => {
    const received: unknown[] = [];
    bridge.onPanelMessage = (event) => received.push(event);
    const sock = await connectPanel();
    await vi.waitFor(() => expect(bridge.connected()).toBe(true));
    sock.send(JSON.stringify({ type: "user_message", text: "make it dreamier" }));
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toMatchObject({ type: "user_message", text: "make it dreamier" });
    sock.close();
  });

  it("push() delivers fire-and-forget frames to the panel", async () => {
    const sock = await connectPanel();
    await vi.waitFor(() => expect(bridge.connected()).toBe(true));
    const got = new Promise<unknown>((resolve) => {
      sock.on("message", (buf) => resolve(JSON.parse(buf.toString())));
    });
    bridge.push({ type: "say", text: "added the KSampler" });
    expect(await got).toEqual({ type: "say", text: "added the KSampler" });
    sock.close();
  });

  it("last writer wins on reconnect", async () => {
    const first = await connectPanel();
    await vi.waitFor(() => expect(bridge.connected()).toBe(true));
    const second = await connectPanel();
    await vi.waitFor(() => expect(second.readyState).toBe(WebSocket.OPEN));
    // First socket gets closed by the server.
    await vi.waitFor(() => expect(first.readyState).toBe(WebSocket.CLOSED));
    second.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      second.send(JSON.stringify({ rid: msg.rid, ok: true, result: "from-second" }));
    });
    await expect(bridge.send({ cmd: "graph_get_state" })).resolves.toBe("from-second");
    second.close();
  });
});
