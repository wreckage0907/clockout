#!/usr/bin/env node
import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import { runDay } from "./commands/day";
import { runEdit, runUndo } from "./commands/edit";
import { runInit } from "./commands/init";

const program = new Command().name("clockout").description(pkg.description).version(pkg.version);

const dayOptions = (cmd: Command) =>
  cmd
    .option("--md", "print a Markdown timesheet")
    .option("--csv", "print a CSV timesheet")
    .option("--json", "print the drafted day as JSON")
    .option("--refresh", "rebuild from fresh activity, dropping corrections")
    .option("--no-ai", "use session and PR titles instead of AI summaries");

dayOptions(program.command("today", { isDefault: true }).description("Draft today")).action(
  (opts) => runDay("today", opts),
);
dayOptions(program.command("yesterday").description("Draft yesterday")).action((opts) =>
  runDay("yesterday", opts),
);
dayOptions(
  program
    .command("day")
    .argument("<date>", "YYYY-MM-DD, or -N for N days ago")
    .description("Draft a specific day"),
).action((date, opts) => runDay(date, opts));

program
  .command("edit")
  .argument("<text...>", "what to change, in plain words")
  .description('Correct a day in plain words, e.g. clockout edit "the gap was lunch"')
  .option("-d, --date <date>", "day to edit (default: today)")
  .option("--dry-run", "show the changes without saving them")
  .action((words: string[], opts) => runEdit(words.join(" "), opts));

program
  .command("undo")
  .description("Undo the last correction")
  .option("-d, --date <date>", "day (default: today)")
  .action((opts) => runUndo(opts));

program
  .command("init")
  .description("Find your tools and write ~/.config/clockout/config.toml")
  .option("-f, --force", "replace an existing config without asking")
  .action((opts) => runInit(opts));

try {
  await program.parseAsync();
} catch (err) {
  // Expected failures (bad config, no TTY) are Errors with a readable message; no stack trace.
  if (!(err instanceof Error)) throw err;
  console.error(`clockout: ${err.message}`);
  process.exitCode = 1;
}
