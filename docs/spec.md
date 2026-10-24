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

One npm package, `clockout-cli` (bin: `clockout`), Node ≥ 22.12. The bare `clockout` name is taken on npm. The bin is a small loader that says which Node is needed on an older one, instead of the bundle failing to load. A mistyped command says so and suggests the nearest (`today` being the default would otherwise read it as an argument). Dates are today, yesterday, `-N` or a real `YYYY-MM-DD`; a day that hasn't happened yet is refused (an export range may run past today and stops there). A saved day that's damaged, or was written by a newer Clockout, is never rebuilt over: Clockout says which file and what to do.

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
  ╭┄ + Add time · 2h 15m short of your 8h day ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄╮
```

- **Home**: the logo on the hours bar, the total, the chat bar. Its date opens a month picker (days with a draft are dotted; Yesterday / Today); its Setup button and ctrl+p open setup.
- **Day**: Enter opens one card per timesheet row (same grouping as the export), in the order the work started. The duration box takes a typed length (`1h 45`, `1:45`, `1.75`); − / + nudge by `round_to`. A length you set is stored on the block (`minutes`) and counts exactly that on the timesheet; times don't move. Ctrl+D or a card's ✕ takes it off the day (its blocks are deleted; Ctrl+Z brings them back). With an ERP set up, a card shows which ERP task it goes to; Ctrl+T or a click on it picks another, for that card alone. Row cards have checkboxes: click them or press Space to select several. Shift-click (or Option/Alt-click) anywhere on a card ticks it; once cards are ticked, it ticks the range from the last one. Option-click is for multiplexers such as herdr, which keep Shift-clicks for their own text selection. Shift+↑↓ ticks a range from the focused card. Clockout asks the terminal to pass Shift-clicks through (XTSHIFTESCAPE), so Ghostty and xterm don't keep them for text selection. A small toolbar then maps all of them to one ERP task (only those cards, not project defaults), copies just their rows, or removes them in one undoable edit; Ctrl+T, Ctrl+Y and Ctrl+D do the same to the selection, otherwise to the focused card/day as before. Esc or **Clear** leaves selection mode. Meetings you haven't confirmed are cards with one-key answers; copying works before they're answered (they're left out, and it says how many), sending waits for them. Gap questions get no card: untracked time only matters if you want hours there, which is what **Add time** is for (project, how long, what; Clockout places it). Its projects, best first: the day's own work, the ones in config (added by hand or named by a rule), the ones mapped to ERP tasks, the last 30 saved days', then under "From <ERP site>" the projects of your ERP tasks (recently used first) when you're signed in; left-out projects, breaks and meetings aren't offered, and names differing only in case are one. **+ New project** (Tab to it or click it; it's where you start when there's nothing to pick) takes a typed name, Enter uses it, and once the time is added the project is saved to config so every day offers it. A project's own `task` is used for time added to it. It shows how far the day is short of the daily target, the same numbers as the header, not the gaps in working hours.
- **Slash commands**: a `/` opens a menu over the chat bar that narrows as you type; ↑↓ choose, Tab fills in, Enter runs, a click runs. `/refresh`, `/connect erp <address>` / `google`, `/disconnect erp` / `google` (shown as a proposal first, like saying it), `/send`, `/copy [md | csv]`, `/undo`, `/add`, `/today`, `/yesterday`, `/date <day>` (a weekday, `-3` or `2026-10-16`), `/setup [sources | day | ai | projects | erp]`, `/problems`, `/help`. They do what the keys and buttons do, without the AI: text starting with `/` (or a dictated "slash …") never goes to it, and one that can't be read stays in the bar with what's wrong. Plain "refresh" and "connect erp …" keep working.
- **Problems**: a source or the AI helper that fails never stops the day; it's drafted from the rest and a ⚠ line under the hours bar shows the first problem ("2 problems · GitHub: …"). Clicking it or `/problems` opens every message in full. Each says what's wrong and how to fix it — GitHub: `gh` not installed, not logged in, a token rejected (which one: gh, `GITHUB_TOKEN`, `GH_TOKEN`), SAML SSO, a missing scope, rate limits, no network; Google: the sign-in client (Desktop app, Internal, Testing expiry), the Calendar API off, the calendar box not ticked, a revoked sign-in, no network. The underlying error goes to `~/.local/share/clockout/errors.log` (XDG data dir; tokens redacted, trimmed past 256 KB), and the dialog shows where. A command that fails prints the same message and `Details: <log>`.
- **Corrections**: anything else typed that isn't a length goes to the AI, which returns edit operations; they're shown as a proposal and applied on Enter. Ctrl+Z undoes.
- **Refresh**: corrections are replayed on newer activity when every drafted block is still in place. When they can't be, the day keeps your corrections and says so, with a **Rebuild the day** button. "refresh" (or "rebuild the day", "start over"; no AI needed) in the chat bar does the same: it drafts the day again from the latest activity, after asking first if that drops corrections. `--refresh` does it from the command line.
- **Setup by chat** ([ADR 0007](adr/0007-setup-from-the-chat-bar.md)): the same bar takes settings ("connect my ERP at erp.example.com", "leave out my personal project" (an ignore rule), "write descriptions in past tense", "my target is 7h30", "send acme/api to the hackathon task"). The AI returns settings operations, shown as a proposal like corrections; on Enter they're applied, validated like config.toml and saved, and the day is drafted again if they affect it. Sign-ins open the browser. An ERP task is searched locally and the picker opens if there's more than one match. A pasted private calendar link is handled without the AI; text that looks like a token is refused and nothing is sent. "connect erp <address>" and "disconnect google" work without the AI. The last three turns go along, so follow-ups work.
- **Send**: ctrl+s (or **Send to ERP**) sends the day to the timesheet system; see "Sending the day" below.
- **Window size**: below 60×18 the screen says to make the window bigger; the day stays as it was underneath.
- **Dialogs** (Setup, Problems, Add time, the task picker) open in the middle of the screen, a little above centre, over a plain backdrop that hides the day behind them; a click on the backdrop closes them. Setup is up to 100 columns wide and its body grows with the terminal (8 to 24 rows), one height for every section so it never jumps.
- **Setup**: sections on the left, the chosen one's settings on the right; ↑↓ moves, → or Enter goes into a section, ←→ changes a value, Space or Enter ticks, Esc goes back; everything is clickable too. **Sources**: coding agents (Claude Code opens a searchable page of its projects, each tickable; Pi; Codex; opencode; Antigravity), calendar (Google Calendar signs in; a private feed shows as read-only), code (GitHub); a tool that isn't on this machine is greyed out. **Day**: daily target, working hours, rounding, idle cutoff, time zone. **AI helper**: Auto, each helper installed here, or No AI (with which one Auto uses), the model, and how descriptions are written (starts with Fix / Fixed / Fixing, short / medium / long; **Prompt** opens a page to type or dictate how descriptions should read, Enter saves, Esc leaves it as it was; examples are set by saying them). **Projects**: default task names; your projects and rules (an ignore rule shows as "left out", one with only a name as "added by you"), each with ✕ remove (⌫); an **Add project** field adds one by name; and how to change them in the chat bar ("add a project called Internal"). **ERP**: an address field to sign in (browser), or once signed in the site, who you are and which ERP task each project goes to (✕ forgets one, so it's asked again on the next send) with Sign out. Saved to config.toml as you go.

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

Read from local files; nothing to set up. Never read auth or token files. A configured folder that's missing or unreadable, or an opencode database that's there but can't be read (busy, a newer layout), is a failure with a warning, so the day keeps what it saved from that tool; one session file that can't be read is skipped and the rest still count. Titles, branches and repo names from any source are cleaned to one line of plain text (no terminal escape codes or control characters) before they reach the screen or an export.

| Agent | Reads | MVP |
|---|---|---|
| Claude Code | `~/.claude/projects/*/*.jsonl` — `user` prompts you sent = human activity (not ones Claude Code writes itself: `origin.kind` other than `human`, such as task notifications or messages from other sessions, `promptSource: "system"`, compaction summaries), `ai-title` = title, `cwd` / `gitBranch` on events | ✓ |
| Codex | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` — `event_msg` `user_message` (from about 0.149: `item_completed` with a `UserMessage` item) = human activity (the `user` / `developer` messages sent to the model hold injected context and don't count); `response_item`s = agent work; `cwd` from `session_meta` / `turn_context`, branch and repo from `session_meta.git`. Subagent threads (`thread_source = "subagent"`) are skipped. No title: the `threads` table's title is the whole first prompt. `.jsonl.zst` rollouts aren't read yet | ✓ |
| Antigravity | The CLI's `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl`: `USER_INPUT` steps from a `USER_…` source = human activity, `MODEL` steps = agent work, system and error steps ignored; title, workspace folder and subagents (`parent_conversation_id`) from `conversation_summaries.db`. A conversation missing from the index still counts, without a title. The IDE's conversations are opaque protobuf and aren't read (the index lists them, but they have no transcript) | ✓ |
| opencode | `$XDG_DATA_HOME/opencode/opencode.db` (default `~/.local/share`), opencode 2 — `session_v2` has `directory`, `title` (a "New session - …" placeholder counts as none) and `parent_id` (subagent sessions are skipped); `session_message` `user` with text = human activity, `assistant` from `time_created` to `data.time.completed` = agent work, everything else ignored. Only times and types are read. Older layouts (1.x JSON storage, the `session` / `message` tables) aren't read | ✓ |
| Pi | `$PI_CODING_AGENT_DIR/sessions/*/*.jsonl` (default `~/.pi/agent`) — `session` header has `cwd`; `message` role `user` (with text) and `bashExecution` (a `!` command) = human activity, `assistant` = agent work, `toolResult` ignored; title only from a name you gave the session (`session_info`). No branch in the log | ✓ |
| Copilot CLI | `~/.copilot/session-store.db` `sessions`, `turns` | stretch |
| Gemini CLI, Goose, Crush, Amp, Kiro, Cline, Cursor | see RESEARCH.md | later |
| Anything else | `command` / `jsonl` source, or a hook that appends to Clockout's JSONL | ✓ |

### Code hosting

| Source | Reads | MVP |
|---|---|---|
| `git` | `git log --author=<me>` in repos seen in agent `cwd`s + configured roots | ✓ |
| `github` | `gh auth token` or `GITHUB_TOKEN` → GraphQL (github.com, or `GITHUB_GRAPHQL_URL` for GitHub Enterprise) `contributionsCollection` (PRs and issues opened, reviews with their comments and the PR's branch) and your latest 100 issue and PR comments (a comment on someone else's PR counts as reviewing it) | ✓ |
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

| Backend | How | Structured output | Status |
|---|---|---|---|
| **Claude Code** | `claude -p --output-format json --json-schema … --tools "" --strict-mcp-config --setting-sources "" --no-session-persistence --model haiku`, prompt on stdin, empty temp dir | Enforced | ✓ Allowed: your own unmodified `claude` on your own login; Clockout never reads your credentials |
| **Codex** | `codex exec --output-schema <file> --output-last-message <file> --sandbox read-only --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check -c model_reasoning_effort="low"`, instructions first in the prompt (no system-prompt flag), empty temp dir | Enforced, in OpenAI's strict form: every key required, optional ones nullable, `anyOf` for `oneOf`; nulls are dropped before validation | ✓ No switch turns tools off: the read-only sandbox has no network and no writes, in an empty folder, without your config's MCP servers or hooks |
| **opencode** | `opencode run --standalone --format json --agent clockout`, with the agent (system prompt, `permission: {"*": "deny"}`, model) in `OPENCODE_CONFIG_CONTENT`; `--standalone` so a private server reads it; the session is deleted afterwards and the opencode source skips Clockout's temp folders | Prompted + validated | ✓ Uses the provider you set up in opencode (its free tier refuses outside opencode itself). A model goes in the agent config: `--model` drops the agent's prompt |
| **Pi** | `pi -p --no-session --no-tools --no-extensions --no-skills --no-prompt-templates --no-context-files --no-mcp --no-themes --no-approve --system-prompt …` | Prompted + validated | ✓ Uses the provider you set up in Pi |
| **Antigravity** | — | — | **Not supported.** Tried `agy -p --output-format json --json-schema …`: 40 s and ~46k tokens for one block, it tries to run commands, answers empty when they're denied, and saves a conversation the Antigravity source would read back as work. Google's terms also forbid using it "in connection with products not provided by us" |
| **GitHub Copilot** | `copilot -p … --output-format json`, tools off | Prompted + validated | later |
| **Ollama / LM Studio** | localhost HTTP | Enforced | later |
| **API key** | Anthropic / OpenAI / Google / OpenRouter | Enforced | later |
| **None** | Titles as descriptions; corrections on the cards and with `/` commands | — | ✓ |

Auto-detect order (when `backend = "auto"`): Claude Code → Codex → opencode → Pi → none. `ai.model` is optional (each helper's default otherwise: haiku for Claude Code, your own default in the rest); a Claude model (`haiku`, `sonnet`, `opus`, `claude-…`) only goes to Claude Code and any other only to the rest, so switching helpers never breaks on a leftover model.

Rules for every CLI backend: run in an empty temp dir with tools off (denied or read-only where there's no switch) and nothing saved; batch the whole day into one call; validate the output with Zod and ask once more on bad output; show which backend and model were used. Pro/Max-style plans assume normal individual use, so keep calls few and small.

**Without a helper.** Choosing a helper never fails: when the configured one (or, for `auto`, every one) isn't on PATH, Clockout runs without AI and says why — on stderr for commands, as a toast when the review screen opens, and in the chat bar's hint. Typed sentences then get a toast saying what to do (turn it on in Setup, or install and sign in to a helper) and stay in the bar; durations, the cards, `/` commands, export and push all work. `clockout edit` says the same and exits non-zero.

**Errors.** A helper's failure shows the CLI's own words, never its command line (which holds the schema and prompt), plus how to sign in again when that's the problem ("Codex: … run `codex login`."), with anything that looks like a token redacted. Summaries that fail fall back to titles with a warning.

**Checks on what comes back.** Edits are dry-run against the day before they're shown as a proposal; ones that don't fit (ids that aren't there, times that don't work) say "didn't fit this day" instead, with the details in the error log. An answer, or a description, holding something that looks like a token is dropped (the title stays). Evidence sent to the helper is redacted the same way.

**Processes.** Each helper runs in its own process group: on the 2-minute timeout, or when Clockout quits (Ctrl+C, a closed terminal, a kill), the helper and anything it started are stopped and its temp folder removed.

**Inside your agent (MCP mode):** `clockout mcp` exposes `get_day`, `get_blocks`, `apply_edits`, `export`. In Claude Code, Codex, Copilot, opencode, pi or Antigravity you say "clockout: fill in yesterday, the gap after lunch was the design review" and the agent's own model does the work — no subprocess, no credentials.

## 7. Configuration

`clockout init` detects installed agents, `gh` login, git repos and AI CLIs, asks which calendar you use, and writes `~/.config/clockout/config.toml` (respects `$XDG_CONFIG_HOME`).

```toml
[me]
name = "Dev"
emails = ["dev@example.com"]        # matches your ATTENDEE line for RSVP status
git_authors = ["dev@example.com"]
timezone = "Asia/Kolkata"

