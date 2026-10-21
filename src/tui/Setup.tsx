import { Box, Text, useInput } from "ink";
import { type ReactNode, useEffect, useState } from "react";
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
import { type Config, durationMinutes, type TaskMapping } from "../config/schema";
import type { ClaudeProject } from "../sources/claude-code/paths";
import { Clickable } from "./clickable";
import { Button, Dialog, Spinner, Typed, useDraft } from "./kit";
import { hm, T } from "./theme";

/** What setup shows: the config, plus what's on this machine. */
export interface SetupState {
  config: Config;
  googleConnected: boolean;
  claude: { found: boolean; projects: ClaudeProject[] };
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

interface Block {
  id: string;
  group: string;
  title: string;
  on: boolean;
  /** What it's reading, or why it can't. */
  line: string;
  /** Can't be ticked here. */
  dead?: boolean;
  /** Opens a panel under the blocks: Claude Code's projects, or the ERP's address and tasks. */
  panel?: "claude" | "erp";
  tick?: () => void;
}

const ROUNDING = [5, 15, 30];

/**
 * Setup, over whatever screen you're on (ctrl+p or the chat bar's Setup button). Every source
 * is a block you tick; Claude Code opens into a searchable list of its projects, each tickable.
 * The ERP opens into its address, or where days go and which task each project goes to.
 * Then your daily target and the AI helper; working hours and rounding wait under "More".
 * Every change is saved to config.toml straight away.
 */
export function Setup({
  actions,
  screen,
  onConfig,
  onClose,
}: {
  actions: SetupActions;
  screen: { width: number; height: number };
  /** Called after each save with the new config. */
  onConfig: (config: Config) => void;
  onClose: () => void;
}) {
  const [state, setState] = useState<SetupState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [panel, setPanel] = useState<"claude" | "erp" | null>(null);
  const [more, setMore] = useState(false);
  const open = panel === "claude";
  const typingSite = panel === "erp" && !state?.erp.connected && busy !== "erp";
  const search = useDraft(open);
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

  useInput((ch, key) => {
    if (busy === "erp") return; // signing in: the browser has it
    if (key.escape) {
      if (open && search.value) return search.setValue("");
      if (panel) return setPanel(null);
      return onClose();
    }
    if (key.ctrl && ch === "p") return onClose();
    if (open) search.edit(ch, key);
    if (typingSite) {
      if (key.return) return void connectErp();
      site.edit(ch, key);
    }
  });

  const width = Math.min(96, screen.width - 4);
  const inner = width - 6;
  if (!state)
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

  const { config } = state;
  const has = (type: string) => config.sources.some((s) => s.type === type);
  const claude = config.sources.find((s) => s.type === "claude-code");
  const excluded = claude?.exclude ?? [];
  const projects = state.claude.projects;
  const included = projects.filter((p) => !excluded.includes(p.folder)).length;

  const erpHost = config.timesheet ? new URL(config.timesheet.url).host : null;
  const erpOn = state.erp.connected && !!config.timesheet;
  const connectErp = async () => {
    const address = site.value.trim() || erpHost;
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
  };
  const disconnectErp = async () => {
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
  };

  const connectGoogle = async () => {
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
  };

  const blocks: Block[] = [
    {
      id: "google",
      group: "calendar",
      title: "Google Calendar",
      on: has("google-calendar"),
      line:
        busy === "google"
          ? "finish in your browser…"
          : has("google-calendar")
            ? "meetings you kept"
            : "tick to sign in",
      tick: () =>
        has("google-calendar")
          ? void save(
              withSource(config, { type: "google-calendar", calendars: ["primary"] }, false),
            )
          : void connectGoogle(),
    },
    ...(has("calendar")
      ? [
          {
            id: "ics",
            group: "calendar",
            title: "Calendar feed",
            on: true,
            line: "private link · in config.toml",
            dead: true,
          },
        ]
      : []),
    {
      id: "claude",
      group: "coding sessions",
      title: "Claude Code",
      on: has("claude-code"),
      dead: !state.claude.found && !has("claude-code"),
      ...(state.claude.found ? { panel: "claude" as const } : {}),
      line: !state.claude.found
        ? "no sessions found"
        : has("claude-code")
          ? `${included} of ${projects.length} projects`
          : "tick to read sessions",
      tick: () => void save(withSource(config, { type: "claude-code" }, !has("claude-code"))),
    },
    {
      id: "codex",
      group: "coding sessions",
      title: "Codex",
      on: false,
      line: "coming soon",
      dead: true,
    },
    {
      id: "opencode",
      group: "coding sessions",
      title: "opencode",
      on: false,
      line: "coming soon",
      dead: true,
    },
    {
      id: "github",
      group: "code",
      title: "GitHub",
      on: has("github"),
      dead: !state.github.found && !has("github"),
      line: !state.github.found
        ? "run gh auth login first"
        : has("github")
          ? "your PRs and reviews"
          : "tick to read PRs",
      tick: () => void save(withSource(config, { type: "github" }, !has("github"))),
    },
    {
      id: "erp",
      group: "timesheet",
      title: "ERP (next-pms)",
      on: erpOn,
      panel: "erp",
      line:
        busy === "erp"
          ? "finish in your browser…"
          : erpOn
            ? (erpHost ?? "")
            : erpHost
              ? `signed out · ${erpHost}`
              : "tick to connect",
      tick: () => (erpOn ? void disconnectErp() : setPanel("erp")),
    },
  ];

  const q = search.value.toLowerCase();
  const shown = projects.filter(
    (p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q),
  );
  const target = durationMinutes(config.day.target);
  const [from, to] = config.day.working_hours.split("-") as [string, string];
  const [start, end] = [clockMinutes(from), clockMinutes(to)];
  const round = durationMinutes(config.day.round_to);
  const ai = config.ai.backend === "none" ? "none" : "claude";

  return (
    <Dialog title="Setup" width={width} screen={screen} onClose={onClose}>
      <Text color={T.muted}>Tick what Clockout reads. Nothing leaves this machine.</Text>
      <Box height={1} />
      <Box flexWrap="wrap" columnGap={1} width={inner}>
        {blocks.map((b) => (
          <SourceBlock
            key={b.id}
            b={b}
            busy={busy === b.id}
            expanded={!!b.panel && panel === b.panel}
            onPress={() =>
              b.panel && (b.on || b.panel === "erp")
                ? setPanel((p) => (p === b.panel ? null : (b.panel ?? null)))
                : b.tick?.()
            }
          />
        ))}
      </Box>

      {open ? (
        <Box flexDirection="column" marginTop={1} width={inner}>
          <Box backgroundColor={T.element} paddingX={1}>
            <Text color={T.faint}>⌕ </Text>
            {search.value ? (
              <Text color={T.text}>
                {search.value}
                <Text inverse> </Text>
              </Text>
            ) : (
              <Text color={T.muted}>
                <Text inverse>S</Text>earch Claude Code projects
              </Text>
            )}
          </Box>
          {shown.slice(0, Math.max(3, screen.height - 30)).map((p) => {
            const isOn = !excluded.includes(p.folder);
            const toggle = () =>
              void save(
                withClaudeExclude(
                  config,
                  isOn ? [...excluded, p.folder] : excluded.filter((f) => f !== p.folder),
                ),
              );
            return (
              <Clickable key={p.folder} onClick={toggle}>
                {(hover) => (
                  <Box backgroundColor={hover ? T.element : undefined} paddingX={1} width={inner}>
                    <Box width={3}>
                      <Text color={isOn ? T.primary : T.faint}>{isOn ? "✓" : "○"}</Text>
                    </Box>
                    <Box flexGrow={1} flexShrink={1}>
                      <Text color={isOn ? T.text : T.muted} wrap="truncate-end">
                        {p.name}
                        <Text color={T.faint}> {p.path}</Text>
                      </Text>
                    </Box>
                    <Text color={T.faint}>
                      {p.recent ? `${p.recent} this week · ` : ""}
                      {p.sessions} session{p.sessions === 1 ? "" : "s"}
                    </Text>
                  </Box>
                )}
              </Clickable>
            );
          })}
          {shown.length === 0 ? (
            <Text color={T.muted}> No project matches “{search.value}”.</Text>
          ) : null}
        </Box>
      ) : null}

      {panel === "erp" ? (
        <ErpPanel
          width={inner}
          config={config}
          connected={erpOn}
          {...(state.erp.user ? { user: state.erp.user } : {})}
          busy={busy === "erp"}
          typed={site.value}
          onConnect={() => void connectErp()}
          onDisconnect={() => void disconnectErp()}
          onForget={(m) => void save(withoutTaskMapping(config, m))}
        />
      ) : null}

      <Box height={1} />
      <Row label="Daily target">
        <Button
          label="−"
          onClick={() =>
            void save(withDay(config, { target: durationText(Math.max(60, target - 30)) }))
          }
        />
        <Box width={7} justifyContent="center">
          <Text color={T.text} bold>
            {hm(target)}
          </Text>
        </Box>
        <Button
          label="+"
          onClick={() =>
            void save(withDay(config, { target: durationText(Math.min(16 * 60, target + 30)) }))
          }
        />
        <Text color={T.faint}> the bar behind the logo fills towards this</Text>
      </Row>
      <Row label="AI helper">
        <Button
          label="Claude Code"
          tone={ai === "claude" ? "primary" : "neutral"}
          onClick={() => void save(withAi(config, "auto"))}
        />
        <Button
          label="No AI"
          tone={ai === "none" ? "primary" : "neutral"}
          onClick={() => void save(withAi(config, "none"))}
        />
        <Text color={T.faint}>
          {state.aiFound || ai === "none"
            ? " writes summaries and reads what you type"
            : " needs the claude CLI on your PATH"}
        </Text>
      </Row>

      <Box marginTop={1}>
        <Clickable onClick={() => setMore((m) => !m)}>
          {(hover) => <Text color={hover ? T.text : T.muted}>{more ? "▾ More" : "▸ More"}</Text>}
        </Clickable>
      </Box>
      {more ? (
        <>
          <Row label="Working hours">
            <Button label="−" onClick={() => setHours(Math.max(0, start - 30), end)} />
            <Text color={T.text}>{clockText(start)}</Text>
            <Button label="+" onClick={() => setHours(Math.min(end - 60, start + 30), end)} />
            <Text color={T.muted}> to </Text>
            <Button label="−" onClick={() => setHours(start, Math.max(start + 60, end - 30))} />
            <Text color={T.text}>{clockText(end)}</Text>
            <Button label="+" onClick={() => setHours(start, Math.min(23 * 60 + 30, end + 30))} />
          </Row>
          <Row label="Round to">
            {ROUNDING.map((r) => (
              <Button
                key={r}
                label={`${r}m`}
                tone={round === r ? "primary" : "neutral"}
                onClick={() => void save(withDay(config, { round_to: durationText(r) }))}
              />
            ))}
          </Row>
        </>
      ) : null}
      {error ? (
        <Box marginTop={1}>
          <Text color={T.danger} wrap="wrap">
            {error}
          </Text>
        </Box>
      ) : null}
    </Dialog>
  );

  function setHours(a: number, b: number) {
    void save(withDay(config, { working_hours: `${clockText(a)}-${clockText(b)}` }));
  }
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box gap={1} alignItems="center">
      <Box width={15}>
        <Text color={T.muted}>{label}</Text>
      </Box>
      {children}
    </Box>
  );
}

