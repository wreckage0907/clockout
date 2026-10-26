import { describe, expect, it } from "vitest";
import { erpOrigin, signInMcp } from "../../src/commands/connect";
import { configSchema } from "../../src/config/schema";
import { startMockMcp } from "../mock-mcp/server";

const me = { name: "Dev", emails: ["dev@example.com"], timezone: "Asia/Kolkata" };
const nothingOpened = async () => {};

describe("erpOrigin", () => {
  it("takes a bare host or a full address, path and all", () => {
    expect(erpOrigin("erp.example.com")).toBe("https://erp.example.com");
    expect(erpOrigin("https://erp.example.com/app/timesheet.")).toBe("https://erp.example.com");
  });

  it("allows plain http only on this machine", () => {
    expect(erpOrigin("http://erp.localhost")).toBe("http://erp.localhost");
    expect(erpOrigin("http://127.0.0.1:8000")).toBe("http://127.0.0.1:8000");
    expect(() => erpOrigin("http://erp.example.com")).toThrow(/https:\/\//);
    expect(() => erpOrigin("ftp://erp.example.com")).toThrow(/https:\/\//);
  });
});

describe("signing in to an MCP server from the app", () => {
  it("adds the server, and the source that reads your recorded meetings", async () => {
    const mock = await startMockMcp({ open: true });
    const config = configSchema.parse({ me });
    const next = await signInMcp("wispr", mock.url, config, nothingOpened);
    await mock.stop();
    expect(next.mcp).toEqual([{ name: "wispr", url: mock.url }]);
    expect(next.sources).toEqual([{ type: "wispr-flow", server: "wispr" }]);
  });

  it("doesn't add the source twice", async () => {
    const mock = await startMockMcp({ open: true });
    const config = configSchema.parse({
      me,
      sources: [{ type: "wispr-flow", server: "wispr" }],
    });
    const next = await signInMcp("wispr", mock.url, config, nothingOpened);
    await mock.stop();
    expect(next.sources).toHaveLength(1);
  });

  it("leaves a server that isn't a recorder's alone", async () => {
    const mock = await startMockMcp({ open: true });
    const next = await signInMcp("notes", mock.url, configSchema.parse({ me }), nothingOpened);
    await mock.stop();
    expect(next.sources).toEqual([]);
  });
});
