import { describe, expect, it } from "vitest";
import { requireOptionalDep } from "../../utils/optional-dep.js";
import { ModelError } from "../../utils/errors.js";

describe("requireOptionalDep", () => {
  it("returns the module when the dep is installed", async () => {
    // `ai` is in optionalDependencies and is installed in dev.
    const mod = await requireOptionalDep<typeof import("ai")>("ai");
    expect(typeof mod.streamText).toBe("function");
  });

  it("throws a ModelError with install hint when the dep is missing", async () => {
    try {
      await requireOptionalDep<unknown>("this-package-does-not-exist-87a3", {
        feature: "imaginary feature",
        installHint: "npm install this-package-does-not-exist-87a3",
      });
      throw new Error("expected requireOptionalDep to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ModelError);
      const m = err as ModelError;
      expect(m.message).toContain("imaginary feature");
      expect(m.message).toContain("npm install this-package-does-not-exist-87a3");
      const details = m.details as { package: string; code: string };
      expect(details.code).toBe("OPTIONAL_DEP_MISSING");
      expect(details.package).toBe("this-package-does-not-exist-87a3");
    }
  });

  it("caches successful resolutions across calls", async () => {
    const a = await requireOptionalDep<typeof import("ai")>("ai");
    const b = await requireOptionalDep<typeof import("ai")>("ai");
    expect(a).toBe(b);
  });
});
