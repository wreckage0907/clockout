import { describe, expect, it } from "vitest";
import { detectClaudeCode, projectsDir } from "../../src/sources/claude-code/paths";

const fixtures = new URL("../fixtures/claude", import.meta.url).pathname;

describe("Claude Code detection", () => {
  it("defaults to ~/.claude/projects", () => {
    expect(projectsDir({ homeDir: "/home/dev", env: {} })).toBe("/home/dev/.claude/projects");
  });

  it("follows CLAUDE_CONFIG_DIR", () => {
    expect(projectsDir({ homeDir: "/home/dev", env: { CLAUDE_CONFIG_DIR: "/cc" } })).toBe(
      "/cc/projects",
    );
  });

  it("counts project folders", async () => {
    const found = await detectClaudeCode({
      homeDir: "/home/dev",
      env: { CLAUDE_CONFIG_DIR: fixtures },
    });
    expect(found?.summary).toMatch(/^2 projects in /);
  });

  it("returns null when Claude Code has never run", async () => {
    expect(await detectClaudeCode({ homeDir: "/nonexistent", env: {} })).toBeNull();
  });
});
