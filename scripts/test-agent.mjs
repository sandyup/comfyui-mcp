// Agent-behavior test runner — spins up a TEST orchestrator (separate port,
// COMFYUI_URL pointed at a dead port so the agent can't touch real ComfyUI),
// drives it with a headless mock panel per scenario, and asserts what graph/
// workflow commands the agent issued. Prints a PASS/FAIL table and exits with
// the number of failures.
//
//   npm run test:agent        (builds first)
//   node scripts/test-agent.mjs
//
// Each scenario: fresh tab, seed an in-memory graph, send a task, record every
// panel_* command, then check expectations. This is how we verify agent
// behavior (e.g. "new workflow" must NOT wipe the graph) without a browser.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import net from "node:net";
import { WebSocket } from "ws";

const FILTER = process.env.SCENARIO_FILTER || ""; // substring to run one scenario
const LOG_ORCH = process.env.LOG_ORCH === "1";

const PORT = Number(process.env.TEST_PORT || 9112);
const MCP_ENTRY = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const DEAD_COMFY = "http://127.0.0.1:9";
const SCENARIO_CAP_MS = Number(process.env.SCENARIO_CAP_MS || 70000);

// ---- in-memory mock graph + executors (shared per scenario) ----
function makeGraph(seed) {
  let seq = 0;
  const nodes = new Map();
  const add = (type, title) => {
    const id = ++seq;
    nodes.set(id, {
      id, type, title: title || type,
      widgets: { value: 0, text: "" },
      inputs: [{ name: "in0", type: "*", link: null }, { name: "model", type: "MODEL", link: null }],
      outputs: [{ name: "out0", type: "*", links: [] }, { name: "MODEL", type: "MODEL", links: [] }],
    });
    return nodes.get(id);
  };
  for (let i = 0; i < seed; i++) add(`SeedNode${i}`, `Existing ${i}`);
  const brief = (n) => ({ id: n.id, type: n.type, title: n.title, widgets: n.widgets, inputs: n.inputs, outputs: n.outputs });
  const EXEC = {
    graph_get_state: () => ({ viewing: { scope: "root" }, node_count: nodes.size, truncated: false, nodes: [...nodes.values()].map(brief) }),
    graph_add_node: ({ class_type, title }) => { if (!class_type) throw new Error("class_type required"); return { added: brief(add(class_type, title)) }; },
    graph_remove_node: ({ node_id }) => { const n = nodes.get(Number(node_id)); if (!n) throw new Error("no node"); nodes.delete(Number(node_id)); return { removed: brief(n) }; },
    graph_clear: () => { const c = nodes.size; nodes.clear(); return { cleared: c }; },
    graph_connect: ({ from_node_id, to_node_id }) => ({ connected: { from: { node_id: from_node_id }, to: { node_id: to_node_id } } }),
    graph_disconnect: ({ node_id }) => ({ disconnected: { node_id } }),
    graph_set_widget: ({ node_id, widget, value }) => { const n = nodes.get(Number(node_id)); if (!n) throw new Error("no node"); const p = n.widgets[widget]; n.widgets[widget] = value; return { set: { node_id, widget, previous: p, value } }; },
    graph_move_node: ({ node_id, pos }) => ({ moved: { node_id, to: pos } }),
    graph_canvas: ({ action }) => ({ canvas: { action } }),
    graph_run: ({ batch_count }) => ({ queued: true, batch_count: batch_count ?? 1 }),
    graph_get_errors: () => ({ last_execution_error: null, node_errors: null, note: "no errors" }),
    workflow_save: () => ({ saved: true, workflow: "mock" }),
    workflow_save_as: ({ name }) => ({ saved_as: `workflows/${name}.json` }),
    workflow_new: () => ({ created: true, active: "Untitled (new tab)" }),
    workflow_list: () => ({ active: { path: "workflows/current.json", filename: "current.json", key: "cur" }, open: [{ path: "workflows/current.json", filename: "current.json", key: "cur", active: true, modified: true, persisted: true }] }),
    workflow_open: ({ path }) => ({ opened: { path, filename: path } }),
    workflow_rename: ({ name }) => ({ renamed: { to: `${name}.json` } }),
    workflow_close: ({ path }) => ({ closed: { path } }),
    graph_select_nodes: ({ node_ids }) => ({ selected: node_ids }),
    graph_create_subgraph: ({ node_ids }) => ({ subgraph: { node_id: ++seq, name: "Subgraph", from_nodes: node_ids } }),
    // Built-in Manager (v2) mock
    nodes_search: ({ query }) => ({
      count: 1,
      results: [{ id: "comfyui-kjnodes", title: "ComfyUI-KJNodes", description: `matches ${query}` }],
    }),
    nodes_list: () => ({ installed: { node_packs: {} } }),
    nodes_install: ({ id, repository }) => ({ queued: true, ui_id: "test-ui", id: id ?? repository }),
    nodes_queue_status: () => ({ status: { done_count: 1, total_count: 1, in_progress_count: 0 } }),
    comfy_reboot: () => ({ rebooting: true }),
  };
  return { nodes, EXEC };
}

