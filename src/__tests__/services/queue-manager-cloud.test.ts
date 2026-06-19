import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stub config + cloud-client BEFORE importing queue-manager.
vi.mock("../../config.js", async () => {
  const actual = await vi.importActual<typeof import("../../config.js")>(
    "../../config.js",
  );
  return { ...actual, isCloudMode: () => true };
});

const cloudGetJobStatus = vi.fn();
const cloudGetHistory = vi.fn();

vi.mock("../../comfyui/cloud-client.js", () => ({
  getJobStatus: (...args: unknown[]) => cloudGetJobStatus(...args),
  getHistory: (...args: unknown[]) => cloudGetHistory(...args),
}));

// Stub the local client so importing queue-manager doesn't try to attach to
// a real ComfyUI. Only getHistory is hit on the local path; it should NOT
// be called in cloud mode for the tests below.
const localGetHistory = vi.fn();
vi.mock("../../comfyui/client.js", () => ({
  getClient: vi.fn(() => {
    throw new Error("getClient should not be called in cloud mode");
  }),
  getHistory: (...args: unknown[]) => localGetHistory(...args),
  getQueue: vi.fn(),
  interrupt: vi.fn(),
  deleteQueueItem: vi.fn(),
  clearQueue: vi.fn(),
  enqueuePrompt: vi.fn(),
}));

const { getJobStatus } = await import("../../services/queue-manager.js");

describe("queue-manager getJobStatus (cloud mode)", () => {
  beforeEach(() => {
    cloudGetJobStatus.mockReset();
    cloudGetHistory.mockReset();
    localGetHistory.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("maps cloud 'pending' to pending:true done:false", async () => {
    cloudGetJobStatus.mockResolvedValue({ status: "pending" });
    const r = await getJobStatus("p1");
    expect(r).toMatchObject({
      running: false,
      pending: true,
      done: false,
      status_str: "pending",
    });
    // No history fetch for incomplete jobs.
    expect(localGetHistory).not.toHaveBeenCalled();
  });

  it("maps cloud 'in_progress' to running:true done:false", async () => {
    cloudGetJobStatus.mockResolvedValue({ status: "in_progress" });
    const r = await getJobStatus("p2");
    expect(r).toMatchObject({ running: true, pending: false, done: false });
  });

  it("maps cloud 'completed' to done:true and enriches from cloud history", async () => {
    cloudGetJobStatus.mockResolvedValue({ status: "completed" });
    localGetHistory.mockResolvedValue({
      p3: {
        prompt: {},
        outputs: {},
        status: { status_str: "success", completed: true, messages: [] },
      },
    });
    const r = await getJobStatus("p3");
    expect(r.done).toBe(true);
    expect(r.running).toBe(false);
    expect(r.pending).toBe(false);
    expect(r.status_str).toBe("success");
  });

  it("falls back to cloud.error when history is unavailable for a failed job", async () => {
    cloudGetJobStatus.mockResolvedValue({
      status: "failed",
      error: "OOM at SamplerCustom",
    });
    localGetHistory.mockRejectedValue(new Error("404"));
    const r = await getJobStatus("p4");
    expect(r.done).toBe(true);
    expect(r.error).toEqual({
      node_id: "",
      node_type: "",
      exception_message: "OOM at SamplerCustom",
    });
  });

  it("returns the base status without error when failed but no error string and no history", async () => {
    cloudGetJobStatus.mockResolvedValue({ status: "failed" });
    localGetHistory.mockResolvedValue({});
    const r = await getJobStatus("p5");
    expect(r.done).toBe(true);
    expect(r.status_str).toBe("failed");
    expect(r.error).toBeUndefined();
  });
});
