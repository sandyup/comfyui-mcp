import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

export function safeErrorDetails(err: unknown): Record<string, unknown> {
  if (!err || typeof err !== "object") return {};
  const record = err as Record<string, unknown>;
  const metadata = record.$metadata as Record<string, unknown> | undefined;
  return {
    name: typeof record.name === "string" ? record.name : undefined,
    code: typeof record.Code === "string"
      ? record.Code
      : typeof record.code === "string"
        ? record.code
        : undefined,
    status: metadata?.httpStatusCode,
  };
}

export function bodyToReadable(body: unknown): Readable {
  if (body instanceof Readable) return body;
  if (body instanceof Uint8Array) return Readable.from(body);
  if (body && typeof (body as { transformToByteArray?: unknown }).transformToByteArray === "function") {
    return Readable.from((async function* () {
      yield await (body as { transformToByteArray: () => Promise<Uint8Array> })
        .transformToByteArray();
    })());
  }
  return Readable.fromWeb(body as WebReadableStream);
}

export function normalizePrefix(prefix: string | undefined): string {
  if (!prefix) return "";
  return prefix.replace(/^\/+/, "").replace(/\/+$/, "");
}

export function withPrefix(prefix: string | undefined, filename: string): string {
  const clean = normalizePrefix(prefix);
  return clean ? `${clean}/${filename}` : filename;
}
