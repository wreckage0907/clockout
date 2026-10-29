# How it works

The full reference, with every rule and its reason, is the [spec](spec.md#8-how-it-works); this page is the short version.

## Evidence becomes time blocks

Each source emits timestamped activity. Clockout resolves its project, joins nearby work on
the same project and branch or pull request, and splits blocks at the configured idle cutoff.
A prompt counts until the agent's reply is read; an agent running unattended for an hour does
not become an hour of your time. Accepted meetings take their time from overlapping work;
tentative and unanswered meetings stay as questions.

## Corrections stay under your control

The AI returns edit operations, never a rewritten timesheet. Core validation rejects invalid
changes before you see the proposal. Your corrections are stored with the day and replayed
when new activity arrives; refreshing keeps them whenever the original blocks still exist.
Use `--no-ai` for titles and heuristic summaries instead.

The AI helper is your own agent CLI, run with its tools off, in an empty temporary folder,
saving nothing: Claude Code (`claude -p`, schema enforced), opencode (`opencode run` as an agent that may use no tools; the
session is deleted afterwards) or Pi (`pi -p --no-tools`). It only sees titles, branch names
and PR subjects. Antigravity can't be the helper: its print mode runs an agent, saves a
conversation, and Google's terms don't allow other products to use it.

## One row per piece of work

Project rules turn repositories, titles and attendee domains into your project names, and
projects you add by hand (Setup → Projects, **+ New project** in Add time, or "add a project
called Internal") are offered whenever you add time; so are recent days' and your ERP's. Task
rules separate development, reviews and meetings. Rows are rounded to your configured step,
unconfirmed meetings and breaks are left out, and repeated exports merge the same work.
Configuration lives in `~/.config/clockout/config.toml`; **Ctrl+P** opens setup in the app.

## Standups from the same evidence

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
