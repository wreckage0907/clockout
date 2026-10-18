import { describe, expect, it } from "vitest";
import { resolvePaths, tildify } from "../../src/config/paths";

describe("resolvePaths", () => {
  it("defaults to ~/.config and ~/.local/share", () => {
    expect(resolvePaths({}, "/home/dev")).toEqual({
      configFile: "/home/dev/.config/clockout/config.toml",
      dataDir: "/home/dev/.local/share/clockout",
    });
  });

  it("respects XDG variables and CLOCKOUT_CONFIG", () => {
    expect(
      resolvePaths({ XDG_CONFIG_HOME: "/x/cfg", XDG_DATA_HOME: "/x/data" }, "/home/dev"),
    ).toEqual({
      configFile: "/x/cfg/clockout/config.toml",
      dataDir: "/x/data/clockout",
    });
    expect(resolvePaths({ CLOCKOUT_CONFIG: "/tmp/c.toml" }, "/home/dev").configFile).toBe(
      "/tmp/c.toml",
    );
  });
});

describe("tildify", () => {
  it("shortens paths under home only", () => {
    expect(tildify("/home/dev/.config/clockout", "/home/dev")).toBe("~/.config/clockout");
    expect(tildify("/home/devops/x", "/home/dev")).toBe("/home/devops/x");
  });
});
