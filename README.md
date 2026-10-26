<p align="center">
  <img src="docs/images/banner.png" alt="Clockout — your day, already accounted for">
</p>

<p align="center">
  <img alt="Node 22.12+" src="https://img.shields.io/badge/Node-22.12%2B-6ee7b7?style=flat-square">
  <img alt="TypeScript 7" src="https://img.shields.io/badge/TypeScript-7-a78bfa?style=flat-square">
  <img alt="License MIT" src="https://img.shields.io/badge/license-MIT-green?style=flat-square">
</p>

<p align="center">
  <samp>
    Turn coding-agent sessions, GitHub activity and calendar events into a timesheet.<br>
    Correct it by voice, then copy it or send it straight to your ERP.
  </samp>
</p>

<samp>

> The evidence of your work already exists. Clockout joins it into a day you can approve,
> instead of asking you to reconstruct the day from memory.

</samp>

<br>

# ✨ Features

<table>
  <tr>
    <td width="50%" valign="top"><samp>
      <b>Your tools become one workday</b>
      <br><br>
      Reads Claude Code, Codex, Pi, opencode and Antigravity sessions, GitHub pull requests,
      reviews, issues and comments, Google Calendar or an ICS feed, and the meetings you
      recorded with Wispr Flow.
    </samp></td>
    <td width="50%" valign="top"><samp>
      <b>Counts your time, not agent runtime</b>
      <br><br>
      Blocks grow from prompts, pull requests, reviews and meetings. Short pauses are bridged,
      overlapping sessions resolve to the one you touched last, and calendar time wins.
    </samp></td>
  </tr>
  <tr>
    <td width="50%" valign="top"><samp>
      <b>Say the correction. Approve the diff.</b>
      <br><br>
      Type or dictate “the gap after lunch was lunch” or “I skipped the design sync.”
      Clockout proposes validated edits; Enter applies them and Ctrl+Z brings the old day back.
    </samp></td>
    <td width="50%" valign="top"><samp>
      <b>A review screen built for finishing</b>
      <br><br>
      Edit a card's duration, answer meeting attendance, add missing time or remove a row.
      Every action works from the keyboard or mouse, with slash commands for AI-free control.
    </samp></td>
  </tr>
  <tr>
    <td width="50%" valign="top"><samp>
      <b>Rows that fit the form</b>
      <br><br>
      Export date, project, task, hours and description as Markdown, CSV, TSV or JSON, or in
      your own named formats. Copy a day to the clipboard, print one day, or export a date range from scripts.
    </samp></td>
    <td width="50%" valign="top"><samp>
      <b>Send only what changed</b>
      <br><br>
      Push reviewed rows to next-pms on Frappe/ERPNext, or any system with a small JSON API. Clockout previews additions, updates
      and removals, remembers task mappings, and leaves entries made in the ERP alone.
    </samp></td>
  </tr>
</table>

<br>

# ⚙️ Installation

<table>
<tr>
<td width="50%" valign="top">

<samp>

**📝 Prerequisites**

1. **Node.js 22.12+** — use **22.13+** for opencode and Antigravity sources
2. **pnpm 11** through Corepack
3. At least one supported coding-agent, GitHub or calendar source

<br>

**🔮 Optional**

- `gh auth login` — GitHub activity
- An AI helper for descriptions and plain-language corrections, on your own subscription:
  `claude`, `codex`, `opencode` or `pi` (the first one installed is used; pick another in
  Setup). Without one, descriptions come from titles and corrections are made on the cards

</samp>

</td>
<td width="50%" valign="top">

<samp>

**🪴 Usage**

1. Clone and build:

       git clone https://github.com/wreckage0907/clockout
       cd clockout
       corepack enable
       pnpm install
       pnpm build

2. Find your tools and create a config:

       node dist/cli.js init

3. Review today:

       node dist/cli.js

</samp>

</td>
</tr>
</table>

<br>

# 🚀 Getting started

<samp>

| | Step | What happens |
|---|---|---|
| **1** | **Run `init`** | Clockout detects local agent logs, GitHub and an AI helper, then asks for your time zone, working hours and calendar. |
| **2** | **Open the day** | Press Enter to expand the timesheet cards. Move with **↑ ↓**, edit a duration with **Enter**, and nudge it with **− / +**. Click checkboxes or press **Space** to select several; **Shift-click** (or **Option-click**, e.g. inside herdr) a card to tick it, or a range once one is ticked. |
| **3** | **Say what is wrong** | Type or dictate a correction. Review the proposed operations, **Enter** to apply, **Esc** to revise, **Ctrl+Z** to undo. |
| **4** | **Take the sheet** | **Ctrl+Y** copies tab-separated rows (or your default export), or only the checked rows when any are selected; `/copy md`, `/copy csv` or `/copy <your export>` copy another format. The selection toolbar can also map or remove several cards together. Use `export` for a file, another format or a range of dates. |
| **5** | **Say your standup** | `clockout standup` (or `/standup` in the app) writes it from the previous working day, today's meetings and your open PRs, and copies it. Blockers are only what you add: `-b "waiting on API keys"` or `/standup waiting on API keys`. |
| **6** | **Pick another day** | Run `yesterday` or `day 2026-10-16`; in the review screen, click the date or use **PgUp / PgDn**. |

