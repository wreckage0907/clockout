import type { Config } from "../config/schema";
import type { Activity } from "./types";

export const MEETINGS_PROJECT = "Meetings";

type Rule = Config["projects"][number];

/**
 * Project for an activity: the first matching [[projects]] rule, else the repo ("owner/name"),
 * else the working directory's folder name. Meetings with no rule go to "Meetings".
 */
export function resolveProject(a: Activity, rules: readonly Rule[]): string {
  if (a.project) return a.project;
  const rule = rules.find((r) => matches(r, a));
  if (rule) return rule.name;
  if (a.kind === "meeting") return MEETINGS_PROJECT;
  if (a.repo) return a.repo;
  if (a.cwd) return a.cwd.split(/[\\/]/).filter(Boolean).pop() ?? a.cwd;
  return "Unsorted";
}

/** The rule's own default task, if the activity matched a rule that has one. */
export function ruleTask(a: Activity, rules: readonly Rule[]): string | undefined {
  return rules.find((r) => matches(r, a))?.task;
}

/** The `ignore` rule's name if one leaves this project off the day. */
export function ignoredBy(project: string, rules: readonly Rule[]): string | undefined {
  const p = project.toLowerCase();
  return rules.find((r) => r.ignore && r.name.toLowerCase() === p)?.name;
}

function matches(rule: Rule, a: Activity): boolean {
  const m = rule.match;
  if (!m) return false;
  if (m.repo && a.repo && a.repo.toLowerCase() === m.repo.toLowerCase()) return true;
  if (m.title && a.title && safeRegex(m.title)?.test(a.title)) return true;
  if (m.attendee_domain && a.attendees) {
    const domain = m.attendee_domain.toLowerCase().replace(/^@/, "");
    if (a.attendees.some((e) => e.toLowerCase().endsWith(`@${domain}`))) return true;
  }
  return false;
}

const regexCache = new Map<string, RegExp | null>();
function safeRegex(source: string): RegExp | null {
  if (!regexCache.has(source)) {
    let re: RegExp | null = null;
    try {
      // Allow a leading (?i) as in most regex dialects.
      re = source.startsWith("(?i)") ? new RegExp(source.slice(4), "i") : new RegExp(source);
    } catch {
      re = null;
    }
    regexCache.set(source, re);
  }
  return regexCache.get(source) ?? null;
}

/** Ticket keys like ABC-123 in a branch name. */
export function ticketKeys(branch: string | undefined): string[] {
  if (!branch) return [];
  return [...new Set(branch.toUpperCase().match(/\b[A-Z][A-Z0-9]+-\d+\b/g) ?? [])];
}
