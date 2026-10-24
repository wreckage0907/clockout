import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
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
});
