import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PushedEntry } from "../core/push";
import type { Activity, Day, EditOp } from "../core/types";

export interface EditRecord {
  at: string;
  /** What the user said or typed, if the edit came from a sentence. */
  text?: string;
  ops: EditOp[];
}

export interface StoredDay {
  version: 1;
  date: string;
  collectedAt: string;
  /** Raw evidence, kept so the day can be rebuilt after agents delete their logs. */
  activities: Activity[];
  day: Day;
  /** Previous versions of `day`, newest last, for undo. */
  history: Day[];
  edits: EditRecord[];
  /** AI summaries by block signature, so unchanged blocks aren't summarized again. */
  summaryCache: Record<string, string>;
  /** Which timesheet-system entry each row became when the day was last sent. */
  pushed?: PushedEntry[];
  /** When the day was last sent, ISO. */
  pushedAt?: string;
}

const HISTORY_LIMIT = 50;

/** One JSON file per day under `<dataDir>/days/`. */
export class DayStore {
  constructor(private readonly dataDir: string) {}

  private file(date: string): string {
    return join(this.dataDir, "days", `${date}.json`);
  }

  async load(date: string): Promise<StoredDay | null> {
    let text: string;
    try {
      text = await readFile(this.file(date), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    const parsed = JSON.parse(text, reviveDates) as StoredDay;
    return parsed.version === 1 ? parsed : null;
  }

  /** Dates with a saved day, sorted ascending; empty when nothing is saved yet. */
  async dates(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(join(this.dataDir, "days"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    return names
      .filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n))
      .map((n) => n.slice(0, 10))
      .sort();
  }

  async save(stored: StoredDay): Promise<void> {
    const file = this.file(stored.date);
    await mkdir(join(this.dataDir, "days"), { recursive: true, mode: 0o700 });
    const trimmed = { ...stored, history: stored.history.slice(-HISTORY_LIMIT) };
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(trimmed, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, file);
  }
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
function reviveDates(key: string, value: unknown): unknown {
  return (key === "start" || key === "end") && typeof value === "string" && ISO.test(value)
    ? new Date(value)
    : value;
}
