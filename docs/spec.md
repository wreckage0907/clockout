# Clockout — spec

> A local-first terminal app that turns your day — coding-agent sessions, git/GitHub activity, and calendar — into a short, ready-to-paste timesheet. You fill gaps and fix entries by voice. It uses the AI subscription you already pay for, not a new API key.

Built for the **#NoHandsChallenge** (WeMakeDevs × Wispr Flow), **Builders track**. Two weeks. Rule: built by voice — requirements and follow-ups are dictated into coding tools via Wispr Flow.

Research behind this spec: [research.md](research.md).

---

## 1. Problem

Filling timesheets means reconstructing the day from memory: which repo, which PR, which meeting, how long. The evidence already exists (AI coding sessions, commits, PRs, calendar) but nothing stitches it together. Result: 15–30 min/week of guessing, and timesheets that are vague or wrong.

Existing trackers don't solve this for developers. They see *which app* was open, not *what was done* (Timely, Rize, Toggl). They need weeks of training before drafts are useful, and their AI features are paid add-ons. Agent-log tools stop at tokens and transcripts (ccusage, sniffly). Nothing joins agent sessions, git/GitHub and the calendar into a timesheet, and nothing lets you correct a whole day in plain speech.

## 2. Principles

- **Works with whatever you use.** Any coding agent, any forge, any calendar. Unknown tools plug in through a generic command or JSONL source.
- **Uses what you already pay for.** The AI work runs through your own installed agent CLI (Claude Code, Codex, Copilot, …) on your existing subscription. API keys and local models are options, not requirements. Works with no AI at all.
- **Local-first.** Everything is read and stored on your machine. Only short titles go to the AI, never code or full prompts.
- **Voice-first review.** You talk over a drafted day; Clockout proposes the edits; you approve.

## 3. Hackathon constraints

- Judges try it with their own data after `clockout init` (the bundled-fixtures `--demo` day was removed; fixtures live on in the tests).
- Submission needs **one real result**: Clockout generates the timesheet for its own two-week build.
- Bonuses: weekly Wispr usage card (words dictated); build in public with `#NoHandsChallenge`, tag WeMakeDevs + Wispr Flow.

## 4. Form factor

One npm package, `clockout-cli` (bin: `clockout`), Node ≥ 22. The bare `clockout` name is taken on npm.

| Surface | Role |
|---|---|
| **TUI** (`clockout`, built with Ink) | Main surface, clickable ([ADR 0005](adr/0005-clickable-tui.md)). Home: the logo on the day's hours against a daily target, and the chat bar. The day: one card per timesheet row with an editable duration. Setup (ctrl+p) ticks sources and sets the target. |
| **Plain CLI** (`clockout today --md`, `--json`) | Scripting and piping; no interactive UI. |
| **MCP server + skill** (`clockout mcp`) | Run Clockout from inside your agent: "fill in yesterday's timesheet". The agent's own model does the AI work. |
| `clockout serve` *(stretch)* | Small local web view of the same data. |

Why a TUI and not a web page: the main advantage of a web UI is dragging and resizing blocks, and voice corrections replace that. A TUI matches where developers already are, runs with plain `npx`, and records well for the demo (VHS GIFs). Why Ink and not OpenTUI: OpenTUI needs Bun or Node ≥ 26 with an experimental flag, which breaks `npx` for most people. Ink is what Claude Code uses.

Voice in the terminal: Wispr Flow pastes into Terminal, iTerm2, Ghostty, Warp, kitty and the VS Code terminal. The TUI uses Ink's `usePaste` (bracketed paste) so dictated text is never read as hotkeys, sends every paste to the "say it" bar, strips newlines so a paste never auto-submits, keeps Enter as submit, and shows the "paste last transcript" shortcut as a fallback.

### Review screen

What counts on a timesheet is how long each thing took, not when, so the screen leads with hours.

