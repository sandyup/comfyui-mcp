import { describe, expect, it, beforeEach, vi } from "vitest";

import {
  pickActive,
  reduceGood,
  reduceBad,
  bisectStart,
  bisectGood,
  bisectBad,
  bisectReset,
  bisectStatus,
  __resetSessionForTests,
  type BisectState,
  type NodeController,
} from "../../services/node-bisect.js";

// ---------------------------------------------------------------------------
// In-memory controller — records enable/disable calls, no real side effects.
// ---------------------------------------------------------------------------

function makeController(
  nodes: string[],
  disabledAtStart: string[] = [],
): {
  controller: NodeController;
  enabled: Set<string>;
  calls: Array<{ enabled: string[]; disabled: string[] }>;
} {
  const enabled = new Set<string>(
    nodes.filter((n) => !disabledAtStart.includes(n)),
  );
  const calls: Array<{ enabled: string[]; disabled: string[] }> = [];
  const controller: NodeController = {
    async listNodes() {
      // Reflect current enabled-state, preserving input order.
      return nodes.map((id) => ({ id, enabled: enabled.has(id) }));
    },
    async setEnabledStates(en, dis) {
      calls.push({ enabled: [...en], disabled: [...dis] });
      for (const n of dis) enabled.delete(n);
      for (const n of en) enabled.add(n);
    },
  };
  return { controller, enabled, calls };
}

/** Build a minimal running state for pure-reducer tests. */
function running(
  all: string[],
  range: string[],
  active: string[],
): BisectState {
  return { status: "running", all, range, active, culprit: null };
}

beforeEach(() => {
  __resetSessionForTests();
});

// ---------------------------------------------------------------------------
// Pure reducers
// ---------------------------------------------------------------------------

describe("pickActive", () => {
  it("selects the upper half (matches comfy-cli range[len//2:])", () => {
    expect(pickActive(["a", "b", "c", "d"])).toEqual(["c", "d"]);
    expect(pickActive(["a", "b", "c"])).toEqual(["b", "c"]);
    expect(pickActive(["a"])).toEqual(["a"]);
    expect(pickActive([])).toEqual([]);
  });
});

describe("reduceGood", () => {
  it("drops the active set from range (culprit among disabled)", () => {
    // all=4, active=upper half [c,d]; GOOD => range becomes [a,b]
    const s = running(["a", "b", "c", "d"], ["a", "b", "c", "d"], ["c", "d"]);
    const next = reduceGood(s);
    expect(next.status).toBe("running");
    expect(next.range).toEqual(["a", "b"]);
    expect(next.active).toEqual(["b"]); // upper half of [a,b]
    expect(next.culprit).toBeNull();
  });

  it("resolves when reduced range collapses to one", () => {
    const s = running(["a", "b"], ["a", "b"], ["b"]);
    const next = reduceGood(s); // range - active = [a]
    expect(next.status).toBe("resolved");
    expect(next.culprit).toBe("a");
    expect(next.active).toEqual([]);
  });
});

describe("reduceBad", () => {
  it("keeps the active set as the new range (culprit within active)", () => {
    const s = running(["a", "b", "c", "d"], ["a", "b", "c", "d"], ["c", "d"]);
    const next = reduceBad(s);
    expect(next.status).toBe("running");
    expect(next.range).toEqual(["c", "d"]);
    expect(next.active).toEqual(["d"]); // upper half of [c,d]
  });

  it("resolves when active is a single node", () => {
    const s = running(["a", "b"], ["a", "b"], ["b"]);
    const next = reduceBad(s); // new range = active = [b]
    expect(next.status).toBe("resolved");
    expect(next.culprit).toBe("b");
  });
});

// ---------------------------------------------------------------------------
// Service orchestration / state machine
// ---------------------------------------------------------------------------

describe("bisectStart", () => {
  it("enables the upper half and disables the rest", async () => {
    const { controller, enabled, calls } = makeController([
      "a",
      "b",
      "c",
      "d",
    ]);
    const { state } = await bisectStart({ controller });

    expect(state.status).toBe("running");
    expect(state.all).toEqual(["a", "b", "c", "d"]);
    expect(state.active).toEqual(["c", "d"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].enabled).toEqual(["c", "d"]);
    expect(calls[0].disabled).toEqual(["a", "b"]);
    expect([...enabled].sort()).toEqual(["c", "d"]);
  });

  it("errors when no custom nodes are installed", async () => {
    const { controller } = makeController([]);
    await expect(bisectStart({ controller })).rejects.toThrow(
      /No enabled custom nodes/i,
    );
  });

  it("short-circuits to resolved with a single node", async () => {
    const { controller } = makeController(["only"]);
    const { state } = await bisectStart({ controller });
    expect(state.status).toBe("resolved");
    expect(state.culprit).toBe("only");
  });
});

