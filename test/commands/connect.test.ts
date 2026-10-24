import { describe, expect, it } from "vitest";
import { erpOrigin } from "../../src/commands/connect";

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
