// @vitest-environment node
//
// A configured endpoint cannot hand the answer to another origin: the POST is
// sent with redirects off, and any 3xx is a JevError (the caller falls back to
// regex). Checked against real sockets, because the danger is fetch's own
// default of following — a mocked fetch would only check the flag.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { JevConfig } from "../../../src/hooks/semantic/jev-config";
import { JevError, transportForConfig } from "../../../src/hooks/semantic/jev-client";
import type { JevRequest } from "../../../src/hooks/semantic/types";

const KEY = ["redir", "test", "abcdef0123456789"].join("-");
const ACCOUNT = "0123456789abcdef0123456789abcdef";

const request: JevRequest = {
  model: "jev-1.13.0",
  state: { tool: "Bash" },
  questions: { a: { type: "noul", instructions: "a" } },
};

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(JevError);
    expect((e as JevError).message).not.toContain(KEY);
    // Said as what it is, not as a generic HTTP failure.
    expect((e as JevError).message).toContain("redirect, which is never followed");
    return (e as JevError).code;
  }
  throw new Error("expected a JevError");
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

describe("the Jev client never follows a redirect", () => {
  // B answers like a real Jev; A redirects every request to B.
  const hitsB: Array<{ url: string; auth: string | undefined }> = [];
  let status = 307;
  const b = createServer((req, res) => {
    hitsB.push({ url: String(req.url), auth: req.headers.authorization });
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: "jev-1.13.0", answers: { a: { type: "noul", noul: 0.99 } } }));
  });
  let bPort = 0;
  const a = createServer((req, res) => {
    req.resume();
    res.writeHead(status, { location: `http://127.0.0.1:${bPort}/systemone` });
    res.end();
  });
  let aPort = 0;

  beforeAll(async () => {
    bPort = await listen(b);
    aPort = await listen(a);
  });
  afterAll(() => {
    a.close();
    b.close();
  });

  const custom = (): JevConfig => ({ provider: "custom", apiKey: KEY, baseUrl: `http://localhost:${aPort}/v1`, mode: "shadow" });

  it.each([307, 308, 302, 301, 303])("HTTP %s from the configured endpoint is an error, and the target is never contacted", async (s) => {
    status = s;
    hitsB.length = 0;
    const code = await codeOf(transportForConfig(custom()).transport(request, AbortSignal.timeout(5_000)));
    expect(code).toBe(`http-${s}`);
    expect(hitsB).toHaveLength(0);
  });

  it("the endpoint that does answer directly still works", async () => {
    hitsB.length = 0;
    const cfg: JevConfig = { provider: "custom", apiKey: KEY, baseUrl: `http://127.0.0.1:${bPort}/v1`, mode: "shadow" };
    const res = await transportForConfig(cfg).transport(request, AbortSignal.timeout(5_000));
    expect(res.answers.a.noul).toBe(0.99);
    expect(hitsB).toHaveLength(1);
    expect(hitsB[0].auth).toBe(`Bearer ${KEY}`);
  });
});

describe("every provider maps a 3xx to a JevError", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const CONFIGS: Record<string, JevConfig> = {
    typesafe: { provider: "typesafe", apiKey: KEY },
    openrouter: { provider: "openrouter", apiKey: KEY },
    vercel: { provider: "vercel", apiKey: KEY },
    cloudflare: { provider: "cloudflare", apiKey: KEY, accountId: ACCOUNT },
    custom: { provider: "custom", apiKey: KEY, baseUrl: "https://jev.example.com/v1" },
  };

  it.each(Object.keys(CONFIGS))("%s", async (name) => {
    const seen: Array<RequestRedirect | undefined> = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      seen.push(init.redirect);
      // What fetch returns for a redirect it was told not to follow.
      return new Response(JSON.stringify({ model: "jev-1.13.0", answers: { a: { type: "noul", noul: 0.5 } } }), {
        status: 302,
        headers: { location: "http://elsewhere.example.com/" },
      });
    }) as unknown as typeof fetch;
    expect(await codeOf(transportForConfig(CONFIGS[name]).transport(request, new AbortController().signal))).toBe("http-302");
    expect(seen).toEqual(["manual"]);
  });
});
