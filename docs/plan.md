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
- [x] Slash commands in the chat bar: a menu on `/`, `/refresh`, `/connect`, `/disconnect`, `/send`, `/copy`, `/undo`, `/add`, `/today`, `/yesterday`, `/date`, `/setup`, `/help`; never sent to the AI
- [ ] An `ignore` project rule (from the review of the personal-project case)
- [x] ERP in Setup: sign in by address, who you are, task mappings (forget one), sign out
- [x] GitHub: issues opened, comments on issues and PRs, reading time before a review, trying out a reviewed PR counts as reviewing it, plain review wording on cards
- [ ] Description style settings (format, length, instructions, examples)

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

## Day 11 — Export and demo

- [x] Clipboard, Markdown, CSV, TSV, JSON: date, project, task, hours, description (same work merged into one row)
- [x] ~~`--demo` on bundled fixtures~~ (removed — not needed in the app)
- [x] README: install, quick start, config, privacy

## Day 12 — Publish (milestone)

- [x] npm trusted publishing workflow on version tags (needs one-time setup on npmjs.com)
- [ ] `clockout-cli@0.1.0` published

## Day 13–14 — Submission

- [ ] VHS demo GIF, demo video
- [ ] Repo public, final #NoHandsChallenge post
