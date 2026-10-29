# Clockout — research notes

Collected 2026-10-18. Sources were checked on the web (via Firecrawl) and, for agent storage, on the dev machine (structure only, never message content or credentials). Rows marked _docs_ were not checked locally.

---

## 1. Prior art

### General auto time trackers

| Tool                       | Form                        | How it collects                                                                                          | Project mapping                                                                                                   | Meetings                                       | Privacy                 | Price                  |
| -------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ----------------------- | ---------------------- |
| Timely (AutoSheet)         | Desktop + web               | OS window/doc titles; OAuth to calendar, Gmail, Zoom, GitHub, Jira                                       | Per-user ML; drafts a full timesheet each morning for review                                                      | Events → entries; no RSVP check                | Cloud                   | $9–28/user/mo          |
| Memtime                    | Desktop                     | Window titles, files, email subjects, tabs                                                               | Manual drag or auto-log                                                                                           | Via connected apps                             | **Local only**          | ~€12–25/mo             |
| Rize                       | Desktop + browser extension | Foreground app/URL, calendar, Linear/Asana                                                               | AI + user rules                                                                                                   | Auto-maps meetings to projects                 | Cloud                   | $10–40/mo + AI credits |
| Timing                     | macOS app                   | App, window title, path, URL                                                                             | Path/title/URL rules, first match wins; **has an MCP server** for Claude Code/Codex                               | —                                              | Local                   | $9–16/mo               |
| Toggl Track                | Web + desktop               | Timeline of apps/sites                                                                                   | Rules by dragging over a window                                                                                   | Calendar auto-track; tracked/untracked "pills" | Cloud                   | Free–$20               |
| Clockify                   | Desktop                     | Record per app/tab switch                                                                                | Manual conversion                                                                                                 | Separate                                       | Local, 45-day retention | Free+                  |
| WakaTime                   | Editor plugins + CLI        | Heartbeats every ~2 min, merged with a 15-min timeout; **Claude Code plugin via hooks** tags "AI coding" | Repo/folder                                                                                                       | Google Calendar                                | Cloud                   | Free/paid              |
| ActivityWatch              | Open-source desktop         | Local server + "watchers" (window, AFK, browser, editor)                                                 | Regex category rules                                                                                              | None                                           | Local                   | Free                   |
| Tempo (Jira)               | Jira app                    | Calendar, Jira, IDE, GitHub webhooks                                                                     | Jira key in commit/branch; priority calendar > Jira > code; "expand suggestions" stretches blocks to fill the day | Drops Private/Free events; no RSVP check       | Cloud                   | Per Jira user          |
| Harvest / Everhour / 7pace | Web                         | Manual timers or manually pulled calendar events                                                         | Manual / issue = task                                                                                             | Manual                                         | Cloud                   | ~$8–11/user            |

### Developer / AI-agent specific

- **ccusage**: tokens and cost per day from Claude Code + Codex logs. No time-on-task, no projects.
- **sniffly**, **claude-code-log**, Claude Code `/insights`: dashboards and transcript viewers. Claude only, no timesheet.
- **cass**, **Agent Sessions**, **agent-chorus**: search and browse sessions across 10+ agents. Useful reference for parsers and paths. No time, no calendar.
- **claude-code-timelog**: closest prior art. Claude Code plugin using hooks to log session start/end and prompts; project from git root, ticket from branch, gaps < 30 min count as active. Claude only, no meetings, no paste-ready output.
- **clerk**, Session Tracker: AI summaries and standups from Claude sessions.
- **timesheet.io / Sandtime / TrackingTime MCP**: "log 2h on X yesterday" from inside an agent. Manual entry through natural language; no inference, one entry at a time.
- **git-hours**: commits < 2h apart form one session, plus 2h before the first commit. Crude.
- **gtm**: editor plugins write file time into git notes.
- **git-standup**: lists commits since yesterday, no durations.
- **n8n "AI Timesheet Generator"** template: confirmed calendar events + GitHub + Gmail → Google Sheet. The only thing found that filters by confirmed events.

### What users complain about

- Trackers see the _app_, not the _client or reason_ ("I spend time in notepad++ but it won't tie it to the case").
- Review overhead: "if it's not 99% automatic and 99% correct you're not saving me time".
- Cold start: ML tools need weeks of manual logging first.
- Price and AI-credit metering; cloud privacy; platform lock-in (Mac-only, Jira-only, one calendar only).

### Patterns worth copying

