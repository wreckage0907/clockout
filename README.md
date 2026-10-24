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
      reviews, issues and comments, plus Google Calendar or an ICS feed.
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
      Export date, project, task, hours and description as Markdown, CSV, TSV or JSON.
      Copy a day to the clipboard, print one day, or export a date range from scripts.
    </samp></td>
    <td width="50%" valign="top"><samp>
      <b>Send only what changed</b>
      <br><br>
      Push reviewed rows to next-pms on Frappe/ERPNext. Clockout previews additions, updates
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
- `claude` — AI summaries and plain-language corrections on your Claude Code subscription

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
| **1** | **Run `init`** | Clockout detects local agent logs, GitHub and Claude Code, then asks for your time zone, working hours and calendar. |
| **2** | **Open the day** | Press Enter to expand the timesheet cards. Move with **↑ ↓**, edit a duration with **Enter**, and nudge it with **− / +**. Click checkboxes or press **Space** to select several; **Shift-click** (or **Option-click**, e.g. inside herdr) a card to tick it, or a range once one is ticked. |
| **3** | **Say what is wrong** | Type or dictate a correction. Review the proposed operations, **Enter** to apply, **Esc** to revise, **Ctrl+Z** to undo. |
| **4** | **Take the sheet** | **Ctrl+Y** copies tab-separated rows, or only the checked rows when any are selected. The selection toolbar can also map or remove several cards together. Use `export` for a file, another format or a range of dates. |
| **5** | **Pick another day** | Run `yesterday` or `day 2026-10-16`; in the review screen, click the date or use **PgUp / PgDn**. |

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

</samp>
</details>

<details>
<summary><b>🧾 One row per piece of work</b></summary>
<br>
<samp>

Project rules turn repositories, titles and attendee domains into your project names. Task
rules separate development, reviews and meetings. Rows are rounded to your configured step,
unconfirmed meetings and breaks are left out, and repeated exports merge the same work.
Configuration lives in `~/.config/clockout/config.toml`; **Ctrl+P** opens setup in the app.

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

<br>

<hr>

<p align="center">
  <samp>MIT &middot; built for the <b>#NoHandsChallenge</b></samp>
</p>
