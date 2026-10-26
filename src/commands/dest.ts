import { confirm, isCancel } from "@clack/prompts";
import type { Config, ExportFormat } from "../config/schema";
import { exportNames, findExport } from "../export/named";
import { planDestination, writeDestination } from "../export/send";

// Sending an export, or a standup, to where it says it goes ([ADR 0010](../../docs/adr/0010-mcp-as-source-and-destination.md)):
// the text and the place are shown first, then one question. Nothing is written without a yes.

export interface DestOptions {
  /** Show the text and where it would go, then stop. */
  dryRun?: boolean;
  /** Write without asking (for scripts). */
  yes?: boolean;
  /** Whether there's someone to ask (a terminal); tests say so. */
  interactive?: boolean;
}

/** The export format called `name`, or the one with a destination; says what to do when none has. */
export function destinationExport(config: Config, name?: string): ExportFormat {
  const withDest = config.exports.filter((e) => e.to);
  if (name) {
    const choice = findExport(name, config);
    if (!choice)
      throw new Error(`Unknown format "${name}". Use ${exportNames(config).join(", ")}.`);
    if (choice.kind === "built-in")
      throw new Error(
        `${choice.name} is built in and has no destination. Add one to an [[exports]] entry of your own in config.toml.`,
      );
    if (!choice.format.to)
      throw new Error(
        `${choice.format.name} has no destination. Add one to its [[exports]] entry in config.toml: to = { file = "~/Vault/Daily/{date}.md", append = true }`,
      );
    return choice.format;
  }
  const named =
    withDest.find((e) => e.default) ?? (withDest.length === 1 ? withDest[0] : undefined);
  if (named) return named;
  if (withDest.length > 1)
    throw new Error(
      `Which export? ${withDest.map((e) => e.name).join(", ")} each have a destination: --to <name>.`,
    );
  throw new Error(
    'No export has a destination yet. Add one to an [[exports]] entry in config.toml: to = { file = "~/Vault/Daily/{date}.md", append = true } or to = { mcp = "notion", tool = "append_block", arguments = { content = "{text}" } }',
  );
}

/**
 * Writes `text` where the format's destination says, after showing both. `date` is what
 * `{date}` becomes (the range's last day, or the standup's day).
 */
export async function saveToDestination(
  config: Config,
  format: ExportFormat,
  text: string,
  date: string,
  opts: DestOptions = {},
): Promise<void> {
  const to = format.to;
  if (!to) throw new Error(`${format.name} has no destination.`);
  const plan = await planDestination(to, text, { date });
  const interactive = opts.interactive ?? (process.stdin.isTTY && process.stdout.isTTY);
  console.log(`${format.name} → ${plan.where}\n`);
  console.log(text);
  if (opts.dryRun) {
    console.log("\n(dry run: nothing written)");
    return;
  }
  if (!opts.yes) {
    if (!interactive) throw new Error("Add --yes to write it without being asked.");
    const replace = plan.exists && "file" in to && !to.append;
    const ok = await confirm({
      message: replace
        ? `${plan.where} is there already. Replace it?`
        : `Write it to ${plan.where}?`,
    });
    if (isCancel(ok) || !ok) {
      console.log("Nothing written.");
      return;
    }
  }
  console.log(`\n${await writeDestination(to, plan, { config })}.`);
}
