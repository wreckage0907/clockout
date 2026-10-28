import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stopHelpers } from "../src/ai/cli";
import { runCommand } from "../src/command";
import { destinationExport, saveToDestination } from "../src/commands/dest";
import { configSchema } from "../src/config/schema";
import { aiSettingOpSchema, applySettings } from "../src/config/setting-ops";
import { commandTarget } from "../src/targets/command";

// The command escape hatch (ADR 0009, layer 4): a program you name, one JSON request on stdin,
// one JSON answer on stdout. No shell, a timeout, and its own process group.

/** A program that runs with node, written where the test can't confuse it with a real one. */
async function program(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "clockout-prog-"));
  const path = join(dir, "prog.mjs");
  await writeFile(path, `#!/usr/bin/env node\n${source}`, { mode: 0o755 });
  return path;
}

const readStdin = `let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;
const request = JSON.parse(raw);`;

describe("running a program", () => {
  it("hands it one JSON request on stdin and reads one JSON answer", async () => {
    const prog = await program(`${readStdin}
console.log(JSON.stringify({ got: request, argv: process.argv.slice(2) }));`);
    const { json } = await runCommand([prog, "--flag"], { op: "day", date: "2026-10-16" });
    expect(json).toEqual({
      got: { op: "day", date: "2026-10-16" },
      argv: ["--flag"],
    });
  });

  it("runs no shell, so a shell character in an argument is just a character", async () => {
    const prog = await program(`console.log(JSON.stringify({ argv: process.argv.slice(2) }));`);
    const argv = ["$(echo hacked)", "a; rm -rf /", "`id`", "--ok"];
    const { json } = await runCommand([prog, ...argv], {});
    expect(json.argv).toEqual(argv);
  });

  it("says what failed, in the program's words, with tokens taken out", async () => {
    const prog = await program(`console.error("no task TASK-9");
console.error("token ghp_4f9adc3b21e7a1b2c3d4e5f6a7b8c9d0e1f2a3b was refused");
process.exit(3);`);
    await expect(runCommand([prog], {})).rejects.toThrow(
      "prog.mjs failed (exit 3): token [redacted] was refused.",
    );
  });

  it("stops a program that hangs", async () => {
    const prog = await program(`setTimeout(() => console.log("{}"), 5000);`);
    await expect(runCommand([prog], {}, { timeoutMs: 150 })).rejects.toThrow(
      /didn't answer within .* so Clockout stopped it/,
    );
  });

  it("says so when the answer isn't JSON, or isn't an object", async () => {
    const notJson = await program('console.log("done!");');
    await expect(runCommand([notJson], {})).rejects.toThrow("didn't print JSON as its answer");
    const notObject = await program('console.log("[1,2]");');
    await expect(runCommand([notObject], {})).rejects.toThrow("isn't a JSON object");
  });

  it("takes an empty answer as no answer", async () => {
    const silent = await program("");
    expect(await runCommand([silent], {})).toEqual({ json: {}, stderr: "" });
  });
});