function waitForPort(port, timeoutMs = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const s = net.connect(port, "127.0.0.1");
      s.on("connect", () => { s.destroy(); resolve(true); });
      s.on("error", () => { s.destroy(); if (Date.now() - start > timeoutMs) reject(new Error("port timeout")); else setTimeout(tick, 300); });
    };
    tick();
  });
}

function runScenario(sc, idx) {
  return new Promise((resolve) => {
    const { nodes, EXEC } = makeGraph(sc.seed || 0);
    const commands = [];
    const says = [];
    let done = false;
    let graceTimer = null;
    let phase = 0;
    let saysBeforeEvent = -1;
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const hard = setTimeout(finish, SCENARIO_CAP_MS);
    function onIdle() {
      // After the first turn settles, optionally fire a follow-up event (e.g. a
      // run-finished) and wait for the agent's reaction before finishing.
      if (sc.followEvent && phase === 0) {
        phase = 1;
        saysBeforeEvent = says.length;
        try { ws.send(JSON.stringify(sc.followEvent)); } catch {}
        return;
      }
      finish();
    }
    function finish() {
      if (done) return;
      done = true;
      clearTimeout(hard); if (graceTimer) clearTimeout(graceTimer);
      try { ws.close(); } catch {}
      const counts = {};
      for (const c of commands) counts[c] = (counts[c] || 0) + 1;
      resolve({ counts, says, finalNodes: nodes.size, saysBeforeEvent });
    }
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "hello", tab_id: `test-${idx}-${sc.seed}`, title: "test" }));
      setTimeout(() => ws.send(JSON.stringify({ type: "user_message", text: sc.task })), 1200);
    });
    ws.on("message", (buf) => {
      let m; try { m = JSON.parse(buf.toString()); } catch { return; }
      if (typeof m.rid === "string" && typeof m.cmd === "string") {
        commands.push(m.cmd);
        let reply;
        try { const fn = EXEC[m.cmd]; if (!fn) throw new Error(`unknown ${m.cmd}`); reply = { rid: m.rid, ok: true, result: fn(m) }; }
        catch (e) { reply = { rid: m.rid, ok: false, error: e.message }; }
        try { ws.send(JSON.stringify(reply)); } catch {}
        return;
      }
      if (m.type === "say") says.push(m.text);
      // The result push carries a numeric context_pct → turn finished; grace then advance.
      if (m.type === "agent_status" && typeof m.context_pct === "number") {
        if (graceTimer) clearTimeout(graceTimer);
        graceTimer = setTimeout(onIdle, 3500);
      }
    });
    ws.on("error", () => {});
  });
}

