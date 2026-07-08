import { ValidationError } from "../utils/errors.js";

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
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const ASCII_CONTROL_RE = /[\x00-\x1F\x7F]/;

function rejectControlChars(label: string, value: string): void {
  if (ASCII_CONTROL_RE.test(value)) {
    throw new ValidationError(`${label} cannot contain ASCII control characters.`);
  }
}

function validateDownloadAuth(auth: DownloadAuth): void {
  if (auth.type === "bearer") {
    rejectControlChars("Bearer token", auth.token);
    return;
  }

  if (auth.type === "basic") {
    rejectControlChars("Basic auth username", auth.username);
    rejectControlChars("Basic auth password", auth.password);
    return;
  }

  if (auth.type === "header") {
    if (!HEADER_NAME_RE.test(auth.header_name)) {
      throw new ValidationError(
        "Header auth header_name must be a valid HTTP header token.",
      );
    }
    rejectControlChars("Header auth header_value", auth.header_value);
    return;
  }

  if (auth.query_param.length === 0) {
    throw new ValidationError("Query auth query_param must be a non-empty string.");
  }
  rejectControlChars("Query auth query_param", auth.query_param);
}

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
  validateDownloadAuth(auth);

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
