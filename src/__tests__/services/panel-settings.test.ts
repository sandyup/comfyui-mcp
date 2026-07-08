import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getNsfwConsent, setNsfwConsent } from "../../services/panel-settings.js";

let dir: string;
let settingsPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cmcp-settings-"));
  // Point at a nested path that doesn't exist yet, to exercise mkdir.
  settingsPath = join(dir, "nested", "panel-settings.json");
  process.env.COMFYUI_MCP_PANEL_SETTINGS = settingsPath;
});

afterEach(() => {
  delete process.env.COMFYUI_MCP_PANEL_SETTINGS;
  rmSync(dir, { recursive: true, force: true });
});

describe("panel-settings nsfw consent", () => {
  it("defaults to OFF when never set", () => {
    expect(getNsfwConsent()).toEqual({ allowed: false });
    expect(existsSync(settingsPath)).toBe(false); // reading doesn't create the file
  });

  it("persists an opt-in with a timestamp and creates the dir", () => {
    const state = setNsfwConsent(true);
    expect(state.allowed).toBe(true);
    expect(typeof state.decidedAt).toBe("string");
    expect(existsSync(settingsPath)).toBe(true);
    // Survives a fresh read (i.e. a reload).
    expect(getNsfwConsent().allowed).toBe(true);
  });

  it("revokes back to OFF", () => {
    setNsfwConsent(true);
    expect(getNsfwConsent().allowed).toBe(true);
    setNsfwConsent(false);
    expect(getNsfwConsent().allowed).toBe(false);
  });

  it("preserves unrelated settings keys", () => {
    setNsfwConsent(true); // creates the file (with mkdir) holding nsfwConsent
    const raw = JSON.parse(readFileSync(settingsPath, "utf-8"));
    raw.someOtherSetting = 42;
    writeFileSync(settingsPath, JSON.stringify(raw));
    setNsfwConsent(false);
    const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(after.someOtherSetting).toBe(42);
    expect(after.nsfwConsent.allowed).toBe(false);
  });
});
