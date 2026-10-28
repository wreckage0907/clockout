# 0007. Setup from the chat bar

Status: accepted (2026-10-21). The ERP sign-in parts ("connect my ERP", the `erp` service of `connect` and `disconnect`) were removed by [0013](0013-timesheet-systems-speak-one-api.md); task mapping by chat stands.

## Context

Setup is a dialog of buttons (ctrl+p), and connecting the ERP or mapping a project to an ERP task only works from the command line or the send flow. The person using Clockout mostly dictates. "Connect my ERP at erp.example.com", "leave out my personal projects" and "my target is seven and a half hours" are as natural to say as timesheet corrections, and the chat bar already turns sentences into checked operations.

Settings are more sensitive than the day: a private calendar address is effectively a password, and sign-ins hold tokens.

## Decision

- The chat bar takes settings as well as corrections, in **one AI call**: the response carries edit operations for the day (`ops`) and settings operations (`settings`). Settings operations live in `src/config/setting-ops.ts`. They're applied by pure functions and the whole config is then validated with the same zod schema as `config.toml`. As with ADR 0002's edits, the AI never writes the config.
- Changes show as a proposal and apply on Enter, like corrections. The day is drafted again when a change affects it.
- The AI sees a **summary of the settings**: which sources are on, Claude Code project names (not folder paths), the day's numbers, task names, project rules, the ERP's host and its task mappings. It never sees credentials, the private calendar link, or anything it doesn't need.
- Sign-ins stay in the browser. `connect` and `disconnect` come back as effects the app runs (the same OAuth flows as `clockout connect`). An ERP task named in words is looked up locally. One match is used straight away; otherwise the task picker opens on those words.
- Before calling the AI, the text is checked on this machine:
  - A pasted private calendar link (`webcal:`, `.ics`, `/ical/`) is handled locally and never sent.
  - Anything that looks like a token or key is refused, and nothing is sent.
  - Plain "connect erp <address>" and "disconnect google" work with no AI at all.
- The `claude` CLI keeps no session, so the last three turns go with each call to make follow-ups ("the personal one") work.
- The Setup dialog stays. Everything said can also be clicked (ADR 0005).

## Consequences

- One more thing per call in the prompt (the settings summary). It's small, but every correction pays for it.
- Settings changes aren't undone with ctrl+z. They're changed back by saying so or in Setup.
- The token check is a heuristic: it errs towards refusing long random-looking strings.
