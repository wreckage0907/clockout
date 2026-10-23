# Clockout

Turns your day (Claude Code, Pi, Codex, opencode and Antigravity sessions, GitHub PRs, reviews, issues and comments, and calendar meetings) into a ready-to-paste timesheet. You fix it by voice: dictate "the gap after lunch was lunch, I skipped the design sync" and Clockout proposes the edits.

The AI work runs on the Claude Code subscription you already have. No API key needed, and it still works with no AI at all.

Built for the **#NoHandsChallenge** (WeMakeDevs × Wispr Flow).

```
  ◷ clockout · Fri, Oct 16 · draft · 5.75h · 5 questions · AI: Claude Code (haiku)
  ▍  09:30–10:00 Meetings            Daily standup                          0h30
      10:00–12:15 Acme API            Fix auth token refresh race (PR #87)   2h15
      12:15–14:00 Nothing recorded 12:15–14:00. Lunch, a break, or work?
      14:00–16:33 dev-example/clockout Build CSV export command (PR #48)     2h33
    ? 15:00–15:30 Meetings            Design sync                            0h30
      Did you attend "Design sync" (15:00–15:30)? You replied maybe.
  ▏ Say it, or / for commands
  ▏ skipped the design sync, and the gap after lunch was lunch
```

Type or dictate a correction, Clockout proposes the edits, you press y. `/` opens the command menu (pick a day, copy, undo); gaps and unanswered questions are shown as plain questions, not decoration.

> Status: MVP. Not yet on npm; run it from a clone (below).

## Try it

```sh
git clone https://github.com/wreckage0907/clockout && cd clockout
corepack enable && pnpm install && pnpm build
node dist/cli.js init
```

## Use it on your own day

```sh
node dist/cli.js init          # finds your coding agents and gh login, asks for your calendar link
node dist/cli.js               # review today
```

`init` writes `~/.config/clockout/config.toml`. It uses:

- **Claude Code** sessions in `~/.claude/projects` (found automatically).
- **Pi** sessions in `~/.pi/agent/sessions` and **Codex** sessions in `~/.codex/sessions` (found automatically; `PI_CODING_AGENT_DIR` and `CODEX_HOME` are respected).
- **opencode** sessions in `~/.local/share/opencode/opencode.db` (opencode 2; `XDG_DATA_HOME` is respected) and **Antigravity** CLI conversations in `~/.gemini/antigravity-cli` (the IDE's own conversations can't be read). Both need Node 22.13 or later.
- **GitHub**: `gh auth login`, or a `GITHUB_TOKEN`.
- **Google Calendar**: sign in once with `clockout connect google` (read-only). It reads your RSVPs, so declined meetings drop out and unanswered ones become questions. First time only: [create a Google sign-in client](docs/google-setup.md) (5 minutes).
- Or any calendar's private ICS address, if your account allows one.

## The review screen

`clockout` opens on today: the logo standing on the day's hours (each project fills its share of the band towards your daily target), the total (`5h 45m of 8h`), and the chat bar. Press **Enter** to open the day as cards, one per timesheet row: what it was, the project and task, where the time came from, and how long, in a big box you can click and type over. Meetings you haven't confirmed come as cards with **Attended** / **Skipped**; a dashed card adds time nothing recorded. Everything is clickable; the keyboard does it all too.

