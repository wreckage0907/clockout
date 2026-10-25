# MVP plan

Personal MVP: Claude Code + GitHub + Google Calendar (private ICS link) → draft the day → correct by voice in the TUI → export **date, project, task, hours, description**. Target: `clockout-cli@0.1.0` on npm by day 12.

Tick items as they land. Each day ends with `pnpm check` passing.

## Day 1 — Scaffold

- [x] Toolchain: pnpm 11, TypeScript 7, tsdown, vitest, Biome, lefthook
- [x] `clockout --version` builds and runs; e2e test
- [x] AGENTS.md, `.claude/settings.json` + format hook, `add-source` skill
- [x] ADRs 0001–0004
- [x] CI workflow (Node 22/24 × macOS/Ubuntu)
- [x] `src/core/types.ts`: `Activity`, `Block`, `Day`, `Question`, `EditOp`
- [x] `src/sources/types.ts`: `Source` interface + registry
- [x] Config: zod schema, TOML load/save, XDG paths
- [x] `clockout init`: detect `~/.claude/projects` and `gh` login; ask ICS link, email, time zone, working hours
- [x] Synthetic fixtures: one Claude Code day, GitHub responses, an ICS file

## Day 2 — Claude Code source

- [x] Read `~/.claude/projects/*/*.jsonl` for a date range
- [x] `user` prompts (not tool results) → human activity; `assistant` → agent activity
- [x] Title from the last `ai-title`; `cwd` and `gitBranch` from events
- [x] Skip `isSidechain` and `isMeta` lines; count and skip malformed lines
- [x] Fixture tests incl. a session crossing midnight

## Day 3 — GitHub source

- [x] Token from `gh auth token`, falling back to `GITHUB_TOKEN`
- [x] GraphQL `contributionsCollection`: PRs opened, reviews, review comments (commit times need local git: later)
- [x] Repo → project via git remote
- [x] Fixture tests from recorded-shape responses

## Day 4 — Google Calendar source

- [x] Fetch the ICS link; expand recurring events for the range
- [x] Own RSVP from `ATTENDEE;PARTSTAT` matched against configured emails
- [x] Skip all-day and cancelled events (declined are kept so core can drop them visibly)
- [x] Fixture tests

- [x] Google Calendar API: `clockout connect google` (sign in once, read-only, loopback + PKCE), RSVP from the `self` attendee; Workspace accounts often block the secret ICS address
- [x] Create Clockout's Google OAuth client (needs the owner's Google account: docs/google-setup.md)

## Day 5–6 — First real draft (milestone)

- [x] Project resolution: config rules → git remote → repo root → cwd; ticket keys from branches
- [x] Blocks from human activity; idle cutoff; rounding; calendar wins on overlap
- [x] Gaps inside working hours
- [x] Attendance questions (tentative / no response / coding during a meeting)
- [x] Task rules (meeting → "Meetings", review → "Code Review", default per project)
- [x] Heuristic summaries
- [x] JSON store for days and corrections
- [x] `clockout today | yesterday | --from --to` with `--md` and `--json`

## Day 7 — Claude summaries

- [x] `LlmBackend` interface
- [x] `claude -p --output-format json --json-schema … --tools ""`, no session persistence, empty temp dir
- [x] Whole day in one call; zod validation; one retry; heuristic fallback; summaries cached per block

## Day 8 — Corrections (milestone)

- [x] Edit operations: add, update, delete, split, merge, fill_gap, clarify
- [x] Validation (no overlaps, inside the day), diff, apply, undo
- [x] `clockout edit "<sentence>"` (with --dry-run) and `clockout undo`

## Day 9–10 — Review screen (milestone)

- [x] Ink TUI: timeline, block table, questions, evidence, "say it" bar
- [x] Calm review screen (2025 redesign): no timeline strip or shortcut dump — block list, questions/evidence under their rows, `/` command menu and khal-style day picker in the input
- [x] Bracketed paste (`usePaste`); newlines never auto-submit
- [x] Proposed changes shown as a diff; `y` / `n` / `u`

## Redesign — home, day cards, setup

- [x] Prototype on the fixture day: logo on the hours bar, chat bar with a clickable date picker, one card per timesheet row with a big editable duration, setup dialog (ctrl+p) with tickable sources
- [x] Mouse support ([ADR 0005](adr/0005-clickable-tui.md))
- [x] Port into the real review screen: hours you set override computed hours (core + export), daily target in config, setup writes the config; `src/prototypes/` deleted
- [x] Update the spec's review screen section

## Send to the ERP