```
            ▐ c l ◷ c k o u t ▌      ← the band behind the logo fills by project towards the target
                5h 45m of 8h
  ┃ Tell me about your day…  "standup ran to 45 minutes"
  ┃ Today · Fri, Oct 16 ▾                                   Setup

  ← Fri, Oct 16                                           5h 45m of 8h
  ╭──────────────────────────────────────────────────────────────────╮
  │ Fix auth token refresh (PR #87)                     ╭────────╮   │
  │ ● Acme API · Development                          − │ 2h 15m │ + │
  │ Claude Code + GitHub · 17 prompts in 1 session      ╰────────╯   │
  ╰──────────────────────────────────────────────────────────────────╯
  ╭──────────────────────────────────────────────────────────────────╮
  │ ? Design sync                                       ╭────────╮   │
  │ Did you attend “Design sync”? You replied maybe.    │  30m   │   │
  │  Attended   Skipped                                 ╰────────╯   │
  ╰──────────────────────────────────────────────────────────────────╯
  ╭┄ + Add time · 2h 15m untracked on this day ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄╮
```

- **Home**: the logo on the hours bar, the total, the chat bar. Its date opens a month picker (days with a draft are dotted; Yesterday / Today); its Setup button and ctrl+p open setup.
- **Day**: Enter opens one card per timesheet row (same grouping as the export), in the order the work started. The duration box takes a typed length (`1h 45`, `1:45`, `1.75`); − / + nudge by `round_to`. A length you set is stored on the block (`minutes`) and counts exactly that on the timesheet; times don't move. Meetings you haven't confirmed are cards with one-key answers. Gap questions get no card: untracked time only matters if you want hours there, which is what **Add time** is for (project, how long, what; Clockout places it).
- **Corrections**: anything typed that isn't a length goes to the AI, which returns edit operations; they're shown as a proposal and applied on Enter. Ctrl+Z undoes.
- **Send**: ctrl+s (or **Send to ERP**) sends the day to the timesheet system; see "Sending the day" below.
- **Setup**: a block per source to tick (Google Calendar signs in; Claude Code opens a searchable list of its projects, each tickable; GitHub), daily target, AI helper; working hours and rounding under More. Saved to config.toml as you go.

## 5. Sources

Every source is an adapter that emits `Activity` records.

```ts
interface Source {
  id: string;
  detect(): Promise<Detected | null>;               // used by `clockout init`
  collect(range: { from: Date; to: Date }, cfg): AsyncIterable<Activity>;
}

type Activity = {
  source: string;                 // "claude-code", "github", "calendar", …
  kind: "agent_session" | "prompt" | "commit" | "pr" | "review" | "meeting" | string;
  start: Date; end?: Date;
  actor: "human" | "agent";       // you, or an agent running unattended
  title?: string;
  project?: string;
  repo?: string; branch?: string; cwd?: string;
  refs?: string[];                // "pr:owner/repo#42", "jira:ABC-123", meeting UID
  attendance?: "accepted" | "tentative" | "needs_action" | "declined" | "unknown";
};
```

### Coding agents

Read from local files; nothing to set up. Never read auth or token files.

| Agent | Reads | MVP |
|---|---|---|
| Claude Code | `~/.claude/projects/*/*.jsonl` — `user` prompts = human activity, `ai-title` = title, `cwd` / `gitBranch` on events | ✓ |
| Codex | `~/.codex/state_5.sqlite` `threads` (cwd, title, branch, remote, times) + `sessions/**/rollout-*.jsonl` | ✓ |
| Antigravity | `~/.gemini/antigravity-cli/conversation_summaries.db` (title, workspace, last user input time; covers IDE conversations too) | ✓ |
| opencode | `~/.local/share/opencode/opencode.db` `session_v2` | ✓ |
| pi | `~/.pi/agent/sessions/*/*.jsonl` | ✓ |
| Copilot CLI | `~/.copilot/session-store.db` `sessions`, `turns` | stretch |
| Gemini CLI, Goose, Crush, Amp, Kiro, Cline, Cursor | see RESEARCH.md | later |
| Anything else | `command` / `jsonl` source, or a hook that appends to Clockout's JSONL | ✓ |

### Code hosting

| Source | Reads | MVP |
|---|---|---|
| `git` | `git log --author=<me>` in repos seen in agent `cwd`s + configured roots | ✓ |
| `github` | `gh auth token` or `GITHUB_TOKEN` → GraphQL `contributionsCollection` (PRs, reviews) | ✓ |
| GitLab / Bitbucket | via `command` source for now | later |

### Calendar

No single method covers everyone. `clockout init` asks which calendar you use and picks the first method that works:

