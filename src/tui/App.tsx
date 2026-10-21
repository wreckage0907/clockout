import { Box, Text, useInput } from "ink";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Correction, Turn } from "../ai/edits";
import type { OpenedDay } from "../collect";
import { type Config, durationMinutes, type TaskMapping } from "../config/schema";
import { describeSettings, type SettingEffect, type SettingOp } from "../config/setting-ops";
import { describeEdits, placeTimeOps } from "../core/edits";
import { changes, type PushPlan, type PushRow } from "../core/push";
import { addDays, parseDuration } from "../core/time";
import { removeRowOps, setRowMinutesOps, timesheetRows } from "../core/timesheet";
import type { Day, EditOp } from "../core/types";
import { toTsv } from "../export/formats";
import type { PushResult } from "../push";
import type { StoredDay } from "../store/json-store";
import type { RemoteTask } from "../targets/types";
import { buildCards, type Card, segments, untracked } from "./cards";
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
  Spinner,
  Toast,
  useDraft,
  useToast,
} from "./kit";
import type { Choice } from "./questions";
import { short } from "./questions";
import { SendPanel, TaskPicker } from "./Send";
import { Setup, type SetupActions } from "./Setup";
import { hm, projectColor, T } from "./theme";

export interface AppActions {
  load(date: string): Promise<OpenedDay>;
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
  const [configChanged, setConfigChanged] = useState(false);
  const [reload, setReload] = useState(0);
  const [stored, setStored] = useState<StoredDay | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [saved, setSaved] = useState<string[]>([]);
  const [overlay, setOverlay] = useState<"date" | "add" | "task" | null>(null);
  const [sending, setSending] = useState<PushPlan | null>(null);
  const [unmapped, setUnmapped] = useState<Picking | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [sel, setSel] = useState(-1);
  const [chip, setChip] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [toast, showToast] = useToast();
  const draft = useDraft(!setup && !overlay && !editing && !busy && !proposal && !sending);
  const pill = useDraft(!setup && editing !== null);
  const offset = useRef(0);

