import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError, loadConfig, saveConfig } from "../../src/config/load";
import type { ConfigInput } from "../../src/config/schema";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "clockout-config-"));
});

const config: ConfigInput = {
  me: { name: "Dev", emails: ["dev@example.com"], timezone: "Asia/Kolkata" },
  sources: [
    { type: "claude-code" },
    { type: "calendar", method: "ics", url: "https://calendar.example/secret/basic.ics" },
  ],
};

describe("config files", () => {
  it("round-trips through TOML", async () => {
    const file = join(dir, "nested", "config.toml");
    await saveConfig(file, config);
    const loaded = await loadConfig(file);
    expect(loaded?.me).toEqual(config.me);
    expect(loaded?.sources).toEqual(config.sources);
  });

  it("is readable only by the user, since it holds a private calendar URL", async () => {
    const file = join(dir, "config.toml");
    await saveConfig(file, config);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("reads the removed Codex AI helper as auto, with one warning", async () => {
    const file = join(dir, "config.toml");
    await writeFile(
      file,
      '[me]\nname = "Dev"\nemails = ["dev@example.com"]\ntimezone = "UTC"\n\n[ai]\nbackend = "codex"\n',
    );
    const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect((await loadConfig(file))?.ai.backend).toBe("auto");
      expect((await loadConfig(file))?.ai.backend).toBe("auto");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/Codex AI helper was removed.*"auto"/);
    } finally {
      warn.mockRestore();
    }
  });

  it("tightens a config that was already there with wider permissions", async () => {
    const file = join(dir, "config.toml");
    await writeFile(file, "old", { mode: 0o644 });
    await chmod(file, 0o644);
    await saveConfig(file, config);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("returns null when there is no config yet", async () => {
    expect(await loadConfig(join(dir, "missing.toml"))).toBeNull();
  });

  it("reports invalid TOML with the file name", async () => {
    const file = join(dir, "config.toml");
    await writeFile(file, "[me\nname = ");
    await expect(loadConfig(file)).rejects.toThrow(ConfigError);
    await expect(loadConfig(file)).rejects.toThrow(file);
  });

  it("reports schema problems readably", async () => {
    const file = join(dir, "config.toml");
    await writeFile(file, '[me]\nname = "Dev"\nemails = ["not-an-email"]\ntimezone = "UTC"\n');
    await expect(loadConfig(file)).rejects.toThrow(/me\.emails\[0\]/);
  });

  it("says how to fix an empty one", async () => {
    const file = join(dir, "config.toml");
    await writeFile(file, "# nothing yet\n");
    await expect(loadConfig(file)).rejects.toThrow(/empty\. Run `clockout init --force`/);
  });

  it("refuses to save an invalid config", async () => {
    const file = join(dir, "config.toml");
    const bad = { ...config, me: { ...config.me, timezone: "Nowhere/Land" } };
    await expect(saveConfig(file, bad)).rejects.toThrow(ConfigError);
    await expect(readFile(file)).rejects.toThrow();
  });

  it("tells someone with a next-pms target what to change instead of a schema error", async () => {
    const file = join(dir, "config.toml");
    await writeFile(
      file,
      `[me]
name = "Dev"
emails = ["dev@example.com"]
timezone = "UTC"

[timesheet]
type = "next-pms"
url = "https://erp.example.com"

[[timesheet.map]]
project = "acme/api"
erp_task = "TASK-1"
`,
    );
    const err = await loadConfig(file).catch((e: Error) => e);
    expect(err).toBeInstanceOf(ConfigError);
    const message = (err as Error).message;
    expect(message).toContain('type = "next-pms" isn\'t supported any more');
    expect(message).toContain('type = "http"');
    expect(message).toContain("docs/timesheet-api.md");
    expect(message).toContain('type = "command"');
    expect(message).not.toContain("Invalid input");
  });

  it("keeps a timesheet token through a save, in a file only you can read", async () => {
    const file = join(dir, "config.toml");
    // A file made before the token was there, readable by others.
    await writeFile(file, "x = 1\n", { mode: 0o644 });
    await saveConfig(file, {
      ...config,
      timesheet: {
        type: "http",
        url: "https://pms.example.com/api",
        token: "abc123def456",
        map: [],
      },
    });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const loaded = await loadConfig(file);
    expect(loaded?.timesheet).toMatchObject({ type: "http", token: "abc123def456" });
  });

  it("doesn't quote a token back in a TOML syntax error", async () => {
    const file = join(dir, "config.toml");
    await writeFile(file, '[timesheet]\ntype = "http"\ntoken = hunter2-secret-value\n');
    const err = await loadConfig(file).catch((e: Error) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).not.toContain("hunter2-secret-value");
  });

  it("doesn't quote a token back when it isn't valid", async () => {
    const file = join(dir, "config.toml");
    await writeFile(
      file,
      `[me]
name = "Dev"
emails = ["dev@example.com"]
timezone = "UTC"

[timesheet]
type = "http"
url = "https://pms.example.com/api"
token = "two words secret-value"
`,
    );
    const err = await loadConfig(file).catch((e: Error) => e);
    expect((err as Error).message).toContain("timesheet.token");
    expect((err as Error).message).not.toContain("secret-value");
  });
});
