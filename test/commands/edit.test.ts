import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Correction } from "../../src/ai/edits";
import type { CompleteRequest, LlmBackend } from "../../src/ai/types";
import { type EditDeps, type EditOptions, runEdit } from "../../src/commands/edit";
import { loadConfig } from "../../src/config/load";
import type { Config } from "../../src/config/schema";
import { DayStore } from "../../src/store/json-store";

// `clockout edit` with a settings change ("remember …"): the day's corrections and the settings
// go through the same words, and what needs the app says so instead of being dropped.

let dir: string;
let configFile: string;
let config: Config;
let store: DayStore;
let said: string[];
const original = { config: process.env.CLOCKOUT_CONFIG, data: process.env.XDG_DATA_HOME };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "clockout-edit-"));
  configFile = join(dir, "config.toml");
  process.env.CLOCKOUT_CONFIG = configFile;
  process.env.XDG_DATA_HOME = join(dir, "data");
  await writeFile(
    configFile,
    `[me]
name = "Dev"
emails = ["dev@example.com"]
timezone = "Asia/Kolkata"

[ai]
backend = "claude-code"
`,
    { mode: 0o600 },
  );
  const loaded = await loadConfig(configFile);
  if (!loaded) throw new Error("the test config didn't load");
  config = loaded;
  store = new DayStore(join(dir, "data", "clockout"));
  said = [];
});

/** Puts the process-wide paths back however a test ends. */
afterEach(() => {
  if (original.config === undefined) delete process.env.CLOCKOUT_CONFIG;
  else process.env.CLOCKOUT_CONFIG = original.config;
  if (original.data === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = original.data;
});

function backend(correction: Partial<Correction>): LlmBackend {
  return {
    id: "fake",
    label: "fake",
    async complete<T>(req: CompleteRequest<T>) {
      said.push(req.prompt);
      return req.schema.parse({ ops: [], reply: "", ...correction });
    },
  };
}

async function edit(
  correction: Partial<Correction>,
  opts: EditOptions = { yes: true },
  deps: EditDeps = {},
) {
  const out: string[] = [];
  const log = console.log;
  console.log = (line: string) => void out.push(line);
  try {
    await runEdit("remember the reader isn't technical", opts, {
      config,
      store,
      backend: backend(correction),
      ...deps,
    });
  } finally {
    console.log = log;
  }
  return out.join("\n");
}

describe("settings said to clockout edit", () => {
  it("remembers what you said, and saves it to the config", async () => {
    const out = await edit({
      settings: [{ op: "remember", text: "The reader isn't technical" }],
      reply: "Remembered.",
    });
    expect(out).toContain("Remember: “The reader isn't technical”");
    expect(out).toContain("Saved to");
    expect(out).toContain("Remembered.");
    expect((await loadConfig(configFile))?.memories).toEqual(["The reader isn't technical"]);
  });

  it("says what needs the app instead of dropping it", async () => {
    const out = await edit({ settings: [{ op: "connect", service: "google" }] });
    expect(out).toContain("needs connect from the app");
    expect((await loadConfig(configFile))?.sources).toEqual([]);
  });

  it("says why a setting didn't fit, and saves nothing", async () => {
    await expect(
      edit({
        settings: [{ op: "remember", text: "token ghp_4f9adc3b21e7a1b2c3d4e5f6a7b8c9d0e1f2a3b" }],
      }),
    ).rejects.toThrow(/looks like a token/);
    expect((await loadConfig(configFile))?.memories).toEqual([]);
    expect(await readFile(configFile, "utf8")).not.toContain("ghp_");
  });

  it("saves nothing on a dry run", async () => {
    const out: string[] = [];
    const log = console.log;
    console.log = (line: string) => void out.push(line);
    try {
      await runEdit(
        "remember the reader isn't technical",
        { dryRun: true, yes: true },
        {
          config,
          store,
          backend: backend({ settings: [{ op: "remember", text: "The reader isn't technical" }] }),
        },
      );
    } finally {
      console.log = log;
    }
    expect(out.join("\n")).toContain("dry run: nothing saved");
    expect((await loadConfig(configFile))?.memories).toEqual([]);
  });
});

describe("confirming settings", () => {
  const remember = { settings: [{ op: "remember" as const, text: "The reader isn't technical" }] };

  it("asks first on a terminal, and saves on a yes", async () => {
    const asked: string[] = [];
    const out = await edit(
      remember,
      {},
      {
        interactive: true,
        ask: async (m) => {
          asked.push(m);
          return true;
        },
      },
    );
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("config.toml");
    expect(out).toContain("Saved to");
    expect((await loadConfig(configFile))?.memories).toEqual(["The reader isn't technical"]);
  });

  it("saves nothing on a no", async () => {
    const out = await edit(remember, {}, { interactive: true, ask: async () => false });
    expect(out).toContain("Settings not saved.");
    expect(out).not.toContain("Saved to");
    expect((await loadConfig(configFile))?.memories).toEqual([]);
  });

  it("refuses without a terminal unless --yes is given", async () => {
    await expect(edit(remember, {}, { interactive: false })).rejects.toThrow(/Add --yes/);
    expect((await loadConfig(configFile))?.memories).toEqual([]);
    await edit(remember, { yes: true }, { interactive: false });
    expect((await loadConfig(configFile))?.memories).toEqual(["The reader isn't technical"]);
  });

  it("doesn't ask when there are no settings", async () => {
    const out = await edit(
      { reply: "Nothing to change." },
      {},
      {
        interactive: false,
        ask: async () => {
          throw new Error("asked");
        },
      },
    );
    expect(out).toContain("Nothing to change.");
  });

  it("prints what the AI wrote without escape codes", async () => {
    const out = await edit(
      { reply: "Done\u001b]0;pwned\u0007 \u001b[31mred\u001b[0m", settings: [] },
      {},
      { interactive: false },
    );
    expect(out).toBe("Done red");
    const proposal = await edit(
      {
        settings: [{ op: "remember", text: "keep\u001b[2Jthis" }],
        reply: "ok\u001b[2J",
      },
      { yes: true },
    );
    expect(proposal).not.toContain("\u001b");
  });
});
