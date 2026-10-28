import { describe, expect, it } from "vitest";
import { hasSecret, redactSecrets } from "../../src/core/secrets";

describe("secrets", () => {
  it("spots tokens and keys", () => {
    expect(hasSecret("my token is ghp_abcdefghijklmnopqrstuvwxyz0123")).toBe(true);
    expect(hasSecret("refresh 1//0gAbCdEfGhIjKlMnOpQrStUv")).toBe(true);
    expect(hasSecret("the standup ran to 45 minutes")).toBe(false);
  });

  it("redacts them and leaves the rest", () => {
    expect(redactSecrets("secret GOCSPX-abcdefghijkl1234 in config.toml")).toBe(
      "secret [redacted] in config.toml",
    );
    expect(redactSecrets("ses_e932404f2ffeYZaohn5UfxG7Rp1234abcd failed")).toBe(
      "[redacted] failed",
    );
    expect(redactSecrets("/Users/dev/.local/share/clockout/errors.log")).toBe(
      "/Users/dev/.local/share/clockout/errors.log",
    );
  });

  it("leaves links readable but still catches a key with slashes in it", () => {
    const link = "see https://github.com/acme0907/clockout/blob/main/docs/google-setup.md";
    expect(redactSecrets(link)).toBe(link);
    expect(redactSecrets("key wJalrXUtnFEMI/K7MDENG/bPxRfiCY3x9Q81kd2Lm x")).toBe(
      "key [redacted] x",
    );
  });

  describe("by the name of what follows", () => {
    it("redacts opaque, short and letters-only tokens after a Bearer", () => {
      expect(redactSecrets("sent Bearer opaqueTokenValue123456 to the server")).toBe(
        "sent Bearer [redacted] to the server",
      );
      expect(redactSecrets("Bearer abcdefghijklmnopqrstuvwxyz")).toBe("Bearer [redacted]");
      expect(redactSecrets("bearer Zm9vYmFy")).toBe("bearer [redacted]");
    });

    it("redacts Authorization and cookie headers whole", () => {
      expect(redactSecrets("headers: Authorization: Basic dXNlcjpwYXNz\nAccept: json")).toBe(
        "headers: Authorization: [redacted]\nAccept: json",
      );
      expect(redactSecrets("authorization=Bearer abcdefghij")).toBe("authorization=[redacted]");
      expect(redactSecrets("Cookie: session=abc")).toBe("Cookie: [redacted]");
    });

    it("redacts the values in a query string or form body", () => {
      expect(
        redactSecrets(
          "POST /token?refresh_token=abcdefgh&client_secret=hunter2&x=1 code_verifier=plainletters",
        ),
      ).toBe(
        "POST /token?refresh_token=[redacted]&client_secret=[redacted]&x=1 code_verifier=[redacted]",
      );
      expect(redactSecrets("access_token=ya&state=ok")).toBe("access_token=[redacted]&state=ok");
      expect(redactSecrets("grant_type=authorization_code&code=4/0AbCdEfGhIjK&state=s")).toBe(
        "grant_type=authorization_code&code=[redacted]&state=s",
      );
    });

    it("redacts values in JSON", () => {
      expect(redactSecrets('{"access_token":"abc","refresh_token": "def","expires_in":3600}')).toBe(
        '{"access_token":"[redacted]","refresh_token": "[redacted]","expires_in":3600}',
      );
      expect(redactSecrets('{"client_secret":"s3cr3t","error":"invalid_grant"}')).toBe(
        '{"client_secret":"[redacted]","error":"invalid_grant"}',
      );
    });

    it("leaves ordinary text alone", () => {
      for (const text of [
        "the process exited with code=1",
        "error_code=12345678901",
        "Bearer authentication was added to the API",
        "fix: refresh the token cache",
        "access token expired, retrying",
        "authorization is required",
      ])
        expect(redactSecrets(text)).toBe(text);
    });
  });

  describe("hasSecret with named keys", () => {
    it("rejects a named key with a value, whatever the value looks like", () => {
      expect(hasSecret("use refresh_token=abcdef to sign in")).toBe(true);
      expect(hasSecret('{"access_token":"hello"}')).toBe(true);
      expect(hasSecret("client_secret=letters")).toBe(true);
    });

    it("doesn't reject normal titles", () => {
      for (const t of [
        "Fix the refresh token flow",
        "Handle code=1 exits",
        "Bearer auth for the API",
        "Authorization header support",
        "Add access_token field to the docs",
      ])
        expect(hasSecret(t)).toBe(false);
    });
  });
});
