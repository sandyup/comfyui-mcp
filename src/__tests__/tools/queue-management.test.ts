import { beforeEach, describe, expect, it, vi } from "vitest";

const getQueueSummaryMock = vi.fn();
const getQueuedWorkflowMock = vi.fn();
const moveQueuedJobMock = vi.fn();
const editQueuedJobMock = vi.fn();

vi.mock("../../services/queue-manager.js", () => ({
  getQueueSummary: (...args: unknown[]) => getQueueSummaryMock(...args),
  getJobStatus: vi.fn(),
  getQueuedWorkflow: (...args: unknown[]) => getQueuedWorkflowMock(...args),
  moveQueuedJob: (...args: unknown[]) => moveQueuedJobMock(...args),
  editQueuedJob: (...args: unknown[]) => editQueuedJobMock(...args),
  cancelRunningJob: vi.fn(),
  cancelQueuedJob: vi.fn(),
  clearAllQueued: vi.fn(),
}));

import { registerQueueManagementTools } from "../../tools/queue-management.js";

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
  registerQueueManagementTools(server as never);
  return handlers;
}

beforeEach(() => {
  getQueueSummaryMock.mockReset();
  getQueuedWorkflowMock.mockReset();
  moveQueuedJobMock.mockReset();
  editQueuedJobMock.mockReset();
});

describe("queue management tools", () => {
  it("wires enhanced queue inspection and edit tools", async () => {
    const handlers = makeServer();
    expect(handlers.has("get_queued_workflow")).toBe(true);
    expect(handlers.has("move_queued_job")).toBe(true);
    expect(handlers.has("edit_queued_job")).toBe(true);

    getQueueSummaryMock.mockResolvedValueOnce({ pending: 0, running: 0 });
    await handlers.get("get_queue")!({ include_workflows: true });
    expect(getQueueSummaryMock).toHaveBeenCalledWith({ include_workflows: true });

    getQueuedWorkflowMock.mockResolvedValueOnce({ prompt_id: "p1" });
    await handlers.get("get_queued_workflow")!({ prompt_id: "p1" });
    expect(getQueuedWorkflowMock).toHaveBeenCalledWith("p1");

    moveQueuedJobMock.mockResolvedValueOnce({ old_prompt_id: "p1", new_prompt_id: "p2" });
    await handlers.get("move_queued_job")!({ prompt_id: "p1", position: "front" });
    expect(moveQueuedJobMock).toHaveBeenCalledWith("p1", "front");

    editQueuedJobMock.mockResolvedValueOnce({ old_prompt_id: "p1", new_prompt_id: "p3" });
    await handlers.get("edit_queued_job")!({
      prompt_id: "p1",
      node_inputs: { "2": { steps: 12 } },
      position: "back",
    });
    expect(editQueuedJobMock).toHaveBeenCalledWith({
      prompt_id: "p1",
      workflow: undefined,
      node_inputs: { "2": { steps: 12 } },
      position: "back",
    });
  });
});
