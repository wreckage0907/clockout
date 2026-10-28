import { randomUUID } from "node:crypto";
import { open, readlink, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tildify } from "./config/paths";

/** A readable reason a file couldn't be written, with the system's error kept as the cause. */
export function fileError(file: string, err: unknown, what = tildify(file)): Error {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  const why =
    code === "ENOENT"
      ? "its folder doesn't exist"
      : code === "EACCES" || code === "EPERM" || code === "EROFS"
        ? "permission denied"
        : code === "EISDIR"
          ? "it's a folder; give a file name"
          : code === "ENOSPC"
            ? "the disk is full"
            : "it couldn't be written";
  return new Error(`Can't write ${what}: ${why}.`, { cause: err });
}

/**
 * Where a write to `path` really lands: a note in a vault is often a symlink, and writing should
 * change the file it points to, not replace the link. A path that isn't there yet resolves
 * through its folder.
 */
export async function realTarget(path: string): Promise<string> {
  let current = resolve(path);
  for (let hops = 0; hops < 40; hops++) {
    try {
      return await realpath(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const link = await readlink(current).catch(() => null);
    if (link === null) return join(await realpath(dirname(current)), basename(current));
    // A link whose target isn't there yet: it's the target that gets written.
    current = resolve(dirname(current), link);
  }
  throw Object.assign(new Error(`Too many levels of symbolic links: ${path}`), { code: "ELOOP" });
}

/**
 * Replaces a file all at once: the text goes to a temporary file next to it (with the mode of
 * the file it replaces, or 0600 for a new one) and is renamed over it, so a full disk or a kill
 * mid-write leaves the old file whole. A symlink is followed to its target, not replaced.
 */
export async function writeFileAtomic(path: string, text: string): Promise<void> {
  const target = await realTarget(path);
  const mode = await stat(target).then(
    (s) => s.mode & 0o7777,
    () => 0o600,
  );
  const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    const file = await open(tmp, "wx", mode);
    try {
      await file.writeFile(text);
      // The umask may have taken bits off at creation; the original's mode is what's wanted.
      await file.chmod(mode);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(tmp, target);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