function SourceBlock({
  b,
  busy,
  expanded,
  onPress,
}: {
  b: Block;
  busy: boolean;
  expanded: boolean;
  onPress: () => void;
}) {
  return (
    <Clickable onClick={b.dead ? undefined : onPress} width={22} flexShrink={0}>
      {(hover) => (
        <Box
          width={22}
          flexDirection="column"
          borderStyle="round"
          borderColor={expanded ? T.text : b.on ? T.primary : hover && !b.dead ? T.muted : T.border}
          backgroundColor={T.panel}
          borderBackgroundColor={T.panel}
          paddingX={1}
        >
          <Text color={T.faint}>
            {b.group}
            {b.panel && (b.on || b.panel === "erp") ? (expanded ? "  ▴" : "  ▾") : ""}
          </Text>
          <Box>
            <Clickable onClick={b.dead ? undefined : b.tick}>
              {(h) =>
                busy ? (
                  <Spinner />
                ) : (
                  <Text color={b.on ? T.primary : b.dead ? T.faint : h ? T.text : T.muted}>
                    {b.on ? "✓" : "○"}
                  </Text>
                )
              }
            </Clickable>
            <Text color={b.dead && !b.on ? T.faint : T.text} bold={b.on} wrap="truncate-end">
              {" "}
              {b.title}
            </Text>
          </Box>
          <Text color={b.on ? T.muted : T.faint} wrap="truncate-end">
            {b.line}
          </Text>
        </Box>
      )}
    </Clickable>
  );
}

