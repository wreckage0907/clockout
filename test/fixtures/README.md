# Test fixtures

Synthetic data for one working day, **Fri 16 Oct 2026, Asia/Kolkata** (UTC+05:30). No real sessions, people or repos.

| Path | Mirrors | What the day contains |
|---|---|---|
| `claude/projects/<slug>/<session>.jsonl` | `~/.claude/projects` | acme-api 10:00–12:15 (`fix/auth-refresh`; title changes mid-session; meta, sidechain, tool-result and one malformed line); clockout 14:00–16:30 (`feat/export`); acme-api 23:40–00:25 crossing midnight |
| `github/contributions-2026-10-16.json` | GraphQL `viewer.contributionsCollection` | PRs acme/api#87 and clockout#48 opened; review of acme/api#212 (comments 16:40–16:52, submitted 16:55); commit counts |
| `ics/calendar.ics` | Google Calendar secret iCal address | Daily standup 09:30 (recurring, accepted, cancelled on 15 Oct); design sync 15:00 (tentative, overlaps coding); vendor demo 17:00 (declined); all-day event; focus block 17:30 (no guests, so it's asked about); Acme sync 18:00 (no response) |

Your address in the calendar is `dev@example.com`. Lunch 12:15–14:00 is an intentional gap.
