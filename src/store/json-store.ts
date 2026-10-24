import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tildify } from "../config/paths";
import type { PushedEntry } from "../core/push";
import type { Activity, Day, EditOp } from "../core/types";
import { fileError } from "../files";

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
    const where = tildify(this.file(date));
    let parsed: unknown;
    try {
      parsed = JSON.parse(text, reviveDates);
    } catch (err) {
      throw new Error(
        `The saved day ${where} is damaged. Move it aside (or delete it) to rebuild the day from your activity; corrections made on it are lost.`,
        { cause: err },
      );
    }
    const version = (parsed as { version?: unknown } | null)?.version;
    if (typeof version === "number" && version > 1)
      throw new Error(
        `${where} was saved by a newer Clockout. Update Clockout to open it (npm i -g clockout-cli).`,
      );
    if (version !== 1 || typeof (parsed as { day?: unknown }).day !== "object")
      throw new Error(
        `The saved day ${where} isn't one Clockout can read. Move it aside (or delete it) to rebuild the day.`,
      );
    return parsed as StoredDay;
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
    await mkdir(join(this.dataDir, "days"), { recursive: true, mode: 0o700 }).catch(
      (err: unknown) => {
        throw fileError(file, err, `the day to ${tildify(file)}`);
      },
    );
    const trimmed = { ...stored, history: stored.history.slice(-HISTORY_LIMIT) };
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      await writeFile(tmp, `${JSON.stringify(trimmed, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, file);
    } catch (err) {
      throw fileError(file, err, `the day to ${tildify(file)}`);
    }
  }
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
function reviveDates(key: string, value: unknown): unknown {
  return (key === "start" || key === "end") && typeof value === "string" && ISO.test(value)
    ? new Date(value)
    : value;
}
