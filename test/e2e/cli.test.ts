import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import pkg from "../../package.json" with { type: "json" };

const bin = new URL("../../dist/cli.js", import.meta.url).pathname;
const home = mkdtempSync(join(tmpdir(), "clockout-e2e-"));
const env = {
  PATH: process.env.PATH ?? "",
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local", "share"),
};

function run(...args: string[]) {
  try {
    return {
      out: execFileSync(process.execPath, [bin, ...args], { encoding: "utf8", env, stdio: "pipe" }),
      code: 0,
    };
  } catch (err) {
    const e = err as { stdout: string; stderr: string; status: number };
    return { out: `${e.stdout}${e.stderr}`, code: e.status };
  }
}

describe("built cli", () => {
  it("prints the package version", () => {
    expect(run("--version").out.trim()).toBe(pkg.version);
  });

  it("explains how to start when there's no config", () => {
    const { out, code } = run("today", "--plain");
    expect(code).toBe(1);
    expect(out).toContain("Run `clockout init` first.");
  });
});
