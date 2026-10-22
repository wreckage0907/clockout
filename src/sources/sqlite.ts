import { stat } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";

// Some agents keep their sessions in SQLite. Node's built-in `node:sqlite` reads them without a
// native dependency (ADR 0008). It's unflagged from Node 22.13; on older Node these sources find
// nothing instead of failing the day.

type SqliteModule = typeof import("node:sqlite");

let loaded: Promise<SqliteModule | null> | undefined;

/** `node:sqlite`, loaded once without its "experimental feature" warning, or null when missing. */
function sqlite(): Promise<SqliteModule | null> {
  loaded ??= (async () => {
    const emit = process.emitWarning;
    process.emitWarning = function (this: unknown, warning, ...rest: unknown[]) {
      if (String(warning).includes("SQLite")) return;
      return (emit as (...args: unknown[]) => void).call(process, warning, ...rest);
    } as typeof process.emitWarning;
    try {
      return await import("node:sqlite");
    } catch {
      return null;
    } finally {
      process.emitWarning = emit;
    }
  })();
  return loaded;
}

/** Another tool's database, opened read-only, or null when it's missing or unreadable. */
export async function openReadOnly(file: string): Promise<DatabaseSync | null> {
  if (!(await stat(file).catch(() => null))?.isFile()) return null;
  const mod = await sqlite();
  if (!mod) return null;
  try {
    return new mod.DatabaseSync(file, { readOnly: true });
  } catch {
    return null;
  }
}
