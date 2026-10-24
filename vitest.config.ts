import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    globalSetup: ["test/setup/build.ts"],
    // Every source file, so ones no test loads show up as uncovered instead of missing.
    coverage: { include: ["src/**/*.{ts,tsx}"] },
  },
});
