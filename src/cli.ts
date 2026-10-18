#!/usr/bin/env node
import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import { runInit } from "./commands/init";

const program = new Command().name("clockout").description(pkg.description).version(pkg.version);

program
  .command("init")
  .description("Find your tools and write ~/.config/clockout/config.toml")
  .option("-f, --force", "replace an existing config without asking")
  .action(runInit);

try {
  await program.parseAsync();
} catch (err) {
  // Expected failures (bad config, no TTY) are Errors with a readable message; no stack trace.
  if (!(err instanceof Error)) throw err;
  console.error(`clockout: ${err.message}`);
  process.exitCode = 1;
}
