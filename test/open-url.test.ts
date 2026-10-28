import { describe, expect, it } from "vitest";
import { openCommand, openUrl } from "../src/open-url";

describe("opening a sign-in page", () => {
  const url = "https://auth.example.com/authorize?client_id=c&state=s&scope=a%20b";

  it("builds the command each platform uses", () => {
    expect(openCommand(url, "darwin")).toEqual({ cmd: "open", args: [url] });
    expect(openCommand(url, "linux")).toEqual({ cmd: "xdg-open", args: [url] });
    expect(openCommand(url, "win32")).toEqual({
      cmd: "rundll32",
      args: ["url.dll,FileProtocolHandler", url],
    });
  });

  it("never uses cmd.exe on Windows, so & and | stay part of the address", () => {
    const hostile = "https://evil.example/a&calc.exe&b|c";
    const { cmd, args } = openCommand(hostile, "win32");
    expect(cmd).not.toMatch(/cmd/i);
    expect(args).not.toContain("/c");
    expect(args.at(-1)).toBe(hostile);
  });

  it("passes the normalised address, so a quote can't end it early", () => {
    const { args } = openCommand('https://x.example/a"b c', "win32");
    expect(args.at(-1)).toBe("https://x.example/a%22b%20c");
  });

  it("refuses anything that isn't http(s)", async () => {
    for (const bad of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "calc.exe",
      "ms-msdt:/id PCWDiagnostic",
      "data:text/html,hi",
      "",
    ]) {
      expect(() => openCommand(bad, "win32")).toThrow("only opens http(s)");
      await expect(openUrl(bad)).rejects.toThrow("only opens http(s)");
    }
  });
});
