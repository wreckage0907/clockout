import { z } from "zod";
import type { EditOp } from "./types";

/** "HH:MM" on the day being edited; "24:00" means the end of the day. */
const localTime = z
  .string()
  .regex(/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/, 'use 24-hour "HH:MM"')
  .describe('24-hour local time "HH:MM"; "24:00" is midnight at the end of the day');

const blockId = z
  .string()
  .regex(/^b\d+$/)
  .describe('A block id from the day, e.g. "b3"');

/** Runtime schema for EditOp; also sent to the AI as the shape to produce. */
export const editOpSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("add"),
      start: localTime,
      end: localTime,
      project: z.string().min(1),
      task: z.string().min(1).optional(),
      summary: z.string().min(1),
      billable: z.boolean().optional(),
      refs: z.array(z.string()).optional(),
    })
    .describe("Add a new block of time"),
  z
    .object({
      op: z.literal("update"),
      id: blockId,
      start: localTime.optional(),
      end: localTime.optional(),
      project: z.string().min(1).optional(),
      task: z.string().min(1).optional(),
      summary: z.string().min(1).optional(),
      billable: z.boolean().optional(),
      confirmed: z.boolean().optional().describe("true when the user says they attended a meeting"),
      minutes: z
        .number()
        .int()
        .min(0)
        .max(24 * 60)
        .optional()
        .describe(
          'How long it took, in minutes, when the user gives a length ("ran to 45 minutes")',
        ),
    })
    .describe("Change fields of an existing block"),
  z
    .object({ op: z.literal("delete"), id: blockId })
    .describe("Remove a block (e.g. a skipped meeting)"),
  z
    .object({ op: z.literal("split"), id: blockId, at: localTime })
    .describe("Split a block in two at a time"),
  z
    .object({ op: z.literal("merge"), ids: z.array(blockId).min(2) })
    .describe("Merge blocks into the earliest one"),
  z
    .object({
      op: z.literal("fill_gap"),
      gapId: z.string().regex(/^g\d+$/),
      project: z.string().min(1).optional(),
      task: z.string().min(1).optional(),
      summary: z.string().min(1),
      billable: z.boolean().optional(),
    })
    .describe("Turn a gap into a block, e.g. lunch (billable false) or work"),
  z
    .object({ op: z.literal("clarify"), question: z.string().min(1) })
    .describe("Ask the user a question instead of guessing"),
]) satisfies z.ZodType<EditOp>;