/**
 * The ERP under its block: the address to sign in to, or where days go and which task each
 * project's rows are sent to. Tasks are picked when you send a day, or by saying so.
 */
function ErpPanel({
  width,
  config,
  connected,
  user,
  busy,
  typed,
  onConnect,
  onDisconnect,
  onForget,
}: {
  width: number;
  config: Config;
  connected: boolean;
  user?: string;
  busy: boolean;
  typed: string;
  onConnect: () => void;
  onDisconnect: () => void;
  onForget: (m: TaskMapping) => void;
}) {
  const host = config.timesheet ? new URL(config.timesheet.url).host : null;
  const map = config.timesheet?.map ?? [];
  if (!connected)
    return (
      <Box flexDirection="column" marginTop={1} width={width}>
        <Box backgroundColor={T.element} paddingX={1}>
          <Text color={T.faint}>ERP address </Text>
          {busy ? (
            <Text color={T.muted}>
              <Spinner /> finish signing in in your browser…
            </Text>
          ) : (
            <Typed value={typed} placeholder={host ?? "erp.example.com"} />
          )}
        </Box>
        <Box gap={1} marginTop={1}>
          <Button label="Sign in ↵" tone="primary" onClick={busy ? undefined : onConnect} />
          <Text color={T.faint}>
            opens your browser · Clockout only reads and writes your own timesheet entries
          </Text>
        </Box>
      </Box>
    );
  return (
    <Box flexDirection="column" marginTop={1} width={width}>
      <Box gap={1}>
        <Text color={T.text}>
          Days go to <Text bold>{host}</Text>
          {user ? <Text color={T.muted}> as {user}</Text> : null}
        </Text>
        <Box flexGrow={1} />
        <Button label="Sign out" onClick={busy ? undefined : onDisconnect} />
      </Box>
      {map.length === 0 ? (
        <Text color={T.muted}>
          No tasks picked yet. You pick one per project the first time you send a day (ctrl+s).
        </Text>
      ) : (
        map.map((m) => (
          <Box key={`${m.project}|${m.task ?? ""}`} paddingX={1} width={width}>
            <Box flexGrow={1} flexShrink={1}>
              <Text color={T.text} wrap="truncate-end">
                {m.project}
                <Text color={T.muted}>{m.task ? ` · ${m.task}` : " · every task"}</Text>
                <Text color={T.faint}> → </Text>
                {m.label ?? m.erp_task}
              </Text>
            </Box>
            <Clickable onClick={() => onForget(m)}>
              {(h) => <Text color={h ? T.danger : T.faint}> ✕ forget</Text>}
            </Clickable>
          </Box>
        ))
      )}
    </Box>
  );
}
