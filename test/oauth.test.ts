import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertLocalIfPlain,
  authServerMetadata,
  loopback,
  OAUTH_TIMEOUT_MS,
  reachError,
  registerPublicClient,
  tokenRequest,
} from "../src/oauth";

const meta = (issuer?: string) => ({
  ...(issuer === undefined ? {} : { issuer }),
  authorization_endpoint: "https://as.example/authorize",
  token_endpoint: "https://as.example/token",
});

describe("authorization server metadata", () => {
  const answer = (body: unknown) => (async () => Response.json(body)) as unknown as typeof fetch;

  it("accepts metadata whose issuer is the one asked for, trailing slash or not", async () => {
    expect(
      await authServerMetadata("https://as.example/", answer(meta("https://as.example"))),
    ).toMatchObject({ token_endpoint: "https://as.example/token" });
    expect(
      await authServerMetadata("https://as.example", answer(meta("https://as.example/"))),
    ).not.toBeNull();
  });

  it("rejects metadata that names another issuer (RFC 8414 3.3)", async () => {
    await expect(
      authServerMetadata("https://as.example", answer(meta("https://other.example"))),
    ).rejects.toThrow("names itself https://other.example, not https://as.example");
  });

  it("gives up on a server that never answers, with a clear message", async () => {
    let signal: AbortSignal | null | undefined;
    const hang = (async (_url: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal;
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }) as typeof fetch;
    await expect(authServerMetadata("https://as.example", hang)).rejects.toThrow(
      `didn't answer within ${OAUTH_TIMEOUT_MS / 1000} seconds`,
    );
    expect(signal).toBeInstanceOf(AbortSignal);
  });
});

describe("requests that carry a secret", () => {
  it("never follow a redirect and have a timeout", async () => {
    const seen: RequestInit[] = [];
    const doFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push(init ?? {});
      return Response.json({ access_token: "a", client_id: "c" });
    }) as typeof fetch;
    await tokenRequest("https://as.example/token", { code: "x" }, doFetch);
    await registerPublicClient("https://as.example/register", "http://127.0.0.1:1", doFetch);
    expect(seen).toHaveLength(2);
    for (const init of seen) {
      expect(init.redirect).toBe("error");
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("explain a redirect, which would have re-sent the code and verifier", async () => {
    let target: Server | undefined;
    let hits = 0;
    const sink = createServer((_req, res) => {
      hits++;
      res.end("{}");
    });
    await new Promise<void>((r) => sink.listen(0, "127.0.0.1", r));
    target = sink;
    const port = (sink.address() as AddressInfo).port;
    const bounce = createServer((_req, res) => {
      res.writeHead(307, { location: `http://127.0.0.1:${port}/steal` }).end();
    });
    await new Promise<void>((r) => bounce.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${(bounce.address() as AddressInfo).port}/token`;
      await expect(tokenRequest(url, { refresh_token: "secret-rt" })).rejects.toThrow(
        "answered with a redirect",
      );
      expect(hits).toBe(0);
    } finally {
      bounce.close();
      target.close();
    }
  });

  it("describe a timeout and an unreachable server in words", () => {
    const timeout = new DOMException("timed out", "TimeoutError");
    expect(reachError("https://as.example/token", timeout).message).toContain("as.example");
    expect(reachError("https://as.example/token", timeout).message).toContain("didn't answer");
    expect(reachError("https://as.example/token", new TypeError("fetch failed")).message).toContain(
      "Couldn't reach",
    );
  });
});

describe("plain http", () => {
  const to =
    (...addresses: string[]) =>
    async () =>
      addresses;

  it("is allowed when the host resolves only to this machine", async () => {
    await expect(assertLocalIfPlain("http://erp.localhost/x", to("127.0.0.1"))).resolves.toBe(
      undefined,
    );
    await expect(assertLocalIfPlain("http://localhost/x", to("::1", "127.0.0.2"))).resolves.toBe(
      undefined,
    );
    await expect(assertLocalIfPlain("http://127.0.0.1:8080/x")).resolves.toBe(undefined);
  });

  it("is refused when the name resolves anywhere else, or not at all", async () => {
    await expect(assertLocalIfPlain("http://erp.localhost/x", to("203.0.113.7"))).rejects.toThrow(
      "erp.localhost doesn't resolve to this machine",
    );
    await expect(
      assertLocalIfPlain("http://erp.localhost/x", to("127.0.0.1", "203.0.113.7")),
    ).rejects.toThrow("doesn't resolve to this machine");
    await expect(assertLocalIfPlain("http://erp.localhost/x", to())).rejects.toThrow(
      "doesn't resolve to this machine",
    );
    await expect(
      assertLocalIfPlain("http://erp.localhost/x", async () => {
        throw new Error("ENOTFOUND");
      }),
    ).rejects.toThrow("doesn't resolve to this machine");
  });

  it("isn't looked at for https", async () => {
    await expect(
      assertLocalIfPlain("https://as.example/x", async () => {
        throw new Error("not called");
      }),
    ).resolves.toBe(undefined);
  });
});

describe("the loopback listener", () => {
  const closers: Array<() => void> = [];
  afterEach(() => {
    for (const close of closers.splice(0)) close();
  });

  async function start() {
    const lb = await loopback("/callback");
    closers.push(lb.close);
    return lb;
  }
  const options = (open: (url: string) => Promise<void>) => ({
    authUrl: "https://as.example/authorize",
    state: "right",
    open,
    service: "Test",
    describeError: (e: string | null) => `failed ${e}`,
    timedOut: "timed out",
    timeoutMs: 5000,
  });

  it("keeps waiting when a request has the wrong state, errors included", async () => {
    const lb = await start();
    const statuses: number[] = [];
    const open = async () => {
      for (const q of ["code=stolen&state=forged", "error=access_denied", "error=x&state=forged"]) {
        statuses.push((await fetch(`${lb.redirectUri}?${q}`)).status);
      }
      statuses.push((await fetch(`${lb.redirectUri}?code=good&state=right`)).status);
    };
    const code = await lb.code(options(open));
    expect(code).toBe("good");
    await new Promise((r) => setTimeout(r, 50));
    expect(statuses).toEqual([400, 400, 400, 200]);
  });

  it("ends with the server's error when it carries the right state", async () => {
    const lb = await start();
    const open = async () => {
      await fetch(`${lb.redirectUri}?error=access_denied&state=right`);
    };
    await expect(lb.code(options(open))).rejects.toThrow("failed access_denied");
  });

  it("ignores requests after the sign-in ended", async () => {
    const lb = await start();
    let late = 0;
    const open = async () => {
      await fetch(`${lb.redirectUri}?code=good&state=right`);
      late = (await fetch(`${lb.redirectUri}?code=again&state=right`)).status;
    };
    expect(await lb.code(options(open))).toBe("good");
    await new Promise((r) => setTimeout(r, 50));
    expect(late).toBe(400);
  });
});