- [x] ADR 0006: next-pms's REST methods over OAuth, not MCP
- [x] `clockout connect erp <url>` / `disconnect erp`: Frappe OAuth (discovery, dynamic registration, PKCE, loopback, refresh-token rotation)
- [x] next-pms target: read a day's entries (locks for approved / rejected / approved week), search tasks, create / update / delete; readable Frappe errors
- [x] `core/push`: plan (create / update / same / delete / blocked / unmapped / theirs), record of sent entries kept with the day
- [x] `clockout push [date] --dry-run --yes`, task picker in the terminal
- [x] Review screen: ctrl+s / **Send to ERP**, task picker, plan panel, Enter sends
- [x] Tested live against a local next-pms site (sign-in, send, update, hand-added entries, disconnect)
- [x] Remove a card by hand (✕ / ctrl+d; typed keys go to the chat bar, so not `d`)
- [x] Slash commands in the chat bar: a menu on `/`, `/refresh`, `/connect`, `/disconnect`, `/send`, `/copy`, `/undo`, `/add`, `/today`, `/yesterday`, `/date`, `/setup`, `/help`, `/quit` (`/exit`); never sent to the AI
- [x] An `ignore` project rule (from the review of the personal-project case): by name or by match, every source, meetings too; "leave out my dotfiles" in the chat bar
- [x] ERP in Setup: sign in by address, who you are, task mappings (forget one), sign out
- [x] GitHub: issues opened, comments on issues and PRs, reading time before a review, trying out a reviewed PR counts as reviewing it, plain review wording on cards
- [x] Description style settings (format, length, instructions, examples): `[descriptions]`, Setup's AI helper section, or said in the chat bar
- [x] Description prompt: a page in Setup's AI helper section to type or dictate how descriptions should read (up to 2000 characters)

## Bulk review

- [x] Card checkboxes, Space to toggle, Shift-click / Shift+↑↓ ranges, and a selection toolbar
- [x] Copy selected rows, remove selected cards in one undoable edit, and map selected cards to one ERP task without changing project defaults
- [x] Shift-click anywhere on a card ticks it, and terminals that keep Shift-click for selection (Ghostty, xterm) pass it through
- [x] Option-click does the same, for multiplexers (herdr) that never pass Shift-clicks on

## Setup by chat

- [x] ADR 0007: settings through the chat bar, one AI call, settings summary only
- [x] Settings operations (sources, Claude Code projects, day numbers, time zone, task names, AI, project rules, connect / disconnect, ERP task), applied and validated like config.toml
- [x] Private calendar links and tokens never reach the AI; plain connect / disconnect without it
- [x] Review screen: settings proposals, sign-ins from the app, ERP task search and picker, last turns for follow-ups

## More agents, better setup

- [x] Pi source: `~/.pi/agent/sessions` (prompts and `!` commands, assistant turns, session names)
- [x] Codex source: `~/.codex/sessions` rollouts (`user_message` prompts, model output, git info; subagents skipped)
- [x] opencode source: `opencode.db` (opencode 2 `session_v2` / `session_message`; subagents skipped) via `node:sqlite` ([ADR 0008](adr/0008-read-agent-sqlite-with-node-sqlite.md))
- [x] Antigravity source: the CLI's `brain/<id>` transcripts, titles and folders from `conversation_summaries.db`; the IDE's protobuf conversations aren't read
- [x] Setup palette: sections on the left (Sources, Day, AI, ERP), the chosen one's settings on the right; keyboard and mouse; nothing hidden under "More"

## Ready for other people

- [x] Evaluation without your own setup: no `claude`, a logged-out `claude`, no sources, no config
- [x] Choosing the AI helper never fails; without one the review screen says so (toast, chat-bar hint, why on typing) and commands print a note
- [x] AI helpers: Codex (`codex exec`, strict schema, read-only sandbox), opencode (agent with every tool denied, session deleted), Pi (`pi -p --no-tools`); `auto` order Claude Code → Codex → opencode → Pi; Setup and init list what's installed. Antigravity can't be one (spec §6)
- [x] Helper failures in the CLI's own words with how to sign in, never the command line
- [x] GitHub and Google sign-in failures: what's wrong and how to fix it, `/problems`, local error log with tokens redacted

## Projects by hand

- [x] A project can be only a name (`[[projects]] name = "…"`, optional `task`): one you log time to by hand
- [x] Add time: + New project (typed, saved to config), and projects from other days, ERP mappings and the ERP's tasks
- [x] Setup → Projects: Add project field, ✕ remove; "add a project called …" in the chat bar

## Production readiness pass

- [x] CLI: Node version check before loading, real dates only, no future days, readable file and saved-day errors, typo suggestions, export range fixes
- [x] Sources: side-by-side sessions share their time, prompts Claude Code sends itself don't count, missing folders and unreadable opencode databases warn and keep saved time, deleted repo folders keep their repo, calendar feed checks
- [x] Safety: control characters stripped from titles, spreadsheet formulas neutralised in CSV/TSV, AI answers checked (fit the day, no tokens) before they're shown, helper errors redacted on screen
- [x] Helpers run in their own process group and are stopped on timeout and on quit; the terminal is restored on SIGTERM/SIGHUP; a too-small window says so
- [x] ERP: https before sign-in, old refresh tokens revoked, reconnect on 403, next-pms missing named, days over 24h not sent, an unconfirmed send says so

## Tests that run it like a user

