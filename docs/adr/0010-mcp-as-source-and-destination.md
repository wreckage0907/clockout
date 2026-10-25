# 0010. MCP servers as a source and as a destination

Status: accepted (2026-10-25)

## Context

ADR 0009 adds an MCP client so a timesheet system's tools can take entries. The same client can read from, and write to, the other tools people keep their work in. Two needs came up:

- **Meetings people record.** Wispr Flow's Notetaker records meetings. Its remote MCP server (`https://api.wisprflow.ai/connect/mcp`) is read-only, signs in with OAuth 2.1 and dynamic client registration, and any MCP client can connect. It serves meetings with times, attendees, summaries and transcripts, Scratchpad notes and calendar events, and it links a recording to its calendar event (`get_meeting_by_calendar_id`). It doesn't serve dictation history. It runs on Mac and Windows and needs Notetaker with MCP access on the account (a beta in October 2026). A calendar says a meeting was planned. A recording says you were there and how long it ran.
- **Notes people keep.** People keep daily notes in Obsidian or Notion and want the day, or a standup, written there as well as into the timesheet.

## Decision

### One MCP client

- `src/mcp/`: JSON-RPC over streamable HTTP (`initialize`, `tools/list`, `tools/call`). Answers come from `structuredContent`, or else the text content parsed as JSON. `isError` is shown as that system's error. Clockout implements the client itself, not with the SDK (ADR 0009).
- Sign-in follows MCP's authorization spec: a 401 with `WWW-Authenticate` leads to the protected-resource metadata (RFC 9728), then authorization-server metadata, dynamic client registration (RFC 7591), and PKCE with the loopback redirect from `src/oauth.ts`. The discovery in `src/targets/next-pms/oauth.ts` is made general, and next-pms signs in as before. Tokens are kept in `credentials.json` next to the ERP's and refreshed. They are never logged or shown to an AI.
- Servers are named in config (`[[mcp]] name = "wispr", url = "…"`) and connected with `clockout connect <name>` / `disconnect <name>`. They must use https (plain http is allowed only for this machine, for tests).
- Clockout only calls tools that are named in config or in a source's code. Tool descriptions and results are data, never instructions.
- Tests use a mock MCP server in `test/mock-mcp/`, the way `test/mock-pms/` is used. It has OAuth with registration, meeting tools and a tool that writes a note.

### Wispr Flow as a source

- The `wispr-flow` source lives in `src/sources/wispr-flow/` and is connected with `clockout connect wispr`. For the date range it lists meetings and emits one `meeting` activity per recording: the title, the recording's start and end, attendees, and `refs` to the calendar event it belongs to. Tool names are checked against the server's `tools/list` when the source is built, not assumed from articles.
- A recording counts as attendance: the meeting is `accepted`, for the recorded length. When a calendar source has the same event (matched through `refs`), core keeps one meeting, with the calendar's title and Wispr's times, and doesn't ask whether you attended. Following AGENTS.md, the source only emits the activity, and core decides the merge and the duration.
- Meeting summaries and notes are private. They appear in the card's evidence on screen, and nowhere else: they are never sent to an AI helper and never exported. As with calendar events, only the title reaches the AI. Transcripts aren't fetched.
- Dictation history isn't read. The server doesn't offer it, and Wispr's local database isn't an official interface (it can change with any app update) and holds private dictation.
- `detect()` only checks whether Wispr is connected. It makes no network call. A server that refuses or has changed its tools gives a warning, and the day keeps what was saved from it, like other sources.

### Destinations for exports

An `[[exports]]` format (ADR 0009) can say where its text goes, in addition to the clipboard or stdout:

```toml
[[exports]]
name = "daily-note"
type = "markdown"
to = { file = "~/Vault/Daily/{date}.md", append = true }

[[exports]]
name = "notion"
type = "markdown"
# tool and arguments are whatever the server's tools/list says
to = { mcp = "notion", tool = "append_block", arguments = { page = "Worklog", content = "{text}" } }
```

- **`file`** writes the file directly. An Obsidian vault is a folder of Markdown, so no Obsidian MCP server, plugin or API key is needed. `append` adds to the end. Without it the file is replaced, and if it already exists Clockout asks first.
- **`mcp`** calls one tool on a connected MCP server. The arguments are templates that fill in fields only, as in ADR 0009.
- Nothing is written until you confirm. Clockout shows the text and where it will go, as it does when sending a day.
- File paths are set by hand or in Setup. The AI never sets them, and they are never in the settings summary (AGENTS.md: folder paths never reach the AI). The AI can propose an MCP destination by server name and tool.
- A standup (spec §8) is one of these texts, so it can go to the daily note as well.

## Consequences

- Wispr's MCP access is a beta tied to Notetaker. Without it, the source finds nothing and says why. If tool names change, the source warns and finds nothing until it's updated.
- Nothing from a meeting leaves the machine except its title, which goes to the AI helper, as calendar titles already do.
- The config gains `[[mcp]]`, `[[sources]] type = "wispr-flow"` and `to` on exports. Each needs settings operations (except file paths), a summary for the AI, and tests.
- The client and sign-in built here are what ADR 0009's `mcp` timesheet target uses after the release.