[day]
working_hours = "09:30-18:30"
idle_cutoff = "20m"
round_to = "15m"
target = "8h"        # hours you aim to log; the review screen fills towards it

[ai]
backend = "auto"     # auto | claude-code | codex | opencode | pi | none
# model = "haiku"   # optional; each helper's own default otherwise

[descriptions]       # how the AI writes descriptions; without it, titles are used as they are
format = "imperative" # imperative "Fix …" | past "Fixed …" | continuous "Fixing …"
length = "short"     # short (3–8 words) | medium (one sentence) | long (one or two sentences)
instructions = "Lead with the ticket key. Write for a client, no jargon."   # optional prompt, your own words (≤ 2000 characters)
examples = ["ABC-12 Fixed the login redirect loop"]   # optional, up to 5 to match the style of

[[sources]]
type = "claude-code"
exclude = []         # Claude Code project folders to leave out

[[sources]]
type = "pi"          # sessions_dir = "…" to read somewhere other than ~/.pi/agent/sessions

[[sources]]
type = "codex"       # sessions_dir = "…" to read somewhere other than ~/.codex/sessions

[[sources]]
type = "opencode"    # db = "…" to read somewhere other than ~/.local/share/opencode/opencode.db

[[sources]]
type = "antigravity" # dir = "…" to read somewhere other than ~/.gemini/antigravity-cli

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

