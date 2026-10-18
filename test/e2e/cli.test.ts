import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import pkg from "../../package.json" with { type: "json" };

const bin = new URL("../../dist/cli.js", import.meta.url).pathname;

describe("built cli", () => {
  it("prints the package version", () => {
    const out = execFileSync(process.execPath, [bin, "--version"], { encoding: "utf8" });
    expect(out.trim()).toBe(pkg.version);
  });
});