- [x] End-to-end workflow: a day from every local source, the calendar and a fake GitHub drafted with `--json`, saved, and exported from what was saved, in every format and as a range
- [x] CLI contract: exit code, stdout and stderr checked separately for bad options, dates, formats, conflicting arguments, typos, unwritable files, broken configs and a damaged saved day
- [x] Generic `http` timesheet target: a five-request JSON API any PMS can answer ([timesheet-api.md](timesheet-api.md)), token from an environment variable
- [x] Mock PMS (`pnpm mock-pms`, `test/mock-pms/`) with a real system's rules; `clockout push` against it: dry run, send, nothing twice, entries deleted or changed there, approved entries, a closed week, an unknown task, a wrong or missing token, the PMS down
- [x] Package smoke test in CI: the packed tarball installed globally runs as `clockout`
- [x] Interactive tests in a pseudo-terminal (`test/tty/`): Ink start-up, keys, a paste that doesn't submit, resizing to too small and back, Ctrl+C and SIGTERM/SIGHUP leaving the terminal as it was, Ctrl+C while an AI helper hangs (helper stopped), sending to the mock PMS with Ctrl+S

## Day 11 — Export and demo

- [x] Clipboard, Markdown, CSV, TSV, JSON: date, project, task, hours, description (same work merged into one row)
- [x] ~~`--demo` on bundled fixtures~~ (removed — not needed in the app)
- [x] README: install, quick start, config, privacy

## Before release, day 1 (2026-10-25) — config and MCP

[ADR 0009](adr/0009-change-clockout-through-config.md): what people change to fit their own timesheet is config the AI can propose, never code. [ADR 0010](adr/0010-mcp-as-source-and-destination.md): MCP servers as a source and as a destination. Both ship in stages: see ADR 0009's Rollout.

- [x] Accept ADR 0009 (in two stages) and ADR 0010
- [ ] MCP client (`src/mcp/`): streamable HTTP, `initialize`, `tools/list`, `tools/call`, answers from `structuredContent` or JSON text, `isError` as that system's error
- [ ] MCP sign-in: protected-resource metadata, authorization-server discovery, dynamic registration, PKCE + loopback, refresh; next-pms's discovery made general without changing how it signs in; `[[mcp]]` servers, `clockout connect <name>` / `disconnect <name>`
- [ ] Mock MCP server (`test/mock-mcp/`): OAuth with registration, meeting tools, a note-writing tool
- [ ] `[[exports]]`: named formats (csv, tsv, markdown, json, text), columns with headers and formats (dates, hours as decimal / h:mm / minutes), merge, text line templates; built-ins unchanged, formula guard kept
- [ ] Use them: `export --format <name>`, `/copy <name>`, a default for Ctrl+Y; README
- [ ] Settings operations for exports ("add a Harvest export with hours as h:mm"), shown in the AI's settings summary

## Before release, day 2 (2026-10-26) — standups, Wispr Flow, destinations

- [ ] Standups: `clockout standup [date]` and `/standup`. Yesterday from the previous working day's saved day (Friday on a Monday); today from today's calendar and unfinished work (open PRs, review requests, branches without a merged PR); blockers only from what you say, never guessed. Copied to the clipboard; can go to an export destination
- [ ] `[standup]` style (format, length, instructions, examples) like `[descriptions]`: Setup's AI helper section and the chat bar. One AI call with titles and summaries only; a plain template without an AI helper
- [ ] Wispr Flow source (ADR 0010): `clockout connect wispr`, recorded meetings for the range, a recording counts as attended for its recorded length, merged with its calendar event in core, summaries on screen only (never to the AI or an export); tests against the mock MCP server
- [ ] Export destinations (ADR 0010): `to = { file, append }` (an Obsidian daily note, written directly) and `to = { mcp, tool, arguments }`; preview, then confirm; file paths never from the AI
- [ ] `type = "command"` target and export: JSON over stdin/stdout, no shell, timeout, own process group; set by hand or on the command line only, refused from the chat bar; how to use it with a local stdio MCP server
- [ ] Spec, README and Setup for all of the above

## Day 12 — Publish (milestone)

- [x] npm trusted publishing workflow on version tags (needs one-time setup on npmjs.com)
- [ ] `clockout-cli@0.1.0` published

## Day 13–14 — Submission

- [ ] VHS demo GIF, demo video
- [ ] Repo public, final #NoHandsChallenge post

## After release

The rest of ADR 0009 (see its Rollout). The MCP client and sign-in are already in from day 1.

- [ ] `type = "api"` timesheet target: the five operations mapped onto any API's requests (paths, body templates, dotted paths into answers, hours units, auth pattern); the `http` target as one fixed mapping; tests against the mock PMS with a different API shape
- [ ] Settings operations for the mapping, drafted from pasted API docs; token and other header values never in the summary
- [ ] `type = "mcp"` timesheet target: the five operations mapped onto a server's tools, preview-then-confirm writes; a mock MCP server with the mock PMS's rules
- [ ] Settings operations for the MCP mapping, drafted from the server's `tools/list`; only mapped tools are ever called
