import type { Config } from "../config/schema";
import type { Activity } from "../core/types";

export interface DateRange {
  from: Date;
  to: Date;
}

/** What a source needs from the outside world, injectable for tests. */
export interface SourceContext {
  config: Config;
  homeDir: string;
  env: NodeJS.ProcessEnv;
}

/** Returned by `detect()` when the tool is present. */
export interface Detected {
  /** Short line for `clockout init` and `clockout doctor`, e.g. "12 projects in ~/.claude/projects". */
  summary: string;
}

export interface Source<C = unknown> {
  /** Matches `type` in `[[sources]]` config. */
  id: string;
  name: string;
  /** Fast, offline check that the tool is installed or logged in. */
  detect(ctx: Omit<SourceContext, "config">): Promise<Detected | null>;
  /** Activities that start inside `range`. Invalid raw records are skipped, not thrown. */
  collect(range: DateRange, cfg: C, ctx: SourceContext): AsyncIterable<Activity>;
}
