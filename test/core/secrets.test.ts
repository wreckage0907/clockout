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
});
