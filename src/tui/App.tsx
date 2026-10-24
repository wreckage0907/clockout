import { Box, Text, useInput } from "ink";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Correction, Turn } from "../ai/edits";
import type { OpenedDay } from "../collect";
import { withProject } from "../config/edit";
import { type Config, durationMinutes, type TaskMapping } from "../config/schema";
import { describeSettings, type SettingEffect, type SettingOp } from "../config/setting-ops";
import { describeEdits, placeTimeOps } from "../core/edits";
import { addTimeProjects } from "../core/projects";
import { changes, mappingFor, type PushPlan, type PushRow } from "../core/push";
import { addDays, parseDuration } from "../core/time";
import {
  removeRowOps,
  rowKey,
  sendRowOps,
  setRowMinutesOps,
  timesheetRows,
} from "../core/timesheet";
import type { Day, EditOp } from "../core/types";
import { toCsv, toMarkdown, toTsv } from "../export/formats";
import type { PushResult } from "../push";
import type { StoredDay } from "../store/json-store";
import type { RemoteTask } from "../targets/types";
import { buildCards, type Card, segments } from "./cards";
import { Clickable } from "./clickable";
import {
  AddTimeDialog,
  BarWordmark,
  Button,
  ChatBar,
  DatePicker,
  HoursBar,
  longDate,
  mix,
  Pill,
  ProblemsDialog,
  SlashMenu,
  Spinner,
  Toast,
  useDraft,
  useToast,
} from "./kit";
import type { Choice } from "./questions";
import { short } from "./questions";
import { SendPanel, TaskPicker } from "./Send";
import { Setup, type SetupActions } from "./Setup";
import {
  type CopyFormat,
  matching,
  parseSlash,
  type SetupSection,
  type Slash,
  type SlashCommand,
  slashText,
} from "./slash";
import { hm, projectColor, T } from "./theme";

export interface AppActions {
  /** The day; `refresh` drafts it again from the latest activity, dropping corrections. */
  load(date: string, opts?: { refresh?: boolean }): Promise<OpenedDay>;
  /** The AI helper now, or why there's none (typed corrections need it; the rest doesn't). */
  ai(): { on: true; label: string } | { on: false; why: string };
  /** Where failures are logged in full, for display. */
  errorLog: string;
  /** What was said, as edits to the day and changes to settings; `earlier` is the last few turns. */
  parse(text: string, day: Day, earlier: Turn[]): Promise<Correction>;
  /**
   * Applies settings changes said in the chat bar: signs in or out where asked, saves the
   * config, and returns it, with an ERP task still to pick if the search wasn't conclusive.
   */
  configure(
    ops: SettingOp[],
  ): Promise<{ config: Config; pick?: Extract<SettingEffect, { kind: "pick_task" }> }>;
  commit(
    stored: StoredDay,
    ops: EditOp[],
    text?: string,
  ): Promise<{ stored: StoredDay; errors: string[] }>;
  undo(stored: StoredDay): Promise<StoredDay | null>;
  copy(text: string): Promise<void>;
  /** Dates with a saved day, for the date picker. */
  savedDates(): Promise<string[]>;
  /** Projects from other days and the ERP, for adding time by hand. */
  moreProjects(date: string): Promise<{ recent: string[]; erp: string[] }>;
  setup: SetupActions;
  /** Sending the day to the ERP; absent when none is set up. */
  send?: SendActions;
}

export interface SendActions {
  /** The ERP's host, for display. */
  site: string;
  plan(stored: StoredDay): Promise<PushPlan>;
  apply(stored: StoredDay, plan: PushPlan): Promise<PushResult>;
  searchTasks(query: string): Promise<RemoteTask[]>;
  /** Saves which ERP task a project goes to; returns the new config. */
  map(mapping: TaskMapping): Promise<Config>;
}

interface Proposal {
  text: string;
  ops: EditOp[];
  settings: SettingOp[];
  lines: string[];
  reply: string;
  /** Draft the day again from the latest activity instead. */
  rebuild?: boolean;
}

/** An ERP task to choose for a project: before sending, or because you asked in the chat. */
interface Picking {
  project: string;
  task?: string;
  /** For the picker's heading, e.g. the row's task. */
  label: string;
  description: string;
  query?: string;
  /** Carry on sending the day once it's picked. */
  send: boolean;
  /** Picking for one card (its row key) rather than for the whole project. */
  card?: string;
  /** Picking for checked cards only; unlike a project's first pick, this never changes config. */
  cards?: string[];
}

/** Turns of the chat kept for follow-ups. */
const TURNS = 3;

/**
 * The review app. Home: the logo standing on the day's hours, the total, and the chat bar.
 * Enter opens the day: one roomy card per timesheet row with a big duration you click and type
 * over, meetings to answer, and a card to add untracked time. Setup opens over either with
 * ctrl+p or the chat bar's button.
 */
