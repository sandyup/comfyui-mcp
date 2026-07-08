// Shared in-memory litegraph mock — the executor half of mock-panel.mjs,
// factored out so scripts/panel-arena.mjs (fine-tune datagen/eval) can run the
// same graph semantics with per-task state and verify against it.
//
// createMockGraph(seedPreset) → { exec(cmd, args), state, summary() }
// exec() mirrors the bridge's {rid, cmd, ...args} → {ok, result|error} shape.

/** A realistic seeded txt2img canvas (what most user tasks start from). */
export const PRESET_TXT2IMG = [
  { type: "CheckpointLoaderSimple", title: "Load Checkpoint", widgets: { ckpt_name: "v1-5-pruned-emaonly-fp16.safetensors" } },
  { type: "CLIPTextEncode", title: "Positive Prompt", widgets: { text: "a scenic mountain lake" } },
  { type: "CLIPTextEncode", title: "Negative Prompt", widgets: { text: "blurry, low quality" } },
  { type: "EmptyLatentImage", title: "Empty Latent", widgets: { width: 512, height: 512, batch_size: 1 } },
  { type: "KSampler", title: "KSampler", widgets: { seed: 42, steps: 20, cfg: 7, sampler_name: "euler", denoise: 1 } },
  { type: "VAEDecode", title: "VAE Decode", widgets: {} },
  { type: "SaveImage", title: "Save Image", widgets: { filename_prefix: "ComfyUI" } },
];

