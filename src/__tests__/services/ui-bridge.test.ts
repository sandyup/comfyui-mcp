import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { UiBridge } from "../../services/ui-bridge.js";

let bridge: UiBridge;
let port: number;

function connectPanel(tabId?: string, title = "workflow-a"): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(`ws://127.0.0.1:${port}`);
    sock.on("open", () => {
      if (tabId) {
        sock.send(JSON.stringify({ type: "hello", tab_id: tabId, title }));
      }
      resolve(sock);
    });
    sock.on("error", reject);
  });
}

/** Auto-reply to commands with a tag identifying which panel answered. */
function autoReply(sock: WebSocket, tag: string): void {
  sock.on("message", (buf) => {
    const msg = JSON.parse(buf.toString());
    if (msg.rid && msg.cmd) {
      sock.send(JSON.stringify({ rid: msg.rid, ok: true, result: { from: tag, cmd: msg.cmd } }));
    }
  });
}

beforeEach(() => {
  port = 20000 + Math.floor(Math.random() * 20000);
  bridge = new UiBridge(port);
  bridge.start();
});

afterEach(async () => {
  await bridge.stop();
  vi.restoreAllMocks();
});

describe("UiBridge (token gate — secure/wss mode)", () => {
  it("accepts the correct token and rejects a missing one", async () => {
    const tport = 20000 + Math.floor(Math.random() * 20000);
    const tbridge = new UiBridge(tport, "s3cr3t-token");
    tbridge.start();
    expect(await tbridge.whenReady()).toBe(true);

    // No token → the verifyClient 401 makes the client error out without opening.
    await expect(
      new Promise((resolve, reject) => {
        const s = new WebSocket(`ws://127.0.0.1:${tport}`);
        s.on("open", () => reject(new Error("opened without a token")));
        s.on("error", () => resolve("rejected"));
      }),
    ).resolves.toBe("rejected");

    // Correct token → opens and can register a tab.
    const ok = await new Promise<WebSocket>((resolve, reject) => {
      const s = new WebSocket(`ws://127.0.0.1:${tport}/?token=s3cr3t-token`);
      s.on("open", () => resolve(s));
      s.on("error", reject);
    });
    ok.send(JSON.stringify({ type: "hello", tab_id: "tab-secure-1", title: "wf" }));
    await vi.waitFor(() => expect(tbridge.connected()).toBe(true));
    ok.close();
    await tbridge.stop();
  });

  it("rejects a wrong token", async () => {
    const tport = 20000 + Math.floor(Math.random() * 20000);
    const tbridge = new UiBridge(tport, "right-token");
    tbridge.start();
    expect(await tbridge.whenReady()).toBe(true);
    await expect(
      new Promise((resolve, reject) => {
        const s = new WebSocket(`ws://127.0.0.1:${tport}/?token=wrong`);
        s.on("open", () => reject(new Error("opened with a wrong token")));
        s.on("error", () => resolve("rejected"));
      }),
    ).resolves.toBe("rejected");
    await tbridge.stop();
  });
});