| Tier | Method | Covers | RSVP | MVP |
|---|---|---|---|---|
| 1 | **ICS URL** | Google personal; Google Workspace if your admin allows the secret address; Proton (times only) | Google: yes (`PARTSTAT`) | ✓ |
| 2 | **OS calendar** — macOS EventKit helper | Every account added to macOS Calendar: Google, M365 work, Exchange, iCloud. No OAuth, no admin. | Yes | ✓ |
| 3 | **CalDAV** + app password | iCloud, Fastmail, Zoho | Yes | stretch |
| 4 | **Microsoft Graph** device-code sign-in | Outlook.com personal; M365 work only if an admin consents (blocked by default since Nov 2025) | Yes | stretch |
| 5 | **Times only** | Anything with a feed but no attendee data | Treated as attended unless you say otherwise | ✓ |

Windows (Outlook COM) and Linux (khal/vdirsyncer folders) OS stores come later. Paid unified calendar APIs (Nylas, Cronofy) don't fit a free local tool.

### Generic

- **`command`**: runs your command with `CLOCKOUT_FROM` / `CLOCKOUT_TO` env vars and reads JSONL `Activity` from stdout.
- **`jsonl`**: reads a file of `Activity` lines. Any agent with hooks can append to it.
- **OTLP receiver** *(stretch)*: accept OpenTelemetry logs from Claude Code, Codex, Copilot or Gemini CLI on `localhost:4318`.
- **`clockout hooks install`** *(stretch)*: adds Claude Code / Codex / Antigravity hooks that append to Clockout's JSONL. Survives Claude Code deleting transcripts after ~30 days.

## 6. AI backend — bring your own agent

Clockout needs AI for two jobs: one-line summaries per block, and turning spoken corrections into edit operations. Both run through one interface:

```ts
interface LlmBackend {
  id: string;
  detect(): Promise<boolean>;     // installed and logged in
  complete(req: { system: string; prompt: string; schema?: JSONSchema }): Promise<unknown>;
}
```

| Backend | How | Structured output | Policy |
|---|---|---|---|
| **Claude Code** | `claude -p --output-format json --json-schema … --tools "" --no-session-persistence --model haiku`, run in an empty temp dir | Enforced | Allowed: runs your own unmodified `claude` on your own login. Clockout never reads or uses your Claude credentials. |
| **Codex** | `codex exec --output-schema … -s read-only --ephemeral --ignore-user-config --skip-git-repo-check` | Enforced | Allowed |
| **GitHub Copilot** | `copilot -p … --output-format json`, tools off | Prompted + validated | Allowed (official SDK exists) |
| **opencode / pi** | `opencode run --format json` / `pi -p --mode json --no-tools` | Prompted + validated | Depends on the provider you configured in them |
| **Antigravity** | `agy -p --output-format json --json-schema … --mode plan` | Enforced | **Opt-in with a warning**: Google's terms forbid using Antigravity "in connection with products not provided by us" |
| **Ollama / LM Studio** | localhost HTTP | Enforced | Free and private |
| **API key** | Anthropic / OpenAI / Google / OpenRouter via Vercel AI SDK | Enforced | Always fine |
| **None** | Heuristic summaries; corrections via the edit keys | — | — |

Auto-detect order (when `backend = "auto"`): Claude Code → Codex → Copilot → opencode → pi → Ollama → API key in env → none. Antigravity is never auto-selected.

Rules for every CLI backend: run in an empty temp dir with tools off and no session saved; batch the whole day into one call; validate the output with Zod and retry once on bad output; show which backend and model were used. Pro/Max-style plans assume normal individual use, so keep calls few and small.

**Inside your agent (MCP mode):** `clockout mcp` exposes `get_day`, `get_blocks`, `apply_edits`, `export`. In Claude Code, Codex, Copilot, opencode, pi or Antigravity you say "clockout: fill in yesterday, the gap after lunch was the design review" and the agent's own model does the work — no subprocess, no credentials.

## 7. Configuration

`clockout init` detects installed agents, `gh` login, git repos and AI CLIs, asks which calendar you use, and writes `~/.config/clockout/config.toml` (respects `$XDG_CONFIG_HOME`).

