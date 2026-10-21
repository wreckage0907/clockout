import type { Correction } from "../../src/ai/edits";
import { withTaskMapping } from "../../src/config/edit";
import type { Config, TaskMapping } from "../../src/config/schema";
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
    parse?: (text: string, day: Day) => Promise<Correction>;
    setup?: Partial<SetupState>;
    /** The day to load; the fixture day by default. */
    day?: Day;
    /** An ERP to send to; no "Send to ERP" without one. */
    erp?: { target: Target; map?: TaskMapping[] };
  } = {},
) {
  const start: StoredDay = opts.day ? { ...stored, day: opts.day } : stored;
  const calls = {
    loads: [] as string[],
    commits: [] as { ops: EditOp[]; text?: string }[],
    copied: [] as string[],
    saved: [] as unknown[],
    mapped: [] as TaskMapping[],
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
    load: async (date) => {
      calls.loads.push(date);
      return { stored: start, warnings: [], kept: false };
    },
    hasAI: () => opts.parse !== undefined,
    parse: (text, day) => {
      if (!opts.parse) throw new Error("no AI");
      return opts.parse(text, day);
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
        github: { found: true },
        aiFound: true,
        ...opts.setup,
      }),
      save: async (next) => {
        calls.saved.push(next);
        return next;
      },
      connectGoogle: async () => {},
    },
  };
  return { actions, calls };
}