[[projects]]
name = "Internal Tools"  # only a name: a project you log time to by hand (Add time, the AI)
task = "Tooling"         # optional: its time goes to this task

[[projects]]
name = "dotfiles"    # ignore: leave this project off the day (work, agent turns, meetings)
ignore = true        # without match it's the project with this name; with one, what it matches
```

## 8. How it works

```
collect → store → resolve projects → blocks → attendance → summarize → review (voice) → export / send
```

1. **Collect** from each configured source for the date range.
2. **Store** in local SQLite (`~/.local/share/clockout/`). Days survive agents deleting their logs; corrections are saved.
3. **Resolve projects**: `[[projects]]` rules → git remote → repo root → `cwd`. A project an `ignore` rule names is dropped before blocks are built, with a note under the day. Ticket keys from branch names. Meetings: links/ticket keys in the description → title rules → attendee domain → past corrections for the same series → AI pick from the project list.
4. **Blocks**: merge activity on the same project + branch/PR; a gap longer than `idle_cutoff` splits a block. Duration comes from **your** activity (prompts, commits, reviews), not agent runtime. Review blocks: cluster of comment/submit times, plus up to 15 min of reading before the first one where nothing else claims that time. A session where you try out a PR you reviewed (it ran on the PR's branch, by name or fetched as `pr-2305`, or its title names the PR) is part of the review. A comment on an issue joins whatever you were doing in that project then, or is its own short block. Calendar wins on overlap. Sessions running side by side: at any moment the one you last prompted wins, and a stretch of switching between them (pieces under 5 min in a row) is shared out by how long each had, one piece each, rather than folded into the first; a lone piece under 5 min joins its neighbour. Round to `round_to`.
5. **Attendance**: accepted → count; tentative / no response → ask; declined → drop; no attendees → count. An event of 10 hours or more (an offsite, a conference, a block over several days) counts only for the day's working hours and is always asked about. Dense prompts or commits during an accepted meeting → ask "skipped or multitasking?". Never drop a meeting silently.
6. **Summarize**: one verb-first line per block, ≤ 8 words by default; `[descriptions]` sets the verb form, the length, your own prompt (`instructions`: who reads the timesheet, what to lead with, words to use or avoid; it follows Clockout's fixed rules, so descriptions still only state facts from the evidence) and examples. AI backend if available, else aiTitle → PR title → commit subject → branch name (the style only applies to the AI's). A style other than the default is part of the summary cache key, so changing it writes them again. Blocks with the same evidence are asked about once and share one description, so the wording never splits one piece of work into two timesheet rows.
7. **Gaps**: unaccounted time inside working hours. A gap of 30 min or more gets a question: 2h or more asks what you were working on and names the work before and after it; a shorter one offers lunch (only when it touches 12:00–15:00), a break, or work. One sentence can fill several gaps ("everything between 12:45 and 16:00 was next-pms"). `--plain` lists blocks, then the timesheet rows, which add up to the header's total.
8. **Review**: type or dictate. The AI returns operations (`add`, `update`, `delete`, `split`, `merge`, `fill_gap`, `clarify`), never a rewritten sheet. Clockout validates them, shows the diff, applies on `y`, and supports undo.
9. **Export**: one row per block with **date, project, task, hours, description** — the fields most timesheet forms ask for. Clipboard, Markdown, CSV, TSV, JSON. A CSV/TSV cell starting with `=`, `+`, `-` or `@` gets a leading `'` so spreadsheets keep it as text (meeting titles can come from anyone); a Markdown row stays on one line. `export --to D` alone exports that one day; a date together with `--from`/`--to` is refused; `-f` takes any case. Task comes from config rules (by activity kind, e.g. meeting → "Meetings", review → "Code Review", or a default per project) and can be changed by voice. After the MVP: user-defined export templates (own columns and formats) and documented presets for common timesheet tools.
10. **Send** *(when a timesheet system is set up)*: see below.

