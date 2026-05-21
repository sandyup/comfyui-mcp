export interface ComfyUITarget {
  host: string;
  port: number;
  ssl: boolean;
}

/**
 * Parse a full ComfyUI URL (e.g. http://127.0.0.1:8188, https://comfy.example.com)
 * into host/port/ssl. Used by --comfyui-url / COMFYUI_URL to target any (incl.
 * remote) ComfyUI instance, overriding the COMFYUI_HOST/PORT/SSL env vars.
 */
export function parseComfyUIUrl(url: string): ComfyUITarget {
  const u = new URL(url);
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`Unsupported protocol "${u.protocol}" in --comfyui-url (expected http or https)`);
  }
  const ssl = u.protocol === "https:";
  const port = u.port ? Number(u.port) : ssl ? 443 : 80;
  return { host: u.hostname, port, ssl };
}
