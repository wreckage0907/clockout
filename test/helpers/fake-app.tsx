import { type Correction, localCorrection, type Turn } from "../../src/ai/edits";
import { withErpSite, withTaskMapping } from "../../src/config/edit";
import type { Config, TaskMapping } from "../../src/config/schema";
import { applySettings, type SettingOp } from "../../src/config/setting-ops";
import { buildDay } from "../../src/core/blocks";
import { applyEdits } from "../../src/core/edits";
import type { Day, EditOp } from "../../src/core/types";
import { applyPush, preparePush } from "../../src/push";
import type { DayStore, StoredDay } from "../../src/store/json-store";
import type { Target } from "../../src/targets/types";
import type { AppActions } from "../../src/tui/App";
import type { SetupState } from "../../src/tui/Setup";
import { FIXTURE_DATE, fixtureActivities, fixtureConfig } from "./fixture-day";

export const config = fixtureConfig();
const activities = await fixtureActivities();
export const fixtureDay: Day = buildDay(FIXTURE_DATE, activities, config);

export const stored: StoredDay = {
  version: 1,
  date: FIXTURE_DATE,
  collectedAt: "2026-10-16T19:00:00Z",
  activities,
  day: fixtureDay,
  history: [],
  edits: [],
  summaryCache: {},
};

/**
 * The app's side effects, in memory: commits apply through core like the real store does,
 * and every call is recorded for assertions.
 */
export function fakeActions(
  opts: {
    parse?: (text: string, day: Day, earlier: Turn[]) => Promise<Correction>;
    setup?: Partial<SetupState>;
    /** Milliseconds each Setup save takes, as writing config.toml does. */
    saveDelay?: number;
    /** The day to load; the fixture day by default. */
    day?: Day;
    /** An ERP to send to; no "Send to ERP" without one. */
    erp?: { target: Target; map?: TaskMapping[] };
    /** A corrected day with newer activity that can't be merged under it, until refreshed. */
    stale?: boolean;
    /** Why there's no AI helper; there is one (Claude Code) without this. */
    noAi?: string;
    /** What went wrong drafting the day, e.g. a source's sign-in. */
    warnings?: string[];
    /** Projects from other days and the ERP, for "Add time". */
    more?: { recent: string[]; erp: string[] };
  } = {},
) {
  const start: StoredDay = opts.day ? { ...stored, day: opts.day } : stored;
  const calls = {
    loads: [] as string[],
    refreshes: 0,
    commits: [] as { ops: EditOp[]; text?: string }[],
    copied: [] as string[],
    saved: [] as unknown[],
    mapped: [] as TaskMapping[],
    configured: [] as SettingOp[][],
    signedIn: [] as string[],
    signedOut: 0,
  };
  let erpConfig: Config = opts.erp
    ? {
        ...config,
        timesheet: {
          type: "next-pms" as const,
          url: "https://erp.example.com",
          map: opts.erp.map ?? [],
        },
      }
    : config;
  const memoryStore = { save: async () => {} } as unknown as DayStore;
  const erp = opts.erp?.target;
  const actions: AppActions = {
    load: async (date, o) => {
      calls.loads.push(date);
      if (o?.refresh) calls.refreshes++;
      if (opts.stale && !o?.refresh)
        return {
          stored: { ...start, edits: [{ at: "", ops: [] }] },
          warnings: ["There's newer activity that can't be merged under your corrections."],
          kept: true,
          stale: true,
        };
      return { stored: start, warnings: opts.warnings ?? [], kept: false };
    },
    errorLog: "~/.local/share/clockout/errors.log",
    moreProjects: async () => opts.more ?? { recent: [], erp: [] },
    ai: () =>
      opts.noAi ? { on: false, why: opts.noAi } : { on: true, label: "Claude Code (haiku)" },
    parse: async (text, day, earlier) => {
      if (opts.parse) return opts.parse(text, day, earlier);
      const local = localCorrection(text);
      if (local) return local;
      throw new Error(
        opts.noAi ?? "Typed corrections need the AI helper. Turn it on in Setup (ctrl+p).",
      );
    },
    configure: async (ops) => {
      calls.configured.push(ops);
      const r = applySettings(erpConfig, ops, [
        { folder: "-Users-dev-work-acme-api", name: "acme-api" },
        { folder: "-Users-dev-code-clockout", name: "clockout" },
      ]);
      if (r.errors.length) throw new Error(r.errors.join(" "));
      erpConfig = r.config;
      const pick = r.effects.find((e) => e.kind === "pick_task");
      return { config: erpConfig, ...(pick?.kind === "pick_task" ? { pick } : {}) };
    },
    commit: async (s, ops, text) => {
      calls.commits.push({ ops, ...(text ? { text } : {}) });
      const r = applyEdits(s.day, ops, config);
      return {
        stored: r.errors.length
          ? s
          : {
              ...s,
              day: r.day,
              history: [...s.history, s.day],
              edits: [...s.edits, { at: "", ops }],
            },
        errors: r.errors,
      };
    },
    undo: async (s) => {
      const prev = s.history.at(-1);
      return prev ? { ...s, day: prev, history: s.history.slice(0, -1) } : null;
    },
    copy: async (t) => {
      calls.copied.push(t);
    },
    savedDates: async () => [FIXTURE_DATE],
    ...(erp
      ? {
          send: {
            site: "erp.example.com",
            plan: (s) => preparePush(s, erpConfig, erp),
            apply: (s, plan) => applyPush(s, plan, erp, memoryStore),
            searchTasks: (q) => erp.searchTasks(q),
            map: async (m) => {
              calls.mapped.push(m);
              erpConfig = withTaskMapping(erpConfig, m);
              return erpConfig;
            },
          } satisfies NonNullable<AppActions["send"]>,
        }
      : {}),
    setup: {
      state: async () => ({
        config,
        googleConnected: false,
        claude: {
          found: true,
          projects: [
            {
              folder: "-Users-dev-work-acme-api",
              path: "~/work/acme-api",
              name: "acme-api",
              sessions: 2,
              recent: 2,
            },
            {
              folder: "-Users-dev-code-clockout",
              path: "~/code/clockout",
              name: "clockout",
              sessions: 1,
              recent: 1,
            },
          ],
        },
        pi: { found: "2 projects in ~/.pi/agent/sessions" },
        codex: { found: null },
        opencode: { found: null },
        antigravity: { found: null },
        github: { found: true },
        helpers: [{ id: "claude-code", name: "Claude Code" }],
        erp: { connected: false },
        ...opts.setup,
      }),
      save: async (next) => {
        if (opts.saveDelay) await new Promise((r) => setTimeout(r, opts.saveDelay));
        calls.saved.push(next);
        return next;
      },
      connectGoogle: async () => {},
      connectErp: async (site) => {
        calls.signedIn.push(site);
        erpConfig = withErpSite(erpConfig, `https://${site}`);
        return { config: erpConfig, user: "dev@example.com" };
      },
      disconnectErp: async () => {
        calls.signedOut++;
      },
    },
  };
  return { actions, calls };
}