```toml
[me]
name = "Girish"
emails = ["girish@example.com"]        # matches your ATTENDEE line for RSVP status
git_authors = ["girish@example.com"]
timezone = "Asia/Kolkata"

[day]
working_hours = "09:30-18:30"
idle_cutoff = "20m"
round_to = "15m"
target = "8h"        # hours you aim to log; the review screen fills towards it

[ai]
backend = "auto"     # auto | claude-code | codex | copilot | opencode | pi | antigravity | ollama | api | none

[[sources]]
type = "claude-code"
exclude = []         # Claude Code project folders to leave out

[[sources]]
type = "github"

[[sources]]
type = "calendar"
method = "macos"     # ics | macos | caldav | graph
calendars = ["Work"]

[[sources]]
type = "command"
name = "my-tracker"
run = "my-tracker export --json"

[[projects]]
name = "Acme API"
match = { repo = "acme/api", title = "(?i)acme", attendee_domain = "acme.com" }
```

## 8. How it works

```
collect → store → resolve projects → blocks → attendance → summarize → review (voice) → export / send
```

1. **Collect** from each configured source for the date range.
2. **Store** in local SQLite (`~/.local/share/clockout/`). Days survive agents deleting their logs; corrections are saved.
3. **Resolve projects**: `[[projects]]` rules → git remote → repo root → `cwd`. Ticket keys from branch names. Meetings: links/ticket keys in the description → title rules → attendee domain → past corrections for the same series → AI pick from the project list.
4. **Blocks**: merge activity on the same project + branch/PR; a gap longer than `idle_cutoff` splits a block. Duration comes from **your** activity (prompts, commits, reviews), not agent runtime. Review blocks: cluster of comment/submit times, minimum 15 min. Calendar wins on overlap. Round to `round_to`.
5. **Attendance**: accepted → count; tentative / no response → ask; declined → drop; no attendees → count. Dense prompts or commits during an accepted meeting → ask "skipped or multitasking?". Never drop a meeting silently.
6. **Summarize**: one verb-first line per block, ≤ 8 words. AI backend if available, else aiTitle → PR title → commit subject → branch name.
7. **Gaps**: unaccounted time inside working hours.
8. **Review**: type or dictate. The AI returns operations (`add`, `update`, `delete`, `split`, `merge`, `fill_gap`, `clarify`), never a rewritten sheet. Clockout validates them, shows the diff, applies on `y`, and supports undo.
9. **Export**: one row per block with **date, project, task, hours, description** — the fields most timesheet forms ask for. Clipboard, Markdown, CSV, JSON. Task comes from config rules (by activity kind, e.g. meeting → "Meetings", review → "Code Review", or a default per project) and can be changed by voice. After the MVP: user-defined export templates (own columns and formats) and documented presets for common timesheet tools.
10. **Send** *(when a timesheet system is set up)*: see below.

### Sending the day

Copy-paste is the step people skip, so Clockout can write the day into the timesheet system itself ([ADR 0006](adr/0006-send-to-timesheet-system.md)).

- **Targets** (`src/targets/`): read the day's entries, search tasks, create / update / delete. First: **next-pms** on Frappe/ERPNext, through the methods its own web app calls (`timesheet.save`, `update_timesheet_detail`, `delete`, `get_timesheet_data`, `task.get_task_list`), so its rules apply. Later: Harvest, Toggl, Clockify, Jira/Tempo, a `command` target.
- **Sign-in**: `clockout connect erp <url>`: OAuth 2 with PKCE as a public client registered for the loopback redirect (RFC 7591/8252), refresh token in `credentials.json`. Frappe rotates refresh tokens; the new one is saved on every refresh.
- **Mapping**: next-pms needs a task per entry. `[[timesheet.map]]` maps a Clockout project (optionally only one of its tasks) to an ERP task, picked once from a searchable list in the review screen or `clockout push`.
- **Plan, then apply** (`core/push`, pure): each row finds its ERP entry by (1) what was sent for that row before, (2) what was sent on the same ERP task for a row that's gone (the description changed), (3) an untracked entry with the same task and description (a send whose record was lost). Then: create / update / same / delete (sent before, row gone or set to zero) / blocked (approved, rejected, approved week) / unmapped / theirs (added in the ERP by hand; never touched). Shown before anything is written; Enter or `--yes` applies.
- **Record**: the day's JSON keeps `pushed` (row key → ERP entry id) and `pushedAt`, and keeps them when the day is rebuilt. A create returns no id, so the day is re-read after sending and entries matched by task, hours and description. One failed entry doesn't stop the rest.
- **What leaves the machine**: date, task id, hours and description per row, to your own ERP, only when you confirm.