export function App({
  initialDate,
  today,
  config: initialConfig,
  actions,
  width,
  height,
}: {
  initialDate: string;
  /** The user's local today, for "Today" / "Yesterday". */
  today: string;
  config: Config;
  actions: AppActions;
  width: number;
  height: number;
}) {
  const [config, setConfig] = useState(initialConfig);
  const [date, setDate] = useState(initialDate);
  const [view, setView] = useState<"home" | "day">("home");
  const [setup, setSetup] = useState(false);
  const [setupAt, setSetupAt] = useState<SetupSection>("sources");
  const [reload, setReload] = useState(0);
  const [stored, setStored] = useState<StoredDay | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [stale, setStale] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [saved, setSaved] = useState<string[]>([]);
  const [overlay, setOverlay] = useState<"date" | "add" | "task" | "problems" | null>(null);
  const [sending, setSending] = useState<PushPlan | null>(null);
  const [unmapped, setUnmapped] = useState<Picking | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [sel, setSel] = useState(-1);
  /** Checked timesheet row keys. `sel` remains the one focused card for keyboard editing. */
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const anchor = useRef(-1);
  const [chip, setChip] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [toast, showToast] = useToast();
  // Say once, at the start, that there's no AI helper and what that means.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only on first render
  useEffect(() => {
    const ai = actions.ai();
    if (!ai.on) showToast(ai.why);
  }, []);
  const aiOn = actions.ai().on;
  const draft = useDraft(!setup && !overlay && !editing && !busy && !proposal && !sending);
  const pill = useDraft(!setup && editing !== null);
  const offset = useRef(0);
  const refreshNext = useRef(false);
  const [menuSel, setMenuSel] = useState(0);
  // A "/" in the chat bar opens the command menu; it starts on the first match as you type.
  const slashing =
    slashText(draft.value) !== null && !overlay && !busy && !proposal && !sending && !editing;
  const commands = slashing ? matching(draft.value) : [];
  const menuAt = Math.min(menuSel, Math.max(0, commands.length - 1));
  useEffect(() => {
    void draft.value;
    setMenuSel(0);
  }, [draft.value]);

  useEffect(() => {
    void reload;
    let live = true;
    const refresh = refreshNext.current;
    refreshNext.current = false;
    setLoading(true);
    setStored(null);
    setWarnings([]);
    setStale(false);
    actions
      .load(date, refresh ? { refresh } : undefined)
      .then((opened) => {
        if (!live) return;
        setStored(opened.stored);
        setWarnings(opened.warnings);
        setStale(!!opened.stale);
      })
      .catch((err: Error) => {
        if (!live) return;
        setStored(null);
        setWarnings([`Couldn't load ${date}: ${err.message}`]);
        setStale(false);
      })
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [date, actions, reload]);

  useEffect(() => {
    if (overlay !== "date") return;
    actions
      .savedDates()
      .then(setSaved)
      .catch(() => setSaved([]));
  }, [overlay, actions]);

  // Projects from other days and the ERP, loaded when "Add time" opens; it shows today's first.
  const [more, setMore] = useState<{ recent: string[]; erp: string[] }>({ recent: [], erp: [] });
  useEffect(() => {
    if (overlay !== "add") return;
    let live = true;
    actions
      .moreProjects(date)
      .then((m) => live && setMore(m))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [overlay, actions, date]);
  const addable = (d: Day) => {
    const { local, erp } = addTimeProjects(d, config, more);
    return {
      projects: local,
      ...(erp.length && actions.send ? { erp: { site: actions.send.site, projects: erp } } : {}),
    };
  };

  const day = stored?.day ?? null;
  const cards = useMemo(() => (day ? buildCards(day, config) : []), [day, config]);
  const minutes = cards.reduce((s, c) => s + (c.kind === "row" ? c.minutes : 0), 0);
  const asks = cards.filter((c) => c.kind === "ask").length;
  const target = durationMinutes(config.day.target);
  const step = durationMinutes(config.day.round_to);
  const bars = segments(cards);

  const items: (Card | "add")[] = [...cards, "add"];
  const current = sel >= 0 ? items[Math.min(sel, items.length - 1)] : undefined;
  const card = current && current !== "add" ? current : undefined;
  const checkedCards = cards.filter(
    (c): c is Card & { kind: "row" } => c.kind === "row" && checked.has(c.key),
  );
  const checkedMinutes = checkedCards.reduce((sum, c) => sum + c.minutes, 0);

  // An AI edit can regroup rows and invalidate their keys; never keep invisible cards checked.
  useEffect(() => {
    setChecked((before) => {
      const next = new Set(
        [...before].filter((key) => cards.some((c) => c.kind === "row" && c.key === key)),
      );
      return next.size === before.size ? before : next;
    });
  }, [cards]);

  const goTo = (d: string) => {
    setDate(d);
    setSel(-1);
    setChecked(new Set());
    anchor.current = -1;
    setEditing(null);
    setProposal(null);
    setSending(null);
  };

  const commit = useCallback(
    async (ops: EditOp[], done: string, text?: string) => {
      if (!stored) return;
      setBusy("Saving…");
      try {
        const r = await actions.commit(stored, ops, text);
        if (r.errors.length) showToast(`Couldn't apply that: ${r.errors.join(" ")}`);
        else {
          setStored(r.stored);
          showToast(`${done} · ctrl+z undoes`);
        }
      } catch (err) {
        showToast(`Couldn't save: ${(err as Error).message}`);
      } finally {
        setBusy(null);
      }
    },
    [stored, actions, showToast],
  );

  const setMinutes = (c: Card, m: number) => {
    if (!day) return;
    void commit(
      setRowMinutesOps(day, c.key, m),
      `✓ ${c.title} → ${hm(m)} · day ${hm(minutes - c.minutes + m)}`,
    );
  };
  /** Focus a card, toggle its checkbox, or extend a range from the last anchor. */
  const selectAt = (i: number, range: boolean, toggle: boolean) => {
    const c = items[i];
    if (!c || c === "add") return;
    setSel(i);
    setChip(0);
    if (range && anchor.current >= 0 && c.kind === "row") {
      const from = Math.min(anchor.current, i);
      const to = Math.max(anchor.current, i);
      setChecked(
        new Set(
          items
            .slice(from, to + 1)
            .flatMap((item) => (item !== "add" && item.kind === "row" ? [item.key] : [])),
        ),
      );
      return;
    }
    anchor.current = i;
    if (toggle && c.kind === "row")
      setChecked((before) => {
        const next = new Set(before);
        if (next.has(c.key)) next.delete(c.key);
        else next.add(c.key);
        return next;
      });
  };
  /**
   * Shift- or Option-click ticks a card; once some are ticked, it ticks the range from the
   * anchor. Option is there for multiplexers like herdr that keep Shift-clicks for selection.
   */
  const shiftClick = (i: number) =>
    checked.size && anchor.current >= 0 ? selectAt(i, true, false) : selectAt(i, false, true);
  /** Takes a card off the day: a row's blocks, or a meeting you weren't in. */
  const remove = (c: Card) => {
    if (!day) return;
    const ops: EditOp[] =
      c.kind === "ask" ? [{ op: "delete", id: c.key.slice(4) }] : removeRowOps(day, c.key);
    const left = minutes - (c.kind === "row" ? c.minutes : 0);
    void commit(ops, `✓ Removed “${c.title}” · day ${hm(left)}`);
  };
  const removeChecked = () => {
    if (!day || checkedCards.length === 0) return;
    const ops = checkedCards.flatMap((c) => removeRowOps(day, c.key));
    const n = checkedCards.length;
    setChecked(new Set());
    void commit(
      ops,
      `✓ Removed ${n} card${n === 1 ? "" : "s"} · day ${hm(minutes - checkedMinutes)}`,
    );
  };
  const choose = (c: Choice) => void commit(c.ops, `✓ ${c.label}`);
  const undo = async () => {
    if (!stored) return;
    const prev = await actions.undo(stored).catch(() => null);
    if (prev) {
      setStored(prev);
      showToast("↶ Undone");
    } else showToast("Nothing to undo");
  };
  const copy = async (format: CopyFormat = "tsv", only?: ReadonlySet<string>) => {
    if (!day) return;
    const rows = timesheetRows(day, config).filter(
      (r) =>
        !only || only.has(rowKey({ project: r.project, task: r.task, summary: r.description })),
    );
    if (rows.length === 0)
      return showToast(only ? "No selected rows to copy" : "Nothing to copy yet");
    const as = { tsv: toTsv, md: toMarkdown, csv: toCsv }[format];
    const kind = { tsv: "", md: " as Markdown", csv: " as CSV" }[format];
    const total = only ? checkedMinutes : minutes;
    try {
      await actions.copy(as(rows));
      // Meetings you haven't answered aren't on the sheet yet; say so rather than refuse.
      const waiting =
        !only && asks ? ` · ${asks} meeting${asks === 1 ? "" : "s"} unanswered, left out` : "";
      showToast(
        `✓ Copied ${rows.length}${only ? " selected" : ""} row${rows.length === 1 ? "" : "s"}${kind} · ${hm(total)}${waiting}`,
      );
    } catch {
      showToast("Couldn't reach the clipboard. Use `clockout export` instead.");
    }
  };
  /** Checks the ERP and shows what sending would change; asks for a task first where needed. */
  const erp = actions.send;
  const startSend = async (current = stored) => {
    if (!erp) return showToast("Sign in to your ERP first: Setup (ctrl+p) → ERP");
    if (!current) return;
    setView("day");
    if (asks) return showToast(`Answer the ${asks} meeting${asks === 1 ? "" : "s"} first`);
    setBusy(`Checking ${erp.site}…`);
    try {
      const plan = await erp.plan(current);
      const first = plan.items.find((i) => i.action === "unmapped");
      if (first?.action === "unmapped") {
        setUnmapped(picking(first.row));
        setOverlay("task");
      } else setSending(plan);
    } catch (err) {
      showToast((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  /** The task a picked card's project goes to, if it has one yet. */
  const projectTaskOf = (p: Picking): TaskMapping | undefined =>
    p.card
      ? mappingFor({ project: p.project, task: p.label }, config.timesheet?.map ?? [])
      : undefined;
  /** For a card's pick: what the rest of its project gets, and the way back to it. */
  const cardPick = (p: Picking) => {
    const projectTask = projectTaskOf(p);
    if (!p.card || !projectTask || !day) return {};
    const key = p.card;
    const label = projectTask.label ?? projectTask.erp_task;
    const own = cards.find((c) => c.key === key)?.sendTo?.own;
    return {
      only: { projectTask: label },
      ...(own
        ? {
            reset: {
              label,
              onPick: () => {
                setOverlay(null);
                setUnmapped(null);
                void commit(sendRowOps(day, key, null), `✓ “${p.description}” → ${label}`);
              },
            },
          }
        : {}),
    };
  };
  /** Which ERP task a card goes to. Its project's first pick becomes the project's task. */
  const pickFor = (c: Card) => {
    if (c.kind !== "row") return;
    if (!erp) return showToast("Sign in to your ERP first: Setup (ctrl+p) → ERP");
    setUnmapped({
      project: c.project,
      label: c.task,
      description: c.title,
      send: false,
      card: c.key,
    });
    setOverlay("task");
  };
  const pickChecked = () => {
    if (checkedCards.length === 0) return;
    if (!erp) return showToast("Sign in to your ERP first: Setup (ctrl+p) → ERP");
    const n = checkedCards.length;
    setUnmapped({
      project: `${n} selected card${n === 1 ? "" : "s"}`,
      label: hm(checkedMinutes),
      description: checkedCards.map((c) => c.title).join(" · "),
      send: false,
      cards: checkedCards.map((c) => c.key),
    });
    setOverlay("task");
  };
  const pickTask = async (p: Picking, task: RemoteTask) => {
    if (!erp) return;
    setOverlay(null);
    setUnmapped(null);
    if (p.cards && day) {
      const ops = p.cards.flatMap((key) =>
        sendRowOps(day, key, { task: task.id, label: task.subject }),
      );
      const n = p.cards.length;
      setChecked(new Set());
      return void commit(ops, `✓ ${n} card${n === 1 ? "" : "s"} → ${task.subject}`);
    }
    const projectTask = projectTaskOf(p);
    if (p.card && projectTask && day) {
      // The project's own task needs no exception; anything else holds for this card alone.
      const to = projectTask.erp_task === task.id ? null : { task: task.id, label: task.subject };
      return void commit(
        sendRowOps(day, p.card, to),
        `✓ “${p.description}” → ${task.subject}${to ? " · only this card" : ""}`,
      );
    }
    try {
      setConfig(
        await erp.map({
          project: p.project,
          ...(p.task ? { task: p.task } : {}),
          erp_task: task.id,
          label: task.subject,
        }),
      );
    } catch (err) {
      return showToast(`Couldn't save that: ${(err as Error).message}`);
    }
    if (p.send) await startSend();
    else showToast(`✓ ${p.project} goes to ${task.subject} from now on`);
  };
  /** Settings said in the chat bar; the day is drafted again if what it reads changed. */
  const configure = async (ops: SettingOp[], done: string) => {
    const signIn = ops.some((o) => o.op === "connect");
    setBusy(signIn ? "Finish signing in in your browser…" : "Saving setup…");
    try {
      const r = await actions.configure(ops);
      setConfig(r.config);
      if (r.pick) {
        const { project, task, search } = r.pick;
        setUnmapped({
          project,
          ...(task ? { task } : {}),
          label: task ?? "every task",
          description: "",
          query: search,
          send: false,
        });
        setOverlay("task");
      } else showToast(`✓ ${done}`);
      if (ops.some(draftsDay)) setReload((n) => n + 1);
    } catch (err) {
      showToast(`Couldn't change that: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  };
  const confirmSend = async () => {
    if (!erp || !sending || !stored) return;
    const plan = sending;
    setSending(null);
    if (changes(plan).length === 0) return;
    setBusy(`Sending to ${erp.site}…`);
    try {
      const r = await erp.apply(stored, plan);
      setStored(r.stored);
      if (r.failed.length || r.unconfirmed) {
        setWarnings([
          ...r.failed.map((f) => f.error),
          ...(r.unconfirmed
            ? [`Couldn't check what ${erp.site} now has (${r.unconfirmed}). Send again to check.`]
            : []),
        ]);
        showToast(
          r.failed.length
            ? `Sent ${r.done}, ${r.failed.length} failed (see above)`
            : `Sent ${r.done}; send again to check`,
        );
      } else showToast(`✓ Sent ${r.done} change${r.done === 1 ? "" : "s"} to ${erp.site}`);
    } catch (err) {
      showToast(`Couldn't send: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  /** Asks before drafting the day again when that would drop corrections. */
  const askRebuild = (text = "", reply = "") => {
    const n = stored?.edits.length ?? 0;
    if (n === 0) return rebuild();
    setProposal({
      text,
      ops: [],
      settings: [],
      rebuild: true,
      lines: [
        `Draft ${longDate(date)} again from the latest activity`,
        `Drops your ${n} correction${n === 1 ? "" : "s"}; ctrl+z can't bring ${n === 1 ? "it" : "them"} back`,
      ],
      reply: reply || "Rebuild the day",
    });
  };
  const rebuild = () => {
    refreshNext.current = true;
    setReload((n) => n + 1);
  };

  const startEdit = (i: number) => {
    const c = items[i];
    if (!c || c === "add" || c.kind !== "row") return;
    setSel(i);
    setEditing(c.key);
    pill.setValue("");
  };
  const commitEdit = () => {
    const c = cards.find((x) => x.key === editing);
    const m = parseDuration(pill.value);
    setEditing(null);
    if (c && m !== null) setMinutes(c, m);
  };

  const openSetup = (section: SetupSection = "sources") => {
    setSetupAt(section);
    setSetup(true);
  };
  /** A slash command: what a key or button does, or a sign-in, without asking the AI. */
  const runSlash = (s: Slash, text: string) => {
    if (s.name === "help") return draft.setValue("/");
    if (s.name === "date") return goTo(s.date);
    if (s.name === "setup") return openSetup(s.section);
    if (s.name === "problems") return setOverlay("problems");
    if (s.name === "connect") {
      const op: SettingOp = { op: "connect", service: s.service, ...(s.url ? { url: s.url } : {}) };
      return void configure(
        [op],
        s.service === "erp" ? "Signed in to your ERP" : "Signed in to Google Calendar",
      );
    }
    setView("day");
    if (s.name === "refresh") return askRebuild();
    if (s.name === "undo") return void undo();
    if (s.name === "copy") return void copy(s.format);
    if (s.name === "add") return day ? setOverlay("add") : undefined;
    if (s.name === "send") {
      if (!erp) return showToast("Sign in to your ERP first: /connect erp <address>");
      return void startSend();
    }
    const settings: SettingOp[] = [{ op: "disconnect", service: s.service }];
    setProposal({
      text,
      ops: [],
      settings,
      lines: describeSettings(settings),
      reply: s.service === "erp" ? "Sign out of your ERP" : "Sign out of Google Calendar",
    });
  };
  /** Picking a command from the menu: runs it, or fills it in when it needs more words. */
  const pickCommand = (c: SlashCommand) => {
    if (c.needsArgs) return draft.setValue(`/${c.name} `);
    void send(`/${c.name}`);
  };

  /**
   * Typed or dictated words: a slash command, a length for the selected card, or for the AI a
   * correction to the day or a change to settings ("connect my ERP", "leave out my personal
   * projects").
   */
  const send = async (text: string) => {
    const slash = parseSlash(text, today);
    if (slash) {
      if ("error" in slash) return showToast(slash.error);
      draft.setValue("");
      return runSlash(slash.ok, text);
    }
    if (!day) return;
    draft.setValue("");
    const typed = parseDuration(text);
    if (typed !== null && card?.kind === "row") return setMinutes(card, typed);
    setBusy(`Thinking about “${text.length > 50 ? `${text.slice(0, 49)}…` : text}”`);
    try {
      const { ops, settings = [], reply, rebuild } = await actions.parse(text, day, turns);
      const asked = describeEdits(day, ops).join(" ");
      setTurns((t) => [...t, { said: text, reply: reply || asked }].slice(-TURNS));
      if (rebuild) return askRebuild(text, reply);
      const changes = ops.filter((o) => o.op !== "clarify");
      if (changes.length === 0 && settings.length === 0) showToast(asked || reply || "No changes.");
      else
        setProposal({
          text,
          ops: changes,
          settings,
          lines: [...describeEdits(day, changes), ...describeSettings(settings)],
          reply,
        });
    } catch (err) {
      draft.setValue(text);
      showToast((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const apply = async () => {
    if (!proposal) return;
    const p = proposal;
    setProposal(null);
    if (p.rebuild) return rebuild();
    if (p.ops.length) await commit(p.ops, `✓ ${p.reply || "Changed"}`, p.text);
    if (p.settings.length) await configure(p.settings, p.reply || "Setup changed");
  };
  const discard = () => {
    if (!proposal) return;
    draft.setValue(proposal.text);
    setProposal(null);
  };

  useInput(
    (ch, key) => {
      if (overlay || busy) return; // an open picker or dialog owns the keys, ctrl+p included
      if (key.ctrl && ch === "p") return openSetup();
      if (editing) {
        if (key.escape) return setEditing(null);
        if (key.return) return commitEdit();
        pill.edit(ch, key);
        return;
      }
      if (proposal) {
        if (key.return) return void apply();
        if (key.escape) return discard();
        return;
      }
      if (sending) {
        if (key.return) return void confirmSend();
        if (key.escape) return setSending(null);
        return;
      }
      if (slashing) {
        if (key.upArrow || key.downArrow) {
          const n = commands.length;
          if (n) setMenuSel((menuAt + (key.upArrow ? -1 : 1) + n) % n);
          return;
        }
        const c = commands[menuAt];
        const words = /\s/.test(draft.value.trim());
        if (key.tab) {
          if (c && !words) draft.setValue(`/${c.name}${c.args ? " " : ""}`);
          return;
        }
        if (key.return && c && !words) return pickCommand(c);
        if (key.return) return void send(draft.value.trim());
      }
      if (key.ctrl && ch === "s") return void startSend();
      if (key.ctrl && ch === "y") return void copy("tsv", checked.size ? checked : undefined);
      if (key.ctrl && ch === "z") return void undo();
      if (key.pageUp) return goTo(addDays(date, -1));
      if (key.pageDown) return goTo(addDays(date, 1));
      if (view === "home") {
        if (key.escape) return draft.setValue("");
        if (key.return) {
          const text = draft.value.trim();
          if (slashText(text) !== null) return void send(text);
          setView("day");
          if (text) void send(text);
          return;
        }
        draft.edit(ch, key);
        return;
      }
      if (key.upArrow || key.downArrow) {
        const d = key.upArrow ? -1 : 1;
        const next = Math.max(0, Math.min(items.length - 1, sel + d));
        if (key.shift) {
          if (anchor.current < 0) anchor.current = sel >= 0 ? sel : next;
          selectAt(next, true, false);
        } else {
          setSel(next);
          anchor.current = next;
          setChip(0);
        }
        return;
      }
      if (key.ctrl && ch === "d") {
        if (checked.size) return removeChecked();
        return card ? remove(card) : undefined;
      }
      if (key.ctrl && ch === "t") {
        if (checked.size) return pickChecked();
        return card ? pickFor(card) : undefined;
      }
      if (ch === " " && draft.value === "" && card?.kind === "row")
        return selectAt(sel, key.shift, true);
      if (draft.value === "" && card?.kind === "row") {
        if (ch === "+" || ch === "=") return setMinutes(card, card.minutes + step);
        if (ch === "-" || ch === "_")
          return card.minutes > step ? setMinutes(card, card.minutes - step) : undefined;
      }
      if (draft.value === "" && card?.kind === "ask") {
        if (key.leftArrow) return setChip((c) => Math.max(0, c - 1));
        if (key.rightArrow) return setChip((c) => Math.min((card.choices?.length ?? 1) - 1, c + 1));
      }
      if (key.escape) {
        if (draft.value) return draft.setValue("");
        if (checked.size) return setChecked(new Set());
        if (sel >= 0) return setSel(-1);
        return setView("home");
      }
      if (key.return) {
        const text = draft.value.trim();
        if (text) return void send(text);
        if (current === "add") return setOverlay("add");
        if (card?.kind === "row") return startEdit(sel);
        if (card?.kind === "ask") {
          const c = card.choices?.[chip];
          if (c) choose(c);
          return;
        }
        return void copy();
      }
      draft.edit(ch, key);
    },
    { isActive: !setup },
  );

  const box = Math.min(84, Math.max(48, width - 10));
  // Home sits a little above centre so the date picker can drop below the chat bar.
  const HOME = 14;
  const PICKER = 13;
  const homeTop = Math.max(1, Math.floor((height - HOME - PICKER) / 2));
  const dropDown = view === "home" && height - homeTop - HOME >= PICKER;
  const screen = { width, height };

  const barW = view === "home" ? box : Math.min(width - 4, 104);
  const bar = (
    <ChatBar
      width={barW}
      value={draft.value}
      busy={busy}
      placeholder={
        !aiOn
          ? view === "home"
            ? "No AI helper: Enter opens the day, / lists commands"
            : card?.kind === "row"
              ? `How long was “${card.title}”?  type 1h 45m  ·  no AI helper: / for commands`
              : "No AI helper: type / for commands, or pick a card to change it"
          : view === "home"
            ? 'Tell me about your day, or what to set up…  "standup ran to 45 minutes"'
            : card?.kind === "row"
              ? `How long was “${card.title}”?  type 1h 45m, or say what changed`
              : 'Say what changed…  "standup ran to 45 minutes"'
      }
      date={date}
      today={today}
      onDate={() => setOverlay("date")}
      actions={
        <>
          {view === "day" ? (
            <Button label="Copy sheet" tone="quiet" onClick={() => void copy()} />
          ) : null}
          {view === "day" && erp ? (
            <Button label="Send to ERP" tone="quiet" onClick={() => void startSend()} />
          ) : null}
          <Button label="Setup" tone="quiet" onClick={() => openSetup()} />
        </>
      }
    />
  );
  const picker =
    overlay === "date" ? (
      <DatePicker
        date={date}
        today={today}
        hasDraft={(d) => saved.includes(d)}
        left={1}
        top={dropDown ? 5 : undefined}
        bottom={dropDown ? undefined : 5}
        onPick={(d) => {
          setOverlay(null);
          goTo(d);
        }}
        onClose={() => setOverlay(null)}
      />
    ) : null;
  const menuH = Math.max(1, commands.length) + 3;
  const menuDown = view === "home" && height - homeTop - HOME >= menuH;
  const menu = slashing ? (
    <SlashMenu
      commands={commands}
      sel={menuAt}
      typed={draft.value.trim()}
      width={Math.min(barW - 2, 80)}
      left={1}
      top={menuDown ? 5 : undefined}
      bottom={menuDown ? undefined : 5}
      onPick={pickCommand}
    />
  ) : null;
  const dialogs = (
    <>
      {overlay === "problems" ? (
        <ProblemsDialog
          problems={warnings}
          errorLog={actions.errorLog}
          screen={screen}
          onClose={() => setOverlay(null)}
        />
      ) : null}
      {overlay === "add" && day ? (
        <AddTimeDialog
          {...addable(day)}
          step={step}
          screen={screen}
          onClose={() => setOverlay(null)}
          onAdd={(p, m, s, isNew) => {
            setOverlay(null);
            void commit(placeTimeOps(day, p, m, s), `✓ Added ${hm(m)} to ${short(p)}`);
            // A project typed in is kept, so it's offered on every day from now on.
            if (isNew)
              void actions.setup
                .save(withProject(config, p))
                .then(setConfig)
                .catch((err: Error) => showToast(err.message));
          }}
        />
      ) : null}
      {overlay === "task" && unmapped && erp ? (
        <TaskPicker
          row={{
            project: unmapped.project,
            task: unmapped.label,
            description: unmapped.description,
          }}
          {...(unmapped.query ? { query: unmapped.query } : {})}
          {...cardPick(unmapped)}
          {...(unmapped.cards ? { selection: unmapped.cards.length } : {})}
          search={erp.searchTasks}
          screen={screen}
          onPick={(t) => void pickTask(unmapped, t)}
          onClose={() => {
            setOverlay(null);
            setUnmapped(null);
          }}
        />
      ) : null}
      {setup ? (
        <Setup
          actions={actions.setup}
          screen={screen}
          start={setupAt}
          onConfig={setConfig}
          onClose={() => setSetup(false)}
        />
      ) : null}
    </>
  );
  const warning = warnings.length ? (
    <Box gap={1} flexGrow={1}>
      <Box flexShrink={1} flexGrow={1}>
        <Clickable onClick={() => setOverlay("problems")}>
          {() => (
            <Text color={T.ask} wrap="truncate-end">
              ⚠ {warnings.length > 1 ? `${warnings.length} problems · ` : ""}
              {warnings[0]}
            </Text>
          )}
        </Clickable>
      </Box>
      <Clickable onClick={() => setOverlay("problems")}>
        {(hover) => <Text color={hover ? T.text : T.muted}>/problems ›</Text>}
      </Clickable>
      {stale ? <Button label="Rebuild the day" tone="ask" onClick={() => askRebuild()} /> : null}
    </Box>
  ) : null;

  if (view === "home")
    return (
      <Box
        width={width}
        height={height}
        flexDirection="column"
        alignItems="center"
        paddingTop={homeTop}
        backgroundColor={T.bg}
      >
        <BarWordmark segments={bars} target={target} />
        <Box height={1} flexShrink={0} />
        <Text>
          {loading ? (
            <Text color={T.muted}>
              <Spinner /> Drafting {longDate(date)}…
            </Text>
          ) : minutes ? (
            <>
              <Text color={T.text} bold>
                {hm(minutes)}
              </Text>
              <Text color={T.muted}> of {hm(target)}</Text>
            </>
          ) : (
            <Text color={T.muted}>Nothing logged yet</Text>
          )}
        </Text>
        <Box height={1} flexShrink={0} width={box}>
          {warning}
        </Box>
        <Box flexDirection="column">
          {bar}
          {picker}
          {menu}
        </Box>
        {dialogs}
        {toast ? (
          <Toast text={toast} bottom={2} right={Math.floor((width - box) / 2)} width={box} />
        ) : null}
      </Box>
    );

  // Day view: cards with room to breathe, the chat bar at the bottom.
  const listW = Math.min(width - 4, 104);
  // Rows left for cards: minus padding, header, bar, gap, chat bar (5), its margin and the
  // "↑ more" / "↓ more" lines. Each card is 5 rows plus a blank line.
  const avail =
    height -
    1 -
    1 -
    1 -
    1 -
    5 -
    1 -
    2 -
    (proposal ? proposal.lines.length + 4 : 0) -
    (sending ? sending.items.length + 5 : 0) -
    (checkedCards.length ? 2 : 0);
  const cap = Math.max(1, Math.floor((avail + 1) / 6));
  const focus = Math.max(0, sel);
  if (focus < offset.current) offset.current = focus;
  if (focus >= offset.current + cap) offset.current = focus - cap + 1;
  offset.current = Math.max(0, Math.min(offset.current, Math.max(0, items.length - cap)));
  const visible = items.slice(offset.current, offset.current + cap);

  return (
    <Box
      width={width}
      height={height}
      flexDirection="column"
      alignItems="center"
      paddingTop={1}
      backgroundColor={T.bg}
    >
      <Box width={listW} justifyContent="space-between" flexShrink={0}>
        <Clickable onClick={() => setView("home")}>
          {(hover) => (
            <Text>
              <Text color={hover ? T.text : T.muted}>← </Text>
              <Text color={T.text} bold>
                {longDate(date)}
              </Text>
            </Text>
          )}
        </Clickable>
        <Text>
          <Text color={T.text} bold>
            {hm(minutes)}
          </Text>
          <Text color={T.muted}> of {hm(target)}</Text>
          {minutes >= target ? <Text color={T.primary}> ✓</Text> : null}
        </Text>
      </Box>
      <Box flexShrink={0}>
        <HoursBar segments={bars} target={target} width={listW} />
      </Box>
      <Box width={listW} flexShrink={0}>
        {warning}
      </Box>
      {checkedCards.length ? (
        <Box width={listW} flexDirection="column" flexShrink={0}>
          <Text>
            <Text color={T.primary} bold>
              {checkedCards.length} selected
            </Text>
            <Text color={T.muted}>
              {" "}
              · {hm(checkedMinutes)} · shift- or option-click for a range
            </Text>
          </Text>
          <Box gap={1}>
            {erp ? <Button label="Map task" tone="primary" onClick={pickChecked} /> : null}
            <Button label="Copy" onClick={() => void copy("tsv", checked)} />
            <Button label="Remove" onClick={removeChecked} />
            <Button label="Clear" tone="quiet" onClick={() => setChecked(new Set())} />
          </Box>
        </Box>
      ) : null}
      <Clickable
        flexDirection="column"
        flexGrow={1}
        width={listW}
        overflow="hidden"
        marginTop={1}
        onWheel={(d) => setSel((s) => Math.max(0, Math.min(items.length - 1, Math.max(0, s) + d)))}
      >
        {loading ? (
          <Text color={T.muted}>
            <Spinner /> Drafting {longDate(date)}…
          </Text>
        ) : (
          <>
            {offset.current > 0 ? <Text color={T.faint}> ↑ {offset.current} more</Text> : null}
            {visible.map((it, k) => {
              const i = offset.current + k;
              if (it === "add")
                return (
                  <AddCard
                    key="add"
                    width={listW}
                    left={Math.max(0, target - minutes)}
                    target={target}
                    notes={day?.notes ?? []}
                    selected={i === sel}
                    onClick={() => setOverlay("add")}
                  />
                );
              return (
                <CardView
                  key={it.key}
                  c={it}
                  width={listW}
                  step={step}
                  selected={i === sel}
                  checked={checked.has(it.key)}
                  chip={i === sel ? chip : -1}
                  editing={editing === it.key}
                  typed={pill.value}
                  onSelect={(shift) => (shift ? shiftClick(i) : selectAt(i, false, false))}
                  onToggle={(shift) => (shift ? shiftClick(i) : selectAt(i, false, true))}
                  onEdit={() => startEdit(i)}
                  onMinutes={(m) => setMinutes(it, m)}
                  onRemove={() => remove(it)}
                  onSendTo={() => pickFor(it)}
                  onChoose={(n) => {
                    const c = it.choices?.[n];
                    if (c) choose(c);
                  }}
                />
              );
            })}
            {offset.current + cap < items.length ? (
              <Text color={T.faint}> ↓ {items.length - offset.current - cap} more</Text>
            ) : null}
          </>
        )}
      </Clickable>
      {proposal ? (
        <ProposalPanel
          width={listW}
          proposal={proposal}
          onApply={() => void apply()}
          onDiscard={discard}
        />
      ) : null}
      {sending && erp ? (
        <SendPanel
          width={listW}
          plan={sending}
          site={erp.site}
          onSend={() => void confirmSend()}
          onCancel={() => setSending(null)}
        />
      ) : null}
      <Box flexDirection="column" marginBottom={1}>
        {bar}
        {picker}
        {menu}
      </Box>
      {dialogs}
      {toast ? (
        <Toast text={toast} bottom={7} right={Math.floor((width - listW) / 2)} width={listW} />
      ) : null}
    </Box>
  );
}

/** Whether a settings change can change how the day is drafted (the ERP's can't). */
function draftsDay(op: SettingOp): boolean {
  if (op.op === "erp_task") return false;
  return !((op.op === "connect" || op.op === "disconnect") && op.service === "erp");
}

function picking(row: PushRow): Picking {
  return { project: row.project, label: row.task, description: row.description, send: true };
}

function ProposalPanel({
  width,
  proposal,
  onApply,
  onDiscard,
}: {
  width: number;
  proposal: Proposal;
  onApply: () => void;
  onDiscard: () => void;
}) {
  return (
    <Box
      width={width}
      flexDirection="column"
      flexShrink={0}
      backgroundColor={T.panel}
      borderStyle="bold"
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      borderLeftColor={T.primary}
      borderLeftBackgroundColor={T.panel}
      paddingX={2}
      paddingY={1}
      marginBottom={1}
    >
      <Text color={T.primary} bold>
        {proposal.reply || "Proposed change"}
      </Text>
      {proposal.lines.map((l) => (
        <Text key={l} color={T.text} wrap="truncate-end">
          • {l}
        </Text>
      ))}
      <Box gap={1} marginTop={1}>
        <Button label="Apply ↵" tone="primary" onClick={onApply} />
        <Button label="Edit my words · esc" onClick={onDiscard} />
      </Box>
    </Box>
  );
}

function CardView({
  c,
  width,
  step,
  selected,
  checked,
  chip,
  editing,
  typed,
  onSelect,
  onToggle,
  onEdit,
  onMinutes,
  onRemove,
  onSendTo,
  onChoose,
}: {
  c: Card;
  width: number;
  step: number;
  selected: boolean;
  checked: boolean;
  chip: number;
  editing: boolean;
  typed: string;
  onSelect: (range: boolean) => void;
  onToggle: (range: boolean) => void;
  onEdit: () => void;
  onMinutes: (m: number) => void;
  onRemove: () => void;
  onSendTo: () => void;
  onChoose: (n: number) => void;
}) {
  const ask = c.kind === "ask";
  const to = c.sendTo;
  let body: ReactNode;
  if (ask)
    body = (
      <>
        <Text color={T.text} bold wrap="truncate-end">
          <Text color={T.ask}>? </Text>
          {c.title}
        </Text>
        <Text color={T.ask} wrap="truncate-end">
          {c.question}
          {c.reason ? <Text color={T.muted}> {c.reason}</Text> : null}
        </Text>
        <Box gap={1}>
          {(c.choices ?? []).map((ch, n) => (
            <Button
              key={ch.label}
              label={ch.label}
              tone={n === chip ? "ask" : "neutral"}
              onClick={() => onChoose(n)}
            />
          ))}
        </Box>
      </>
    );
  else
    body = (
      <>
        <Box>
          <Clickable
            onClick={({ shift, alt }) => onToggle(shift || alt)}
            marginRight={1}
            flexShrink={0}
          >
            {(hover) => (
              <Text color={checked || hover ? T.primary : T.muted}>{checked ? "[x]" : "[ ]"}</Text>
            )}
          </Clickable>
          <Text color={T.text} bold wrap="truncate-end">
            {c.title}
          </Text>
        </Box>
        <Box>
          <Box flexShrink={1}>
            <Text wrap="truncate-end">
              <Text color={projectColor(c.project)}>● </Text>
              <Text color={T.text}>{short(c.project)}</Text>
              <Text color={T.muted}> · {c.task}</Text>
              {c.edited ? <Text color={T.primary}> · set by you</Text> : null}
            </Text>
          </Box>
          {to !== undefined ? (
            <Clickable onClick={onSendTo} flexShrink={1} marginLeft={2}>
              {(h) => (
                <Text
                  wrap="truncate-end"
                  color={h ? T.text : to === null ? T.ask : to.own ? T.info : T.muted}
                >
                  → {to === null ? "pick an ERP task" : to.label}
                  {selected ? <Text color={T.faint}> ctrl+t</Text> : null}
                </Text>
              )}
            </Clickable>
          ) : null}
        </Box>
        <Text color={T.faint} wrap="truncate-end">
          {c.from}
        </Text>
      </>
    );
  return (
    <Clickable onClick={({ shift, alt }) => onSelect(shift || alt)} marginBottom={1} flexShrink={0}>
      {(hover) => {
        // A filled panel like the chat bar: the left bar marks focus, ticks and questions.
        const bg = selected ? T.element : hover ? mix(T.panel, T.element, 0.5) : T.panel;
        const bar = ask
          ? selected
            ? T.ask
            : mix(bg, T.ask, 0.6)
          : checked
            ? T.primary
            : selected
              ? T.text
              : bg;
        return (
          <Box
            width={width}
            backgroundColor={bg}
            borderStyle="bold"
            borderTop={false}
            borderRight={false}
            borderBottom={false}
            borderLeftColor={bar}
            borderLeftBackgroundColor={bg}
            paddingX={2}
            paddingY={1}
          >
            <Box flexDirection="column" flexGrow={1} flexShrink={1}>
              {body}
            </Box>
            <Pill
              minutes={c.minutes}
              step={step}
              editing={editing}
              text={typed}
              edited={c.edited}
              dim={ask}
              surface={bg}
              onEdit={ask ? undefined : onEdit}
              onChange={ask ? undefined : onMinutes}
            />
            {ask ? null : (
              <Clickable onClick={onRemove} marginLeft={2} alignSelf="center">
                {(h) => <Text color={h ? T.danger : selected || hover ? T.muted : T.faint}>✕</Text>}
              </Clickable>
            )}
          </Box>
        );
      }}
    </Clickable>
  );
}

const DASHED = {
  topLeft: "╭",
  top: "┄",
  topRight: "╮",
  left: "┆",
  bottomLeft: "╰",
  bottom: "┄",
  bottomRight: "╯",
  right: "┆",
};

function AddCard({
  width,
  left,
  target,
  notes,
  selected,
  onClick,
}: {
  width: number;
  /** What the day is short of its target. */
  left: number;
  target: number;
  notes: string[];
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Clickable onClick={onClick} flexShrink={0}>
        {(hover) => (
          <Box
            width={width}
            borderStyle={DASHED}
            borderColor={selected || hover ? T.text : T.border}
            borderBackgroundColor={T.bg}
            paddingX={2}
            justifyContent="space-between"
            alignItems="center"
            height={5}
          >
            <Box flexDirection="column">
              <Text color={T.text} bold>
                + Add time
              </Text>
              <Text color={T.muted}>
                {left
                  ? `${hm(left)} short of your ${hm(target)} day`
                  : "for anything nothing recorded"}
              </Text>
            </Box>
            <Text color={T.faint}>project · how long · what</Text>
          </Box>
        )}
      </Clickable>
      {notes.map((n) => (
        <Text key={n} color={T.faint} wrap="truncate-end">
          {"  "}
          {n}
        </Text>
      ))}
    </Box>
  );
}
