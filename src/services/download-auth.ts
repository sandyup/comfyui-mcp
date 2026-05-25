export type DownloadAuth =
  | { type: "bearer"; token: string }
  | { type: "basic"; username: string; password: string }
  | { type: "header"; header_name: string; header_value: string }
  | { type: "query"; query_param: string; query_value: string };

export interface DownloadRequestAuth {
  url: string;
  headers: Record<string, string>;
}

const TOKEN_QUERY_RE = /token|key|secret|signature|auth|password|credential/i;
const REDACTED = "[REDACTED]";

export function redactUrlForLogs(
  url: string,
  extraSensitiveParams: string[] = [],
): string {
  try {
    const parsed = new URL(url);
    const sensitive = new Set(extraSensitiveParams.map((p) => p.toLowerCase()));
    for (const key of [...parsed.searchParams.keys()]) {
      if (sensitive.has(key.toLowerCase()) || TOKEN_QUERY_RE.test(key)) {
        parsed.searchParams.set(key, REDACTED);
      }
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

export function applyDownloadAuth(
  url: string,
  auth?: DownloadAuth,
): DownloadRequestAuth {
  if (!auth) return { url, headers: {} };

  if (auth.type === "bearer") {
    return {
      url,
      headers: { Authorization: `Bearer ${auth.token}` },
    };
  }

  if (auth.type === "basic") {
    const encoded = Buffer.from(`${auth.username}:${auth.password}`).toString("base64");
    return {
      url,
      headers: { Authorization: `Basic ${encoded}` },
    };
  }

  if (auth.type === "header") {
    return {
      url,
      headers: { [auth.header_name]: auth.header_value },
    };
  }

  const parsed = new URL(url);
  parsed.searchParams.set(auth.query_param, auth.query_value);
  return {
    url: parsed.toString(),
    headers: {},
  };
}