const SCENARIOS = [
  {
    name: "build graph on canvas (#6)",
    seed: 0,
    task: "Add a CheckpointLoaderSimple node and a KSampler node to my canvas, then connect the checkpoint MODEL output to the KSampler model input. Don't generate, just build.",
    check: (r) => ({
      pass: (r.counts.graph_add_node || 0) >= 2 && (r.counts.graph_connect || 0) >= 1 && !r.counts.graph_clear,
      detail: `add=${r.counts.graph_add_node || 0} connect=${r.counts.graph_connect || 0} clear=${r.counts.graph_clear || 0}`,
    }),
  },
  {
    name: "new workflow is NON-destructive",
    seed: 6,
    task: "This fruit-stand workflow is done. Start a brand-new workflow for a short video — a fresh canvas for the new project.",
    check: (r) => ({
      pass: (r.counts.workflow_new || 0) >= 1 && !r.counts.graph_clear && r.finalNodes === 6,
      detail: `workflow_new=${r.counts.workflow_new || 0} clear=${r.counts.graph_clear || 0} nodesLeft=${r.finalNodes}/6`,
    }),
  },
  {
    name: "explicit clear STILL works",
    seed: 4,
    task: "Wipe this canvas completely — delete every node on the current workflow so it's empty.",
    check: (r) => ({
      pass: (r.counts.graph_clear || 0) >= 1 || (r.counts.graph_remove_node || 0) >= 4,
      detail: `clear=${r.counts.graph_clear || 0} remove=${r.counts.graph_remove_node || 0}`,
    }),
  },
  {
    name: "create subgraph from nodes",
    seed: 3,
    task: "Group nodes 1, 2 and 3 on my canvas into a single subgraph.",
    check: (r) => ({
      pass: (r.counts.graph_create_subgraph || 0) >= 1,
      detail: `create_subgraph=${r.counts.graph_create_subgraph || 0} select=${r.counts.graph_select_nodes || 0}`,
    }),
  },
  {
    name: "asks choices in chat (no picker)",
    seed: 0,
    task: "I want to turn my current image into a short video. Should I use WAN or Kling? Ask me which one first, before building anything.",
    check: (r) => {
      const txt = r.says.join(" ").toLowerCase();
      return {
        pass: txt.includes("wan") && txt.includes("kling"),
        detail: `offered both options in chat=${txt.includes("wan") && txt.includes("kling")}`,
      };
    },
  },
  {
    name: "installs missing node via built-in Manager",
    seed: 0,
    task: "I want to use the KJNodes 'ImageSharpen' node but I don't have KJNodes installed. Please install it for me.",
    check: (r) => ({
      pass: (r.counts.nodes_install || 0) >= 1,
      detail: `search=${r.counts.nodes_search || 0} install=${r.counts.nodes_install || 0} reboot=${r.counts.comfy_reboot || 0}`,
    }),
  },
  {
    name: "run-finished event reaches agent (#7)",
    seed: 2,
    task: "I'm about to render my fruit-stand image — just stand by, you'll get an event when it finishes.",
    followEvent: {
      type: "agent_event",
      kind: "executed",
      images: [{ filename: "IDEOGRAM_00007.png", subfolder: "", type: "output" }],
    },
    check: (r) => ({
      pass: r.saysBeforeEvent >= 0 && r.says.length > r.saysBeforeEvent,
      detail: `reactedToEvent=${r.says.length > r.saysBeforeEvent} (says ${r.saysBeforeEvent}→${r.says.length})`,
    }),
  },
];

async function main() {
  console.log(`[test-agent] starting test orchestrator on :${PORT} (COMFYUI_URL=${DEAD_COMFY})`);
  const env = { ...process.env, COMFYUI_MCP_BRIDGE_PORT: String(PORT), COMFYUI_URL: DEAD_COMFY, COMFYUI_MCP_PARENT_PID: "" };
  delete env.COMFYUI_MCP_PARENT_PID;
  let stdio = ["ignore", "ignore", "ignore"];
  let logFd = null;
  if (LOG_ORCH) {
    logFd = fs.openSync(fileURLToPath(new URL("../test-orch-debug.log", import.meta.url)), "w");
    stdio = ["ignore", logFd, logFd];
  }
  const orch = spawn(process.execPath, [MCP_ENTRY, "--panel-orchestrator"], { env, stdio });
  let exitCode = 1;
  try {
    await waitForPort(PORT);
    console.log("[test-agent] orchestrator up. running scenarios...\n");
    const results = [];
    for (let i = 0; i < SCENARIOS.length; i++) {
      if (FILTER && !SCENARIOS[i].name.includes(FILTER)) continue;
      process.stdout.write(`  • ${SCENARIOS[i].name} ... `);
      const r = await runScenario(SCENARIOS[i], i);
      const v = SCENARIOS[i].check(r);
      results.push({ name: SCENARIOS[i].name, ...v, cmds: JSON.stringify(r.counts) });
      console.log(v.pass ? `PASS (${v.detail})` : `FAIL (${v.detail})`);
    }
    const fails = results.filter((r) => !r.pass);
    console.log(`\n===== ${results.length - fails.length}/${results.length} PASSED =====`);
    for (const r of results) console.log(`${r.pass ? "✓" : "✗"} ${r.name}  [${r.cmds}]`);
    exitCode = fails.length;
  } catch (e) {
    console.error("[test-agent] ERROR:", e.message);
    exitCode = 1;
  } finally {
    try { orch.kill("SIGTERM"); } catch {}
    setTimeout(() => { try { orch.kill("SIGKILL"); } catch {}; process.exit(exitCode); }, 1000);
  }
}
main();
