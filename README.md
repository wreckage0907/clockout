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

# ⚙️ Installation

<table>
<tr>
<td width="50%" valign="top">

<samp>

**📝 Prerequisites**

1. **Node.js 22.12+** — use **22.13+** for opencode and Antigravity sources
2. At least one supported coding-agent, GitHub or calendar source

<br>

**🔮 Optional**

- `gh auth login` — GitHub activity
- An AI helper for descriptions and plain-language corrections, on your own subscription:
  `claude`, `opencode` or `pi` (the first one installed is used; pick another in
  Setup). Without one, descriptions come from titles and corrections are made on the cards

</samp>

</td>
<td width="50%" valign="top">

<samp>

**🪴 Usage**

1.  Install it:

        npm install --global clockout-cli

2.  Find your tools and create a config:

        clockout init

3.  Review today:

        clockout
<br>

**🛠️ From source**

Needs **pnpm 11** through Corepack. Every `clockout` command in this README
becomes `node dist/cli.js` when you run it from a clone.

    git clone https://github.com/wreckage0907/clockout
    cd clockout
    corepack enable
    pnpm install
    pnpm build

</samp>

</td>
</tr>
</table>

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
      Push reviewed rows to any timesheet system with a small JSON API, or to a program of yours. Clockout previews additions, updates
      and removals, remembers task mappings, and leaves entries made in the system alone.
    </samp></td>
  </tr>
</table>

<br>

# 🚀 Getting started

<samp>

|       | Step                  | What happens                                                                                                                                                                                                                                      |
| ----- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1** | **Run `init`**        | Clockout detects local agent logs, GitHub and an AI helper, then asks for your time zone, working hours and calendar.                                                                                                                             |
| **2** | **Open the day**      | Press Enter to expand the timesheet cards. Move with **↑ ↓**, edit a duration with **Enter** and nudge it with **− / +**; press **Space** or click a checkbox to select several.                                                                  |
| **3** | **Say what is wrong** | Type or dictate a correction. Review the proposed operations, **Enter** to apply, **Esc** to revise, **Ctrl+Z** to undo.                                                                                                                          |
| **4** | **Take the sheet**    | **Ctrl+Y** copies tab-separated rows (or your default export), or only the checked rows when any are selected; `/copy md`, `/copy csv` or `/copy <your export>` copy another format. Use `export` for a file, another format or a range of dates. |
| **5** | **Say your standup**  | `clockout standup` (or `/standup` in the app) writes it from the previous working day, today's meetings and your open PRs, and copies it. Blockers are only what you add: `-b "waiting on API keys"` or `/standup waiting on API keys`.           |
| **6** | **Pick another day**  | Run `yesterday` or `day 2026-10-16`; in the review screen, click the date or use **PgUp / PgDn**.                                                                                                                                                 |

Anything you'd rather say once ("remember the reader isn't technical", "remember we spell it
frontend") is kept as a memory: Clockout hands it to the AI helper with every description and
standup, and Setup → AI helper lists what it remembers.

**One command, a finished sheet**

```sh
clockout day 2026-10-16 --md --no-ai
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

# 📚 Docs

<samp>

| Guide                                         | Covers                                                                                         |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [How it works](docs/how-it-works.md)          | Evidence becoming time blocks, corrections staying yours, how rows and standups are written    |
| [Connections](docs/connections.md)            | Google Calendar or ICS, sending days to a timesheet system, MCP servers, Wispr Flow recordings |
| [Exports and destinations](docs/exports.md)   | Named formats of your own, and `to =` places writes go (vault notes, MCP tools)                |
| [On a schedule](docs/scheduling.md)           | A daily job: launchd, systemd or cron, what it writes and where                                |
| [Troubleshooting](docs/troubleshooting.md)    | When sources fail, no AI helper, a damaged saved day, Node too old                             |
| [Timesheet API](docs/timesheet-api.md)        | The five JSON requests any timesheet system answers                                            |
| [Google Calendar setup](docs/google-setup.md) | Creating the desktop sign-in client, and sign-in problems                                      |

</samp>

<br>

<hr>

<p align="center">
  <samp>MIT &middot; built for the <b>#NoHandsChallenge</b></samp>
</p>
