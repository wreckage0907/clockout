# On a schedule

Write your day somewhere every day, without running anything:

```sh
clockout schedule add daily-note --at 18:30 --for today -f daily-note
clockout schedule                 # what's set up, and where each writes
clockout run daily-note           # what the scheduler runs (try it now)
clockout schedule log             # what the last runs did
clockout schedule remove daily-note
```

Adding a job shows the time, the day and the exact place it writes — that's the confirmation;
from then on it writes without asking. `--at` is your local clock, `--for yesterday` gives the
finished sheet (good at 06:30), `--kind standup --to` style jobs write the standup, and
`--allow-open` keeps a deliberate mid-afternoon run from exiting 1.

macOS gets a launchd agent, Linux a systemd user timer (`loginctl enable-linger $USER` for a
machine you're logged out of), and anywhere else `schedule print` gives you a crontab line
instead of pretending to install one. A run takes a lock, writes one day once (`--again`
rewrites), keeps its own `<!-- clockout:start -->` block in a shared note so the note isn't
appended to twice, and exits 1 when the sheet it wrote still had open questions.
