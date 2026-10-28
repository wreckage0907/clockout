import { describe, expect, it } from "vitest";
import { MAX_TITLE_PATTERN, unsafePatternReason } from "../../src/core/regex";

describe("unsafePatternReason", () => {
  it.each([
    "standup",
    "^(daily|weekly) sync",
    "(?i)design (review|sync)",
    "\\[WIP\\]|fixup!",
    "[a-z]+-\\d+",
    "(acme|acme corp) planning",
    "^sprint (\\d+) retro$",
    "(foo)?bar",
    "(\\d+\\.)?\\d+",
    "(ab){2,3}",
  ])("accepts %s", (p) => {
    expect(unsafePatternReason(p)).toBeUndefined();
  });

  it.each([
    "(a+)+$",
    "(a*)*",
    "(a|a)*",
    "(a|ab)+c",
    "^(\\w+\\s?)*$",
    "(?:x+x+)+y",
    "((a+)b)*",
    "([a-z]+)*",
    "(a{2,})+",
    "(a+){2,}",
  ])("refuses %s", (p) => {
    expect(unsafePatternReason(p)).toBeTruthy();
  });

  it("refuses a pattern longer than the limit", () => {
    expect(unsafePatternReason("a".repeat(MAX_TITLE_PATTERN))).toBeUndefined();
    expect(unsafePatternReason("a".repeat(MAX_TITLE_PATTERN + 1))).toMatch(/longer than/);
  });
});
