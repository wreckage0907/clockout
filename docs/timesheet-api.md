# Clockout's timesheet API

Clockout can send a day to any timesheet or project-management system that answers these five
requests. next-pms on Frappe/ERPNext has its own built-in target; this one is for everything
else: your company's PMS, a small service in front of one, or the mock PMS used in the tests.

```toml
[timesheet]
type = "http"
url = "https://pms.example.com/api/clockout"   # https; plain http only on this machine
token_env = "CLOCKOUT_TIMESHEET_TOKEN"         # the default; the token is never in this file

[[timesheet.map]]                              # which task each project's rows go to
project = "acme/api"
erp_task = "TASK-API"
```

Run Clockout with the token in that variable: `CLOCKOUT_TIMESHEET_TOKEN=… clockout`.

## Requests

Every request carries `Authorization: Bearer <token>` and is JSON. Paths are under `url`.

| Request | Body | Answer |
|---|---|---|
| `GET /entries?date=YYYY-MM-DD` | | `{ "entries": [Entry], "closed"?: "why" }` |
| `GET /tasks?search=text` | | `{ "tasks": [{ "id", "subject", "project" }] }`, best matches first; an empty search lists them all |
| `POST /entries` | `{ "date", "task", "hours", "description" }` | 201 `{ "id" }` |
| `PUT /entries/{id}` | `{ "date", "task", "hours", "description" }` | 200 |
| `DELETE /entries/{id}` | | 204 |

`Entry` is `{ "id", "task", "hours", "description", "locked"?: "why" }`: your entries on that
date, any task. `id` may be a string or a number. Hours are decimal (`1.25`). A description may
be HTML; Clockout reads it as plain text.

- **`locked`**: an entry that can't change any more (approved, invoiced…). Clockout shows the
  reason and never writes to it.
- **`closed`**: the whole date can't change (an approved week, a locked period). Nothing is sent.

## Errors

Any refusal is a non-2xx status with `{ "error": "a sentence for the user" }`, shown as it's
written next to the row it's about (e.g. 422 `{ "error": "There's no task TASK-9." }`). One
refused entry doesn't stop the others.

| Status | Clockout says |
|---|---|
| 401, 403 | the token in `token_env` was refused: check it or get a new one |
| 404 on a read | there's no timesheet API at `url` |
| 5xx | the system isn't answering; try again later (with its `error`, if any) |
| anything else | its `error` |

## What Clockout does with it

Before sending, Clockout reads the date's entries and plans: a row it sent before is updated
in place (by the `id` it remembers), a row that's gone is deleted, a new row is created, an
entry made in the system by hand is left alone, and the plan is shown before anything is
written. After sending it reads the date again to learn the new entries' ids, so sending
twice never adds anything twice.

## Trying it

`pnpm mock-pms` (Node 22.18 or newer) runs a mock PMS on `http://127.0.0.1:4100/api` with three
tasks, token `mock-token`, entries kept in memory, and the rules a real one has: tasks must
exist, hours between 0 and 24 and no more than 24 in a day, approved entries can't change.
