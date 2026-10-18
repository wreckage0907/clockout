import type { z } from "zod";

export interface CompleteRequest<T> {
  system: string;
  prompt: string;
  /** Output must match this schema; backends enforce it where they can and validate always. */
  schema: z.ZodType<T>;
}

export interface LlmBackend {
  id: string;
  /** Shown to the user, e.g. "Claude Code (haiku)". */
  label: string;
  complete<T>(req: CompleteRequest<T>): Promise<T>;
}
