// Helper for lazy-loading optional dependencies.
//
// Heavy or feature-gated packages (cloud SDKs, AI SDKs, cloudflared) live in
// `optionalDependencies` so a `npm install --no-optional comfyui-mcp` install
// still yields a working server. The features that need those deps surface a
// clear "install <pkg>" error instead of crashing on import.

import { ModelError } from "./errors.js";

const cache = new Map<string, unknown>();

export async function requireOptionalDep<T>(
  spec: string,
  options?: {
    feature?: string;
    installHint?: string;
  },
): Promise<T> {
  const cached = cache.get(spec);
  if (cached !== undefined) return cached as T;
  try {
    const mod = (await import(spec)) as T;
    cache.set(spec, mod);
    return mod;
  } catch (err) {
    const feature = options?.feature ?? spec;
    const installHint = options?.installHint ?? `npm install ${spec}`;
    throw new ModelError(
      `Optional dependency for ${feature} is not installed. ` +
        `To enable it, run: ${installHint}`,
      {
        code: "OPTIONAL_DEP_MISSING",
        package: spec,
        cause: err instanceof Error ? err.message : String(err),
      },
    );
  }
}
