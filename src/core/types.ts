// Domain types shared by sources, core, AI backends, the TUI and exporters.
// Times are UTC `Date`s; convert to the user's time zone only for display and export.

export interface DateRange {
  from: Date;
  to: Date;
}

export type ActivityKind =
  | "prompt" // the user sent a prompt to a coding agent
  | "agent_turn" // a coding agent worked (may run while the user is elsewhere)
  | "commit"
  | "pr" // the user opened a pull request
  | "review" // the user submitted a pull request review
  | "review_comment"
  | "meeting";

export type Actor = "human" | "agent";

/** The user's RSVP for a meeting. `unknown` when the calendar gives no attendee data. */
export type Attendance = "accepted" | "tentative" | "needs_action" | "declined" | "unknown";

/** One piece of evidence of work, as emitted by a source. */
export interface Activity {
  source: string;
  kind: ActivityKind;
  actor: Actor;
  start: Date;
  end?: Date;
  title?: string;
  /** Set only when the source knows it for sure; otherwise resolved later by core. */
  project?: string;
  /** "owner/name" */
  repo?: string;
  branch?: string;
  cwd?: string;
  sessionId?: string;
  /** Stable references, e.g. "pr:owner/repo#42", "jira:ABC-123", "event:<uid>". */
  refs?: string[];
  attendance?: Attendance;
}

/** A stretch of time on one thing, shown as one timesheet row. */
export interface Block {
  /** Stable within a day ("b1", "b2", …) so edit operations can target it. */
  id: string;
  start: Date;
  end: Date;
  project: string;
  task: string;
  summary: string;
  kind: "work" | "meeting" | "review";
  billable: boolean;
  evidence: Activity[];
}

/** Unaccounted time inside working hours. */
export interface Gap {
  id: string; // "g1", "g2", …
  start: Date;
  end: Date;
}

export interface Question {
  id: string; // "q1", "q2", …
  kind: "attendance" | "gap" | "overlap";
  text: string;
  blockId?: string;
  gapId?: string;
}

export interface Day {
  /** Local calendar date in `timezone`, "YYYY-MM-DD". */
  date: string;
  timezone: string;
  blocks: Block[];
  gaps: Gap[];
  questions: Question[];
}

/** Local wall-clock time on the day being edited, "HH:MM". */
export type LocalTime = string;

/**
 * A change to a day, produced by the AI from a spoken correction (or by a key press).
 * The AI never rewrites the day; core validates and applies these.
 */
export type EditOp =
  | {
      op: "add";
      start: LocalTime;
      end: LocalTime;
      project: string;
      task?: string;
      summary: string;
      billable?: boolean;
      refs?: string[];
    }
  | {
      op: "update";
      id: string;
      start?: LocalTime;
      end?: LocalTime;
      project?: string;
      task?: string;
      summary?: string;
      billable?: boolean;
    }
  | { op: "delete"; id: string }
  | { op: "split"; id: string; at: LocalTime }
  | { op: "merge"; ids: string[] }
  | {
      op: "fill_gap";
      gapId: string;
      project?: string;
      task?: string;
      summary: string;
      billable?: boolean;
    }
  | { op: "clarify"; question: string };

/** One timesheet row as exported. */
export interface TimesheetRow {
  date: string; // "YYYY-MM-DD"
  project: string;
  task: string;
  hours: number;
  description: string;
}
