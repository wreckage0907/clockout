import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

// The browser half of an OAuth sign-in from a CLI (RFC 8252): a one-shot listener on
// 127.0.0.1 that catches the redirect, with PKCE so the code is useless to anyone else.

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function randomState(): string {
  return randomBytes(16).toString("base64url");
}

export interface Loopback {
  /** Where the server should send you back; register or pass this exactly. */
  redirectUri: string;
  /**
   * Opens the sign-in page and resolves with the code the server redirects back with.
   * `describeError` turns an `error` parameter into the message to throw.
   */
  code(opts: {
    authUrl: string;
    state: string;
    open: (url: string) => Promise<void>;
    /** Shown in the browser tab once it worked, e.g. "Google Calendar". */
    service: string;
    describeError: (error: string | null) => string;
    /** The message when nobody finishes signing in. */
    timedOut: string;
    timeoutMs?: number;
  }): Promise<string>;
  close(): void;
}

/** Listens on a free port on 127.0.0.1; `path` is the redirect URI's path. */
export async function loopback(path = "/"): Promise<Loopback> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const redirectUri = path === "/" ? origin : `${origin}${path}`;
  return {
    redirectUri,
    code: (opts) =>
      new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(opts.timedOut)),
          opts.timeoutMs ?? 5 * 60_000,
        );
        server.on("request", (req, res) => {
          const url = new URL(req.url ?? "/", origin);
          if (url.pathname !== path) {
            res.writeHead(404).end();
            return;
          }
          const error = url.searchParams.get("error");
          const ok =
            !error && url.searchParams.get("state") === opts.state && url.searchParams.get("code");
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(
            ok
              ? `<h1>Clockout is connected to ${escapeHtml(opts.service)}.</h1><p>You can close this tab.</p>`
              : `<h1>Sign-in didn't finish.</h1><p>${escapeHtml(error ?? "Unexpected response")}. Go back to the terminal.</p>`,
          );
          clearTimeout(timer);
          if (ok) resolve(url.searchParams.get("code") as string);
          else reject(new Error(opts.describeError(error)));
        });
        void opts.open(opts.authUrl).catch(reject);
      }),
    close: () => server.close(),
  };
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}
