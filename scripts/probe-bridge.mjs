// Full-flow probe: connect like a panel, log the models frame, send a real
// user message, and watch for the agent's reply. Run:
//   BRIDGE_URL=ws://127.0.0.1:9110 node scripts/probe-bridge.mjs
import { WebSocket } from "ws";
const url = process.env.BRIDGE_URL || "ws://127.0.0.1:9101";
const sock = new WebSocket(url);
const t0 = Date.now();
const ms = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
let gotReply = false;
sock.on("open", () => {
  console.log(ms(), "connected", url);
  sock.send(JSON.stringify({ type: "hello", tab_id: "probe-tab-0001", title: "probe" }));
  // Send a real message shortly after connecting (no set_options → uses the
  // orchestrator's default model, which we know is valid).
  setTimeout(() => {
    console.log(ms(), "-> user_message: hi");
    sock.send(JSON.stringify({ type: "user_message", text: "hi" }));
  }, 1500);
});
sock.on("message", (buf) => {
  let m;
  try { m = JSON.parse(buf.toString()); } catch { return; }
  if (m.type === "models") {
    console.log(ms(), `<< models: ${m.models.length} [${m.models.map((x) => x.value).join(", ")}]`);
  } else if (m.type === "say") {
    gotReply = true;
    console.log(ms(), `<< say: ${String(m.text).slice(0, 100)}`);
  } else if (m.type === "agent_status") {
    console.log(ms(), `<< agent_status: ctx=${m.context_pct} used=${m.used} win=${m.context_window} model=${m.model}`);
  } else {
    console.log(ms(), `<< ${m.type}${m.kind ? "/" + m.kind : ""}`);
  }
});
sock.on("error", (e) => console.error(ms(), "error:", e.message));
setTimeout(() => {
  console.log(ms(), gotReply ? "DONE (agent replied)" : "DONE (NO agent reply — stuck)");
  sock.close();
  process.exit(0);
}, 45000);
