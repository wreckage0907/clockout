import { z } from "zod";
import { runCommand } from "../../command";
import { plainText, type RemoteDay, roundHours } from "../../core/push";
import type { EntryInput, RemoteTask, Target } from "../types";

// A timesheet system behind your own program ([ADR 0009](../../../docs/adr/0009-change-clockout-through-config.md),
// layer 4): Clockout runs it with one JSON request on stdin and reads one JSON answer, in the
// same shapes as the JSON API ([timesheet-api.md](../../../docs/timesheet-api.md)). No shell,
// a timeout, its own process group. It's set by hand only; no AI operation can add one.

const entries = z.object({
  entries: z.array(
    z.object({
      id: z.union([z.string(), z.number()]).transform(String),
      task: z.string(),
      hours: z.number(),
      description: z.string().nullable().default(""),
      locked: z.string().nullable().optional(),
    }),
  ),
  closed: z.string().nullable().optional(),
});

const tasks = z.object({
  tasks: z.array(
    z.object({
      id: z.union([z.string(), z.number()]).transform(String),
      subject: z.string().nullable().optional(),
      project: z.string().nullable().optional(),
    }),
  ),
});

const created = z.object({ id: z.union([z.string(), z.number()]).transform(String) }).optional();

export function commandTarget(run: readonly string[]): Target {
  const name = run[0] ?? "your program";

  /** One request, one answer; a shape it can't read is its fault and says so. */
  async function ask<T>(schema: z.ZodType<T>, request: Record<string, unknown>, what: string) {
    const { json } = await runCommand(run, request, { name });
    const parsed = schema.safeParse(json);
    if (!parsed.success)
      throw new Error(`${name} sent ${what} in a shape Clockout can't read.`, {
        cause: parsed.error,
      });
    return parsed.data;
  }

  /** A refusal is `{ "error": "a sentence for the user" }`, shown as it's written. */
  async function send(request: Record<string, unknown>) {
    const { json } = await runCommand(run, request, { name });
    if (typeof json.error === "string") throw new Error(plainText(json.error));
    return json;
  }

  return {
    id: "command",
    name,
    async day(date): Promise<RemoteDay> {
      const answer = await ask(entries, { op: "day", date }, "a day");
      return {
        entries: answer.entries.map((e) => ({
          id: e.id,
          // A flat list of entries, as the JSON API has: no document to belong to.
          parent: "",
          task: e.task,
          hours: roundHours(e.hours),
          description: plainText(e.description ?? ""),
          ...(e.locked ? { locked: e.locked } : {}),
        })),
        ...(answer.closed ? { closed: answer.closed } : {}),
      } satisfies RemoteDay;
    },
    async searchTasks(query): Promise<RemoteTask[]> {
      const answer = await ask(tasks, { op: "tasks", search: query }, "a task list");
      return answer.tasks.map((t) => ({
        id: t.id,
        subject: t.subject ?? t.id,
        project: t.project ?? "",
      }));
    },
    async create(date, entry: EntryInput) {
      const answer = await send({ op: "create", date, entry: shaped(entry) });
      created.parse(answer);
    },
    async update(date, id, parent, entry: EntryInput) {
      await send({ op: "update", date, id, parent, entry: shaped(entry) });
    },
    async remove(id, parent) {
      await send({ op: "delete", id, parent });
    },
  };

  /** The entry as the API writes it: hours rounded to what a timesheet takes. */
  function shaped(entry: EntryInput) {
    return {
      task: entry.task,
      hours: roundHours(entry.hours),
      description: entry.description,
    };
  }
}
