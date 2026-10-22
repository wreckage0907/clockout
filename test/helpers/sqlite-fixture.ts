import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

/** Builds a SQLite database at `file` from a fixture's SQL script (fixtures stay readable text). */
export async function buildDb(sqlFile: string, file: string): Promise<void> {
  const db = new DatabaseSync(file);
  db.exec(await readFile(sqlFile, "utf8"));
  db.close();
}
