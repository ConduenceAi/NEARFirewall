import { defineConfig } from "vitest/config";

// Run tests with `npm test` (scripts/test.mjs), which also works around a Windows
// drive-letter casing issue that makes Vitest load itself twice.
export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/runner/test/**/*.test.ts", "apps/web/test/**/*.test.ts", "apps/gateway/test/**/*.test.ts"],
  },
});
