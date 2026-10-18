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

## What Clockout reads

For each event in the day: title, start and end, whether it's cancelled, its type (out-of-office and working-location entries are skipped, focus time becomes a question), your RSVP, and the other attendees' emails (for project rules). Nothing is written to your calendar, and nothing leaves your machine except the requests to Google.
