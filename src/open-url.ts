import { execa } from "execa";

// Opens a sign-in page in the user's browser. The address can come from a server we don't
// control (an MCP server names its own authorization endpoint), so it is checked, and no shell
// ever sees it: on Windows `cmd /c start` would treat `&` and `|` in it as commands.

/** The program and arguments that open `url` on this platform; throws for anything but http(s). */
export function openCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): { cmd: string; args: string[] } {
  const href = httpHref(url);
  if (platform === "darwin") return { cmd: "open", args: [href] };
  // rundll32 takes the address as its own argument; there is no shell to read `&` in it.
  if (platform === "win32") return { cmd: "rundll32", args: ["url.dll,FileProtocolHandler", href] };
  return { cmd: "xdg-open", args: [href] };
}

/** The normalised address, only if it is http(s). */
function httpHref(url: string): string {
  const parsed = URL.canParse(url) ? new URL(url) : null;
  if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:"))
    throw new Error("Clockout only opens http(s) addresses in the browser.");
  return parsed.href;
}

/**
 * Opens a URL in the default browser. Refuses anything that isn't http(s) (throws); a browser
 * that can't be started is not an error, since the callers show the address too.
 */
export async function openUrl(url: string): Promise<void> {
  const { cmd, args } = openCommand(url);
  await execa(cmd, args).catch(() => undefined);
}
