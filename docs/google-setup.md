# Connect Google Calendar

Clockout reads your meetings through the Google Calendar API, read-only. You sign in once with `clockout connect google`; after that it reads your calendar on every run.

Before the first sign-in, Clockout needs a Google "OAuth client", its identity on Google's sign-in screen. Until Clockout ships its own, create one in your Google account. It takes about 5 minutes and you do it once.

## 1. Create the client (once)

1. **Create a project.** Open [console.cloud.google.com/projectcreate](https://console.cloud.google.com/projectcreate), name it `Clockout`, and create it.
2. **Turn on the Calendar API.** Open [Google Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com) for that project and click **Enable**.
3. **Set up the sign-in screen.** Open [Google Auth Platform](https://console.cloud.google.com/auth/overview) and click **Get started**:
   - App name `Clockout`, your email as the support email.
   - **Audience**:
     - **Internal** if you created the project with your work account and only people in your organization will use it. There's no verification and no warning screen.
     - **External** otherwise.
   - Contact email: yours. Agree and create.
4. **Allow the calendar scope.** Go to **Data access** → **Add or remove scopes** and add `https://www.googleapis.com/auth/calendar.events.readonly`. Save.
5. **External only: publish it.** Go to **Audience** → **Publish app** → confirm. While an app is in "Testing", Google expires the sign-in every 7 days, so you'd have to reconnect weekly. Published but unverified apps work, with a warning screen, for up to 100 users.
6. **Create the client.** Go to **Clients** → **Create client**:
   - Application type **Desktop app**, name `Clockout CLI`.
   - Click **Create**, then copy the **Client ID** and **Client secret**.

A desktop app's client secret isn't treated as a secret by Google (it ships inside apps). The sign-in itself is protected with PKCE.

## 2. Tell Clockout about it

Add this to `~/.config/clockout/config.toml`:

```toml
[google]
client_id = "1234567890-abc.apps.googleusercontent.com"
client_secret = "GOCSPX-…"
```

Or set `CLOCKOUT_GOOGLE_CLIENT_ID` and `CLOCKOUT_GOOGLE_CLIENT_SECRET`.

## 3. Connect

```sh
clockout connect google
```

1. Your browser opens Google's sign-in. Pick the account whose calendar you want.
2. With an External, unverified app you'll see **"Google hasn't verified this app"**. Click **Advanced** → **Go to Clockout (unsafe)**. It's your own client.
3. Allow **"View events on all your calendars"**.
4. The tab says Clockout is connected. Back in the terminal, Clockout lists how many events it found today.

The sign-in is stored in `~/.config/clockout/credentials.json`, readable only by you. `clockout disconnect google` revokes it and deletes it. You can also remove access any time at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

## Work accounts (Google Workspace)

If sign-in stops with **"Access blocked"** or `admin_policy_enforced`, your Workspace admin only allows approved apps. Ask them to trust the client:

> Admin console → Security → Access and data control → API controls → Manage third-party app access → Add app → OAuth App Name Or Client ID → paste the Client ID → set it to **Trusted** (or Limited, with access to Calendar).

Creating the project with your work account and choosing **Internal** in step 3 avoids this, if your organization lets you create Cloud projects.

## Troubleshooting

Every Google Calendar message starts with `Google Calendar:`, says what went wrong, and what to do. In more detail:

| Message says                                                                                                                      | Why                                                                                                                                                | Fix                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| No Google sign-in client is set up yet                                                                                            | There's no `[google]` client in config.toml                                                                                                        | Do steps 1–2 above.                                                                                                                      |
| Google didn't accept Clockout's sign-in client (`invalid_client`, `unauthorized_client`)                                          | The client ID or secret is wrong, or the client was deleted                                                                                        | Copy both again from **Clients** in the Cloud console into `[google]`, or `CLOCKOUT_GOOGLE_CLIENT_ID` / `CLOCKOUT_GOOGLE_CLIENT_SECRET`. |
| the sign-in client isn't a "Desktop app" client, Google rejected the sign-in request (`redirect_uri_mismatch`, `invalid_request`) | The client is a "Web application" (or another type), which needs fixed redirect addresses                                                          | Create a **Desktop app** client (step 6) and use its ID and secret.                                                                      |
| access wasn't allowed                                                                                                             | You pressed Cancel, or Google showed "has not completed the Google verification process"                                                           | Sign in again and allow access. For the verification page, publish the app (step 5) or add your account under **Audience → Test users**. |
| your Google Workspace admin blocks this app (`admin_policy_enforced`)                                                             | Your organization only allows approved apps                                                                                                        | See [Work accounts](#work-accounts-google-workspace).                                                                                    |
| the sign-in client is "Internal" to another organization (`org_internal`)                                                         | The Cloud project's audience is Internal, and you signed in with an account outside that organization                                              | Sign in with an account from that organization, or set the audience to External (step 3).                                                |
| sign-in timed out                                                                                                                 | Nothing came back to Clockout within 5 minutes. Usually Google showed an error page instead ("Access blocked", "Error 400: redirect_uri_mismatch") | Match the error on that page to a row above, then run `clockout connect google` again.                                                   |
| Google didn't return a lasting sign-in                                                                                            | Google skipped the refresh token, usually because Clockout was already allowed                                                                     | Remove Clockout at [myaccount.google.com/permissions](https://myaccount.google.com/permissions), then connect again.                     |
| the sign-in was revoked or expired                                                                                                | You removed access, or the app is still in "Testing" (sign-ins expire after 7 days)                                                                | Run `clockout connect google` again. If it happens every week, publish the app (step 5).                                                 |
| you connected with a different sign-in client, the sign-in client changed or was deleted                                          | `[google]` in config.toml now names another client than the one you signed in with                                                                 | Run `clockout connect google` again.                                                                                                     |
| the Google Calendar API is off for your Cloud project                                                                             | Step 2 was skipped, or the API was turned off                                                                                                      | [Enable the Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com), wait a minute, try again.         |
| calendar access wasn't allowed when you signed in                                                                                 | The "View events on all your calendars" box was unticked on Google's consent screen                                                                | Run `clockout connect google` again and tick it.                                                                                         |
| Google is limiting requests right now                                                                                             | Too many requests in a short time                                                                                                                  | Wait a minute.                                                                                                                           |
| couldn't reach Google                                                                                                             | No connection, a proxy or a firewall                                                                                                               | Check your connection and try again.                                                                                                     |

## What Clockout reads

For each event in the day: title, start and end, whether it's cancelled, its type (out-of-office and working-location entries are skipped, focus time becomes a question), your RSVP, and the other attendees' emails (for project rules). Nothing is written to your calendar, and nothing leaves your machine except the requests to Google.
