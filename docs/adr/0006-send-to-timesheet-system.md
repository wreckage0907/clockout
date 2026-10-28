# 0006. Send the day to the timesheet system, over its own API

Status: accepted (2026-10-21). Superseded in part by [0013](0013-timesheet-systems-speak-one-api.md): the `next-pms` target and its OAuth sign-in were removed; the plan-then-apply design and the target interface stand.

## Context

Copying rows into a company ERP by hand is the step people skip. The spec had "pushing directly into any timesheet system's API" out of scope. The first target is a Frappe/ERPNext site running rtCamp's next-pms app, which is what the owner uses.

Two ways in were looked at:

- **MCP.** rtCamp's ERP runs an MCP server, but its tools are generic (`create_document`, `update_document`, …), writes need a preview-then-confirm round trip and the MCP User / MCP Write User roles, and a generic create on `Timesheet` clashes with next-pms's one-timesheet-per-day-and-project rule. Frappe's own `frappe-mcp` is marked experimental. An MCP client would also be a new dependency.
- **next-pms's REST methods.** The ones its web app calls: `timesheet.save(date, task, hours, description)`, `update_timesheet_detail`, `delete`, `get_timesheet_data`, `task.get_task_list`. They keep all of next-pms's own rules (task required, backdating window, approved weeks, rejected rows). Frappe accepts an OAuth bearer token on any `/api/method` call, and Frappe 15+ supports PKCE public clients with dynamic registration, so a CLI can sign in like any app, no admin-issued API key.

## Decision

- Clockout sends the reviewed day straight to the timesheet system through a small **target** interface (`src/targets/`): list the day's entries, search tasks, create, update, delete. The first target is `next-pms`.
- Sign-in is OAuth 2 with PKCE: discover the server's metadata, register a public client for the loopback redirect, open the browser, keep the refresh token in `credentials.json` (mode 0600) like the Google one. No passwords or API keys are asked for or stored.
- Sending is **plan, then apply**: Clockout reads what's already in the ERP for that day, compares it with the rows and with a record of what it sent before (kept in the day's JSON), and shows create / update / delete / unchanged / blocked before anything is written. Entries added in the ERP by hand are never touched.
- Clockout projects map to ERP tasks once (`[[timesheet.map]]` in config, written when you pick a task in the review screen).
- MCP stays possible as another target later; nothing in core depends on how a target talks to its server.

## Consequences

- No new dependency: `fetch` and the existing loopback code.
- What leaves the machine: the day's rows (date, task, hours, description) and task searches, to the user's own ERP, only when they confirm.
- next-pms's `save` doesn't return the new entry's id and isn't idempotent, so Clockout re-reads the day after sending and records ids by matching task, hours and description. A crash between the two can be recovered: an ERP entry with the same task and description is adopted, not duplicated.
- Other systems (Harvest, Toggl, Clockify, Jira/Tempo) need their own target; a `command` target that pipes the plan to a script is the escape hatch.