export function createMockGraph(seedNodes = []) {
  let seq = 0;
  const nodes = new Map();
  const blueprints = new Map();
  let clipboard = [];
  let selection = [];
  const commands = []; // every {cmd, args} the agent issued, in order

  function addNode(type, title, widgets = {}) {
    const id = ++seq;
    nodes.set(id, {
      id,
      type,
      title: title || type,
      widgets: { ...widgets },
      inputs: [
        { name: "in0", type: "*", link: null },
        { name: "model", type: "MODEL", link: null },
      ],
      outputs: [
        { name: "out0", type: "*", links: [] },
        { name: "MODEL", type: "MODEL", links: [] },
      ],
    });
    return nodes.get(id);
  }
  for (const s of seedNodes) addNode(s.type, s.title, s.widgets);

  const summarize = (n) => ({
    id: n.id, type: n.type, title: n.title, is_subgraph: !!n.is_subgraph,
    widgets: n.widgets, inputs: n.inputs, outputs: n.outputs,
  });

  const EXEC = {
    graph_get_state: () => ({
      viewing: { scope: "root" },
      node_count: nodes.size,
      truncated: false,
      nodes: [...nodes.values()].map(summarize),
    }),
    graph_add_node: ({ class_type, title }) => {
      if (!class_type) throw new Error("class_type required");
      return { added: summarize(addNode(class_type, title)) };
    },
    graph_remove_node: ({ node_id }) => {
      const n = nodes.get(Number(node_id));
      if (!n) throw new Error(`no node ${node_id}`);
      nodes.delete(Number(node_id));
      return { removed: summarize(n) };
    },
    graph_clear: () => {
      const c = nodes.size;
      nodes.clear();
      return { cleared: c };
    },
    graph_connect: ({ from_node_id, to_node_id }) => {
      if (!nodes.get(Number(from_node_id)) || !nodes.get(Number(to_node_id))) {
        throw new Error("both nodes must exist");
      }
      return { connected: { from: { node_id: from_node_id }, to: { node_id: to_node_id } } };
    },
    graph_disconnect: ({ node_id }) => ({ disconnected: { node_id } }),
    graph_set_widget: ({ node_id, widget, value }) => {
      const n = nodes.get(Number(node_id));
      if (!n) throw new Error(`no node ${node_id}`);
      const prev = n.widgets[widget];
      n.widgets[widget] = value;
      return { set: { node_id, widget, previous: prev, value } };
    },
    graph_move_node: ({ node_id, pos }) => ({ moved: { node_id, to: pos } }),
    graph_canvas: ({ action }) => ({ canvas: { action } }),
    graph_run: ({ batch_count }) => ({ queued: true, batch_count: batch_count ?? 1 }),
    graph_get_errors: () => ({ last_execution_error: null, node_errors: null, note: "no errors" }),
    graph_outline: () => ({
      viewing: { scope: "root" },
      node_count: nodes.size,
      outline: [...nodes.values()].map((n) => ({ id: n.id, type: n.type, title: n.title })),
    }),
    graph_screenshot: () => ({ captured: true, note: "mock canvas — no pixels", node_count: nodes.size }),
    workflow_save: () => ({ saved: true, workflow: "mock" }),
    workflow_save_as: ({ name }) => ({ saved_as: `workflows/${name}.json` }),
    workflow_new: () => ({ created: true, active: "Untitled (new tab)" }),
    workflow_list: () => ({
      active: { path: "workflows/current.json", filename: "current.json", key: "current" },
      open: [{ path: "workflows/current.json", filename: "current.json", key: "current", active: true, modified: true, persisted: true }],
    }),
    workflow_open: ({ path }) => ({ opened: { path, filename: path } }),
    workflow_rename: ({ name }) => ({ renamed: { to: `${name}.json` } }),
    workflow_close: ({ path }) => ({ closed: { path } }),
    graph_select_nodes: ({ node_ids }) => {
      selection = (node_ids || []).map(Number);
      return { selected: node_ids };
    },
    graph_create_subgraph: ({ node_ids }) => {
      const id = ++seq;
      nodes.set(id, { id, type: "Subgraph", title: "Subgraph", is_subgraph: true, widgets: {}, inputs: [], outputs: [] });
      selection = [id];
      return { subgraph: { node_id: id, name: "Subgraph", from_nodes: node_ids } };
    },
    graph_copy_nodes: ({ node_ids }) => {
      const ids = Array.isArray(node_ids) && node_ids.length ? node_ids.map(Number) : selection;
      const src = ids.map((id) => nodes.get(Number(id))).filter(Boolean);
      if (!src.length) throw new Error("nothing selected to copy");
      clipboard = src.map((n) => ({ type: n.type, title: n.title, widgets: { ...n.widgets } }));
      return { copied: clipboard.length };
    },
    graph_paste_nodes: () => {
      if (!clipboard.length) throw new Error("clipboard empty");
      const pasted = clipboard.map((c) => addNode(c.type, c.title, c.widgets));
      return { pasted_count: pasted.length, pasted_node_ids: pasted.map((n) => n.id), pasted: pasted.map(summarize) };
    },
    graph_save_subgraph: ({ node_id, name }) => {
      const id = node_id != null ? Number(node_id) : selection[0];
      const n = id != null ? nodes.get(id) : null;
      if (!n || !n.is_subgraph) throw new Error("select a subgraph node first");
      const finalName = typeof name === "string" && name.trim() ? name.trim() : n.title || "Subgraph";
      blueprints.set(finalName, { name: finalName, type: `SubgraphBlueprint.${finalName}` });
      return { saved: { name: finalName, from_node_id: id, type: `SubgraphBlueprint.${finalName}` } };
    },
    graph_list_subgraphs: () => ({
      count: blueprints.size,
      blueprints: [...blueprints.values()].map((b) => ({ ...b, display_name: b.name, description: null, is_global: false })),
    }),
    graph_add_subgraph: ({ name }) => {
      const key = String(name).replace(/^SubgraphBlueprint\./, "");
      if (!blueprints.has(key)) throw new Error(`No blueprint "${name}"`);
      const id = ++seq;
      nodes.set(id, { id, type: `SubgraphBlueprint.${key}`, title: key, is_subgraph: true, widgets: {}, inputs: [], outputs: [] });
      return { added: summarize(nodes.get(id)), from_blueprint: `SubgraphBlueprint.${key}` };
    },
  };

  return {
    /** Known panel command names (ground truth for rewrite validation). */
    commandNames: new Set(Object.keys(EXEC)),
    /** Execute one bridge command frame; mirrors {ok, result|error}. */
    exec(cmd, args) {
      commands.push({ cmd, args });
      const fn = EXEC[cmd];
      try {
        if (!fn) throw new Error(`unknown cmd ${cmd}`);
        return { ok: true, result: fn(args ?? {}) };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    state: { nodes, blueprints, commands, get selection() { return selection; } },
    counts() {
      const c = {};
      for (const x of commands) c[x.cmd] = (c[x.cmd] || 0) + 1;
      return c;
    },
  };
}