describe("the program's process group", () => {
  /** True while the process is alive. */
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const gone = async (pid: number) => {
    for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
    return !alive(pid);
  };
  /** A program that starts a child of its own, records its pid, and then hangs. */
  const withChild = async () => {
    const pidFile = join(await mkdtemp(join(tmpdir(), "clockout-child-")), "pid");
    const prog = await program(`import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
setInterval(() => {}, 1000);`);
    return { prog, pidFile };
  };

  it("stops what the program started too when it times out", async () => {
    if (process.platform === "win32") return; // no process groups there
    const { prog, pidFile } = await withChild();
    await expect(runCommand([prog], {}, { timeoutMs: 1000 })).rejects.toThrow(
      /so Clockout stopped it/,
    );
    const child = Number(await readFile(pidFile, "utf8"));
    expect(child).toBeGreaterThan(0);
    expect(await gone(child)).toBe(true);
  });

  it("stops it when Clockout quits", async () => {
    if (process.platform === "win32") return;
    const { prog, pidFile } = await withChild();
    const running = runCommand([prog], {}, { timeoutMs: 60_000 });
    running.catch(() => undefined);
    for (let i = 0; i < 50; i++) {
      if (
        await readFile(pidFile, "utf8").then(
          () => true,
          () => false,
        )
      )
        break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const child = Number(await readFile(pidFile, "utf8"));
    expect(alive(child)).toBe(true);
    stopHelpers();
    expect(await gone(child)).toBe(true);
    await expect(running).rejects.toThrow();
  });
});

describe("a timesheet behind a program", () => {
  const make = async () => {
    const state = join(await mkdtemp(join(tmpdir(), "clockout-pms-")), "state.json");
    const prog = await program(`${readStdin}
const path = ${JSON.stringify(state)};
const saved = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(path, "utf8")).catch(() => "{}"));
const answer = async (next) => {
  await (await import("node:fs/promises")).writeFile(path, JSON.stringify(next));
};
if (request.op === "day") {
  console.log(JSON.stringify({ entries: saved.entries ?? [], ...(saved.closed ? { closed: saved.closed } : {}) }));
} else if (request.op === "tasks") {
  console.log(JSON.stringify({ tasks: [{ id: "TASK-1", subject: "API work", project: "Acme" }] }));
} else if (request.op === "create") {
  await answer({ entries: [...(saved.entries ?? []), { id: "e1", ...request.entry }] });
  console.log(JSON.stringify({ id: "e1" }));
} else if (request.op === "update") {
  await answer({ entries: (saved.entries ?? []).map((e) => (e.id === request.id ? { id: request.id, ...request.entry } : e)) });
  console.log("{}");
} else if (request.op === "delete") {
  await answer({ entries: (saved.entries ?? []).filter((e) => e.id !== request.id) });
  console.log("{}");
}`);
    return { target: commandTarget([prog]), state };
  };

  it("reads the day and its tasks", async () => {
    const { target } = await make();
    expect(await target.day("2026-10-16")).toEqual({ entries: [] });
    expect(await target.searchTasks("api")).toEqual([
      { id: "TASK-1", subject: "API work", project: "Acme" },
    ]);
  });

  it("creates, changes and deletes entries, and reads back what's there", async () => {
    const { target } = await make();
    await target.create("2026-10-16", { task: "TASK-1", hours: 1.25, description: "Fix auth" });
    expect((await target.day("2026-10-16")).entries).toEqual([
      { id: "e1", parent: "", task: "TASK-1", hours: 1.25, description: "Fix auth" },
    ]);
    await target.update("2026-10-16", "e1", "", {
      task: "TASK-1",
      hours: 2,
      description: "Fixed auth",
    });
    expect((await target.day("2026-10-16")).entries[0]).toMatchObject({
      hours: 2,
      description: "Fixed auth",
    });
    await target.remove("e1", "");
    expect((await target.day("2026-10-16")).entries).toEqual([]);
  });

  it("reads a refusal as the program writes it", async () => {
    const prog = await program(
      `console.log(JSON.stringify({ error: "There's no task TASK-9." }));`,
    );
    await expect(
      commandTarget([prog]).create("2026-10-16", { task: "TASK-9", hours: 1, description: "x" }),
    ).rejects.toThrow("There's no task TASK-9.");
  });

  it("says what it couldn't read", async () => {
    const prog = await program(`console.log(JSON.stringify({ entries: "nope" }));`);
    await expect(commandTarget([prog]).day("2026-10-16")).rejects.toThrow(
      "prog.mjs sent a day in a shape Clockout can't read.",
    );
  });
});

describe("a program as an export destination", () => {
  it("gets the text and the day, and says what it did", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clockout-dest-prog-"));
    const out = join(dir, "written.txt");
    const prog = await program(`${readStdin}
await (await import("node:fs/promises")).writeFile(${JSON.stringify(out)}, request.date + "\\n" + request.text);
console.log(JSON.stringify({ message: "wrote it" }));`);
    const config = configSchema.parse({
      me: { name: "Dev", emails: ["dev@example.com"], timezone: "Asia/Kolkata" },
      exports: [{ name: "note", type: "text", line: "{project}", to: { command: [prog] } }],
    });
    const said: string[] = [];
    const log = console.log;
    console.log = (line: string) => void said.push(line);
    try {
      await saveToDestination(
        config,
        destinationExport(config, "note"),
        "2026-10-16 acme/api Fix auth",
        "2026-10-16",
        { yes: true },
      );
    } finally {
      console.log = log;
    }
    expect(said.join("\n")).toContain("note → the program ");
    expect(said.join("\n")).toContain("Handed it to ");
    expect(said.join("\n")).toContain("wrote it");
    expect(await readFile(out, "utf8")).toBe("2026-10-16\n2026-10-16 acme/api Fix auth");
  });
});

describe("a program is never something the AI can set", () => {
  it("has no operation for a command, and none for a timesheet", () => {
    const ops = aiSettingOpSchema.options.map((o) => o.shape.op.value);
    expect(ops).not.toContain("timesheet");
    expect(ops).not.toContain("command");
    expect(ops).not.toContain("export_command");
  });

  it("can't even be written as one: the AI's schema has no command destination", () => {
    const parsed = aiSettingOpSchema.safeParse({
      op: "export_format",
      name: "note",
      type: "text",
      line: "{project}",
      to: { command: ["/bin/rm", "-rf", "/"] },
    });
    expect(parsed.success).toBe(false);
  });

  it("refuses a command destination if one is handed in anyway", () => {
    const r = applySettings(
      configSchema.parse({ me: { name: "Dev", emails: ["dev@example.com"], timezone: "UTC" } }),
      [
        {
          op: "export_format",
          name: "note",
          type: "text",
          line: "{project}",
          to: { command: ["/bin/rm", "-rf", "/"] },
        } as never,
      ],
    );
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.config.exports).toEqual([]);
  });
});