- **Draft → review → submit** with an "evidence" view per entry (Timely).
- **Corrections become rules** (Timely, Timing).
- **Declarative rules** for project mapping (Timing, ActivityWatch).
- **Ticket key from branch or commit** (Tempo).
- **Source priority on overlap**: calendar wins (Tempo).
- **Heartbeat + idle timeout** to turn events into durations (WakaTime).
- **Local-first storage** (Memtime, Timing, ActivityWatch).

### The gap Clockout fills

1. **Nobody joins several coding agents + git/GitHub + calendar into a timesheet.** Agent tools stop at tokens/transcripts; time trackers don't read agent sessions as "what was done".
2. **Nobody separates agent wall-clock from human attention**, e.g. an agent running while you sit in a meeting.
3. **No natural-language correction of a whole drafted day.** The MCP trackers edit one entry at a time. No voice.
4. **No RSVP/attendance handling** in any mainstream tracker reviewed.
5. **Zero cold start**: git remote, branch, ticket key and agent `cwd` identify the project without training.
6. **Paste-ready, tool-agnostic output** instead of lock-in to one timesheet system.

---

## 2. Where coding agents store sessions

| Agent               | Path                                                                                                                                                               | Format                                    | Time/project fields                                                                                                                                                                                                           | Effort                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Claude Code         | `~/.claude/projects/<slug>/<sessionId>.jsonl` (+ `<sessionId>/subagents/`)                                                                                         | JSONL                                     | `timestamp`, `cwd`, `gitBranch`, `sessionId`, `isSidechain`; `ai-title` gives a title. **Transcripts are deleted after ~30 days by default (`cleanupPeriodDays`).**                                                           | Easy                                               |
| Codex CLI           | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (sometimes `.zst`) + `~/.codex/state_5.sqlite`                                                                      | JSONL + SQLite                            | `session_meta` (`cwd`, `git.branch`, `git.repository_url`); `task_started/complete` with `duration_ms`; SQLite `threads` table has `cwd, created_at_ms, updated_at_ms, title, first_user_message, git_branch, git_origin_url` | Easy                                               |
| opencode            | `~/.local/share/opencode/opencode.db`                                                                                                                              | SQLite                                    | `session_v2`: `directory, title, time_created, time_updated`                                                                                                                                                                  | Easy                                               |
| Cline / Roo         | VS Code `globalStorage/<ext-id>/tasks/<id>/`                                                                                                                       | JSON                                      | `ui_messages.json` `ts` per message                                                                                                                                                                                           | Easy–medium                                        |
| Copilot Chat        | VS Code `workspaceStorage/<hash>/chatSessions/*.jsonl`                                                                                                             | JSONL snapshot + patch ops                | `creationDate`, request timestamps; project from `workspace.json`                                                                                                                                                             | Medium                                             |
| Gemini CLI _(docs)_ | `~/.gemini/tmp/<project_hash>/chats/`                                                                                                                              | JSON                                      | Message timestamps; project is a hash of the root dir                                                                                                                                                                         | Medium                                             |
| Aider _(docs)_      | `.aider.chat.history.md` per repo                                                                                                                                  | Markdown                                  | Only "chat started at" headers                                                                                                                                                                                                | Medium                                             |
| Cursor _(docs)_     | `…/Cursor/User/globalStorage/state.vscdb` (`cursorDiskKV`) + `~/.cursor/…`                                                                                         | SQLite KV                                 | `composerData:<id>` (`createdAt`), `bubbleId:…`                                                                                                                                                                               | Hard                                               |
| Antigravity         | IDE: `~/.gemini/antigravity/conversations/*.pb`; CLI: `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl` + `conversation_summaries.db` | IDE: binary protobuf; CLI: JSONL + SQLite | CLI steps: `type`, `source`, `created_at`                                                                                                                                                                                     | IDE not feasible; CLI easy (read since 2026-10-22) |
| Windsurf _(docs)_   | `~/.codeium/windsurf/cascade/*.pb`                                                                                                                                 | Encrypted protobuf                        | —                                                                                                                                                                                                                             | Not feasible; use hooks                            |

### Push-based collection (optional, more accurate)