  useEffect(() => {
    void reload;
    let live = true;
    setLoading(true);
    actions
      .load(date)
      .then((opened) => {
        if (!live) return;
        setStored(opened.stored);
        setWarnings(opened.warnings);
      })
      .catch((err: Error) => {
        if (!live) return;
        setStored(null);
        setWarnings([`Couldn't load ${date}: ${err.message}`]);
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

  const goTo = (d: string) => {
    setDate(d);
    setSel(-1);
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
  /** Takes a card off the day: a row's blocks, or a meeting you weren't in. */
  const remove = (c: Card) => {
    if (!day) return;
    const ops: EditOp[] =
      c.kind === "ask" ? [{ op: "delete", id: c.key.slice(4) }] : removeRowOps(day, c.key);
    const left = minutes - (c.kind === "row" ? c.minutes : 0);
    void commit(ops, `✓ Removed “${c.title}” · day ${hm(left)}`);
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
  const copy = async () => {
    if (!day) return;
    if (asks) return showToast(`Answer the ${asks} meeting${asks === 1 ? "" : "s"} first`);
    const rows = timesheetRows(day, config);
    if (rows.length === 0) return showToast("Nothing to copy yet");
    try {
      await actions.copy(toTsv(rows));
      showToast(`✓ Copied ${rows.length} row${rows.length === 1 ? "" : "s"} · ${hm(minutes)}`);
    } catch {
      showToast("Couldn't reach the clipboard. Use `clockout export` instead.");
    }
  };
  /** Checks the ERP and shows what sending would change; asks for a task first where needed. */
  const erp = actions.send;
  const startSend = async (current = stored) => {
    if (!erp || !current) return;
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
      showToast(`Couldn't reach the ERP: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  };
  const pickTask = async (p: Picking, task: RemoteTask) => {
    if (!erp) return;
    setOverlay(null);
    setUnmapped(null);
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
      if (r.failed.length) {
        setWarnings(r.failed.map((f) => f.error));
        showToast(`Sent ${r.done}, ${r.failed.length} failed (see above)`);
      } else showToast(`✓ Sent ${r.done} change${r.done === 1 ? "" : "s"} to ${erp.site}`);
    } catch (err) {
      showToast(`Couldn't send: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
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

  /**
   * Typed or dictated words: a length for the selected card, or for the AI a correction to the
   * day or a change to settings ("connect my ERP", "leave out my personal projects").
   */
  const send = async (text: string) => {
    if (!day) return;
    draft.setValue("");
    const typed = parseDuration(text);
    if (typed !== null && card?.kind === "row") return setMinutes(card, typed);
    setBusy(`Thinking about “${text.length > 50 ? `${text.slice(0, 49)}…` : text}”`);
    try {
      const { ops, settings = [], reply } = await actions.parse(text, day, turns);
      const asked = describeEdits(day, ops).join(" ");
      setTurns((t) => [...t, { said: text, reply: reply || asked }].slice(-TURNS));
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
      if (key.ctrl && ch === "p") return setSetup(true);
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
      if (key.ctrl && ch === "s") return void startSend();
      if (key.ctrl && ch === "y") return void copy();
      if (key.ctrl && ch === "z") return void undo();
      if (key.pageUp) return goTo(addDays(date, -1));
      if (key.pageDown) return goTo(addDays(date, 1));
      if (view === "home") {
        if (key.escape) return draft.setValue("");
        if (key.return) {
          setView("day");
          const text = draft.value.trim();
          if (text) void send(text);
          return;
        }
        draft.edit(ch, key);
        return;
      }
      if (key.upArrow || key.downArrow) {
        const d = key.upArrow ? -1 : 1;
        setSel((s) => Math.max(0, Math.min(items.length - 1, s + d)));
        setChip(0);
        return;
      }
      if (key.ctrl && ch === "d") return card ? remove(card) : undefined;
      if (draft.value === "" && card?.kind === "row") {
        if (ch === "+" || ch === "=") return setMinutes(card, card.minutes + step);
        if (ch === "-" || ch === "_") return setMinutes(card, Math.max(step, card.minutes - step));
      }
      if (draft.value === "" && card?.kind === "ask") {
        if (key.leftArrow) return setChip((c) => Math.max(0, c - 1));
        if (key.rightArrow) return setChip((c) => Math.min((card.choices?.length ?? 1) - 1, c + 1));
      }
      if (key.escape) {
        if (draft.value) return draft.setValue("");
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

  const bar = (
    <ChatBar
      width={view === "home" ? box : Math.min(width - 4, 104)}
      value={draft.value}
      busy={busy}
      placeholder={
        view === "home"
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
          <Button label="Setup" tone="quiet" onClick={() => setSetup(true)} />
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
  const dialogs = (
    <>
      {overlay === "add" && day ? (
        <AddTimeDialog
          projects={[
            ...new Set([
              ...day.blocks.filter((b) => b.billable).map((b) => b.project),
              ...config.projects.map((p) => p.name),
            ]),
          ].concat(day.blocks.length || config.projects.length ? [] : ["General"])}
          step={step}
          screen={screen}
          onClose={() => setOverlay(null)}
          onAdd={(p, m, s) => {
            setOverlay(null);
            void commit(placeTimeOps(day, p, m, s), `✓ Added ${hm(m)} to ${short(p)}`);
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
          onConfig={(c) => {
            setConfig(c);
            setConfigChanged(true);
          }}
          onClose={() => {
            setSetup(false);
            if (configChanged) {
              setConfigChanged(false);
              setReload((n) => n + 1);
            }
          }}
        />
      ) : null}
    </>
  );
  const warning = warnings.length ? (
    <Text color={T.ask} wrap="truncate-end">
      ⚠ {warnings.join(" · ")}
    </Text>
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
        </Box>
        {dialogs}
        {toast ? <Toast text={toast} bottom={2} /> : null}
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
    (sending ? sending.items.length + 5 : 0);
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
                    untracked={day ? untracked(day) : 0}
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
                  chip={i === sel ? chip : -1}
                  editing={editing === it.key}
                  typed={pill.value}
                  onSelect={() => setSel(i)}
                  onEdit={() => startEdit(i)}
                  onMinutes={(m) => setMinutes(it, m)}
                  onRemove={() => remove(it)}
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
      </Box>
      {dialogs}
      {toast ? <Toast text={toast} bottom={7} /> : null}
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
  chip,
  editing,
  typed,
  onSelect,
  onEdit,
  onMinutes,
  onRemove,
  onChoose,
}: {
  c: Card;
  width: number;
  step: number;
  selected: boolean;
  chip: number;
  editing: boolean;
  typed: string;
  onSelect: () => void;
  onEdit: () => void;
  onMinutes: (m: number) => void;
  onRemove: () => void;
  onChoose: (n: number) => void;
}) {
  const ask = c.kind === "ask";
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
        <Text color={T.text} bold wrap="truncate-end">
          {c.title}
        </Text>
        <Text wrap="truncate-end">
          <Text color={projectColor(c.project)}>● </Text>
          <Text color={T.text}>{short(c.project)}</Text>
          <Text color={T.muted}> · {c.task}</Text>
          {c.edited ? <Text color={T.primary}> · set by you</Text> : null}
        </Text>
        <Text color={T.faint} wrap="truncate-end">
          {c.from}
        </Text>
      </>
    );
  return (
    <Clickable onClick={onSelect} marginBottom={1} flexShrink={0}>
      {(hover) => (
        <Box
          width={width}
          borderStyle="round"
          borderColor={
            selected
              ? ask
                ? T.ask
                : T.text
              : ask
                ? mix(T.bg, T.ask, 0.5)
                : hover
                  ? T.muted
                  : T.border
          }
          paddingX={2}
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
            onEdit={ask ? undefined : onEdit}
            onChange={ask ? undefined : onMinutes}
          />
          {ask ? null : (
            <Clickable onClick={onRemove} marginLeft={2} alignSelf="center">
              {(h) => <Text color={h ? T.danger : selected || hover ? T.muted : T.faint}>✕</Text>}
            </Clickable>
          )}
        </Box>
      )}
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
  untracked,
  notes,
  selected,
  onClick,
}: {
  width: number;
  untracked: number;
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
                {untracked
                  ? `${hm(untracked)} untracked on this day`
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
