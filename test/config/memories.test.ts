import { describe, expect, it } from "vitest";
import { settingsContext } from "../../src/ai/edits";
import { writeStandup } from "../../src/ai/standup";
import { blockSignature, summarizeDay } from "../../src/ai/summarize";
import type { CompleteRequest, LlmBackend } from "../../src/ai/types";
import { configSchema } from "../../src/config/schema";
import { applySettings, describeSettings } from "../../src/config/setting-ops";
import { buildDay } from "../../src/core/blocks";
import type { StandupFacts } from "../../src/core/standup";
import { atLocalTime } from "../../src/core/time";
import type { Activity } from "../../src/core/types";

// Things you told Clockout to remember (ADR 0011): kept in the config, in your words, handed to
// the AI for descriptions, standups and settings, and never a secret.

const TZ = "Asia/Kolkata";
const D = "2026-10-16";
const me = { name: "Dev", emails: ["dev@example.com"], timezone: TZ };
const config = (memories: string[] = []) => configSchema.parse({ me, memories });

function remembered(config: ReturnType<typeof configSchema.parse>, text: string) {
  return applySettings(config, [{ op: "remember", text }]);
}

function forgotten(config: ReturnType<typeof configSchema.parse>, text: string) {
  return applySettings(config, [{ op: "forget", text }]);
}

function recorder() {
  const systems: string[] = [];
  const backend: LlmBackend = {
    id: "test",
    label: "test",
    async complete<T>(req: CompleteRequest<T>) {
      systems.push(req.system);
      // Both output shapes, so one recorder serves descriptions and the standup.
      return req.schema.parse({ summaries: [], yesterday: [], today: [] });
    },
  };
  return { backend, systems };
}

describe("remembering something you said", () => {
  it("keeps it in the config, once, however it's capitalised", () => {
    const first = remembered(config(), "Ticket keys come first");
    expect(first.errors).toEqual([]);
    expect(first.config.memories).toEqual(["Ticket keys come first"]);

    const again = remembered(first.config, "  ticket keys COME first ");
    expect(again.errors).toEqual([]);
    expect(again.config.memories).toEqual(["Ticket keys come first"]);
  });

  it("forgets one by its own words, or by part of them", () => {
    const start = remembered(
      remembered(config(), "Ticket keys come first").config,
      "No jargon",
    ).config;
    expect(forgotten(start, "Ticket keys come first").config.memories).toEqual(["No jargon"]);
    // A part of it, when it names only one.
    expect(forgotten(start, "jargon").config.memories).toEqual(["Ticket keys come first"]);
  });

  it("says what it remembers when asked to forget something else", () => {
    const start = remembered(config(), "Ticket keys come first").config;
    const r = forgotten(start, "always round up");
    expect(r.config.memories).toEqual(["Ticket keys come first"]);
    expect(r.errors).toEqual([
      "There's no memory like “always round up”. Clockout remembers: Ticket keys come first",
    ]);
    expect(forgotten(config(), "anything").errors).toEqual([
      "Clockout isn't remembering anything yet.",
    ]);
  });

  it("never keeps something that looks like a token", () => {
    for (const text of [
      "my API key is sk-live-4f9adc3b21e7a1b2c3d4e5",
      "deploy token ghp_4f9adc3b21e7a1b2c3d4e5f6a7b8c9d0e1f2a3b",
      "the key is a9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4",
    ]) {
      const r = remembered(config(), text);
      expect(r.config.memories).toEqual([]);
      expect(r.errors).toEqual([
        "That looks like a password or a token, so Clockout didn't remember it.",
      ]);
    }
  });

  it("holds twenty at most, and says so", () => {
    const twenty = config(Array.from({ length: 20 }, (_, i) => `thing ${i + 1}`));
    const r = remembered(twenty, "one more");
    expect(r.config.memories).toHaveLength(20);
    expect(r.errors[0]).toMatch(/Clockout remembers 20 things at most/);
    expect(r.errors[0]).toContain("thing 20");
  });

  it("is shown in the proposal in its own words", () => {
    expect(describeSettings([{ op: "remember", text: "Ticket keys come first" }])).toEqual([
      "Remember: “Ticket keys come first”",
    ]);
    expect(describeSettings([{ op: "forget", text: "Ticket keys" }])).toEqual([
      "Forget “Ticket keys”",
    ]);
  });
});

describe("what the AI is told", () => {
  const prompt = (system: string) => system.includes("Ticket keys come first");

  it("writes descriptions with them", async () => {
    const day = buildDay(
      D,
      [
        {
          source: "claude-code",
          kind: "prompt",
          actor: "human",
          start: atLocalTime(D, "10:00", TZ),
          repo: "acme/api",
          branch: "feat/x",
          sessionId: "s1",
          title: "Refresh tokens",
        } satisfies Activity,
      ],
      config(["Ticket keys come first"]),
    );
    const { backend, systems } = recorder();
    await summarizeDay(day, backend, {}, undefined, ["Ticket keys come first"]);
    expect(systems.some(prompt)).toBe(true);
  });

  it("writes the standup with them", async () => {
    const facts: StandupFacts = {
      date: D,
      yesterday: null,
      meetings: [],
      prs: [],
      reviews: [],
      branches: [],
      blockers: [],
    };
    const { backend, systems } = recorder();
    await writeStandup(facts, backend, configSchema.parse({ me }).standup, [
      "Ticket keys come first",
    ]);
    expect(systems.some(prompt)).toBe(true);
  });

  it("sees them when changing settings, so it can forget one", () => {
    const facts = { googleConnected: false, erpConnected: false, claudeProjects: [] };
    expect(settingsContext(config(["Ticket keys come first"]), facts).memories).toEqual([
      "Ticket keys come first",
    ]);
  });
});

describe("the summary cache", () => {
  it("writes descriptions again when what to remember changes", () => {
    const [b] = buildDay(
      D,
      [
        {
          source: "claude-code",
          kind: "prompt",
          actor: "human",
          start: atLocalTime(D, "10:00", TZ),
          repo: "acme/api",
          branch: "feat/x",
          sessionId: "s1",
          title: "Refresh tokens",
        } satisfies Activity,
      ],
      config(),
    ).blocks;
    if (!b) throw new Error("no block");
    expect(blockSignature(b)).toBe(blockSignature(b, undefined, []));
    expect(blockSignature(b, undefined, ["Ticket keys come first"])).not.toBe(blockSignature(b));
  });
});

describe("memories in config.toml", () => {
  it("survive being written and read back", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { loadConfig, saveConfig } = await import("../../src/config/load");
    const file = join(await mkdtemp(join(tmpdir(), "clockout-memories-")), "config.toml");
    const start = config(["Ticket keys come first", "No jargon"]);
    await saveConfig(file, start);
    const loaded = await loadConfig(file);
    expect(loaded?.memories).toEqual(["Ticket keys come first", "No jargon"]);
  });

  it("are capped and kept to one line by the schema", () => {
    const many = configSchema.safeParse({ me, memories: Array(21).fill("a thought") });
    expect(many.success ? "" : many.error.issues[0]?.message).toContain("20 things at most");
    const long = configSchema.safeParse({ me, memories: ["x".repeat(201)] });
    expect(long.success).toBe(false);
    const blank = configSchema.safeParse({ me, memories: ["  "] });
    expect(blank.success).toBe(true); // whitespace is trimmed when it's applied, not read
  });
});
