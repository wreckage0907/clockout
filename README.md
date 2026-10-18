# Clockout

Turns your day (Claude Code sessions, GitHub PRs and reviews, and calendar meetings) into a ready-to-paste timesheet. You fix it by voice: dictate "the gap after lunch was lunch, I skipped the design sync" and Clockout proposes the edits.

The AI work runs on the Claude Code subscription you already have. No API key needed, and it still works with no AI at all.

Built for the **#NoHandsChallenge** (WeMakeDevs × Wispr Flow).

```
clockout · Fri, Oct 16 · DRAFT                    6.25h · 4 questions · AI: Claude Code (haiku)
▓▓▓▓███████████████░░░░░░░░███████████████████░███░░░▓▓▓▓???░░░░░░░░░░░░░░░░░░░░░░░░░░░░░█
    #    TIME        DUR   HOURS  PROJECT               SUMMARY
    b1   09:30–10:00 0h30  0.50h  Meetings              Daily standup
    b2   10:00–12:15 2h15  2.25h  Acme API              Fix auth token refresh race (PR #87)
  ░      12:15–14:00 1h45                               ── gap ──
    b3   14:00–16:33 2h33  2.50h  dev-example/clockout  Add CSV export command (PR #48)
  ? b4   15:00–15:30 0h30         Meetings              Design sync
╭ Say it ───────────────────────────────────────────────────────────────────────────────────╮
│ › I skipped the design sync, and the gap after lunch was just lunch                       │
╰───────────────────────────────────────────────────────────────────────────────────────────╯
```

> Status: MVP. Not yet on npm; run it from a clone (below).

## Try it

```sh
git clone https://github.com/wreckage0907/clockout && cd clockout
corepack enable && pnpm install && pnpm build
node dist/cli.js demo          # a made-up day, no setup needed
```

## Use it on your own day

```sh
node dist/cli.js init          # finds Claude Code and your gh login, asks for your calendar link
node dist/cli.js               # review today
```

`init` writes `~/.config/clockout/config.toml`. It needs:

- **Claude Code** sessions in `~/.claude/projects` (found automatically).
- **GitHub**: `gh auth login`, or a `GITHUB_TOKEN`.
- **Google Calendar** (optional): Settings → your calendar → Integrate calendar → **Secret address in iCal format**. It includes your RSVPs, so declined meetings drop out and unanswered ones become questions.

## The review screen

| Key | Does |
|---|---|
| type or dictate, then **Enter** | Send a correction in plain words |
| **y** / **n** | Apply or discard the proposed changes |
| **↑ ↓** | Select a block or gap; its evidence shows on the right |
| **c** / **m** | Copy the timesheet (tab-separated, or Markdown) |
| **u** | Undo the last correction |
| **[** / **]** | Previous / next day |
| **q** | Quit |

Single-key shortcuts work when the input is empty. Dictated text arrives as one paste, so a line break never sends it early.

Things you can say:

- "the gap after lunch was lunch"
- "I skipped the design sync, but I was at the Acme call"
- "block 2 was two hours"
- "add 30 minutes reviewing Sam's PR on acme"
- "put the standup under Acme API, task Meetings"

## Commands

```sh
clockout                       # review today (also: yesterday, day 2026-10-16, day -2)
clockout today --plain         # print instead of opening the review screen
clockout edit "the gap was lunch" [--date yesterday] [--dry-run]
clockout undo [--date yesterday]
clockout export [date] --format csv|md|tsv|json [--out file] [--from DATE --to DATE]
clockout demo
```

`--no-ai` uses session, PR and meeting titles instead of AI summaries.

The timesheet has one row per piece of work: **date, project, task, hours, description**. Hours are rounded to 15 minutes. Unconfirmed meetings and breaks are left out.

## Config

```toml
[me]
name = "Ada"
emails = ["ada@company.com"]         # finds your RSVP in calendar invites
timezone = "Asia/Kolkata"

[day]
working_hours = "09:30-18:30"        # gaps are only flagged inside these
idle_cutoff = "20m"                  # a pause longer than this ends a block
round_to = "15m"

[tasks]                              # task names for your timesheet
work = "Development"
review = "Code Review"
meeting = "Meetings"

[ai]
backend = "auto"                     # auto | claude-code | none
model = "haiku"

[[sources]]
type = "claude-code"

[[sources]]
type = "github"

[[sources]]
type = "calendar"
method = "ics"
url = "https://calendar.google.com/calendar/ical/…/basic.ics"

[[projects]]                         # map repos, titles or attendees to your timesheet's project names
name = "Acme API"
task = "Backend"
match = { repo = "acme/api", title = "(?i)acme", attendee_domain = "acme.com" }
```

## How time is counted

- Time comes from what **you** did: prompts, PRs, review comments and meetings. A prompt counts until the agent's reply is read, so an agent running unattended for an hour doesn't become an hour of your time.
- Pauses shorter than `idle_cutoff` are bridged. When two sessions overlap, the time goes to the one you touched last.
- Accepted meetings take their time from work. Tentative and unanswered ones wait for you to confirm; declined ones are left out with a note.

## Privacy

- Everything is read and stored on your machine (`~/.local/share/clockout`). No telemetry.
- The AI sees session titles, branch names, PR titles and meeting names, never your prompts or code.
- Clockout runs your own `claude` binary with tools off and never reads your credentials.
- The config file is readable only by you; it holds your private calendar address.

## Development

Coding agents and contributors: start with [AGENTS.md](AGENTS.md).

```sh
pnpm install
pnpm exec lefthook install
pnpm check               # lint, typecheck, build, test, publint
```

- [Spec](docs/spec.md) · [Plan](docs/plan.md) · [Decisions](docs/adr/) · [Research](docs/research.md)

## License

MIT
