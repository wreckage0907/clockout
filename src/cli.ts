#!/usr/bin/env node
import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import { runConnect, runDisconnect } from "./commands/connect";
import { runDay } from "./commands/day";
import { runEdit, runUndo } from "./commands/edit";
import { runExport } from "./commands/export";
import { runInit } from "./commands/init";

const program = new Command().name("clockout").description(pkg.description).version(pkg.version);

const dayOptions = (cmd: Command) =>
  cmd
    .option("--md", "print a Markdown timesheet")
    .option("--csv", "print a CSV timesheet")
    .option("--json", "print the drafted day as JSON")
    .option("--refresh", "rebuild from fresh activity, dropping corrections")
    .option("--no-ai", "use session and PR titles instead of AI summaries")
    .option("--plain", "print the day instead of opening the review screen")
    .option("--demo", "try it on a made-up day, without any setup");

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
  .command("export")
  .argument("[date]", "today, yesterday, -N or YYYY-MM-DD (default: today)")
  .description("Write the timesheet: date, project, task, hours, description")
  .option("-f, --format <format>", "csv, md, tsv or json", "csv")
  .option("-o, --out <file>", "write to a file instead of the terminal")
  .option("--from <date>", "first day of a range")
  .option("--to <date>", "last day of a range")
  .option("--no-ai", "use session and PR titles instead of AI summaries")
  .action((date, opts) => runExport(date, opts));

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
  .command("connect")
  .argument("<service>", "google")
  .description("Sign in once so Clockout can read your Google Calendar")
  .action((service: string) => runConnect(service));

program
  .command("disconnect")
  .argument("<service>", "google")
  .description("Revoke access and forget the sign-in")
  .action((service: string) => runDisconnect(service));

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
