import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
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
    const env = await pathWith("pi", "opencode");
    expect((await chooseBackend(config({}), env)).backend?.id).toBe("opencode");
  });

  it("gives a Claude model only to Claude Code", async () => {
    const env = await pathWith("claude", "opencode");
    const claude = await chooseBackend(config({ model: "sonnet" }), env);
    expect(claude.backend?.label).toBe("Claude Code (sonnet)");
    const other = await chooseBackend(config({ backend: "opencode", model: "haiku" }), env);
    expect(other.backend?.label).toBe("opencode");
  });

  it("works without a helper and says why, instead of failing", async () => {
    const env = await pathWith();
    const none = await chooseBackend(config({}), env);
    expect(none.backend).toBeNull();
    expect(none.notice).toBe(
      "No AI helper found (Claude Code, opencode or Pi). Descriptions come from session and PR titles, and typed corrections are off.",
    );
    const missing = await chooseBackend(config({ backend: "claude-code" }), env);
    expect(missing.backend).toBeNull();
    expect(missing.notice).toMatch(/^The AI helper is set to Claude Code, but `claude` isn't on/);
  });

  it("keeps the timesheet token and GitHub's out of the helper it starts", async () => {
    const env = await pathWith();
    const seenFile = join(dir, "seen-env");
    // A claude that notes its environment and answers.
    await writeFile(
      join(dir, "claude"),
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.2.3; exit 0; fi\nenv > ${seenFile}\ncat > /dev/null\necho '{"structured_output":{"summary":"ok"}}'\n`,
    );
    await chmod(join(dir, "claude"), 0o755);
    vi.stubEnv("PATH", `${dir}:${process.env.PATH ?? ""}`);
    vi.stubEnv("GITHUB_TOKEN", "ghp_secret");
    vi.stubEnv("CLOCKOUT_PMS_TOKEN", "pms_secret");
    vi.stubEnv("PMS_API_KEY", "pms_key_secret");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-own");
    try {
      const wired = configSchema.parse({
        ...base,
        timesheet: { type: "http", url: "https://pms.example.com/api", token_env: "PMS_API_KEY" },
      });
      const { backend } = await chooseBackend(wired, env);
      const schema = z.object({ summary: z.string() });
      expect(await backend?.complete({ system: "s", prompt: "p", schema })).toEqual({
        summary: "ok",
      });
      const seen = await readFile(seenFile, "utf8");
      expect(seen).toContain("ANTHROPIC_API_KEY=sk-ant-own");
      expect(seen).not.toMatch(/GITHUB_TOKEN|CLOCKOUT_PMS_TOKEN|PMS_API_KEY|secret/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("says nothing when the helper is turned off", async () => {
    const env = await pathWith("claude");
    expect(await chooseBackend(config({ backend: "none" }), env)).toEqual({
      backend: null,
      notice: null,
    });
  });
});
