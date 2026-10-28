# 0012. Let a scheduler run it

Status: accepted (2026-10-26)

## Context

ADR 0010 lets an export write to a file, an MCP tool or a program, but only when you run it. The
thing people actually want is the note being written for them: a daily note in Obsidian, a row
in Notion, both with nobody watching. A cron line already works today — `export -f daily-note
--dest --yes` runs with no terminal, no helper on PATH, and `--yes` respected — but three things
make it a bad citizen when left to a scheduler:

- **It writes again every time it runs.** With `append = true`, a second run adds a second table
  to the note; two runs a day, or a run plus a manual one, and the note fills up.
- **Its exit code lies.** A day with open questions is written as a partial sheet and exits 0, so
  cron can't tell a finished run from a half-finished one.
- **Two runs can collide.** Nothing takes a lock. A scheduled run and one you started by hand can
  both refresh the same rotating sign-in token (MCP, Frappe, Google), and the loser's refresh
  token is already spent; `credentials.json` writes aren't guarded either.

And ADR 0010 says "nothing is written until you confirm", which a scheduled run cannot do.

## Decision

### A schedule is a standing confirmation

Adding a job shows exactly what it will do — the time, the day, the export, the place — and says
in as many words that from then on it writes without asking. That is the confirmation; there is
no second prompt at 18:30 (`--yes` is implied, not needed). `clockout schedule` lists every job
with the same detail at any time, and `clockout schedule remove` stops one.

Jobs live in the config, not in the OS:

```toml
[[schedule]]
name = "daily-note"
at = "18:30"        # your local clock
day = "today"       # today (fresh, maybe unfinished) or yesterday (finished)
kind = "export"     # export (a named format) or standup
format = "daily"    # an [[exports]] name with a `to`
allow_open = false  # false: open questions make the run exit 1
```

### `clockout schedule` installs the unit, or prints it

`add`, `remove`, `sync`, `print`, `log`, and the job list from a bare `clockout schedule`.
`add` and `sync` write a launchd user agent (`~/Library/LaunchAgents/com.clockout.<name>.plist`)
on macOS, a systemd **user** timer on Linux, and on anything else print a crontab line instead of
pretending to install. The unit records the absolute path of the interpreter and the PATH the job
was set up with — cron and launchd don't read your shell's profile, and an AI helper or `gh` has
to be findable at 18:30. `print` shows the same text without touching the system. Every job's
stdout and stderr go to one log file per job.

### One runner: `clockout run <name>`

The unit runs the job through Clockout, not through a hand-built command line, so the rules
below can't be forgotten:

- **A lock.** `src/lock.ts` (an `O_EXCL` lock file holding a pid and a random owner token) is
  held for the whole run and touched every minute while held; a second run exits 0 with "another
  run has it". A lock untouched for 10 minutes was left by a dead run and is taken over: waiters
  race on a `rename` to a unique name, so only one wins, and release only removes a lock that
  still carries its own token. A quit by signal lets go of held locks (`releaseHeldLocks`).
  Credential writes take the lock around the whole read-change-write and are written to a temp
  file and renamed in; a refresh of a rotating token re-reads the saved sign-in under the same
  lock first, so a run never uses a token another run has already spent.
- **Once a day per job.** Each job remembers the last day it wrote (`schedule/<name>.json` in the
  data dir). Running again on the same day exits 0 and says so; `--again` writes it again, which
  is what you use after editing the day.
- **Its own marked block in a shared note.** With `append = true`, Clockout now writes between
  `<!-- clockout:start -->` and `<!-- clockout:end -->` and replaces that block next time — a
  standup gets `<!-- clockout:standup:start -->`. Your own writing in the note is never touched,
  and a marker that has lost its pair is reported instead of guessed at. `append = false` still
  means the whole file is Clockout's. A destination that isn't a file (an MCP tool) gets the
  once-a-day guard instead, so your Notion page isn't appended to twice.
- **An honest exit code.** 1 when nothing was written, and 1 when the day had open questions
  unless the job says `allow_open = true` (a deliberate mid-afternoon run). Cron and launchd
  only read the exit code.
- **A record.** One line per run in `~/.local/share/clockout/runs.log`, read with `clockout
  schedule log`. Details of a failure still go to `errors.log`.
- **Nothing private in the unit.** It names the job, not the day's contents; the destination is
  the one in `[[exports]]`, and the AI is never asked anything about it.

### What the AI can't do

No settings operation can add a job, change one, or point one anywhere: like the `command`
target (ADR 0009, layer 4), a schedule is a standing write, so it stays hand-set
(`clockout schedule add`, or the config).

## Consequences

- Clockout writes places you've named at times you've named, with nobody watching. That's the
  point, and it's why the first confirmation is verbose and `schedule` shows it forever after.
- The note-file format now carries two HTML comments. A note edited by hand can break a block;
  that's reported, not silently repaired.
- `append = true` changes meaning from "add to the end" to "keep your own block", which is a
  behaviour change for anyone already using it (documented in the spec).
- A user timer on Linux needs `loginctl enable-linger` to run while logged out; the install says
  so. Windows has no installer: `schedule print` gives the line, and the docs say how.
- One `[[schedule]]` section means one more thing for the config schema, `schedule sync` after
  hand edits, and a new file per job in the data dir. No new dependency, no daemon, no network.
