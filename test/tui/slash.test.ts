import { describe, expect, it } from "vitest";
import { matching, parseSlash, slashText } from "../../src/tui/slash";

const TODAY = "2026-10-16"; // a Friday

describe("slashText", () => {
  it("reads a typed / or a dictated “slash”, without the closing full stop", () => {
    expect(slashText("/refresh")).toBe("/refresh");
    expect(slashText("  Slash connect ERP.")).toBe("/connect ERP");
    expect(slashText("refresh")).toBeNull();
    expect(slashText("the slash in acme/api")).toBeNull();
  });
});

describe("matching", () => {
  it("lists every command for a bare / and narrows by the first word", () => {
    expect(matching("/").length).toBeGreaterThan(10);
    expect(matching("/co").map((c) => c.name)).toEqual(["connect", "copy"]);
    expect(matching("/connect erp x").map((c) => c.name)).toEqual(["connect"]);
    expect(matching("/ex").map((c) => c.name)).toEqual(["quit"]);
    expect(matching("/zzz")).toEqual([]);
    expect(matching("hello")).toEqual([]);
  });
});

describe("parseSlash", () => {
  const ok = (text: string) => {
    const r = parseSlash(text, TODAY);
    if (!r || !("ok" in r)) throw new Error(`not a command: ${text}`);
    return r.ok;
  };
  const error = (text: string) => {
    const r = parseSlash(text, TODAY);
    return r && "error" in r ? r.error : null;
  };

  it("leaves anything without a slash to the chat", () => {
    expect(parseSlash("refresh", TODAY)).toBeNull();
    expect(parseSlash("standup ran to 45 minutes", TODAY)).toBeNull();
  });

  it("reads the plain commands, in any case", () => {
    expect(ok("/refresh")).toEqual({ name: "refresh" });
    expect(ok("/SEND")).toEqual({ name: "send" });
    expect(ok("slash undo.")).toEqual({ name: "undo" });
    expect(ok("/add")).toEqual({ name: "add" });
    expect(ok("/")).toEqual({ name: "help" });
    expect(ok("/help")).toEqual({ name: "help" });
    expect(ok("/quit")).toEqual({ name: "quit" });
    expect(ok("/exit")).toEqual({ name: "quit" });
    expect(ok("Slash exit.")).toEqual({ name: "quit" });
  });

  it("signs in and out of the ERP and Google", () => {
    expect(ok("/connect erp erp.example.com")).toEqual({
      name: "connect",
      service: "erp",
      url: "erp.example.com",
    });
    expect(ok("/connect ERP at https://erp.example.com")).toEqual({
      name: "connect",
      service: "erp",
      url: "https://erp.example.com",
    });
    expect(ok("/connect erp")).toEqual({ name: "connect", service: "erp" });
    expect(ok("/connect calendar")).toEqual({ name: "connect", service: "google" });
    expect(ok("/disconnect google")).toEqual({ name: "disconnect", service: "google" });
    expect(error("/connect")).toBe("/connect erp or /connect google?");
    expect(error("/disconnect github")).toBe("/disconnect erp or /disconnect google?");
  });

  it("copies as rows to paste, Markdown or CSV", () => {
    expect(ok("/copy")).toEqual({ name: "copy", format: "tsv" });
    expect(ok("/copy md")).toEqual({ name: "copy", format: "md" });
    expect(ok("/copy markdown")).toEqual({ name: "copy", format: "md" });
    expect(ok("/copy csv")).toEqual({ name: "copy", format: "csv" });
    expect(error("/copy pdf")).toContain("md or csv");
  });

  it("goes to a day by word, days ago, weekday or date", () => {
    expect(ok("/today")).toEqual({ name: "date", date: TODAY });
    expect(ok("/yesterday")).toEqual({ name: "date", date: "2026-10-15" });
    expect(ok("/date -3")).toEqual({ name: "date", date: "2026-10-13" });
    expect(ok("/date monday")).toEqual({ name: "date", date: "2026-10-12" });
    expect(ok("/date fri")).toEqual({ name: "date", date: TODAY });
    expect(ok("/date saturday")).toEqual({ name: "date", date: "2026-10-10" });
    expect(ok("/date 2026-09-30")).toEqual({ name: "date", date: "2026-09-30" });
    expect(error("/date")).toContain("Which day?");
    expect(error("/date someday")).toContain("Which day?");
    expect(error("/date 2099-01-01")).toBe("2099-01-01 hasn't happened yet");
  });

  it("opens setup, at a section if one is named", () => {
    expect(ok("/setup")).toEqual({ name: "setup" });
    expect(ok("/setup ERP")).toEqual({ name: "setup", section: "erp" });
    expect(error("/setup colours")).toContain("sources, day, ai, projects, erp");
  });

  it("says when a command doesn't exist or takes nothing", () => {
    expect(error("/frobnicate")).toBe("No command /frobnicate. Type / to see them.");
    expect(error("/refresh now")).toBe("/refresh takes nothing after it.");
  });
});
