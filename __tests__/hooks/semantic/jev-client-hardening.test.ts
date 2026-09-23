// @vitest-environment node
//
// Review round 1 on the BYOK provider layer: the key never survives into an
// error message by any route (Cloudflare's 200 {success:false} envelope, a job
// state, a reported model id, a network error), a configured Cloudflare model
// reaches the wire, a custom endpoint must say which Jev answered, plain-http
// loopback is shadow-only, and the 64 KiB config cap holds.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JEV_API_KEY_ENV,
  inspectJevConfig,
  jevConfigPath,
  loadJevConfig,
  validateJevConfig,
  type JevConfig,
} from "../../../src/hooks/semantic/jev-config";
import { JevError, readAnswers, scrubSecret, transportForConfig } from "../../../src/hooks/semantic/jev-client";
import type { JevRequest, JevResponse } from "../../../src/hooks/semantic/types";

// Built at runtime: this repo's own hooks refuse secret-shaped literals.
const KEY = ["hard", "tok", "abcdef0123456789XYZ"].join("-");
const ACCOUNT = "0123456789abcdef0123456789abcdef";

const request: JevRequest = {
  model: "jev-1.13.0",
  state: { tool: "Bash" },
  questions: { a: { type: "noul", instructions: "a" } },
};
const answers = { a: { type: "noul", noul: 0.5 } };

const CLOUDFLARE: JevConfig = { provider: "cloudflare", apiKey: KEY, accountId: ACCOUNT };

const realFetch = globalThis.fetch;
let seenBodies: Array<Record<string, unknown>> = [];

function reply(body: unknown, status = 200): void {
  seenBodies = [];
  globalThis.fetch = (async (_url: string | URL, init: RequestInit) => {
    seenBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

async function send(cfg: JevConfig): Promise<JevResponse> {
  return transportForConfig(cfg).transport(request, new AbortController().signal);
}

async function errorOf(p: Promise<unknown>): Promise<JevError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof JevError) return e;
    throw new Error(`expected a JevError, got ${(e as Error).name}`);
  }
  throw new Error("expected a JevError, got an answer");
}

function syncErrorOf(fn: () => unknown): JevError {
  try {
    fn();
  } catch (e) {
    if (e instanceof JevError) return e;
    throw new Error(`expected a JevError, got ${(e as Error).name}`);
  }
  throw new Error("expected a JevError");
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the key never reaches an error message", () => {
  it("cloudflare: a 200 {success:false} whose error text echoes the token is scrubbed", async () => {
    reply({ success: false, errors: [{ message: `Invalid token ${KEY}` }, { message: `and again ${KEY}` }], result: null });
    const e = await errorOf(send(CLOUDFLARE));
    expect(e.code).toBe("cloudflare-error");
    expect(e.message).not.toContain(KEY);
    expect(e.message).toContain("Invalid token [key]");
  });

  it("cloudflare: the same error behind a base URL override (a proxy) is scrubbed too", async () => {
    reply({ success: false, errors: [{ message: `proxy refused ${KEY}` }] });
    const e = await errorOf(send({ ...CLOUDFLARE, baseUrl: "https://cf-proxy.example.com/client/v4" }));
    expect(e.code).toBe("cloudflare-error");
    expect(e.message).not.toContain(KEY);
  });

  it("cloudflare: a job state that echoes the token is scrubbed", async () => {
    reply({ success: true, result: { state: `Failed ${KEY}`, result: null } });
    const e = await errorOf(send(CLOUDFLARE));
    expect(e.code).toBe("cloudflare-incomplete");
    expect(e.message).not.toContain(KEY);
  });

  it("cloudflare: a reported model id that echoes the token never reaches a model-mismatch message", async () => {
    reply({ success: true, result: { state: "Completed", result: { model: `jev-${KEY}`, answers } } });
    const res = await send(CLOUDFLARE);
    expect(res.model).not.toContain(KEY);
    const e = syncErrorOf(() => readAnswers(request, res));
    expect(e.code).toBe("model-mismatch");
    expect(e.message).not.toContain(KEY);
  });

  it("native: a reported model id that echoes the key never reaches a model-mismatch message", async () => {
    reply({ model: KEY, answers });
    const res = await send({ provider: "typesafe", apiKey: KEY });
    expect(res.model).not.toContain(KEY);
    const e = syncErrorOf(() => readAnswers(request, res));
    expect(e.code).toBe("model-mismatch");
    expect(e.message).not.toContain(KEY);
  });

  it.each(["typesafe", "cloudflare"] as const)("%s: a network error whose text carries the key is scrubbed", async (provider) => {
    globalThis.fetch = (async () => {
      throw new TypeError(`fetch failed: proxy said ${KEY}`);
    }) as unknown as typeof fetch;
    const cfg: JevConfig = provider === "cloudflare" ? CLOUDFLARE : { provider, apiKey: KEY };
    const e = await errorOf(send(cfg));
    expect(e.code).toBe("network");
    expect(e.message).not.toContain(KEY);
    expect(e.message).toContain("[key]");
  });

  it("scrubSecret replaces every occurrence, and leaves text alone for a key too short to mean anything", () => {
    expect(scrubSecret(`a ${KEY} b ${KEY}`, KEY)).toBe("a [key] b [key]");
    expect(scrubSecret("abc", "b")).toBe("abc");
  });
});

