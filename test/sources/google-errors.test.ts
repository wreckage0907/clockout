import { describe, expect, it } from "vitest";
import { configSchema } from "../../src/config/schema";
import { dayRange } from "../../src/core/time";
import { createGoogleCalendarSource, eventsError } from "../../src/sources/google-calendar";
import {
  accessToken,
  connectGoogle,
  exchangeError,
  googleError,
  refreshError,
} from "../../src/sources/google-calendar/oauth";

const client = { client_id: "cid.apps.googleusercontent.com", client_secret: "s3cr3t-client" };

/** Follows the consent screen straight back with a code, like a browser would. */
const consent = async (url: string) => {
  const q = new URL(url).searchParams;
  await fetch(`${q.get("redirect_uri")}/?code=abc&state=${q.get("state")}`);
};
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    if (e instanceof Error) return e;
  }
  throw new Error("expected an Error");
}
const answering = (status: number, body: unknown) =>
  (async () => Response.json(body, { status })) as unknown as typeof fetch;

describe("Google sign-in errors", () => {
  it("explains each error Google sends back to the browser", () => {
    expect(googleError("access_denied")).toContain("add your account as a test user");
    expect(googleError("admin_policy_enforced")).toContain("Workspace admin");
    expect(googleError("org_internal")).toContain('"Internal" to another organization');
    expect(googleError("invalid_client")).toContain('"Desktop app"');
    expect(googleError("redirect_uri_mismatch")).toContain('"Desktop app"');
    expect(googleError("something_new")).toBe(
      "Google Calendar: sign-in failed (something_new). Run `clockout connect google` again.",
    );
  });

  it("reads Google's reason when trading the code fails, without the client secret", async () => {
    const err = await rejection(
      connectGoogle(client, consent, {
        fetch: answering(401, { error: "invalid_client", error_description: "Unauthorized" }),
      }),
    );
    expect(err.message).toContain(
      "Google didn't accept Clockout's sign-in client (invalid_client)",
    );
    expect(err.message).toContain("[google] in config.toml");
    expect((err.cause as Error).message).toBe("HTTP 401 invalid_client: Unauthorized");
    expect(`${err.message} ${(err.cause as Error).message}`).not.toContain("s3cr3t");
    expect(exchangeError(400, { error: "invalid_grant" }).message).toContain(
      "expired or was already used",
    );
    expect(exchangeError(500, "oops").message).toContain("Google refused the sign-in (HTTP 500)");
  });

  it("explains a sign-in without a refresh token", async () => {
    await expect(
      connectGoogle(client, consent, {
        fetch: answering(200, { access_token: "at", expires_in: 3600 }),
      }),
    ).rejects.toThrow("myaccount.google.com/permissions");
  });

  it("points at Google's error page when the sign-in times out", async () => {
    await expect(connectGoogle(client, async () => {}, { timeoutMs: 20 })).rejects.toThrow(
      /timed out.*"redirect_uri_mismatch".*Troubleshooting/,
    );
  });

  it("tells an expired sign-in from a changed client and a network problem", async () => {
    expect(refreshError(400, { error: "invalid_grant" }).message).toContain('still in "Testing"');
    expect(refreshError(401, { error: "unauthorized_client" }).message).toContain(
      "changed or was deleted since you connected",
    );
    const offline = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const err = await rejection(accessToken(client, "rt", offline));
    expect(err.message).toBe(
      "Google Calendar: couldn't reach Google. Check your connection and try again.",
    );
    expect(err.cause).toBeInstanceOf(TypeError);
  });
});

describe("Google Calendar request errors", () => {
  const body = (reason: string, message = "") => ({
    error: { code: 403, message, errors: [{ reason }] },
  });

  it("explains each refusal", () => {
    expect(eventsError(401, null, "primary").message).toContain("Run `clockout connect google`");
    expect(eventsError(403, body("accessNotConfigured"), "primary").message).toContain(
      "console.cloud.google.com/apis/library/calendar-json.googleapis.com",
    );
    const scope = {
      error: { message: "scopes", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] },
    };
    expect(eventsError(403, scope, "primary").message).toContain(
      '"View events on all your calendars"',
    );
    expect(eventsError(403, body("rateLimitExceeded"), "primary").message).toContain(
      "Try again in a minute",
    );
    expect(eventsError(429, null, "primary").message).toContain("Try again in a minute");
    expect(eventsError(404, null, "work").message).toBe(
      'Google Calendar: no calendar "work" on this account.',
    );
    const other = eventsError(500, { error: { message: "Backend Error" } }, "primary");
    expect(other.message).toBe(
      "Google Calendar: request failed (HTTP 500: Backend Error). Try again shortly.",
    );
    expect((other.cause as Error).message).toBe("HTTP 500: Backend Error");
  });

  it("asks to reconnect when the client changed since you connected", async () => {
    const config = configSchema.parse({
      me: { name: "Dev", emails: ["dev@example.com"], timezone: "UTC" },
      google: { client_id: "new-client", client_secret: "s" },
    });
    const source = createGoogleCalendarSource({
      fetch: answering(200, {}),
      credentials: async () => ({
        refresh_token: "rt",
        client_id: "old-client",
        scope: "s",
        connected_at: "",
      }),
    });
    const run = async () => {
      for await (const _ of source.collect(
        dayRange("2026-10-16", "UTC"),
        { type: "google-calendar", calendars: ["primary"] },
        { config, homeDir: "/home/dev", env: {} },
      ));
    };
    await expect(run()).rejects.toThrow("different sign-in client");
  });
});