Anything you'd rather say once ("remember the reader isn't technical", "remember we spell it
frontend") is kept as a memory: Clockout hands it to the AI helper with every description and
standup, and Setup → AI helper lists what it remembers.

**One command, a finished sheet**

```sh
node dist/cli.js day 2026-10-16 --md --no-ai
```

```text
| Date | Project | Task | Hours | Description |
|---|---|---|---:|---|
| 2026-10-16 | acme-api | Development | 2.25 | Fix auth token refresh |
| 2026-10-16 | clockout | Development | 2.50 | Build export command |
| 2026-10-16 | acme-api | Development | 0.25 | Investigate flaky deploy |
| | | **Total** | **5.00** | |
```

</samp>

<br>

# 🧠 How it works

<details>
<summary><b>🧩 Evidence becomes time blocks</b></summary>
<br>
<samp>

Each source emits timestamped activity. Clockout resolves its project, joins nearby work on
the same project and branch or pull request, and splits blocks at the configured idle cutoff.
A prompt counts until the agent's reply is read; an agent running unattended for an hour does
not become an hour of your time. Accepted meetings take their time from overlapping work;
tentative and unanswered meetings stay as questions.

</samp>
</details>

<details>
<summary><b>💬 Corrections stay under your control</b></summary>
<br>
<samp>

The AI returns edit operations, never a rewritten timesheet. Core validation rejects invalid
changes before you see the proposal. Your corrections are stored with the day and replayed
when new activity arrives; refreshing keeps them whenever the original blocks still exist.
Use `--no-ai` for titles and heuristic summaries instead.

The AI helper is your own agent CLI, run with its tools off, in an empty temporary folder,
saving nothing: Claude Code (`claude -p`, schema enforced), Codex (`codex exec`, read-only
sandbox, schema enforced), opencode (`opencode run` as an agent that may use no tools; the
session is deleted afterwards) or Pi (`pi -p --no-tools`). It only sees titles, branch names
and PR subjects. Antigravity can't be the helper: its print mode runs an agent, saves a
conversation, and Google's terms don't allow other products to use it.

</samp>
</details>

<details>
<summary><b>🧾 One row per piece of work</b></summary>
<br>
<samp>

