import { Box, Text, useInput } from "ink";
import { Fragment, type ReactNode, useEffect, useState } from "react";
import {
  clockMinutes,
  clockText,
  durationText,
  withAi,
  withClaudeExclude,
  withDay,
  withoutTaskMapping,
  withSource,
} from "../config/edit";
import { type Config, durationMinutes } from "../config/schema";
import type { ClaudeProject } from "../sources/claude-code/paths";
import { Clickable } from "./clickable";
import { Button, Dialog, Spinner, Typed, useDraft } from "./kit";
import type { SetupSection } from "./slash";
import { hm, T } from "./theme";

/** What setup shows: the config, plus what's on this machine. */
export interface SetupState {
  config: Config;
  googleConnected: boolean;
  claude: { found: boolean; projects: ClaudeProject[] };
  /** Other agents' session logs on this machine: what `detect()` said, or null. */
  pi: { found: string | null };
  codex: { found: string | null };
  opencode: { found: string | null };
  antigravity: { found: string | null };
  github: { found: boolean };
  /** The `claude` CLI is installed, so the AI helper can work. */
  aiFound: boolean;
  /** Signed in to the ERP in `config.timesheet`, and as whom. */
  erp: { connected: boolean; user?: string };
}

export interface SetupActions {
  state(): Promise<SetupState>;
  /** Validates and writes config.toml; returns the config as loaded. */
  save(config: Config): Promise<Config>;
  /** Signs in to Google in the browser and keeps the sign-in. */
  connectGoogle(): Promise<void>;
  /** Signs in to the ERP at an address in the browser; returns the saved config and who you are. */
  connectErp(site: string): Promise<{ config: Config; user?: string }>;
  /** Signs out of the ERP; the site and task mappings stay in the config. */
  disconnectErp(): Promise<void>;
}

type SectionId = SetupSection;

const SECTIONS: { id: SectionId; label: string }[] = [
  { id: "sources", label: "Sources" },
  { id: "day", label: "Day" },
  { id: "ai", label: "AI helper" },
  { id: "projects", label: "Projects" },
  { id: "erp", label: "ERP" },
];

interface Option {
  label: string;
  on: boolean;
  pick: () => void;
}

/** One line of a section. A row you can change has `press`, `step`, `options` or `opens`. */
interface Row {
  id: string;
  /** Heading over the first row of a group. */
  group?: string;
  label: string;
  /** The label takes the whole line instead of a column (a task mapping). */
  wide?: boolean;
  /** Shown after the control, quieter: what it's reading, or what it does. */
  note?: string;
  /** A switch: ✓ or ○ before the label. */
  on?: boolean;
  /** Greyed out: nothing to change here. */
  dead?: boolean;
  busy?: boolean;
  /** What it's set to. With `step`, nudged by ← → or − +. */
  value?: string;
  step?: (d: -1 | 1) => void;
  /** Choices, picked by ← → or a click. */
  options?: Option[];
  /** Text typed into the row (the ERP address). */
  input?: { value: string; placeholder: string };
  /** The row is a button. */
  button?: "primary" | "neutral";
  /** Enter, space or a click. */
  press?: () => void;
  /** Opens a page (›): Claude Code's projects. Enter and → open it; space still ticks. */
  opens?: () => void;
  /** A small action at the end of the line, e.g. "✕ forget". */
  trail?: string;
  /**
   * Takes something away: ⌫ / Delete on the row, or a click on its trail. Never Enter or
   * Space, which also move you into a section and would delete by accident.
   */
  remove?: () => void;
}

const canChange = (r: Row) => !r.dead && !!(r.press || r.step || r.options || r.opens || r.remove);

const ROUNDING = [5, 15, 30];
const IDLE = [10, 20, 30, 45];
const NAV = 15;
const LABEL = 16;

/**
 * Setup, over whatever screen you're on (ctrl+p or the chat bar's Setup button). Sections on the
 * left, the chosen one's settings on the right; the keyboard and the mouse both work everywhere.
 * Claude Code opens a page of its projects to tick. Everything is saved to config.toml straight
 * away; what can't be set here (task names, project rules) is shown with how to say it instead.
 */