- **Claude Code hooks**: `SessionStart`, `UserPromptSubmit`, `Stop`, `SessionEnd`… Input has `session_id`, `cwd`, `transcript_path`. Hooks can be `type: "http"` and POST straight to a local URL.
- **Claude Code OpenTelemetry**: `CLAUDE_CODE_ENABLE_TELEMETRY=1` + OTLP exporters. `claude_code.active_time.total` is a ready-made measure of active time that excludes idle time.
- **Codex**: `notify = [...]` on `agent-turn-complete`; lifecycle hooks; `[otel]` export.
- **Cursor, Gemini CLI, VS Code agents**: all have hook systems now.

Use: parse logs as the baseline (zero setup, works on past days), offer `clockout hooks install` as an upgrade that also survives Claude Code's 30-day cleanup.

---

## 3. Form factor

| Option                                | Reads local agent logs?                                                                                                      | Effort                       | Verdict                                                                                                            |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| CLI                                   | Yes                                                                                                                          | Low                          | Core                                                                                                               |
| CLI + local web UI (`clockout serve`) | Yes                                                                                                                          | Medium                       | **Recommended UI.** Same pattern as ActivityWatch (local server + web UI). A plain textarea works with Wispr Flow. |
| MCP server over the same core         | Yes                                                                                                                          | Low                          | Bonus: "fill my timesheet" from inside Claude Code / Codex                                                         |
| Hosted web app                        | **No.** File System Access API is Chromium-only, blocks the home dir, the picker hides dotfolders, permissions don't persist | Medium                       | Only as a static demo on fixtures                                                                                  |
| Desktop app (Tauri/Electron/menubar)  | Yes                                                                                                                          | High (signing, notarization) | Not in 2 weeks                                                                                                     |
| Browser extension                     | No                                                                                                                           | —                            | No                                                                                                                 |

---

## 4. Calendar

| Option                                   | Covers                                      | Attendance data                                                                                                                            | Cost                                                                                                                                                                           |
| ---------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Private ICS URL**                      | Google, iCloud, most CalDAV; Outlook partly | **Google's secret ICS includes `ATTENDEE;PARTSTAT=…` for every guest, including you.** Outlook's published ICS reportedly drops attendees. | None. Default.                                                                                                                                                                 |
| macOS EventKit (Swift helper or `ekctl`) | Every account added to macOS Calendar       | `EKParticipant.participantStatus`                                                                                                          | One OS permission prompt. Mac only.                                                                                                                                            |
| Google Calendar API                      | Google                                      | `attendees[].self.responseStatus`, `eventType` (skip focus time, OOO, working location)                                                    | `calendar.readonly` is a sensitive scope: verification takes days; unverified apps are capped at 100 users with a warning screen. Use "bring your own OAuth client" if at all. |
| Microsoft Graph                          | M365                                        | `responseStatus`                                                                                                                           | App registration; many tenants need admin consent.                                                                                                                             |

**Did I actually attend?**
- RSVP: accepted → count; tentative / needs-action → ask; declined → drop; events with no attendees (solo blocks) → count.
- Real join data is mostly unavailable: Google Meet's API only returns meetings you organised; Zoom reports need a paid plan.
- Heuristic: dense prompts or commits during an accepted meeting → ask "skipped or multitasking?". Never drop silently.

**Meeting → project**, in order: links/ticket keys in the description → title rules → attendee email domain → remembered past corrections (by event UID or recurring series) → LLM pick from the project list.

---

## 5. GitHub

- Auth: `gh auth token`, falling back to a `GITHUB_TOKEN` PAT. A GitHub App is overkill.
- Commit times: local `git log` (exact, no rate limits).
- PRs and reviews: GraphQL `contributionsCollection(from, to)` gets commit, PR and review contributions with timestamps in one call. Search API (`author:@me`, `reviewed-by:@me`) as a fallback, 30 req/min.
- Events API: only the last 30 days and 300 events, with up to 6h delay. Don't rely on it.
- Review time: GitHub records only when comments and reviews were submitted. Estimate a review block from the cluster of those times plus a 15-min minimum, merged with any agent session in that repo.

---

## 6. Natural-language edits

