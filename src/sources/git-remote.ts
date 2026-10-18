import { execa } from "execa";

const cache = new Map<string, Promise<string | undefined>>();

/** "owner/name" for the repo containing `cwd`, from its origin remote. Cached per directory. */
export function repoForDir(cwd: string): Promise<string | undefined> {
  let hit = cache.get(cwd);
  if (!hit) {
    hit = execa("git", ["-C", cwd, "remote", "get-url", "origin"], { timeout: 5000 })
      .then(({ stdout }) => parseRemote(stdout.trim()))
      .catch(() => undefined);
    cache.set(cwd, hit);
  }
  return hit;
}

/** git@github.com:acme/api.git, https://github.com/acme/api(.git), ssh://… → "acme/api" */
export function parseRemote(url: string): string | undefined {
  const m = /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(url);
  return m?.[1];
}
