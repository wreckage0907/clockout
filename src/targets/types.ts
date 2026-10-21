import type { RemoteDay } from "../core/push";

/** A task you can log time against in the timesheet system. */
export interface RemoteTask {
  id: string;
  /** The task's name. */
  subject: string;
  /** The project's name. */
  project: string;
}

/** An entry to write. */
export interface EntryInput {
  task: string;
  hours: number;
  description: string;
}

/**
 * A timesheet system Clockout sends days to. Only reads and writes entries; what to send is
 * decided in core/push.
 */
export interface Target {
  /** Matches `type` in `[timesheet]` config. */
  id: string;
  /** For messages, e.g. "the ERP". */
  name: string;
  /** Your entries on a local date ("YYYY-MM-DD"). */
  day(date: string): Promise<RemoteDay>;
  /** Tasks you can log against, best matches first. */
  searchTasks(query: string): Promise<RemoteTask[]>;
  create(date: string, entry: EntryInput): Promise<void>;
  update(date: string, id: string, parent: string, entry: EntryInput): Promise<void>;
  remove(id: string, parent: string): Promise<void>;
}
