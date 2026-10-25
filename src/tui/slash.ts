import { addDays, isDate } from "../core/time";

export type SetupSection = "sources" | "day" | "ai" | "projects" | "erp";
type Service = "erp" | "google";

/** A command typed after a `/` in the chat bar. These never go to the AI. */
export type Slash =
  | { name: "refresh" }
  | { name: "connect"; service: Service; url?: string }
  | { name: "disconnect"; service: Service }
  | { name: "send" }
  /** A built-in format or one of yours from `[[exports]]`; none for the default. */
  | { name: "copy"; format?: string }
  | { name: "undo" }
  | { name: "add" }
  | { name: "date"; date: string }
  | { name: "setup"; section?: SetupSection }
  | { name: "problems" }
  | { name: "help" }
  | { name: "quit" };

export interface SlashCommand {
  name: string;
  /** What goes after the name, for the menu, e.g. "erp <address> | google". */
  args?: string;
  /** Whether it needs an argument, so picking it from the menu fills it in rather than runs it. */
  needsArgs?: boolean;
  about: string;
  /** The key that does the same, if there is one. */
  key?: string;
  /** Other names that run it, e.g. `/exit` for `/quit`. */
  aliases?: string[];
}

export const COMMANDS: SlashCommand[] = [
  { name: "refresh", about: "Draft the day again from new activity" },
  { name: "connect", args: "erp <address> | google", needsArgs: true, about: "Sign in" },
  { name: "disconnect", args: "erp | google", needsArgs: true, about: "Sign out" },
  { name: "send", about: "Send the day to your ERP", key: "ctrl+s" },
  { name: "copy", args: "[md | csv | your export]", about: "Copy the timesheet", key: "ctrl+y" },
  { name: "undo", about: "Undo the last change", key: "ctrl+z" },
  { name: "add", about: "Add time nothing recorded" },
  { name: "today", about: "Go to today" },
  { name: "yesterday", about: "Go to yesterday" },
  { name: "date", args: "<day>", needsArgs: true, about: "Go to a day: monday, -3 or 2026-10-16" },
  {
    name: "setup",
    args: "[section]",
    about: "Open setup, at sources, day, ai, projects or erp",
    key: "ctrl+p",
  },
  { name: "problems", about: "What didn't work (sign-ins, AI helper) and how to fix it" },
  { name: "help", about: "List these commands" },
  { name: "quit", about: "Leave Clockout (/exit works too)", key: "ctrl+c", aliases: ["exit"] },
];

const SECTIONS: SetupSection[] = ["sources", "day", "ai", "projects", "erp"];
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/**
 * The chat bar's text as a slash command, if it is one. Dictation writes "slash refresh" or
 * "Slash connect ERP." rather than "/refresh", so a spoken "slash" counts too, and case and a
 * closing full stop don't matter.
 */
export function slashText(text: string): string | null {
  const t = text.trim().replace(/^slash\s+/i, "/");
  if (!t.startsWith("/")) return null;
  return t.replace(/[.!]+$/, "");
}

/** The commands the first word typed so far could be: all of them for a bare "/". */
export function matching(text: string): SlashCommand[] {
  const t = slashText(text);
  if (t === null) return [];
  const [word = "", ...rest] = t.slice(1).split(/\s+/);
  const name = word.toLowerCase();
  const names = (c: SlashCommand) => [c.name, ...(c.aliases ?? [])];
  if (rest.length) return COMMANDS.filter((c) => names(c).includes(name));
  return COMMANDS.filter((c) => names(c).some((n) => n.startsWith(name)));
}

/**
 * Reads a slash command: null when the text isn't one, an error to show when it can't be read.
 * `today` is the user's local date, for `/today`, `/yesterday` and `/date`; `exports` the names
 * of your own export formats, for `/copy <name>`.
 */
export function parseSlash(
  text: string,
  today: string,
  exports: readonly string[] = [],
): { ok: Slash } | { error: string } | null {
  const t = slashText(text);
  if (t === null) return null;
  const [word = "", ...args] = t.slice(1).split(/\s+/).filter(Boolean);
  const name = word.toLowerCase();
  const arg = args[0]?.toLowerCase();
  const none = (s: Slash) =>
    args.length ? { error: `/${name} takes nothing after it.` } : { ok: s };
  switch (name) {
    case "":
    case "help":
      return { ok: { name: "help" } };
    case "refresh":
      return none({ name: "refresh" });
    case "send":
      return none({ name: "send" });
    case "undo":
      return none({ name: "undo" });
    case "add":
      return none({ name: "add" });
    case "problems":
      return none({ name: "problems" });
    case "quit":
    case "exit":
      return none({ name: "quit" });
    case "today":
      return none({ name: "date", date: today });
    case "yesterday":
      return none({ name: "date", date: addDays(today, -1) });
    case "copy": {
      if (!arg) return { ok: { name: "copy" } };
      const format = arg === "markdown" ? "md" : arg;
      if (args.length === 1 && ["md", "csv", "tsv", ...exports].includes(format))
        return { ok: { name: "copy", format } };
      return {
        error: `Copy as ${[...exports, "md", "csv"].join(", ").replace(/, ([^,]*)$/, " or $1")}, or leave it out for ${exports.length ? "your default" : "rows to paste"}.`,
      };
    }
    case "connect":
    case "disconnect": {
      const service =
        arg === "erp" ? "erp" : arg === "google" || arg === "calendar" ? "google" : null;
      if (!service) return { error: `/${name} erp or /${name} google?` };
      if (name === "disconnect") return { ok: { name, service } };
      const url =
        service === "erp" ? args.slice(1).find((a) => a.toLowerCase() !== "at") : undefined;
      return { ok: { name, service, ...(url ? { url } : {}) } };
    }
    case "date": {
      const date = arg ? dateFrom(arg, today) : null;
      if (!date) return { error: "Which day? e.g. /date monday, /date -3 or /date 2026-10-16" };
      if (date > today) return { error: `${date} hasn't happened yet` };
      return { ok: { name: "date", date } };
    }
    case "setup": {
      if (!arg) return { ok: { name: "setup" } };
      const section = SECTIONS.find((s) => s === arg || (s === "sources" && arg === "source"));
      if (!section) return { error: `Setup has ${SECTIONS.join(", ")}.` };
      return { ok: { name: "setup", section } };
    }
    default:
      return { error: `No command /${word}. Type / to see them.` };
  }
}

/** "today", "yesterday", "-3" (days ago), a weekday (the latest one, today included) or a date. */
function dateFrom(arg: string, today: string): string | null {
  if (arg === "today") return today;
  if (arg === "yesterday") return addDays(today, -1);
  if (/^-\d+$/.test(arg)) return addDays(today, Number(arg));
  if (isDate(arg)) return arg;
  const wd = WEEKDAYS.findIndex((d) => d === arg || d.slice(0, 3) === arg);
  if (wd < 0) return null;
  const now = new Date(`${today}T12:00:00Z`).getUTCDay();
  return addDays(today, -((now - wd + 7) % 7));
}
