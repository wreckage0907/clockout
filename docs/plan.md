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
- [x] Bracketed paste (`usePaste`); newlines never auto-submit
- [x] Proposed changes shown as a diff; `y` / `n` / `u`
- [ ] Wispr tested in Terminal, iTerm2, Ghostty, VS Code terminal (needs a human: manual test)

## Day 11 — Export and demo

- [ ] Clipboard, Markdown, CSV: date, project, task, hours, description
- [ ] `--demo` on bundled fixtures
- [ ] README: install, quick start, config, privacy

## Day 12 — Publish (milestone)

- [ ] npm trusted publishing workflow on version tags
- [ ] `clockout-cli@0.1.0` published
- [ ] Generate real timesheets for the build

## Day 13–14 — Submission

- [ ] VHS demo GIF, demo video
- [ ] Repo public, final #NoHandsChallenge post
