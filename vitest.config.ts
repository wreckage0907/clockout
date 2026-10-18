import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    globalSetup: ["test/setup/build.ts"],
  },
});