Project rules turn repositories, titles and attendee domains into your project names, and
projects you add by hand (Setup → Projects, **+ New project** in Add time, or "add a project
called Internal") are offered whenever you add time; so are recent days' and your ERP's. Task
rules separate development, reviews and meetings. Rows are rounded to your configured step,
unconfirmed meetings and breaks are left out, and repeated exports merge the same work.
Configuration lives in `~/.config/clockout/config.toml`; **Ctrl+P** opens setup in the app.

</samp>
</details>

<details>
<summary><b>🗣️ Standups from the same evidence</b></summary>
<br>
<samp>

```text
Friday
- Scoped project ToDo access and opened PR #2308
- Built /refresh and /connect slash commands in clockout

Today
- Review PR #2214 docs: update readme
- Continue PR #2308 project ToDo access

Blockers
- Waiting on the npm publisher setup
```

Yesterday is the previous working day's timesheet with your corrections (Friday on a Monday).
Today is your calendar plus what's still open on GitHub: your PRs, reviews asked of you, and
branches with no PR yet. Blockers are never guessed and never sent to the AI. Without an AI
helper (or with `--no-ai`) a plain template lists the same facts. Choose bullets or sentences,
a length and your own prompt in Setup → AI helper → Standup, or say "keep my standup short".

</samp>
</details>

<details>
<summary><b>📋 Your own export formats</b></summary>
<br>
<samp>

When your timesheet wants other columns, add a named format to `config.toml`, or say it in
the chat bar ("add a Harvest export with hours as h:mm", "make it what ctrl+y copies"):

```toml
[[exports]]
name = "harvest"
type = "csv"                 # csv | tsv | markdown | json | text
merge = true                 # the same work in one row (false: one row per block)
default = true               # what Ctrl+Y and a bare /copy use
columns = [
  { field = "date", header = "Date", format = "dd/MM/yyyy" },
  { field = "project", header = "Client project" },
  { field = "hours", header = "Time", format = "h:mm" },   # decimal | h:mm | minutes | hm
  { field = "description", header = "Notes" },
]

[[exports]]
name = "slack"
type = "text"
line = "{project}: {description} ({hours})"
```

Fields are `date`, `project`, `task`, `hours`, `description`, `erp_task` and `erp_task_name`.
Dates take a pattern of `yyyy yy MMMM MMM MM M dd d EEEE EEE`; hours as decimal take
`decimals` (0–4). Templates only fill in fields. Use them with `clockout export -f harvest`
or `/copy harvest`. CSV and TSV cells that look like spreadsheet formulas are always kept as
text.

</samp>
</details>

<br>

# 🔌 Connections

<samp>Connect a calendar for meetings and RSVPs, or an ERP to skip copy-paste entirely.</samp>

<details>
<summary><b>📅 Google Calendar or ICS</b></summary>
<br>
<samp>

For Google Calendar, [create a desktop sign-in client](docs/google-setup.md), then run:

```sh
node dist/cli.js connect google
```

For any calendar with a private iCal address, choose **Paste a private calendar address (ICS)**
during `init`. Accepted meetings count automatically; declined meetings drop out; tentative
and unanswered meetings wait for your answer.

</samp>
</details>

<details>
<summary><b>↗️ next-pms on Frappe/ERPNext</b></summary>
<br>
<samp>

Enable dynamic client registration in the site's OAuth Settings, then sign in through the browser:

```sh
node dist/cli.js connect erp https://erp.example.com
```

Press **Ctrl+S** in the review screen, pick an ERP task for each project, inspect the plan and
press **Enter** to send. To reroute several cards at once, check them and choose **Map task**;
this changes only those cards, not the saved project mappings. From scripts, preview and apply
the same flow with:

```sh
node dist/cli.js push yesterday --dry-run
node dist/cli.js push yesterday --yes
```

</samp>
</details>

<details>
<summary><b>📝 Where exports go</b></summary>
<br>
<samp>

An export can say where its text also goes — a daily note in your vault, or a tool on an MCP
server — and Clockout shows the text and the place before writing:

```toml
[[exports]]
name = "daily-note"
type = "markdown"
to = { file = "~/Vault/Daily/{date}.md", append = true }

[[exports]]
name = "notion"
type = "markdown"
to = { mcp = "notion", tool = "append_block", arguments = { content = "{text}" } }
```

```sh
node dist/cli.js export -f daily-note --dest          # asks first
node dist/cli.js export -f daily-note --dest --dry-run
node dist/cli.js standup --to daily-note              # the standup, into the same note
```

`{text}` and `{date}` are the only things filled in. A file path is set by hand (or in Setup),
never by the AI; replacing a note that's there is a question. Your own program can take the text
too: `to = { command = ["my-writer"] }` gets `{ date, format, text }` as JSON on stdin.

</samp>
</details>

<details>
<summary><b>🧩 MCP servers</b></summary>
<br>
<samp>

Give a remote MCP server a short name and its address; Clockout signs in through the browser
(OAuth with dynamic registration) and lists the server's tools to show it works:

```sh
node dist/cli.js connect notes https://notes.example.com/mcp
node dist/cli.js connect notes      # sign in again later
node dist/cli.js disconnect notes   # revoke and forget the sign-in
```

The server is kept in `[[mcp]]` in the config.

If you record meetings with Wispr Flow (Notetaker with MCP access), connecting it also turns on
the source that reads them, so a meeting you recorded counts as attended for as long as it ran,
and its calendar event stops asking whether you were there:

```sh
node dist/cli.js connect wispr
```

What a recording says (its summary) is shown next to the meeting and nowhere else: it is never
sent to the AI helper or into an export. Note destinations for exports (a vault file, an MCP tool) are in "Where exports go" below.

</samp>
</details>

<details>
<summary><b>↗️ Any other timesheet or PMS</b></summary>
<br>
<samp>

Anything that answers five JSON requests (list a day's entries, search tasks, create, update,
delete) with a bearer token can take your days: see [docs/timesheet-api.md](docs/timesheet-api.md).

```toml
[timesheet]
type = "http"
url = "https://pms.example.com/api/clockout"
```

Put the token in `CLOCKOUT_TIMESHEET_TOKEN` (never in the config), then send as above.
`pnpm mock-pms` runs a mock one on your machine to try it.

</samp>
</details>

<details>
<summary><b>🩺 When something doesn't work</b></summary>
<br>
<samp>

A source that fails never stops the day: it is drafted from the rest, and the review screen
shows a ⚠ line. Click it or type `/problems` for each message in full with its fix (sign in
again, turn on the Calendar API, authorize a token for your organization's SSO…). The
underlying errors are kept in `~/.local/share/clockout/errors.log`, on your machine only,
with anything that looks like a token redacted. Google sign-in problems are listed in
[docs/google-setup.md](docs/google-setup.md#troubleshooting).

Without an AI helper, Clockout says so when it opens. The cards, `/` commands and exports
all work; only typed corrections and AI descriptions need one.

If a saved day is damaged (`The saved day … is damaged`), move that file aside and open the
day again: it's rebuilt from your activity, without the corrections made on it. On Node older
than 22.12, Clockout says so and stops; update Node.

</samp>
</details>

<br>

<hr>

<p align="center">
  <samp>MIT &middot; built for the <b>#NoHandsChallenge</b></samp>
</p>
