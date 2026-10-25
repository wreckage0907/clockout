import type { Config, StandupStyle } from "../config/schema";
import { ignoredBy, MEETINGS_PROJECT, resolveProject } from "./projects";
import { addDays, localTime } from "./time";
import { blockHours, countedBlocks, rowKey } from "./timesheet";
import type { Activity, Day } from "./types";

// A standup from the same evidence as the timesheet (spec §8): yesterday from the previous
// working day's saved day, today from today's calendar and what's still open, blockers only
// from what you say.

/** Your pull request that's still open. */
export interface OpenPr {
  repo: string;
  number: number;
  title: string;
  draft?: boolean;
  branch?: string;
}

/** Someone's pull request waiting for your review. */
export interface ReviewRequest {
  repo: string;
  number: number;
  title: string;
  author?: string;
}

/** What's still open on GitHub, read when the standup is written. */
export interface OpenWork {
  prs: OpenPr[];
  reviews: ReviewRequest[];
  /** "owner/name" → head branches of your recently merged or closed pull requests. */
  finished: Record<string, string[]>;
}

export interface StandupFacts {
  /** The standup's day. */
  date: string;
  /** The previous working day, and what's on its timesheet. */
  yesterday: { date: string; items: StandupItem[] } | null;
  /** Today's meetings, from the calendar, in order. */
  meetings: { title: string; time: string }[];
  prs: OpenPr[];
  reviews: ReviewRequest[];
  /** Branches you worked on that have no pull request, open or merged. */
  branches: { repo: string; branch: string }[];
  /** Only what you said. Never guessed. */
  blockers: string[];
}

export interface StandupItem {
  kind: "work" | "review" | "meeting";
  project: string;
  description: string;
  hours: number;
}

/** What the standup says, by section; blockers are always yours, word for word. */
export interface StandupSections {
  yesterday: string[];
  today: string[];
}

const DEFAULT_BRANCHES = new Set(["main", "master", "develop", "development", "dev", "trunk"]);

/** The working day before `date`: Friday for a Saturday, Sunday or Monday. */
export function previousWorkingDay(date: string): string {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return addDays(date, day === 1 ? -3 : day === 0 ? -2 : -1);
}

/** The day's timesheet as standup items: one per row, with the kind of work it was. */
export function dayItems(day: Day, config: Config): StandupItem[] {
  const items = new Map<string, StandupItem>();
  for (const b of countedBlocks(day)) {
    const key = rowKey(b);
    const item = items.get(key) ?? {
      kind: b.kind,
      project: b.project,
      description: b.summary,
      hours: 0,
    };
    item.hours += blockHours(b, config);
    items.set(key, item);
  }
  return [...items.values()];
}

/** Today's meetings you haven't declined, minus those an `ignore` rule leaves out. */
export function todaysMeetings(
  activities: readonly Activity[],
  config: Config,
  tz: string,
): StandupFacts["meetings"] {
  const seen = new Set<string>();
  return activities
    .filter((a) => a.kind === "meeting" && a.attendance !== "declined" && a.title)
    .filter((a) => !ignoredBy(resolveProject(a, config.projects), config.projects))
    .toSorted((a, b) => a.start.getTime() - b.start.getTime())
    .flatMap((a) => {
      const key = `${a.start.getTime()} ${a.title}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ title: a.title ?? "", time: localTime(a.start, tz) }];
    });
}

/**
 * Branches you worked on during `day` that no pull request of yours covers: not open, not
 * merged or closed lately. Only what GitHub can say, so only with `open`.
 */
export function branchesWithoutPr(day: Day, open: OpenWork): { repo: string; branch: string }[] {
  const covered = new Set([
    ...open.prs.flatMap((p) => (p.branch ? [`${p.repo} ${p.branch}`] : [])),
    ...Object.entries(open.finished).flatMap(([repo, bs]) => bs.map((b) => `${repo} ${b}`)),
  ]);
  const out = new Map<string, { repo: string; branch: string }>();
  for (const b of countedBlocks(day)) {
    if (b.kind !== "work") continue;
    for (const a of b.evidence) {
      if (!a.repo || !a.branch || DEFAULT_BRANCHES.has(a.branch) || a.branch === "HEAD") continue;
      const key = `${a.repo} ${a.branch}`;
      if (!covered.has(key)) out.set(key, { repo: a.repo, branch: a.branch });
    }
  }
  return [...out.values()];
}

/** The standup without an AI helper: what was on the timesheet, and what's on today. */
export function plainSections(facts: StandupFacts): StandupSections {
  const items = facts.yesterday?.items ?? [];
  const work = items.filter((i) => i.kind !== "meeting");
  const meetings = items.filter((i) => i.kind === "meeting");
  const yesterday = [
    ...work.map((i) =>
      i.kind === "review" || i.project === MEETINGS_PROJECT
        ? i.description
        : `${i.description} (${i.project})`,
    ),
    ...(meetings.length ? [`Meetings: ${meetings.map((m) => m.description).join(", ")}`] : []),
  ];
  const today = [
    ...facts.prs.map(
      (p) => `${p.draft ? "Finish" : "Follow up on"} PR #${p.number} ${p.title} (${p.repo})`,
    ),
    ...facts.branches.map((b) => `Continue ${b.branch} (${b.repo})`),
    ...facts.reviews.map(
      (r) => `Review PR #${r.number} ${r.title} (${r.repo}${r.author ? `, ${r.author}` : ""})`,
    ),
    ...(facts.meetings.length
      ? [`Meetings: ${facts.meetings.map((m) => `${m.title} ${m.time}`).join(", ")}`]
      : []),
  ];
  return { yesterday, today };
}

/** The standup as text to paste. Blockers are yours, as you said them, or "None". */
export function renderStandup(
  sections: StandupSections,
  facts: Pick<StandupFacts, "date" | "yesterday" | "blockers">,
  style: Pick<StandupStyle, "format">,
): string {
  const before = facts.yesterday?.date;
  const label =
    !before || before === addDays(facts.date, -1)
      ? "Yesterday"
      : new Date(`${before}T12:00:00Z`).toLocaleDateString("en", {
          weekday: "long",
          timeZone: "UTC",
        });
  const parts: [string, string[], string][] = [
    [label, sections.yesterday, "Nothing on the timesheet"],
    ["Today", sections.today, "Nothing planned yet"],
    ["Blockers", facts.blockers, "None"],
  ];
  if (style.format === "prose")
    return parts
      .map(([title, lines, none]) => `${title}: ${lines.length ? sentence(lines) : `${none}.`}`)
      .join("\n");
  return parts
    .map(([title, lines, none]) =>
      [title, ...(lines.length ? lines : [none]).map((l) => `- ${l}`)].join("\n"),
    )
    .join("\n\n");
}

/** Items as one run of text: "a; b; c." */
function sentence(lines: string[]): string {
  const text = lines.map((l) => l.replace(/[.;]+$/, "")).join("; ");
  return `${text}.`;
}
