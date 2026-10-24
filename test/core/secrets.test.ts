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
});