export function Setup({
  actions,
  screen,
  start = "sources",
  onConfig,
  onClose,
}: {
  actions: SetupActions;
  screen: { width: number; height: number };
  /** The section it opens on. */
  start?: SectionId;
  /** Called after each save with the new config. */
  onConfig: (config: Config) => void;
  onClose: () => void;
}) {
  const [state, setState] = useState<SetupState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [section, setSection] = useState<SectionId>(start);
  const [focus, setFocus] = useState<"nav" | "rows">("nav");
  const [sel, setSel] = useState(0);
  const [page, setPage] = useState<"claude" | null>(null);
  const [pick, setPick] = useState(0);
  const search = useDraft(page === "claude");
  const typingSite =
    section === "erp" && focus === "rows" && !state?.erp.connected && busy !== "erp";
  const site = useDraft(typingSite);

  useEffect(() => {
    let live = true;
    actions
      .state()
      .then((s) => live && setState(s))
      .catch((err: Error) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [actions]);

  const save = async (next: Config) => {
    setError(null);
    try {
      const saved = await actions.save(next);
      setState((s) => (s ? { ...s, config: saved } : s));
      onConfig(saved);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const config = state?.config;
  const projects = state?.claude.projects ?? [];
  const excluded = (config && claudeSource(config)?.exclude) ?? [];
  const q = search.value.toLowerCase();
  const shown = projects.filter(
    (p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q),
  );
  const rows = state && config ? sectionRows(section) : [];
  const changeable = rows.flatMap((r, i) => (canChange(r) ? [i] : []));
  // Rows come and go (signing in swaps the ERP's), so the selection snaps to one that's there.
  const cur = changeable.includes(sel) ? sel : (changeable[0] ?? -1);
  const row = rows[cur];

  useInput((ch, key) => {
    if (busy === "erp") return; // signing in: the browser has it
    if (key.ctrl && ch === "p") return onClose();
    if (page === "claude") return projectKeys(ch, key);
    if (focus === "nav") {
      if (key.escape) return onClose();
      if (key.upArrow || key.downArrow) {
        const i = SECTIONS.findIndex((s) => s.id === section) + (key.upArrow ? -1 : 1);
        const next = SECTIONS[(i + SECTIONS.length) % SECTIONS.length];
        if (next) moveTo(next.id);
        return;
      }
      if ((key.rightArrow || key.return || key.tab) && changeable.length) {
        setFocus("rows");
        setSel(changeable[0] ?? 0);
      }
      return;
    }
    if (key.escape || key.tab) return setFocus("nav");
    if (key.upArrow || key.downArrow) {
      const at = changeable.indexOf(cur) + (key.upArrow ? -1 : 1);
      setSel(changeable[Math.max(0, Math.min(changeable.length - 1, at))] ?? cur);
      return;
    }
    if (!row) return;
    if (row.remove && (key.backspace || key.delete)) return row.remove();
    if (row.input) {
      if (key.return) return row.press?.();
      if (key.leftArrow && !site.value) return setFocus("nav");
      site.edit(ch, key);
      return;
    }
    if (key.leftArrow || key.rightArrow) {
      const d = key.leftArrow ? -1 : 1;
      if (row.step) return row.step(d);
      if (row.options) return chooseNext(row.options, d);
      if (key.rightArrow && row.opens && row.on) return row.opens();
      if (key.leftArrow) return setFocus("nav");
      return;
    }
    if (key.return) {
      if (row.opens && row.on) return row.opens();
      if (row.options) return chooseNext(row.options, 1);
      return row.press?.();
    }
    if (ch === " ") {
      if (row.options) return chooseNext(row.options, 1);
      return row.press?.();
    }
  });

  function moveTo(id: SectionId) {
    setSection(id);
    setPage(null);
    setSel(0);
  }

  function chooseNext(options: Option[], d: -1 | 1) {
    const at = options.findIndex((o) => o.on);
    const next = options[Math.max(0, Math.min(options.length - 1, at + d))];
    if (next && !next.on) next.pick();
  }

  function projectKeys(ch: string, key: Parameters<Parameters<typeof useInput>[0]>[1]) {
    if (key.escape && search.value) return search.setValue("");
    if (key.escape || (key.leftArrow && !search.value)) return setPage(null);
    if (key.upArrow || key.downArrow) {
      const d = key.upArrow ? -1 : 1;
      setPick((p) => Math.max(0, Math.min(shown.length - 1, p + d)));
      return;
    }
    if (key.return || ch === " ") {
      const p = shown[Math.min(pick, shown.length - 1)];
      if (p) toggleProject(p);
      return;
    }
    if (search.edit(ch, key)) setPick(0);
  }

  function toggleProject(p: ClaudeProject) {
    if (!config) return;
    const isOn = !excluded.includes(p.folder);
    void save(
      withClaudeExclude(
        config,
        isOn ? [...excluded, p.folder] : excluded.filter((f) => f !== p.folder),
      ),
    );
  }

  const width = Math.min(100, screen.width - 4);
  const inner = width - 6;
  const paneWidth = inner - NAV - 3;
  if (!state || !config)
    return (
      <Dialog title="Setup" width={width} screen={screen} onClose={onClose}>
        {error ? (
          <Text color={T.danger}>{error}</Text>
        ) : (
          <Text color={T.muted}>
            <Spinner /> Looking at what's on this machine…
          </Text>
        )}
      </Dialog>
    );

  const hint =
    page === "claude"
      ? "type to search · ↑↓ move · space tick · esc back"
      : focus === "nav"
        ? "↑↓ section · → or enter to change it · esc close"
        : row?.input
          ? "type the address · enter signs in · esc back"
          : row?.remove
            ? "↑↓ move · ⌫ forget · esc back"
            : "↑↓ move · ←→ change · enter or space pick · esc back";

  return (
    <Dialog title="Setup" width={width} screen={screen} onClose={onClose}>
      <Box minHeight={Math.min(16, Math.max(8, screen.height - 12))}>
        <Box flexDirection="column" width={NAV} flexShrink={0}>
          {SECTIONS.map((s) => (
            <NavItem
              key={s.id}
              label={s.label}
              active={s.id === section}
              focused={s.id === section && focus === "nav" && page === null}
              onClick={() => {
                moveTo(s.id);
                setFocus("nav");
              }}
            />
          ))}
        </Box>
        <Box
          flexDirection="column"
          width={paneWidth + 3}
          paddingLeft={2}
          borderStyle="single"
          borderTop={false}
          borderRight={false}
          borderBottom={false}
          borderColor={T.border}
          borderBackgroundColor={T.panel}
        >
          {page === "claude" ? (
            <ClaudeProjects
              width={paneWidth}
              projects={projects}
              shown={shown.slice(0, Math.max(4, screen.height - 18))}
              excluded={excluded}
              search={search.value}
              picked={Math.min(pick, shown.length - 1)}
              onBack={() => setPage(null)}
              onToggle={toggleProject}
            />
          ) : (
            <>
              <Box marginBottom={1} width={paneWidth}>
                <Text color={T.muted} wrap="wrap">
                  {lead(section)}
                </Text>
              </Box>
              {rows.map((r, i) => (
                <Fragment key={r.id}>
                  {r.group && r.group !== rows[i - 1]?.group ? (
                    <Box marginTop={i > 0 ? 1 : 0} paddingX={1}>
                      <Text color={T.faint}>{r.group.toUpperCase()}</Text>
                    </Box>
                  ) : null}
                  <RowView
                    row={r}
                    width={paneWidth}
                    selected={focus === "rows" && i === cur}
                    onSelect={() => {
                      setFocus("rows");
                      if (canChange(r)) setSel(i);
                    }}
                  />
                </Fragment>
              ))}
            </>
          )}
        </Box>
      </Box>
      {error ? (
        <Box marginTop={1}>
          <Text color={T.danger} wrap="wrap">
            {error}
          </Text>
        </Box>
      ) : null}
      <Box marginTop={1} gap={2} width={inner}>
        <Box flexGrow={1} flexShrink={1}>
          <Text color={T.faint} wrap="truncate-end">
            {hint}
          </Text>
        </Box>
        <Text color={T.faint}>saved as you go</Text>
      </Box>
    </Dialog>
  );

  // ── Sections ───────────────────────────────────────────────────────────────

  function lead(id: SectionId): ReactNode {
    if (!state || !config) return null;
    switch (id) {
      case "sources":
        return "What Clockout reads to draft your day. Nothing leaves this machine.";
      case "day":
        return "How the day is counted and rounded.";
      case "ai":
        return "Writes the descriptions and reads what you type in the chat bar. It gets titles, branch names and commit subjects, never code or your prompts.";
      case "projects":
        return 'Change these by saying it in the chat bar, e.g. "anything in acme/api is Acme Website" or "call meetings Calls".';
      case "erp": {
        const host = erpHost(config);
        if (state.erp.connected && host)
          return (
            <>
              Days go to <Text bold>{host}</Text>
              {state.erp.user ? ` as ${state.erp.user}` : ""}
            </>
          );
        return host
          ? `Signed out · ${host}. Sign in again to send days.`
          : "Sign in to your next-pms site to send each day to your timesheet.";
      }
    }
  }

  function sectionRows(id: SectionId): Row[] {
    switch (id) {
      case "sources":
        return sourceRows();
      case "day":
        return dayRows();
      case "ai":
        return aiRows();
      case "projects":
        return projectRows();
      case "erp":
        return erpRows();
    }
  }

  function has(type: string) {
    return config?.sources.some((s) => s.type === type) ?? false;
  }

  function sourceRows(): Row[] {
    if (!state || !config) return [];
    const c = config;
    const included = projects.filter((p) => !excluded.includes(p.folder)).length;
    const agent = (
      type: "pi" | "codex" | "opencode" | "antigravity",
      label: string,
      found: string | null,
    ): Row => ({
      id: type,
      group: "Coding agents",
      label,
      on: has(type),
      dead: !found && !has(type),
      note: found ?? "no sessions found",
      press: () => void save(withSource(c, { type }, !has(type))),
    });
    return [
      {
        id: "claude",
        group: "Coding agents",
        label: "Claude Code",
        on: has("claude-code"),
        dead: !state.claude.found && !has("claude-code"),
        note: !state.claude.found
          ? "no sessions found"
          : has("claude-code")
            ? `${included} of ${projects.length} projects`
            : `${projects.length} projects`,
        press: () => void save(withSource(c, { type: "claude-code" }, !has("claude-code"))),
        ...(state.claude.found
          ? {
              opens: () => {
                setPage("claude");
                setPick(0);
              },
            }
          : {}),
      },
      agent("pi", "Pi", state.pi.found),
      agent("codex", "Codex", state.codex.found),
      agent("opencode", "opencode", state.opencode.found),
      agent("antigravity", "Antigravity", state.antigravity.found),
      {
        id: "google",
        group: "Calendar",
        label: "Google Calendar",
        on: has("google-calendar"),
        busy: busy === "google",
        note:
          busy === "google"
            ? "finish in your browser…"
            : has("google-calendar")
              ? "meetings you kept"
              : "tick to sign in",
        press: () =>
          has("google-calendar")
            ? void save(withSource(c, { type: "google-calendar", calendars: ["primary"] }, false))
            : void connectGoogle(),
      },
      ...(has("calendar")
        ? [
            {
              id: "ics",
              group: "Calendar",
              label: "Calendar feed",
              on: true,
              dead: true,
              note: "private link · in config.toml",
            },
          ]
        : []),
      {
        id: "github",
        group: "Code",
        label: "GitHub",
        on: has("github"),
        dead: !state.github.found && !has("github"),
        note: !state.github.found ? "run gh auth login first" : "PRs, reviews, issues and comments",
        press: () => void save(withSource(c, { type: "github" }, !has("github"))),
      },
    ];
  }

  function dayRows(): Row[] {
    if (!config) return [];
    const c = config;
    const target = durationMinutes(c.day.target);
    const [from, to] = c.day.working_hours.split("-") as [string, string];
    const [start, end] = [clockMinutes(from), clockMinutes(to)];
    const hours = (a: number, b: number) =>
      void save(withDay(c, { working_hours: `${clockText(a)}-${clockText(b)}` }));
    const minutes = (key: "round_to" | "idle_cutoff", choices: number[]): Option[] => {
      const now = durationMinutes(c.day[key]);
      const all = choices.includes(now) ? choices : [...choices, now].sort((a, b) => a - b);
      return all.map((m) => ({
        label: `${m}m`,
        on: m === now,
        pick: () => void save(withDay(c, { [key]: durationText(m) })),
      }));
    };
    return [
      {
        id: "target",
        label: "Daily target",
        value: hm(target),
        note: "the bar behind the logo fills towards this",
        step: (d) =>
          void save(
            withDay(c, { target: durationText(Math.max(60, Math.min(16 * 60, target + d * 30))) }),
          ),
      },
      {
        id: "start",
        group: "Working hours",
        label: "Starts",
        value: clockText(start),
        step: (d) => hours(Math.max(0, Math.min(end - 60, start + d * 30)), end),
      },
      {
        id: "end",
        group: "Working hours",
        label: "Ends",
        value: clockText(end),
        step: (d) => hours(start, Math.max(start + 60, Math.min(23 * 60 + 30, end + d * 30))),
      },
      {
        id: "round",
        group: "Counting",
        label: "Round to",
        options: minutes("round_to", ROUNDING),
        note: "each row's hours",
      },
      {
        id: "idle",
        group: "Counting",
        label: "Idle cutoff",
        options: minutes("idle_cutoff", IDLE),
        note: "a longer pause ends a block",
      },
      {
        id: "tz",
        group: "Counting",
        label: "Time zone",
        value: c.me.timezone,
        note: 'say "my time zone is …" to change it',
      },
    ];
  }

  function aiRows(): Row[] {
    if (!state || !config) return [];
    const c = config;
    const on = c.ai.backend !== "none";
    return [
      {
        id: "ai",
        label: "Helper",
        options: [
          { label: "Claude Code", on, pick: () => void save(withAi(c, "auto")) },
          { label: "No AI", on: !on, pick: () => void save(withAi(c, "none")) },
        ],
        note: state.aiFound || !on ? "" : "needs the claude CLI on your PATH",
      },
      {
        id: "model",
        label: "Model",
        value: c.ai.model,
        note: on ? "ai.model in config.toml" : "off: descriptions come from titles",
      },
    ];
  }

  function projectRows(): Row[] {
    if (!config) return [];
    const c = config;
    const tasks: Row[] = [
      { id: "t-work", label: "Coding", value: c.tasks.work },
      { id: "t-review", label: "Reviews", value: c.tasks.review },
      { id: "t-meeting", label: "Meetings", value: c.tasks.meeting },
    ].map((r) => ({ ...r, group: "Default tasks" }));
    const rules: Row[] = c.projects.length
      ? c.projects.map((p, i) => ({
          id: `rule-${i}`,
          group: "Project rules",
          label: p.name,
          value: [
            p.match.repo ? `repo ${p.match.repo}` : "",
            p.match.title ? `title /${p.match.title}/` : "",
            p.match.attendee_domain ? `meetings with ${p.match.attendee_domain}` : "",
          ]
            .filter(Boolean)
            .join(", "),
          ...(p.task ? { note: `→ ${p.task}` } : {}),
        }))
      : [
          {
            id: "rules-none",
            group: "Project rules",
            label: "None yet",
            note: "projects come from each repo's name",
          },
        ];
    return [...tasks, ...rules];
  }

  function erpRows(): Row[] {
    if (!state || !config) return [];
    const c = config;
    const host = erpHost(c);
    if (!state.erp.connected || !c.timesheet)
      return [
        {
          id: "address",
          label: "ERP address",
          input: { value: site.value, placeholder: host ?? "erp.example.com" },
          busy: busy === "erp",
          ...(busy === "erp" ? { note: "finish signing in in your browser…" } : {}),
          press: () => void connectErp(),
        },
        {
          id: "sign-in",
          label: "Sign in ↵",
          button: "primary",
          note: "opens your browser · only your own timesheet entries",
          press: () => void connectErp(),
        },
      ];
    const map = c.timesheet.map;
    return [
      ...(map.length
        ? map.map(
            (m): Row => ({
              id: `map-${m.project}|${m.task ?? ""}`,
              group: "Where rows go",
              label: `${m.project} · ${m.task ?? "every task"} → ${m.label ?? m.erp_task}`,
              wide: true,
              trail: "✕ forget",
              remove: () => void save(withoutTaskMapping(c, m)),
            }),
          )
        : [
            {
              id: "map-none",
              group: "Where rows go",
              label: "No tasks picked yet",
              wide: true,
              note: "you pick them the first time you send a day (ctrl+s)",
            },
          ]),
      {
        id: "sign-out",
        group: "Sign-in",
        label: "Sign out",
        button: "neutral",
        press: () => void disconnectErp(),
      },
    ];
  }

  // ── Sign-ins ───────────────────────────────────────────────────────────────

  async function connectGoogle() {
    if (!state || !config) return;
    setBusy("google");
    setError(null);
    try {
      if (!state.googleConnected) {
        await actions.connectGoogle();
        setState((s) => (s ? { ...s, googleConnected: true } : s));
      }
      await save(withSource(config, { type: "google-calendar", calendars: ["primary"] }, true));
    } catch (err) {
      setError(`Google sign-in didn't finish: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function connectErp() {
    if (!config) return;
    const address = site.value.trim() || erpHost(config);
    if (!address) return setError("Type your ERP's address, e.g. erp.example.com");
    setBusy("erp");
    setError(null);
    try {
      const r = await actions.connectErp(address);
      setState((s) =>
        s
          ? {
              ...s,
              config: r.config,
              erp: { connected: true, ...(r.user ? { user: r.user } : {}) },
            }
          : s,
      );
      onConfig(r.config);
      site.setValue("");
    } catch (err) {
      setError(`ERP sign-in didn't finish: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function disconnectErp() {
    setBusy("erp");
    setError(null);
    try {
      await actions.disconnectErp();
      setState((s) => (s ? { ...s, erp: { connected: false } } : s));
    } catch (err) {
      setError(`Couldn't sign out of the ERP: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }
}

function claudeSource(config: Config) {
  const s = config.sources.find((x) => x.type === "claude-code");
  return s?.type === "claude-code" ? s : undefined;
}

function erpHost(config: Config): string | null {
  return config.timesheet ? new URL(config.timesheet.url).host : null;
}

// ── Pieces ───────────────────────────────────────────────────────────────────

function NavItem({
  label,
  active,
  focused,
  onClick,
}: {
  label: string;
  active: boolean;
  focused: boolean;
  onClick: () => void;
}) {
  return (
    <Clickable onClick={onClick}>
      {(hover) => (
        <Box
          width={NAV - 1}
          paddingX={1}
          backgroundColor={focused || hover ? T.element : undefined}
        >
          <Text color={active ? T.primary : T.faint}>{active ? "▍" : " "}</Text>
          <Text color={active || hover ? T.text : T.muted} bold={active}>
            {label}
          </Text>
        </Box>
      )}
    </Clickable>
  );
}

function RowView({
  row: r,
  width,
  selected,
  onSelect,
}: {
  row: Row;
  width: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const live = !r.dead;
  // A click on the line opens a page when there is one (and the source is on), else presses.
  // Steppers, choices and trailing actions only act through their own buttons.
  const onLine = () => {
    onSelect();
    if (!live) return;
    if (r.opens && r.on) return r.opens();
    if (!r.step && !r.options && !r.trail) r.press?.();
  };
  return (
    <Clickable onClick={onLine}>
      {(hover) => (
        <Box
          width={width}
          paddingX={1}
          gap={1}
          backgroundColor={selected || (hover && canChange(r)) ? T.element : undefined}
        >
          {r.on !== undefined ? (
            <Clickable onClick={live ? r.press : undefined}>
              {(h) =>
                r.busy ? (
                  <Spinner />
                ) : (
                  <Text color={r.on ? T.primary : !live ? T.faint : h ? T.text : T.muted}>
                    {r.on ? "✓" : "○"}
                  </Text>
                )
              }
            </Clickable>
          ) : null}
          {r.button ? (
            <Button label={r.label} tone={r.button} focused={selected} onClick={r.press} />
          ) : (
            <Box width={r.wide ? undefined : LABEL} flexShrink={r.wide && r.trail ? 1 : 0}>
              <Text
                color={!live && !r.on ? T.faint : T.text}
                bold={r.on === true || selected}
                wrap="truncate-end"
              >
                {r.label}
              </Text>
            </Box>
          )}
          {r.step ? (
            <>
              <Button label="−" onClick={() => r.step?.(-1)} />
              <Box width={7} flexShrink={0} justifyContent="center">
                <Text color={T.text} bold>
                  {r.value}
                </Text>
              </Box>
              <Button label="+" onClick={() => r.step?.(1)} />
            </>
          ) : r.value !== undefined ? (
            <Box flexShrink={0} paddingLeft={1}>
              <Text color={T.text} wrap="truncate-end">
                {r.value}
              </Text>
            </Box>
          ) : null}
          {r.options?.map((o) => (
            <Button
              key={o.label}
              label={o.label}
              tone={o.on ? "primary" : "neutral"}
              onClick={o.pick}
            />
          ))}
          {r.input ? (
            r.busy ? (
              <Spinner />
            ) : (
              <Box backgroundColor={T.elementHi} paddingX={1} flexShrink={1}>
                <Typed value={r.input.value} placeholder={r.input.placeholder} />
              </Box>
            )
          ) : null}
          <Box flexGrow={1} flexShrink={1}>
            <Text color={T.faint} wrap="truncate-end">
              {r.note ?? ""}
            </Text>
          </Box>
          {r.trail ? (
            <Clickable onClick={r.remove ?? r.press} flexShrink={0}>
              {(h) => <Text color={h ? T.danger : selected ? T.muted : T.faint}>{r.trail}</Text>}
            </Clickable>
          ) : null}
          {r.opens && r.on ? <Text color={selected || hover ? T.text : T.muted}>›</Text> : null}
        </Box>
      )}
    </Clickable>
  );
}

/** Claude Code's projects, each tickable, with a search for long lists. */
function ClaudeProjects({
  width,
  projects,
  shown,
  excluded,
  search,
  picked,
  onBack,
  onToggle,
}: {
  width: number;
  projects: ClaudeProject[];
  shown: ClaudeProject[];
  excluded: string[];
  search: string;
  picked: number;
  onBack: () => void;
  onToggle: (p: ClaudeProject) => void;
}) {
  const on = projects.filter((p) => !excluded.includes(p.folder)).length;
  return (
    <Box flexDirection="column" width={width}>
      <Box marginBottom={1} gap={1}>
        <Clickable onClick={onBack}>
          {(h) => <Text color={h ? T.text : T.muted}>‹ Sources</Text>}
        </Clickable>
        <Text color={T.faint}>/</Text>
        <Text color={T.text} bold>
          Claude Code projects
        </Text>
        <Box flexGrow={1} />
        <Text color={T.faint}>
          {on} of {projects.length} on
        </Text>
      </Box>
      <Box backgroundColor={T.element} paddingX={1} marginBottom={1}>
        <Text color={T.faint}>⌕ </Text>
        {search ? (
          <Text color={T.text}>
            {search}
            <Text inverse> </Text>
          </Text>
        ) : (
          <Text color={T.muted}>
            <Text inverse>S</Text>earch Claude Code projects
          </Text>
        )}
      </Box>
      {shown.map((p, i) => {
        const isOn = !excluded.includes(p.folder);
        return (
          <Clickable key={p.folder} onClick={() => onToggle(p)}>
            {(hover) => (
              <Box
                backgroundColor={i === picked || hover ? T.element : undefined}
                paddingX={1}
                width={width}
              >
                <Box width={3} flexShrink={0}>
                  <Text color={isOn ? T.primary : T.faint}>{isOn ? "✓" : "○"}</Text>
                </Box>
                <Box flexGrow={1} flexShrink={1}>
                  <Text color={isOn ? T.text : T.muted} wrap="truncate-end">
                    {p.name}
                    <Text color={T.faint}> {p.path}</Text>
                  </Text>
                </Box>
                <Box flexShrink={0} marginLeft={1}>
                  <Text color={T.faint}>
                    {p.recent ? `${p.recent} this week · ` : ""}
                    {p.sessions} session{p.sessions === 1 ? "" : "s"}
                  </Text>
                </Box>
              </Box>
            )}
          </Clickable>
        );
      })}
      {shown.length === 0 ? <Text color={T.muted}> No project matches “{search}”.</Text> : null}
    </Box>
  );
}