### Sending the day

Copy-paste is the step people skip, so Clockout can write the day into the timesheet system itself ([ADR 0006](adr/0006-send-to-timesheet-system.md)).

- **Targets** (`src/targets/`): read the day's entries, search tasks, create / update / delete. First: **next-pms** on Frappe/ERPNext, through the methods its own web app calls (`timesheet.save`, `update_timesheet_detail`, `delete`, `get_timesheet_data`, `task.get_task_list`), so its rules apply. **http**: any timesheet or PMS system answering Clockout's five-request JSON API ([timesheet-api.md](timesheet-api.md)) with a bearer token read from an environment variable (`token_env`, never stored); `pnpm mock-pms` runs one for trying it, and the end-to-end tests send to it. Later: Harvest, Toggl, Clockify, Jira/Tempo, a `command` target.
- **Sign-in**: `clockout connect erp <url>`: OAuth 2 with PKCE as a public client registered for the loopback redirect (RFC 7591/8252), refresh token in `credentials.json`. Frappe rotates refresh tokens; the new one is saved on every refresh.
- **Mapping**: next-pms needs a task per entry. `[[timesheet.map]]` maps a Clockout project (optionally only one of its tasks) to an ERP task, picked once from a searchable list in the review screen or `clockout push`.
- **Per card**: with an ERP set up, each card shows where it goes (`→ API maintenance`). Clicking that or Ctrl+T opens the same task search. A project's first pick becomes its mapping; once it has one, a different pick holds for that card only, stored on its blocks as `sendTo` through a `send_to` edit (so Ctrl+Z undoes it and it's replayed when the day is rebuilt). The search then offers "Back to <project's task>" first. Checked cards can share one pick: it applies only to those cards and never changes project mappings. `sendTo` wins over the mapping when planning a send; it isn't part of the export.
- **Plan, then apply** (`core/push`, pure): each row finds its ERP entry by (1) what was sent for that row before, (2) what was sent on the same ERP task for a row that's gone (the description changed), (3) an untracked entry with the same task and description (a send whose record was lost). Then: create / update / same / delete (sent before, row gone or set to zero) / blocked (approved, rejected, approved week) / unmapped / theirs (added in the ERP by hand; never touched). Shown before anything is written; Enter or `--yes` applies.
- **Checks**: a day adding up to more than 24 hours isn't sent (fix the hours first). The ERP's address must be https (plain http only on this machine), checked before signing in. Frappe keeps old refresh tokens working, so each one replaced on a refresh is revoked; a 400/401/403 from the token endpoint asks you to connect again, a 5xx says the ERP isn't answering. A site without next-pms (or one too old) is named as such.
- **Record**: the day's JSON keeps `pushed` (row key → ERP entry id) and `pushedAt`, and keeps them when the day is rebuilt. A create returns no id, so the day is re-read after sending and entries matched by task, hours and description. One failed entry doesn't stop the rest. If the day can't be re-read after sending (the site went down), it says how many were sent and to send again to check; the record is left as it was, and the next send matches what's already there, so nothing is added twice. `push --yes` exits 1 when anything failed or was left out (no task, blocked).
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
- Store: JSON files ([ADR 0003](adr/0003-json-store.md)); opencode's and Antigravity's SQLite are read with `node:sqlite` ([ADR 0008](adr/0008-read-agent-sqlite-with-node-sqlite.md))
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
