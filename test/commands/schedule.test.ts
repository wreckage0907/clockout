import { describe, expect, it } from "vitest";
import { printUnits } from "../../src/commands/schedule";
import { configSchema, type ScheduleJob } from "../../src/config/schema";

// ADR 0012: the unit is a file on disk, and `schedule print` shows it. It carries where things are
// (PATH, HOME, the config and data folders), never a token from the environment.

const job = (): ScheduleJob =>
  configSchema.parse({
    me: { name: "Dev", emails: ["dev@example.com"], timezone: "Asia/Kolkata" },
    exports: [{ name: "daily", type: "markdown", to: { file: "~/Vault/{date}.md", append: true } }],
    schedule: [{ name: "daily-note", at: "18:30", format: "daily" }],
  }).schedule[0] as ScheduleJob;

describe("what a scheduled unit carries from your environment", () => {
  it("keeps the paths it needs and leaves tokens out", () => {
    const printed: string[] = [];
    printUnits(
      job(),
      {
        platform: "darwin",
        home: "/Users/dev",
        node: "/usr/local/bin/node",
        cli: "/opt/clockout/dist/cli.js",
        env: {
          PATH: "/usr/local/bin:/usr/bin:/bin",
          XDG_CONFIG_HOME: "/Users/dev/.config",
          GITHUB_TOKEN: "ghp_example",
          CLOCKOUT_TIMESHEET_TOKEN: "example-token",
          ANTHROPIC_API_KEY: "example-key",
        },
      },
      (line) => printed.push(line),
    );
    const text = printed.join("\n");
    expect(text).toContain("<key>PATH</key>\n      <string>/usr/local/bin:/usr/bin:/bin</string>");
    expect(text).toContain("<key>XDG_CONFIG_HOME</key>\n      <string>/Users/dev/.config</string>");
    expect(text).not.toContain("GITHUB_TOKEN");
    expect(text).not.toContain("ghp_example");
    expect(text).not.toContain("example-token");
    expect(text).not.toContain("example-key");
  });
});
