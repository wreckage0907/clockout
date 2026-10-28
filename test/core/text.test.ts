import { describe, expect, it } from "vitest";
import { cleanLines, cleanText } from "../../src/core/text";

describe("cleanText", () => {
  it("drops escape sequences that would recolour the terminal or set its title", () => {
    expect(cleanText("Fix \u001b[31mauth\u001b[0m \u001b]0;pwned\u0007now")).toBe("Fix auth now");
  });

  it("puts line breaks, tabs and other control characters on one line", () => {
    expect(cleanText(" Sync\r\nweekly\tplan\u0000\u009b ")).toBe("Sync weekly plan");
  });

  it("leaves unicode alone", () => {
    expect(cleanText("Café ☕ 会议")).toBe("Café ☕ 会议");
  });

  it("drops bidi overrides, zero-width characters and tag characters that disguise text", () => {
    expect(cleanText("invoice‮fdp.exe")).toBe("invoicefdp.exe");
    expect(cleanText("pa​ss⁠word﻿ ­ok")).toBe("password ok");
    expect(cleanText("hi\u{E0041}\u{E0042}")).toBe("hi");
  });

  it("keeps the joiner that builds an emoji sequence, drops a loose one", () => {
    expect(cleanText("👩‍💻 pairing")).toBe("👩‍💻 pairing");
    expect(cleanText("❤️‍🔥")).toBe("❤️‍🔥");
    expect(cleanText("a‍b ‍👩")).toBe("ab 👩");
  });
});

describe("cleanLines", () => {
  it("keeps line breaks but nothing else a terminal would act on", () => {
    expect(cleanLines("one \u001b]52;c;ZXZpbA==\u0007\r\n two‮\t \u0000 three\n\n")).toBe(
      "one\ntwo three",
    );
  });
});