describe("a configured cloudflare model reaches the request", () => {
  it("sends the configured model, not the alias", async () => {
    const cfg: JevConfig = { ...CLOUDFLARE, model: "typesafe/jev-1.13" };
    reply({ success: true, result: { state: "Completed", result: { model: "jev-1.13.0", answers } } });
    const built = transportForConfig(cfg);
    expect(built.model).toBe("typesafe/jev-1.13");
    await built.transport(request, new AbortController().signal);
    expect(seenBodies[0].model).toBe("typesafe/jev-1.13");
    expect(seenBodies[0]).toEqual({ model: "typesafe/jev-1.13", input: { state: request.state, questions: request.questions } });
  });

  it("with no override, sends the alias", async () => {
    reply({ success: true, result: { model: "jev-1.13.0", answers } });
    await send(CLOUDFLARE);
    expect(seenBodies[0].model).toBe("typesafe/jev");
  });
});

describe("custom: the endpoint must say which Jev answered", () => {
  const custom: JevConfig = { provider: "custom", apiKey: KEY, baseUrl: "https://jev.example.com/v1" };

  it("an answer with no model at all is refused, not accepted as unverified", async () => {
    reply({ answers });
    const res = await send(custom);
    expect(res.modelUnverified).toBeUndefined();
    const e = syncErrorOf(() => readAnswers(request, res));
    expect(e.code).toBe("model-mismatch");
    expect(e.message).toContain("no model id");
  });

  it("the same for a custom endpoint configured with an unversioned name", async () => {
    reply({ answers });
    const res = await send({ ...custom, model: "house-jev" });
    expect(res.modelUnverified).toBeUndefined();
    expect(syncErrorOf(() => readAnswers(request, res)).code).toBe("model-mismatch");
  });

  it("a reported 1.13 version is still verified", async () => {
    reply({ model: "jev-1.13.3", answers });
    const res = await send(custom);
    expect(res.modelUnverified).toBeUndefined();
    expect(readAnswers(request, res)).toEqual({ a: 0.5 });
  });
});

describe("config hardening", () => {
  let home: string;
  const saved: Record<string, string | undefined> = {};
  const ENV = ["FAILPROOFAI_HOME", JEV_API_KEY_ENV];

  beforeEach(() => {
    for (const k of ENV) saved[k] = process.env[k];
    for (const k of ENV) delete process.env[k];
    home = mkdtempSync(join(tmpdir(), "fp-jev-hard-"));
    process.env.FAILPROOFAI_HOME = join(home, ".failproofai");
  });
  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(home, { recursive: true, force: true });
  });

  const write = (text: string) => {
    mkdirSync(join(home, ".failproofai"), { recursive: true, mode: 0o700 });
    writeFileSync(jevConfigPath(), text, { mode: 0o600 });
    chmodSync(jevConfigPath(), 0o600);
  };

  describe("plain http to loopback is accepted in shadow mode only", () => {
    const problem = (obj: unknown) => {
      const r = validateJevConfig(obj);
      return r.ok ? null : r.problem;
    };

    it.each(["http://localhost:8787/v1", "http://127.0.0.1:8787", "http://[::1]:8787"])("%s", (baseUrl) => {
      // enforce, explicit or by default: refused, and the reason says what to do.
      expect(problem({ provider: "custom", apiKey: KEY, baseUrl })).toMatch(/shadow/);
      expect(problem({ provider: "custom", apiKey: KEY, baseUrl, mode: "enforce" })).toMatch(/https/);
      expect(problem({ provider: "typesafe", apiKey: KEY, baseUrl })).toMatch(/shadow/);
      // shadow: accepted; a forged answer there changes no decision.
      expect(problem({ provider: "custom", apiKey: KEY, baseUrl, mode: "shadow" })).toBeNull();
    });

    it("https to loopback is fine in enforce mode: the agent cannot present a trusted certificate", () => {
      expect(problem({ provider: "custom", apiKey: KEY, baseUrl: "https://localhost:8443/v1" })).toBeNull();
    });

    it("a file with loopback http in enforce mode switches Jev off rather than on", () => {
      write(JSON.stringify({ provider: "custom", apiKey: KEY, baseUrl: "http://localhost:8787/v1" }));
      expect(loadJevConfig()).toBeNull();
      const r = inspectJevConfig();
      expect(r.status === "refused" && r.reason).toBe("invalid");
      write(JSON.stringify({ provider: "custom", apiKey: KEY, baseUrl: "http://localhost:8787/v1", mode: "shadow" }));
      expect(loadJevConfig()).toMatchObject({ provider: "custom", mode: "shadow", baseUrl: "http://localhost:8787/v1" });
    });
  });

  describe("the 64 KiB cap", () => {
    const LIMIT = 64 * 1024;
    const padded = (total: number) => {
      const base = { provider: "typesafe", apiKey: KEY, pad: "" };
      const overhead = JSON.stringify(base).length;
      return JSON.stringify({ ...base, pad: "x".repeat(total - overhead) });
    };

    it("refuses a file larger than 64 KiB, without quoting it", () => {
      const text = padded(LIMIT + 1);
      expect(text.length).toBe(LIMIT + 1);
      write(text);
      expect(loadJevConfig()).toBeNull();
      const r = inspectJevConfig();
      expect(r.status).toBe("refused");
      if (r.status === "refused") {
        expect(r.reason).toBe("too-large");
        expect(JSON.stringify(r)).not.toContain(KEY);
      }
    });

    it("reads a file of exactly 64 KiB", () => {
      const text = padded(LIMIT);
      expect(text.length).toBe(LIMIT);
      write(text);
      expect(loadJevConfig()).toMatchObject({ provider: "typesafe", apiKey: KEY });
    });
  });
});
