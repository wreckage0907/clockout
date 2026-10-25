import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import { runConnect, runDisconnect } from "./commands/connect";
import { runDay } from "./commands/day";
import { runEdit, runUndo } from "./commands/edit";
import { runExport } from "./commands/export";
import { runInit } from "./commands/init";
import { runPush } from "./commands/push";
import { tildify } from "./config/paths";
import { errorLogPath, isBug, logError } from "./log";

const program = new Command().name("clockout").description(pkg.description).version(pkg.version);

const dayOptions = (cmd: Command) =>
  cmd
    .option("--md", "print a Markdown timesheet")
    .option("--csv", "print a CSV timesheet")
    .option("--json", "print the drafted day as JSON")
    .option("--refresh", "rebuild from fresh activity, dropping corrections")
    .option("--no-ai", "use session and PR titles instead of AI summaries")
    .option("--plain", "print the day instead of opening the review screen");

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
  .option("-f, --format <format>", "csv, md, tsv, json, or a name from [[exports]]", "csv")
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
  .command("push")
  .argument("[date]", "today, yesterday, -N or YYYY-MM-DD (default: today)")
  .description("Send the day to your ERP timesheet, after showing what would change")
  .option("-n, --dry-run", "show what would change without sending")
  .option("-y, --yes", "send without asking")
  .option("--no-ai", "use session and PR titles instead of AI summaries")
  .action((date, opts) => runPush(date, opts));

program
  .command("connect")
  .argument("<service>", "google, erp, or a name for an MCP server")
  .argument("[url]", "for erp: your ERP's address; for an MCP server: its https:// address")
  .description(
    "Sign in once: google reads your calendar, erp lets Clockout fill your timesheet, a named MCP server is added to [[mcp]]",
  )
  .action((service: string, url?: string) => runConnect(service, url));

program
  .command("disconnect")
  .argument("<service>", "google, erp, or an MCP server's name")
  .description("Revoke access and forget the sign-in")
  .action((service: string) => runDisconnect(service));

program
  .command("init")
  .description("Find your tools and write ~/.config/clockout/config.toml")
  .option("-f, --force", "replace an existing config without asking")
  .action((opts) => runInit(opts));

/** `today` is the default command, so a typo would otherwise read as "too many arguments for today". */
function checkCommand(word: string | undefined): void {
  if (!word || word.startsWith("-")) return;
  const names = [...program.commands.map((c) => c.name()), "help"];
  if (names.includes(word)) return;
  const near = names.find((n) => distance(n, word) <= 2);
  throw new Error(
    `Unknown command "${word}".${near ? ` Did you mean ${near}?` : ""} See clockout --help.`,
  );
}

function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++)
      row[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    prev = row;
  }
  return prev[b.length] ?? 0;
}

try {
  checkCommand(process.argv[2]);
  await program.parseAsync();
} catch (err) {
  // Expected failures (bad config, no TTY) are Errors with a readable message; no stack trace.
  if (!(err instanceof Error)) throw err;
  console.error(`clockout: ${err.message}`);
  const bug = isBug(err);
  if (bug) console.error("That's a bug in Clockout. Please report it with the details below.");
  if (err.cause !== undefined || bug) {
    await logError(`clockout ${process.argv.slice(2, 3).join(" ")}`.trim(), err);
    console.error(`Details: ${tildify(errorLogPath())}`);
  }
  process.exitCode = 1;
}
