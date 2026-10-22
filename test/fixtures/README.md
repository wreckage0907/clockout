# Test fixtures

Synthetic data for one working day, **Fri 16 Oct 2026, Asia/Kolkata** (UTC+05:30). No real sessions, people or repos.

| Path | Mirrors | What the day contains |
|---|---|---|
| `claude/projects/<slug>/<session>.jsonl` | `~/.claude/projects` | acme-api 10:00–12:15 (`fix/auth-refresh`; title changes mid-session; meta, sidechain, tool-result and one malformed line); clockout 14:00–16:30 (`feat/export`); acme-api 23:40–00:25 crossing midnight |
| `pi/sessions/<--cwd-->/<time>_<id>.jsonl` | `~/.pi/agent/sessions` | acme-api 11:01–11:20 IST (named "Rate limit the login endpoint" mid-session; a `!` command, tool results, a system message and one malformed line); clockout 23:51–00:06 crossing midnight, never named |
| `codex/sessions/2026/10/16/rollout-*.jsonl` | `~/.codex/sessions` | acme-api 12:31–12:50 IST on `fix/rate-limit` (git remote in `session_meta`; injected user/developer context; the cwd moves into `web/`; one malformed line); a review subagent it started (skipped); `~/scratch` 23:46–00:12 crossing midnight, no git info |
| `github/contributions-2026-10-16.json` | GraphQL `viewer.contributionsCollection` | PRs acme/api#87 and clockout#48 opened; review of acme/api#212 (comments 16:40–16:52, submitted 16:55); `viewer.issueComments`: one on acme/api#90 during the morning session, one on #212, one the day before; commit counts |
| `next-pms/*.json` | Responses of a Frappe site running next-pms (shapes recorded from a local test site) | Week of 12 Oct: one entry on Mon; on the 16th an entry sent before (HTML description), an approved standup and a rejected row. Two tasks to pick from; an employee; a backdating error; OAuth server metadata |
| `ics/calendar.ics` | Google Calendar secret iCal address | Daily standup 09:30 (recurring, accepted, cancelled on 15 Oct); design sync 15:00 (tentative, overlaps coding); vendor demo 17:00 (declined); all-day event; focus block 17:30 (no guests, so it's asked about); Acme sync 18:00 (no response) |

Your address in the calendar is `dev@example.com`. Lunch 12:15–14:00 is an intentional gap.
