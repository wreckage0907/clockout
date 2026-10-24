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