describe("good/bad require a running session", () => {
  it("bisect_good throws when idle", async () => {
    const { controller } = makeController(["a", "b"]);
    await expect(bisectGood({ controller })).rejects.toThrow(
      /No bisect session is in progress/i,
    );
  });

  it("bisect_bad throws when idle", async () => {
    const { controller } = makeController(["a", "b"]);
    await expect(bisectBad({ controller })).rejects.toThrow(
      /No bisect session is in progress/i,
    );
  });
});

describe("convergence (deterministic)", () => {
  it("BAD then BAD narrows 4 nodes to a single culprit and re-enables all", async () => {
    const { controller, enabled } = makeController(["a", "b", "c", "d"]);
    const start = await bisectStart({ controller });
    expect(start.state.active).toEqual(["c", "d"]);

    // Problem present with [c,d] enabled -> BAD. range=[c,d], active=[d]
    const r1 = await bisectBad({ controller });
    expect(r1.state.status).toBe("running");
    expect(r1.state.range).toEqual(["c", "d"]);
    expect(r1.state.active).toEqual(["d"]);

    // Problem still present with [d] -> BAD. range=[d] -> resolved, culprit d
    const r2 = await bisectBad({ controller });
    expect(r2.state.status).toBe("resolved");
    expect(r2.state.culprit).toBe("d");
    // All nodes re-enabled after resolution.
    expect([...enabled].sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("GOOD then BAD isolates a culprit in the lower half", async () => {
    const { controller } = makeController(["a", "b", "c", "d"]);
    await bisectStart({ controller }); // active [c,d]

    // Problem gone with [c,d] -> GOOD. range = [a,b], active = [b]
    const r1 = await bisectGood({ controller });
    expect(r1.state.range).toEqual(["a", "b"]);
    expect(r1.state.active).toEqual(["b"]);

    // Problem present with [b] -> BAD. range=[b] -> resolved culprit b
    const r2 = await bisectBad({ controller });
    expect(r2.state.status).toBe("resolved");
    expect(r2.state.culprit).toBe("b");
  });

  it("GOOD then GOOD isolates the remaining disabled candidate", async () => {
    const { controller } = makeController(["a", "b", "c", "d"]);
    await bisectStart({ controller }); // active [c,d]

    // GOOD: range=[a,b], active=[b]
    await bisectGood({ controller });
    // GOOD again: range = [a,b] - [b] = [a] -> resolved culprit a
    const r = await bisectGood({ controller });
    expect(r.state.status).toBe("resolved");
    expect(r.state.culprit).toBe("a");
  });
});

describe("each round applies the correct enable/disable partition", () => {
  it("disabled set is always the complement of active within all", async () => {
    const { controller, calls } = makeController(["a", "b", "c", "d", "e"]);
    await bisectStart({ controller });
    // all=5, active = range[2:] = [c,d,e]; disabled = [a,b]
    expect(calls[0].enabled).toEqual(["c", "d", "e"]);
    expect(calls[0].disabled).toEqual(["a", "b"]);

    // BAD: range=[c,d,e], active=[d,e]; disabled = all - [d,e] = [a,b,c]
    await bisectBad({ controller });
    expect(calls[1].enabled).toEqual(["d", "e"]);
    expect(calls[1].disabled).toEqual(["a", "b", "c"]);
  });
});

describe("bisectReset", () => {
  it("re-enables all known nodes and clears the session", async () => {
    const { controller, enabled, calls } = makeController(["a", "b", "c", "d"]);
    await bisectStart({ controller }); // disables a,b
    expect([...enabled].sort()).toEqual(["c", "d"]);

    const { state, message } = await bisectReset({ controller });
    expect(state.status).toBe("idle");
    expect([...enabled].sort()).toEqual(["a", "b", "c", "d"]);
    expect(message).toMatch(/Re-enabled 4 custom node/);
    // Last call re-enables everything with nothing disabled.
    const last = calls[calls.length - 1];
    expect(last.enabled.sort()).toEqual(["a", "b", "c", "d"]);
    expect(last.disabled).toEqual([]);

    // Status is idle after reset.
    expect(bisectStatus().state.status).toBe("idle");
  });

  it("with no active session is a no-op (never re-enables user-disabled packs)", async () => {
    const { controller, calls } = makeController(["x", "y"]);
    const { state, message } = await bisectReset({ controller });
    expect(state.status).toBe("idle");
    expect(message).toMatch(/nothing to reset/i);
    expect(calls).toHaveLength(0);
  });

  it("excludes packs disabled before the session and leaves them disabled on reset", async () => {
    // "x" is already disabled when bisect starts.
    const { controller, enabled } = makeController(["a", "b", "c", "x"], ["x"]);
    const start = await bisectStart({ controller });
    expect(start.state.all).toEqual(["a", "b", "c"]); // x excluded from bisect set
    expect(enabled.has("x")).toBe(false);

    await bisectReset({ controller });
    // x stays disabled; only the bisect set is restored.
    expect(enabled.has("x")).toBe(false);
    expect([...enabled].sort()).toEqual(["a", "b", "c"]);
  });
});

describe("bisectStatus", () => {
  it("reports idle before any session", () => {
    const { state, message } = bisectStatus();
    expect(state.status).toBe("idle");
    expect(message).toMatch(/No bisect session is active/i);
  });

  it("reports running detail mid-session", async () => {
    const { controller } = makeController(["a", "b", "c", "d"]);
    await bisectStart({ controller });
    const { state, message } = bisectStatus();
    expect(state.status).toBe("running");
    expect(state.range).toEqual(["a", "b", "c", "d"]);
    expect(message).toMatch(/candidate node/i);
  });

  it("returned state is a snapshot (mutation does not leak into session)", async () => {
    const { controller } = makeController(["a", "b", "c", "d"]);
    await bisectStart({ controller });
    const { state } = bisectStatus();
    state.range.push("injected");
    expect(bisectStatus().state.range).toEqual(["a", "b", "c", "d"]);
  });
});

// ---------------------------------------------------------------------------
// Manager HTTP controller — exercised via mocked global.fetch.
// ---------------------------------------------------------------------------

describe("managerController (mocked fetch)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("lists nodes from /customnode/installed and starts a run when toggling", async () => {
    const { managerController } = await import("../../services/node-bisect.js");

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/customnode/installed")) {
        return new Response(
          JSON.stringify({
            "b-node": { ver: "1.0", enabled: true },
            "a-node": { ver: "1.0", enabled: true },
          }),
          { status: 200 },
        );
      }
      // queue/disable, queue/install, queue/start all succeed
      void init;
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ids = await managerController.listNodes();
    expect(ids).toEqual([
      { id: "a-node", enabled: true },
      { id: "b-node", enabled: true },
    ]); // sorted, stable

    await managerController.setEnabledStates(["a-node"], ["b-node"]);
    const byUrl = (frag: string) =>
      fetchMock.mock.calls.find((c) => (c[0] as string).includes(frag));
    const disableCall = byUrl("/manager/queue/disable");
    const installCall = byUrl("/manager/queue/install");
    expect(disableCall).toBeDefined();
    expect(installCall).toBeDefined();
    expect(byUrl("/manager/queue/start")).toBeDefined();

    // Payloads must carry the pack's REAL installed version (from the cached
    // /customnode/installed descriptor), never "unknown".
    const disableBody = JSON.parse((disableCall![1] as RequestInit).body as string);
    expect(disableBody).toMatchObject({ id: "b-node", version: "1.0" });
    expect(disableBody.version).not.toBe("unknown");
    const installBody = JSON.parse((installCall![1] as RequestInit).body as string);
    expect(installBody).toMatchObject({
      id: "a-node",
      version: "1.0",
      selected_version: "1.0",
      skip_post_install: true,
    });

    vi.unstubAllGlobals();
  });

  it("does not start the queue when nothing changes", async () => {
    const { managerController } = await import("../../services/node-bisect.js");
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await managerController.setEnabledStates([], []);
    expect(fetchMock).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("throws NodeBisectError on a non-OK installed response", async () => {
    const { managerController } = await import("../../services/node-bisect.js");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );
    await expect(managerController.listNodes()).rejects.toThrow(/HTTP 500/);
    vi.unstubAllGlobals();
  });
});