| Key | Does |
|---|---|
| type or dictate, then **Enter** | Send a correction in plain words; review the proposed change, then **Enter** applies, **Esc** goes back to your words |
| **/** | Commands, without the AI: `/refresh`, `/connect erp <address>` or `google`, `/disconnect`, `/send`, `/copy [md\|csv]`, `/undo`, `/add`, `/today`, `/yesterday`, `/date monday` (or `-3`, `2026-10-16`), `/setup [section]`, `/help`. The menu narrows as you type; **↑ ↓** choose, **Tab** fills in, **Enter** runs. Saying "slash refresh" works too |
| **↑ ↓** | Select a card |
| **Enter** on a card | Type its length: `1h 45`, `1:45`, `1.75`, `45m` (or type it into the chat bar) |
| **-** / **+** | Shorten or lengthen the selected card by your rounding step |
| **Ctrl+D** (or the card's **✕**) | Take the selected card off the day (Ctrl+Z brings it back) |
| **Ctrl+T** (or the card's **→ task**) | Pick which ERP task the selected card goes to. The first pick for a project is for all its cards; after that, a different pick is for this card only |
| **Ctrl+Y** (or **Copy sheet**) | Copy the timesheet, tab-separated, once no meeting is waiting |
| **Ctrl+S** (or **Send to ERP**) | Send the day to your ERP: shows what would be added, updated or removed first; **Enter** sends |
| **Ctrl+Z** | Undo |
| **Ctrl+P** (or **Setup**) | Setup, in sections: **Sources** (Claude Code and which of its projects, Pi, Codex, opencode, Antigravity, Google Calendar, GitHub), **Day** (daily target, working hours, rounding, idle cutoff), **AI helper**, **Projects** (task names and project rules), **ERP** (sign in, which task each project goes to). Arrow keys or the mouse |
| click the date | Pick another day; **PgUp** / **PgDn** step a day |
| **Esc** | Back home · **Ctrl+C** quits |

A length you set counts exactly that on the timesheet; nothing else moves. Dictated text arrives as one paste, so a line break never sends it early.

Things you can say:

- "the gap after lunch was lunch"
- "I skipped the design sync, but I was at the Acme call"
- "the standup ran to 45 minutes"
- "add 30 minutes reviewing Sam's PR on acme"
- "put the standup under Acme API, task Meetings"

Setup works the same way: say what to change, check the proposal, press Enter.

- "connect my ERP at erp.example.com" (signs in in your browser)
- "stop reading my personal project" · "turn off GitHub"
- "my target is seven and a half hours, round to 30 minutes"
- "send acme api to the hackathon task"
- paste your calendar's private ICS link: it's read on this machine and never sent to the AI

## Commands

```sh
clockout                       # review today (also: yesterday, day 2026-10-16, day -2)
clockout today --plain         # print instead of opening the review screen
clockout edit "the gap was lunch" [--date yesterday] [--dry-run]
clockout undo [--date yesterday]
clockout export [date] --format csv|md|tsv|json [--out file] [--from DATE --to DATE]
clockout push [date] [--dry-run] [--yes]   # send the day to your ERP timesheet
clockout connect google        # sign in once; disconnect google to revoke
clockout connect erp https://erp.example.com   # sign in to your ERP; disconnect erp to revoke
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
target = "8h"                        # the hours you aim to log; the bar fills towards it

[tasks]                              # task names for your timesheet
work = "Development"
review = "Code Review"
meeting = "Meetings"

[ai]
backend = "auto"                     # auto | claude-code | none
model = "haiku"

[[sources]]
type = "claude-code"
# exclude = ["-Users-ada-personal"]   # project folders to leave out (Setup writes this)

[[sources]]
type = "github"

[[sources]]
type = "google-calendar"             # added by `clockout connect google`
calendars = ["primary"]

[google]                             # your sign-in client: docs/google-setup.md
client_id = "…apps.googleusercontent.com"
client_secret = "GOCSPX-…"

[[projects]]                         # map repos, titles or attendees to your timesheet's project names
name = "Acme API"
task = "Backend"
match = { repo = "acme/api", title = "(?i)acme", attendee_domain = "acme.com" }

[timesheet]                          # where `push` / ctrl+s sends the day; added by `clockout connect erp`
type = "next-pms"                    # Frappe/ERPNext with rtCamp's next-pms
url = "https://erp.example.com"

[[timesheet.map]]                    # which ERP task a project's rows go to (picked once in the app)
project = "Acme API"
# task = "Code Review"               # only rows with this task; leave out for the whole project
erp_task = "TASK-2026-00088"
label = "API maintenance"
```

## Sending to your ERP

Instead of pasting rows, send the day straight into your timesheet. Supported now: Frappe/ERPNext sites running [next-pms](https://github.com/rtCamp/next-pms).

1. `clockout connect erp https://erp.example.com` signs you in through the browser (OAuth; no password or API key is stored). The site's OAuth Settings must allow dynamic client registration.
2. In the review screen press **Ctrl+S**. The first time a project is sent, pick its ERP task from a searchable list; it's remembered. To send one card somewhere else (two kinds of work in the same project), select it and press **Ctrl+T**.
3. Clockout reads what's already logged for that day and shows the plan: `+` add, `~` update, `−` remove, `=` already sent, `!` can't (approved week, rejected entry), `·` added in the ERP by hand. **Enter** sends.

Sending again only changes what changed. Entries you added in the ERP yourself are never touched, and approval stays in the ERP. From scripts: `clockout push yesterday --dry-run`, then `--yes`.

## How time is counted

- Time comes from what **you** did: prompts, PRs, review comments and meetings. A prompt counts until the agent's reply is read, so an agent running unattended for an hour doesn't become an hour of your time.
- Pauses shorter than `idle_cutoff` are bridged. When two sessions overlap, the time goes to the one you touched last.
- Accepted meetings take their time from work. Tentative and unanswered ones wait for you to confirm; declined ones are left out with a note. Blocks on your own calendar with no guests (lunch, gym, focus time) are asked about, not billed. If two accepted meetings overlap, only the first counts until you say otherwise.
- Corrections stick: when you open a corrected day again, new activity is added under your corrections.

## Privacy

- Everything is read and stored on your machine (`~/.local/share/clockout`). No telemetry.
- The AI sees session titles, branch names, PR titles and meeting names, never your prompts or code.
- Clockout runs your own `claude` binary with tools off and never reads your credentials.
- The config and the sign-ins (`credentials.json`: Google, ERP) are readable only by you. Calendar access is read-only.
- Your ERP gets only what you send: date, task, hours and description per row, when you confirm.

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
