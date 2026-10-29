# Connections

Connect a calendar for meetings and RSVPs, or a timesheet system to skip copy-paste entirely.

## Google Calendar or ICS

For Google Calendar, [create a desktop sign-in client](google-setup.md), then run:

```sh
clockout connect google
```

For any calendar with a private iCal address, choose **Paste a private calendar address (ICS)**
during `init`. Accepted meetings count automatically; declined meetings drop out; tentative
and unanswered meetings wait for your answer.

## Send to your timesheet system

Say where days go in `config.toml`. No ERP is built in: Clockout talks to anything that answers
its small JSON API ([timesheet-api.md](timesheet-api.md)), or to a program you name.

```toml
[timesheet]
type = "http"
url = "https://pms.example.com/api/clockout"
token = "…"                  # or token_env = "PMS_TOKEN" to read it from the environment
```

The token can live in `config.toml` (written readable only by you), so **don't commit or share
that file**. If you'd rather keep it out, use `token_env` (or just set
`CLOCKOUT_TIMESHEET_TOKEN`) instead; use one of the two. Clockout never prints the token and
never sends it to the AI helper, and chat or Setup can't read or change it or the address:
they're set by hand here.

Press **Ctrl+S** in the review screen, pick a task for each project, inspect the plan and
press **Enter** to send. To reroute several cards at once, check them and choose **Map task**;
this changes only those cards, not the saved project mappings. From scripts, preview and apply
the same flow with:

```sh
clockout push yesterday --dry-run
clockout push yesterday --yes
```

## MCP servers

Give a remote MCP server a short name and its address; Clockout signs in through the browser
(OAuth with dynamic registration) and lists the server's tools to show it works:

```sh
clockout connect notes https://notes.example.com/mcp
clockout connect notes      # sign in again later
clockout disconnect notes   # revoke and forget the sign-in
```

The server is kept in `[[mcp]]` in the config.

If you record meetings with Wispr Flow (Notetaker with MCP access), connecting it also turns on
the source that reads them, so a meeting you recorded counts as attended for as long as it ran,
and its calendar event stops asking whether you were there:

```sh
clockout connect wispr
```

What a recording says (its summary) is shown next to the meeting and nowhere else: it is never
sent to the AI helper or into an export. Note destinations for exports (a vault file, an MCP tool) are in [Exports and destinations](exports.md).

## Building a timesheet connection

Anything that answers five JSON requests (list a day's entries, search tasks, create, update,
delete) with a bearer token can take your days: see [timesheet-api.md](timesheet-api.md).
In a clone, `pnpm mock-pms` runs a mock one on your machine to try it. For a system that doesn't, point
Clockout at a program instead:

```toml
[timesheet]
type = "command"
run = ["my-pms", "--timesheet"]
```

**Coming from `type = "next-pms"`?** That target was removed
([ADR 0013](adr/0013-timesheet-systems-speak-one-api.md)); Clockout stops with a message
until you change `[timesheet]` to `http` or `command` (your `[[timesheet.map]]` entries stay as
they are). The old ERP sign-in in `credentials.json` is no longer used.