## 9. MVP (must ship)

- [ ] Core: collect, SQLite store, project resolution, blocks, gaps, attendance, heuristic summaries
- [ ] Agent sources: Claude Code, Codex, Antigravity, opencode, pi
- [ ] `git`, `github`
- [ ] Calendar: ICS URL, macOS EventKit helper, times-only fallback
- [ ] `command` and `jsonl` sources
- [ ] AI backends: Claude Code, Codex, Ollama, API key, none (others behind the same interface as time allows)
- [ ] Edit operations + diff + undo
- [ ] Ink TUI review screen with the "say it" bar
- [ ] `clockout today | yesterday | week | --from --to`, `--md`, `--json`
- [ ] Export: clipboard, Markdown, CSV with date, project, task, hours, description
- [ ] `clockout init` with auto-detect
- [ ] VHS demo GIF (records a real day; the `--demo` command was removed)
- [ ] README + demo video

## 10. Stretch

- `clockout mcp` + skill
- AI backends: Copilot, opencode, pi, Antigravity (opt-in)
- Sources: Copilot CLI, Gemini CLI, Goose, Crush; CalDAV; Microsoft Graph
- `clockout hooks install`, OTLP receiver
- `clockout serve`
- Export templates for Toggl / Harvest / Clockify / Jira
- Saving repeated corrections as rules
- Standup mode

## 11. Out of scope

- Hosted/cloud version, accounts, sync
- ~~Pushing directly into any timesheet system's API~~ (now in: [ADR 0006](adr/0006-send-to-timesheet-system.md), next-pms first)
- OS-level window/app tracking
- Reading or storing any vendor's login tokens
- Verified Google/Microsoft OAuth apps
- Built-in speech recognition (Wispr Flow handles voice input)

## 12. Stack

See [ADR 0004](adr/0004-toolchain.md) for the toolchain and [docs/plan.md](plan.md) for the day-by-day plan.

- **TypeScript 7 / Node ≥ 22.12**, ESM, pnpm 11, tsdown, vitest, Biome, lefthook
- TUI: `ink` 8 + `ink-text-input`; CLI: `commander`; setup wizard: `@clack/prompts`
- Config: `smol-toml`; validation: `zod`
- Store: JSON files ([ADR 0003](adr/0003-json-store.md)); reading Codex / Antigravity / opencode SQLite comes later via `node:sqlite`
- Calendar: `node-ical`; macOS EventKit helper later
- GitHub: `@octokit/graphql`; git and agent CLIs via `execa`
- `clipboardy`, `date-fns` + `@date-fns/tz`
- Tests: fixture sessions (also power `--demo`); demo recording: VHS

## 13. Two-week plan

| Days | Goal |
|---|---|
| 1 | Scaffold, config + `init`, fixtures, SQLite store. Start logging own build. |
| 2–3 | Agent sources (Claude Code, Codex, Antigravity, opencode, pi) + `git` |
| 4 | `github`, calendar ICS + EventKit helper, attendance |
| 5–6 | Project resolution, blocks, gaps, heuristic summaries, `--md` / `--json` output |
| 7–8 | AI backend interface (Claude Code, Codex, Ollama, API key), summaries, edit operations, undo |
| 9–10 | Ink TUI review screen, "say it" bar, Wispr testing across terminals |
| 11 | Exports, `command` / `jsonl` sources |
| 12 | Publish to npm; run on own two weeks → **real result** |
| 13–14 | README, VHS GIF, demo video, submission. Stretch items if time allows. |

Weekly: export Wispr usage card; post progress with `#NoHandsChallenge`.

## 14. Open decisions

- Daily hours available for the build
- Accuracy target for the real result (e.g. within ±15 min/day of a manually kept log)
- Whether MCP mode moves into the MVP (it's cheap once the core exists)

## 15. Success metric (for the submission)

"Clockout logged its own build: N days, X hours across Y tasks, generated in Z seconds per day, with W voice corrections" + time spent on timesheets before vs after.
