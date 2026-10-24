import { describe, expect, it } from "vitest";
import { cleanText } from "../../src/core/text";

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
});