describe("UiBridge (multi-tab)", () => {
  it("routes to the single connected tab without tab_id", async () => {
    const a = await connectPanel("tab-aaaa-1111");
    autoReply(a, "A");
    await vi.waitFor(() => expect(bridge.connected()).toBe(true));
    const result = await bridge.send({ cmd: "graph_get_state" });
    expect(result).toEqual({ from: "A", cmd: "graph_get_state" });
    a.close();
  });

  it("registers multiple tabs and lists them in status()", async () => {
    const a = await connectPanel("tab-aaaa-1111", "flux-workflow");
    const b = await connectPanel("tab-bbbb-2222", "video-workflow");
    await vi.waitFor(() => expect(bridge.tabs()).toHaveLength(2));
    const status = bridge.status();
    expect(status).toContain("2 panel tab(s) connected");
    expect(status).toContain("flux-workflow");
    expect(status).toContain("video-workflow");
    a.close();
    b.close();
  });

  it("routes by explicit tab_id (full id and 8-char prefix)", async () => {
    const a = await connectPanel("tab-aaaa-1111");
    const b = await connectPanel("tab-bbbb-2222");
    autoReply(a, "A");
    autoReply(b, "B");
    await vi.waitFor(() => expect(bridge.tabs()).toHaveLength(2));

    const full = await bridge.send({ cmd: "x" }, { tabId: "tab-bbbb-2222" });
    expect(full).toMatchObject({ from: "B" });
    const prefix = await bridge.send({ cmd: "x" }, { tabId: "tab-aaaa" });
    expect(prefix).toMatchObject({ from: "A" });
    a.close();
    b.close();
  });

  it("errors with the tab list when multiple tabs and no target", async () => {
    const a = await connectPanel("tab-aaaa-1111", "one");
    const b = await connectPanel("tab-bbbb-2222", "two");
    await vi.waitFor(() => expect(bridge.tabs()).toHaveLength(2));
    await expect(bridge.send({ cmd: "x" })).rejects.toThrow(/pass tab_id/);
    a.close();
    b.close();
  });

  it("defaults to the last tab the user typed in", async () => {
    const a = await connectPanel("tab-aaaa-1111");
    const b = await connectPanel("tab-bbbb-2222");
    autoReply(a, "A");
    autoReply(b, "B");
    await vi.waitFor(() => expect(bridge.tabs()).toHaveLength(2));

    // User types in tab B → it becomes the default target.
    b.send(JSON.stringify({ type: "user_message", text: "hi from B" }));
    await vi.waitFor(async () => {
      const result = await bridge.send({ cmd: "x" });
      expect(result).toMatchObject({ from: "B" });
    });
    a.close();
    b.close();
  });

  it("stamps user_message events with tab_id and title", async () => {
    const received: unknown[] = [];
    bridge.onPanelMessage = (e) => {
      if (e.type === "user_message") received.push(e);
    };
    const a = await connectPanel("tab-aaaa-1111", "my-flux-graph");
    await vi.waitFor(() => expect(bridge.tabs()).toHaveLength(1));
    a.send(JSON.stringify({ type: "user_message", text: "make it dreamier" }));
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toMatchObject({
      text: "make it dreamier",
      tab_id: "tab-aaaa-1111",
      title: "my-flux-graph",
    });
    a.close();
  });

  it("push() broadcasts to all tabs by default and targets with tabId", async () => {
    const got: Record<string, unknown[]> = { A: [], B: [] };
    const a = await connectPanel("tab-aaaa-1111");
    const b = await connectPanel("tab-bbbb-2222");
    a.on("message", (buf) => {
      const m = JSON.parse(buf.toString());
      if (m.type === "say") got.A.push(m);
    });
    b.on("message", (buf) => {
      const m = JSON.parse(buf.toString());
      if (m.type === "say") got.B.push(m);
    });
    await vi.waitFor(() => expect(bridge.tabs()).toHaveLength(2));

    expect(bridge.push({ type: "say", text: "to all" })).toBe(2);
    expect(bridge.push({ type: "say", text: "only B" }, "tab-bbbb")).toBe(1);
    await vi.waitFor(() => {
      expect(got.A).toHaveLength(1);
      expect(got.B).toHaveLength(2);
    });
    a.close();
    b.close();
  });

  it("same tab reconnecting (reload) supersedes its stale socket without touching other tabs", async () => {
    const a1 = await connectPanel("tab-aaaa-1111");
    const b = await connectPanel("tab-bbbb-2222");
    autoReply(b, "B");
    await vi.waitFor(() => expect(bridge.tabs()).toHaveLength(2));

    const a2 = await connectPanel("tab-aaaa-1111"); // reload of tab A
    autoReply(a2, "A2");
    await vi.waitFor(() => expect(a1.readyState).toBe(WebSocket.CLOSED));
    expect(bridge.tabs()).toHaveLength(2);

    const viaA = await bridge.send({ cmd: "x" }, { tabId: "tab-aaaa" });
    expect(viaA).toMatchObject({ from: "A2" });
    const viaB = await bridge.send({ cmd: "x" }, { tabId: "tab-bbbb" });
    expect(viaB).toMatchObject({ from: "B" });
    a2.close();
    b.close();
  });

  it("times out when the target tab never replies", async () => {
    const a = await connectPanel("tab-aaaa-1111");
    await vi.waitFor(() => expect(bridge.tabs()).toHaveLength(1));
    await expect(bridge.send({ cmd: "x" }, { timeoutMs: 100 })).rejects.toThrow(/did not reply/);
    a.close();
  });

  it("rejects in-flight commands when the target tab disconnects", async () => {
    const a = await connectPanel("tab-aaaa-1111");
    await vi.waitFor(() => expect(bridge.tabs()).toHaveLength(1));
    const promise = bridge.send({ cmd: "x" }, { timeoutMs: 5000 });
    a.close();
    await expect(promise).rejects.toThrow(/disconnected mid-command/);
  });

  it("fails fast with guidance when no tab is connected", async () => {
    await expect(bridge.send({ cmd: "x" })).rejects.toThrow(/no panel connected/);
  });

  it("rejects an unknown tab_id with the connected-tab list", async () => {
    const a = await connectPanel("tab-aaaa-1111", "one");
    await vi.waitFor(() => expect(bridge.tabs()).toHaveLength(1));
    await expect(bridge.send({ cmd: "x" }, { tabId: "nope" })).rejects.toThrow(/no connected tab/);
    a.close();
  });

  it("retries binding when the port is briefly held, then self-heals", async () => {
    // Simulate a fast /mcp reconnect: a previous session still owns the port
    // when the new bridge starts. It should back off, retry, and bind once the
    // old owner releases the port — without crashing.
    const racePort = 40000 + Math.floor(Math.random() * 20000);
    const blocker = new WebSocketServer({ port: racePort, host: "127.0.0.1" });
    await new Promise<void>((resolve) => blocker.on("listening", () => resolve()));

    const reconnecting = new UiBridge(racePort);
    reconnecting.start(); // hits EADDRINUSE, schedules a retry
    // Release the contended port shortly after, mid-backoff.
    setTimeout(() => blocker.close(), 250);

    try {
      // Eventually the retried bind succeeds and accepts a panel connection.
      await vi.waitFor(
        () =>
          new Promise<void>((resolve, reject) => {
            const probe = new WebSocket(`ws://127.0.0.1:${racePort}`);
            probe.on("open", () => {
              probe.close();
              resolve();
            });
            probe.on("error", reject);
          }),
        { timeout: 8000, interval: 150 },
      );
    } finally {
      await reconnecting.stop();
    }
  });
});
