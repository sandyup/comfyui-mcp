import { defineConfig } from "vitest/config";

// Scope test discovery to the source tree. Without this, Vitest's default glob
// also picks up test files inside transient git worktrees under .claude/ (left
// by background agents), polluting the run.
export default defineConfig({
  test: {
    include: ["src/**/*.{test,spec}.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.git/**",
      "**/.claude/**",
    ],
  },
});
