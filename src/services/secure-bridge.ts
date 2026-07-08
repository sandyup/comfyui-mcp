// Secure bridge: when `connect` (or the panel orchestrator) drives a REMOTE
// https ComfyUI (e.g. a RunPod pod), the pod's HTTPS panel page cannot open a
// plain `ws://127.0.0.1:9180` to the local bridge — browsers block insecure
// (ws://) sockets from a secure (https://) page (mixed-content) and gate
// public→loopback access (Private Network Access). This module makes it work
// transparently:
//
//   1. open a cloudflared quick tunnel to the loopback bridge port,
//   2. hand the panel a `wss://<rand>.trycloudflare.com/?token=<token>` URL
//      (valid TLS, public origin → no mixed-content, no PNA prompt),
//   3. ADVERTISE that URL to the pod's panel pack so the browser panel fetches
//      and uses it automatically — the user never copies a URL.
//
// The token is the only thing gating a now-publicly-reachable bridge, so it is
// generated per session and checked constant-time on every WS upgrade
// (see UiBridge).

import { startQuickTunnel, type QuickTunnel } from "./tunnel.js";
import { logger } from "../utils/logger.js";

export interface SecureBridge {
  /** The wss URL the panel connects to (token embedded). */
  wssUrl: string;
  /** Re-advertise to the (possibly retargeted) pod. Safe to call repeatedly. */
  advertise(comfyuiUrl: string): Promise<boolean>;
  /** Tear down the cloudflared tunnel. Idempotent. */
  stop(): void;
}

/** https://host → wss://host/?token=…  (the panel's bridge URL). */
function toWssUrl(httpsUrl: string, token: string): string {
  const u = new URL(httpsUrl);
  u.protocol = "wss:";
  u.search = "";
  u.searchParams.set("token", token);
  return u.toString();
}

/** Auth headers for the pod's ComfyUI, mirroring the connect-time env the docs
 *  document (COMFYUI_AUTH_TOKEN + optional header/scheme). Empty when unset. */
function comfyuiAuthHeaders(): Record<string, string> {
  const token = process.env.COMFYUI_AUTH_TOKEN?.trim();
  if (!token) return {};
  const header = process.env.COMFYUI_AUTH_HEADER?.trim() || "Authorization";
  const scheme = process.env.COMFYUI_AUTH_SCHEME?.trim() ?? "Bearer";
  return { [header]: scheme ? `${scheme} ${token}` : token };
}

/** Mask the token when logging a wss URL. */
function maskToken(url: string): string {
  return url.replace(/token=[^&]+/, "token=…");
}

/**
 * POST the bridge URL to the pod's panel pack so its browser panel can fetch it.
 * Retries a few times — the orchestrator may advertise before the pod route is
 * warm. Returns true on the first 2xx.
 */
export async function advertiseBridge(comfyuiUrl: string, wssUrl: string): Promise<boolean> {
  let endpoint: string;
  try {
    endpoint = new URL("/comfyui_mcp_panel/advertise_bridge", comfyuiUrl).toString();
  } catch {
    return false;
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...comfyuiAuthHeaders() },
        body: JSON.stringify({ url: wssUrl }),
      });
      if (res.ok) return true;
      logger.warn(`[secure-bridge] advertise got HTTP ${res.status} from the pod panel`);
    } catch (err) {
      logger.warn(
        `[secure-bridge] advertise attempt ${attempt + 1}/3 failed: ${(err as Error).message}`,
      );
    }
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  return false;
}

/**
 * Open a cloudflared tunnel to the loopback bridge and advertise the resulting
 * wss URL to the pod. Throws if the tunnel can't come up (caller decides whether
 * to fall back to the plain ws bridge or fail).
 */
export async function setupSecureBridge(opts: {
  bridgePort: number;
  comfyuiUrl: string;
  token: string;
}): Promise<SecureBridge> {
  const { bridgePort, comfyuiUrl, token } = opts;
  // 127.0.0.1 (not localhost) — the bridge is IPv4 loopback-bound.
  const tunnel: QuickTunnel = await startQuickTunnel(bridgePort, "127.0.0.1");
  // Safety net: kill the tunnel on any process exit (e.g. the orchestrator's
  // uncaughtException → process.exit(1) path, which bypasses the graceful
  // shutdown that also calls stop()). Idempotent. Does not fire on SIGKILL.
  process.once("exit", () => {
    try {
      tunnel.stop();
    } catch {
      // already gone
    }
  });
  const wssUrl = toWssUrl(tunnel.url, token);
  logger.info(`[secure-bridge] bridge exposed securely at ${maskToken(wssUrl)}`);

  const advertise = async (target: string): Promise<boolean> => {
    const ok = await advertiseBridge(target, wssUrl);
    if (ok) {
      logger.info(`[secure-bridge] advertised the secure bridge URL to the pod panel`);
    } else {
      logger.warn(
        `[secure-bridge] could not reach the pod panel to advertise the bridge URL — ` +
          `open the pod's ComfyUI and it will retry on Connect`,
      );
    }
    return ok;
  };

  await advertise(comfyuiUrl);

  return {
    wssUrl,
    advertise,
    stop: () => {
      try {
        tunnel.stop();
      } catch {
        // already gone
      }
    },
  };
}
