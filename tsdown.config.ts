import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: "esm",
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  fixedExtension: false,
  dts: false,
  // Synthetic fixtures double as --demo data.
  copy: [{ from: "test/fixtures/**/*", to: "dist/demo", flatten: false }],
});
