# Send your day to next-pms

Clockout has no ERP built in ([ADR 0013](adr/0013-timesheet-systems-speak-one-api.md)). For next-pms on Frappe/ERPNext, a small program in this repository, [`examples/next-pms.mjs`](../examples/next-pms.mjs), sits between the two: Clockout asks it for your entries and tasks and hands it the rows to send, and it calls the same next-pms methods the ERP's own timesheet page uses. Everything next-pms checks there (a task on every entry, backdating limits, approved weeks) still applies.

It takes about 5 minutes and you do it once. You need Node 22.12 or newer, which Clockout already needs.

## 1. Save the program

1. Download [`examples/next-pms.mjs`](../examples/next-pms.mjs) and save it next to your Clockout config, at `~/.config/clockout/next-pms.mjs`.
2. Make it runnable:

   ```sh
   chmod +x ~/.config/clockout/next-pms.mjs
   ```

If you work from a clone of this repository, you can point Clockout at `examples/next-pms.mjs` in the clone instead.

## 2. Get an API key from the ERP

1. Sign in to your ERP and open your own user: the avatar menu → **My Settings**.
2. Open the **Settings** tab and find **API Access**.
3. Click **Generate Keys**. The ERP shows the **API Secret** once; copy it now. The **API Key** stays visible on the page.

If you don't see **API Access** or the button, your role isn't allowed to create keys. Ask whoever runs the ERP to generate them for your user.

Generating keys again replaces the secret, so anything already using the old one stops working.

## 3. Save the key where only you can read it

1. Create `~/.config/clockout/next-pms.json` with your site and the two values:

   ```json
   {
     "url": "https://erp.example.com",
     "api_key": "your API key",
     "api_secret": "your API secret"
   }
   ```

2. Make it readable only by you:

   ```sh
   chmod 600 ~/.config/clockout/next-pms.json
   ```

The program refuses to run while others can read the file. The address must be https; plain http works only for a site on your own machine (`localhost`, `*.localhost`). To keep the file somewhere else, set `NEXT_PMS_SETTINGS` to its path.

## 4. Tell Clockout to use it

In `~/.config/clockout/config.toml`, add (or replace) the `[timesheet]` section. `run` takes the program's full path; `~` isn't expanded there:

```toml
[timesheet]
type = "command"
run = ["/Users/you/.config/clockout/next-pms.mjs"]
```

Keep any `[[timesheet.map]]` entries you already have; they say which ERP task each project's rows go to.

## 5. Check it

```sh
clockout push yesterday --dry-run
```

This reads yesterday's entries from the ERP and shows what would be added, changed or removed, without sending anything. Rows from a project with no task yet are listed as blocked: open the review screen, press **Ctrl+S**, and pick a task for each project once.

When the plan looks right, send it from the review screen (**Ctrl+S**) or with `clockout push yesterday`.

## If something goes wrong

Clockout shows the program's message as it is.

| Message                                   | What to do                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------- |
| No next-pms settings at …                 | Step 3: the file is missing or at another path.                           |
| … can be read by others                   | Run the `chmod 600` from step 3.                                          |
| … needs a "api_secret"                    | The settings file is missing that value.                                  |
| The ERP refused the API key               | The key or secret is wrong, or was generated again: repeat steps 2 and 3. |
| Your ERP user isn't linked to an employee | Ask whoever runs the ERP to link your user to your employee record.       |
| This ERP doesn't have next-pms            | The site doesn't run next-pms, or its version is too old.                 |
| Couldn't reach …                          | Check the address in the settings file and your connection.               |

The key is never shown to the AI helper, and Clockout never prints it.