- Give the LLM: date and timezone, blocks with stable IDs (`b1…bn`), gaps (`g1…`), and candidate refs (today's PRs, repos, meetings) so "Sam's PR" resolves to a real ID.
- The LLM returns operations, never a rewritten timesheet: `add`, `update`, `delete`, `split`, `merge`, `fill_gap`, `clarify`.
- Code validates them (no overlaps, inside the day), shows a diff, applies them, and keeps undo.
- Providers behind one interface: Anthropic, OpenAI, and **Ollama** (supports JSON-schema-constrained output) for a fully local mode.

---

# Round 2 (2026-10-18): any calendar, any agent, subscriptions, TUI

## 7. Calendars beyond Google

Findings that change round 1:
- **Microsoft 365**: since Nov 2025 the default consent policy no longer lets users approve `Calendars.Read` themselves, so an admin has to approve. Personal outlook.com isn't affected. (Third-party source: blog-en.topedia.com; check against learn.microsoft.com.)
- **Outlook published ICS** dropping ATTENDEE/ORGANIZER is a reported regression since ~May 2026, with no fix from Microsoft. Admins can also disable publishing.
- **Google Workspace** hides the secret iCal address unless the admin allows sharing full event details externally.
- Borrowing Microsoft's own Graph PowerShell client ID works technically but isn't a sound basis. Register a Clockout public client and accept `--client-id`.
- Unverified Google OAuth apps are capped at 100 users for the project's lifetime.

| Provider               | Best method                                                     | RSVP         | Friction       |
| ---------------------- | --------------------------------------------------------------- | ------------ | -------------- |
| Google personal        | Secret ICS URL                                                  | Yes          | Low            |
| Google Workspace       | ICS if allowed → OS store → OAuth                               | Yes          | Low–medium     |
| Outlook.com            | Graph device code (`/consumers`)                                | Yes          | Low            |
| M365 work              | macOS EventKit / Windows Outlook COM / Graph with admin consent | Yes          | High for Graph |
| iCloud, Fastmail, Zoho | CalDAV + app password (or EventKit)                             | Yes          | Medium         |
| Proton                 | Share-link ICS (paid)                                           | Probably not | Low            |
| Exchange on-prem       | EWS / Outlook COM / EventKit                                    | Yes          | Medium–high    |

**OS stores aggregate every account with no OAuth:** macOS EventKit (`EKParticipant.participantStatus`, `isCurrentUser`; full access on macOS 14+; permission goes to the terminal app; avoid icalBuddy on Sequoia), Windows classic Outlook COM (`ResponseStatus`), Linux khal/vdirsyncer folders.

**Unified calendar APIs** (Nylas, Cronofy, Unified.to, Composio) all need a vendor key on a server and cost $10–750/mo. They don't fit a free local tool.

## 8. More agents (checked locally where marked)

| Agent             | Path                                                                                                        | Format                     | Fields                                                                                         | Hooks / OTel                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Antigravity CLI ✓ | `~/.gemini/antigravity-cli/conversation_summaries.db`; `brain/<id>/.system_generated/logs/transcript.jsonl` | SQLite + JSONL             | `conversation_id, title, workspace_uris, last_modified_time, last_user_input_time, step_count` | Hooks in `~/.gemini/config/hooks.json`; no OTel             |
| Antigravity IDE ✓ | `~/.gemini/antigravity/conversations/*.pb`                                                                  | Opaque protobuf            | —                                                                                              | Use the CLI index above, which also lists IDE conversations |
| pi ✓              | `~/.pi/agent/sessions/--<cwd>--/<ts>_<uuid>.jsonl`                                                          | JSONL v3                   | header `id, timestamp, cwd`; entry `timestamp`                                                 | Extension events                                            |
| opencode ✓        | `~/.local/share/opencode/opencode.db`                                                                       | SQLite                     | `session_v2(directory, title, time_created, time_updated)`                                     | Plugin events                                               |
| Copilot CLI ✓     | `~/.copilot/session-store.db`                                                                               | SQLite + JSONL             | `sessions(cwd, repository, branch, summary, created_at, updated_at)`, `turns.timestamp`        | Hooks; OTel (`COPILOT_OTEL_ENABLED`)                        |
| Gemini CLI        | `~/.gemini/tmp/<hash>/chats/`                                                                               | JSON / JSONL (two formats) | message timestamps; cwd only via hash                                                          | Hooks; OTel                                                 |
| Goose             | `~/.local/share/goose/sessions/sessions.db`                                                                 | SQLite                     | `working_dir, created_at, updated_at`                                                          | OTel (unverified)                                           |
| Crush             | `<project>/.crush/crush.db` + `~/.local/share/crush/projects.json`                                          | SQLite                     | `sessions(title, created_at, updated_at)`                                                      | —                                                           |
| Amp               | `~/.local/share/amp/threads/*.json`; `amp threads export`                                                   | JSON                       | timestamps; no cwd                                                                             | —                                                           |
| Kiro              | several stores across versions                                                                              | Mixed                      | `title, workspacePaths, timestamp`                                                             | CLI hooks                                                   |

Good reference for 40+ agents' paths and schemas: getagentseal/codeburn `docs/providers`.

**No universal session-log format yet.** OpenTelemetry GenAI conventions are still in development (Copilot CLI and Gemini CLI emit them); ATIF is used for benchmarks; Agent Trace covers code attribution, not sessions. So: native readers + a generic JSONL that hooks can append to + optional OTLP receiver.

## 9. Using existing AI subscriptions instead of API keys

Checked locally with `--help`: claude 2.1.302, codex 0.155, agy 1.3.5, opencode 2.0.29, pi 1.2.0, copilot 1.0.83.

| Backend                       | Invocation                                                                           | Structured output | Policy                                                                                                                                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------ | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code                   | `claude -p --output-format json --json-schema … --tools ""`                          | Enforced          | Shelling out to the user's own unmodified `claude` is allowed. Using the Agent SDK or the user's token on a subscription is **not** allowed for third-party developers. Don't use `--bare` (reads only `ANTHROPIC_API_KEY`). |
| Codex                         | `codex exec --output-schema … -s read-only --ephemeral` (or warm `codex app-server`) | Enforced          | Allowed                                                                                                                                                                                                                      |
| OpenAI "Sign in with ChatGPT" | App's own OAuth + Responses API                                                      | Enforced          | Officially supported for open-source local apps (preview, Plus/Pro)                                                                                                                                                          |
| Antigravity                   | `agy -p --output-format json --json-schema … --mode plan`                            | Enforced          | Grey: terms forbid use "in connection with products not provided by us"; Google has banned accounts for third-party OAuth use. Opt-in only.                                                                                  |
| Gemini CLI                    | —                                                                                    | —                 | No longer serves personal accounts since 18 Jun 2026 (replaced by Antigravity CLI); API key / Vertex only                                                                                                                    |
| Copilot                       | `copilot -p … --output-format json` or `@github/copilot-sdk`                         | Prompted          | Allowed; uses premium requests                                                                                                                                                                                               |
| opencode / pi                 | `opencode run --format json` / `pi -p --mode json --no-tools`                        | Prompted          | Depends on configured provider; never route Anthropic Pro/Max OAuth through them                                                                                                                                             |
| Ollama / LM Studio            | localhost HTTP                                                                       | Enforced          | Free, private                                                                                                                                                                                                                |

Sources: code.claude.com/docs/en/legal-and-compliance (wording checked); developers.openai.com/siwc/token-sharing-open-source; antigravity.google/terms; developers.googleblog.com (Gemini CLI transition).

**ACP (Agent Client Protocol)** is supported by many agents but isn't a good single interface here: it's an editor↔agent session protocol with no schema output, needs extra adapters, and the Claude adapter is built on the Agent SDK.

**MCP mode** (Clockout runs inside the user's agent) has the cleanest policy story and fits voice corrections well, but can't run unattended and uses the agent's context. Ship it alongside the CLI backends. MCP sampling isn't supported by Claude Code yet.

## 10. TUI vs web

| Framework                           | `npx` on plain Node?                                      | Fit                                              |
| ----------------------------------- | --------------------------------------------------------- | ------------------------------------------------ |
| **Ink 8** (Claude Code, Gemini CLI) | Yes, Node ≥ 22                                            | High: React + TS; `usePaste` for bracketed paste |
| OpenTUI (opencode)                  | No: Bun ≥ 1.3.14 or Node ≥ 26.4 with `--experimental-ffi` | Best widgets, but breaks `npx`                   |
| Bubble Tea / Ratatui / Textual      | Needs Go/Rust binaries or Python                          | Language switch                                  |
- **Wispr Flow** pastes into Terminal.app and iTerm2 (Accessibility permission), Warp, Ghostty, kitty, Alacritty, and the VS Code / Cursor terminals. Not over SSH or in WSL (use "paste last transcript"). Past breakages were in how the app handled pastes (Claude Code 2.1.83, fixed later), so use bracketed paste and never auto-submit on a newline.
- **Competitor UX**: Timely AutoSheet's daily draft → review → submit with an evidence view is the closest flow. Timeline tools (Timing, Toggl) need a GUI because editing is drag-and-resize, which voice replaces.
- **Demo**: VHS for GIFs; asciinema for playback on a web page; ttyd for a live hosted TUI.
