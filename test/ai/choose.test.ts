import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { chooseBackend } from "../../src/ai";
import { configSchema } from "../../src/config/schema";

const base = { me: { name: "Dev", emails: ["dev@example.com"], timezone: "UTC" } };
const config = (ai: object) => configSchema.parse({ ...base, ai });
let dir = "";

/** A PATH holding only fake CLIs that print a version. */
async function pathWith(...commands: string[]) {
  dir = await mkdtemp(join(tmpdir(), "clockout-path-"));
  for (const c of commands) {
    const file = join(dir, c);
    await writeFile(file, "#!/bin/sh\necho 1.2.3\n");
    await chmod(file, 0o755);
  }
  return { PATH: dir };
}
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("chooseBackend", () => {
  it("picks the first helper installed, in auto order", async () => {
    const env = await pathWith("pi", "codex");
    expect((await chooseBackend(config({}), env)).backend?.id).toBe("codex");
  });

  it("gives a Claude model only to Claude Code", async () => {
    const env = await pathWith("claude", "codex");
    const claude = await chooseBackend(config({ model: "sonnet" }), env);
    expect(claude.backend?.label).toBe("Claude Code (sonnet)");
    const codex = await chooseBackend(config({ backend: "codex", model: "haiku" }), env);
    expect(codex.backend?.label).toBe("Codex");
  });

  it("works without a helper and says why, instead of failing", async () => {
    const env = await pathWith();
    const none = await chooseBackend(config({}), env);
    expect(none.backend).toBeNull();
    expect(none.notice).toBe(
      "No AI helper found (Claude Code, Codex, opencode or Pi). Descriptions come from session and PR titles, and typed corrections are off.",
    );
    const missing = await chooseBackend(config({ backend: "claude-code" }), env);
    expect(missing.backend).toBeNull();
    expect(missing.notice).toMatch(/^The AI helper is set to Claude Code, but `claude` isn't on/);
  });

  it("says nothing when the helper is turned off", async () => {
    const env = await pathWith("claude");
    expect(await chooseBackend(config({ backend: "none" }), env)).toEqual({
      backend: null,
      notice: null,
    });
  });
});
