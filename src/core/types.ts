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
  | "review_comment" // a comment on someone else's pull request
  | "issue" // the user opened an issue
  | "comment" // the user commented on an issue or their own pull request
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
  /** Other attendees' emails, for meetings. */
  attendees?: string[];
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
  /** Exported and counted only when true. False for lunch, breaks and the like. */
  billable: boolean;
  /** False for meetings you haven't confirmed attending; they're left out until you do. */
  confirmed: boolean;
  /**
   * Minutes you set by hand ("standup ran to 45 minutes"). Replaces end − start on the
   * timesheet; the times themselves stay as they were.
   */
  minutes?: number;
  /**
   * The ERP task you picked for this block's row in the review screen. Wins over the task
   * mapped for its project, for this day only.
   */
  sendTo?: ErpTaskRef;
  evidence: Activity[];
}

/** An ERP task by id, with its name for display. */
export interface ErpTaskRef {
  task: string;
  label: string;
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
  /** Things the user should know, e.g. declined meetings that were left out. */
  notes: string[];
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
      confirmed?: boolean;
      /** Minutes to count for the block, regardless of its times. */
      minutes?: number;
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
  | { op: "clarify"; question: string }
  /**
   * Which ERP task a block's row is sent to; `task: null` goes back to the project's. Made by the
   * review screen's task picker, never by the AI (it isn't in the schema the AI gets).
   */
  | { op: "send_to"; id: string; task: string | null; label?: string };

/** One timesheet row as exported. */
export interface TimesheetRow {
  date: string; // "YYYY-MM-DD"
  project: string;
  task: string;
  hours: number;
  description: string;
  /** The ERP task picked for this row, if it differs from its project's. Not exported. */
  sendTo?: ErpTaskRef;
}
