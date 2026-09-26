// @vitest-environment node
/**
 * The FailproofAI Cloud route against a real socket: `POST
 * <origin>/enforcement/v1/jev/systemone`, one synchronous request whose
 * response body is the answer (contract §2).
 *
 * What is pinned is what the CLI half owns:
 *
 *   - the request is TypeSafe's native body `{model, state, questions}` at
 *     `<baseUrl>/systemone`, with the machine key as a bearer and nowhere else
 *     — not the body, not the URL, not another header;
 *   - a 200 is used only when it names a Jev 1.13 model; another model, an
 *     alias, or no model at all is `model-mismatch`;
 *   - every other status the server documents is a `JevError` with a stable
 *     code — 402 → `out-of-credits`, the rest `http-<status>` — so the caller
 *     falls back to the regex verdict;
 *   - a redirect is refused and its target never contacted.
 *
 * Every fallback code here must be one the activity store keeps
 * (`normalizeJevFallbackReason`), or it would ship as `other`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JevConfig } from "../../../src/hooks/semantic/jev-config";
import {
  JEV_CLOUD_RETRY_AFTER_CAP_MS,
  JEV_CLOUD_RETRY_AFTER_DEFAULT_MS,
  JevError,
  JEV_PROVIDER_DEFAULTS,
  readAnswers,
  resetJevCloudCooldown,
  retryAfterMs,
  transportForConfig,
} from "../../../src/hooks/semantic/jev-client";
import { startJevReview } from "../../../src/hooks/semantic/jev-review";
import { resetJevThrottle } from "../../../src/hooks/semantic/jev-throttle";
import { normalizeJevFallbackReason } from "../../../src/hooks/jev-activity";
import type { JevRequest } from "../../../src/hooks/semantic/types";

// Built at runtime: this repo's own hooks refuse secret-shaped literals.
const KEY = ["fp", "machine", "c10ud0123456789ab"].join("-");

interface Hit {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

const request: JevRequest = {
  model: "jev-1.13.0",
  state: { tool: "Bash", agent_request: { command: "ls" } },
  questions: { a: { type: "noul", instructions: "Is this a directory listing?" } },
};

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

/** Answers every question the request carries, as TypeSafe would. */
function answersFor(body: string, p = 0.01): Record<string, { type: "noul"; noul: number }> {
  const parsed = JSON.parse(body) as { questions?: Record<string, unknown> };
  return Object.fromEntries(Object.keys(parsed.questions ?? {}).map((id) => [id, { type: "noul" as const, noul: p }]));
}

describe("the FailproofAI Cloud route, over a real socket", () => {
  const hits: Hit[] = [];
  const elsewhereHits: Hit[] = [];
  let reply: (hit: Hit) => Reply = () => ({ status: 500 });
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const hit = { method: String(req.method), url: String(req.url), headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
      hits.push(hit);
      const r = reply(hit);
      res.writeHead(r.status, { "content-type": "application/json", ...(r.headers ?? {}) });
      res.end(r.body === undefined ? "" : typeof r.body === "string" ? r.body : JSON.stringify(r.body));
    });
  });
  const elsewhere = createServer((req, res) => {
    elsewhereHits.push({ method: String(req.method), url: String(req.url), headers: req.headers, body: "" });
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: "jev-1.13.0", answers: { a: { type: "noul", noul: 0.99 } } }));
  });
  let port = 0;
  let elsewherePort = 0;
  let home: string;
  let prevHome: string | undefined;

  beforeAll(async () => {
    port = await listen(server);
    elsewherePort = await listen(elsewhere);
  });
  afterAll(() => {
    server.close();
    elsewhere.close();
  });
  beforeEach(() => {
    // The 429 cool-down is module state: one test's Retry-After must not hold
    // the next test's first call back.
    resetJevCloudCooldown();
    hits.length = 0;
    elsewhereHits.length = 0;
    prevHome = process.env.FAILPROOFAI_HOME;
    home = mkdtempSync(join(tmpdir(), "fp-jev-cloud-transport-"));
    process.env.FAILPROOFAI_HOME = join(home, ".failproofai");
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.FAILPROOFAI_HOME;
    else process.env.FAILPROOFAI_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  /** The config the loader produces for a connected machine (plain http to loopback: shadow only). */
  const cloud = (): JevConfig => ({
    provider: "failproofai",
    apiKey: KEY,
    baseUrl: `http://127.0.0.1:${port}/enforcement/v1/jev`,
    mode: "shadow",
    timeoutMs: 3000,
    // The loader records the origin of the credential it validated against.
    credentialOrigin: `http://127.0.0.1:${port}`,
  });

  const send = () => transportForConfig(cloud()).transport(request, AbortSignal.timeout(5_000));

  async function failure(p: Promise<unknown>): Promise<JevError> {
    try {
      await p;
    } catch (e) {
      expect(e).toBeInstanceOf(JevError);
      expect((e as JevError).message).not.toContain(KEY);
      return e as JevError;
    }
    throw new Error("expected a JevError");
  }

  it("pins jev-1.13.0 and no default base", () => {
    expect(JEV_PROVIDER_DEFAULTS.failproofai).toEqual({ baseUrl: null, model: "jev-1.13.0" });
  });

  it("POSTs the native body to <base>/systemone, with the key as the bearer and nowhere else", async () => {
    reply = (hit) => ({ status: 200, body: { model: "jev-1.13.0", answers: answersFor(hit.body, 0.97), usage: { input_tokens: 12 } } });
    const res = await send();
    expect(readAnswers(request, res)).toEqual({ a: 0.97 });
    expect(res.modelUnverified).toBeUndefined();

    expect(hits).toHaveLength(1);
    const [hit] = hits;
    expect(hit.method).toBe("POST");
    expect(hit.url).toBe("/enforcement/v1/jev/systemone");
    expect(hit.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(hit.headers["content-type"]).toBe("application/json");
    const body = JSON.parse(hit.body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["model", "questions", "state"]);
    expect(body.model).toBe("jev-1.13.0");
    // The key is in the Authorization header and in nothing else that left.
    expect(hit.body).not.toContain(KEY);
    expect(hit.url).not.toContain(KEY);
    for (const [name, value] of Object.entries(hit.headers)) {
      if (name === "authorization") continue;
      expect(String(value), name).not.toContain(KEY);
    }
  });

  it.each([
    ["another Jev family", { model: "jev-1.14.0" }],
    ["an unversioned alias", { model: "jev" }],
    ["another vendor's model", { model: "gpt-4o" }],
    ["no model at all", {}],
  ])("a 200 naming %s is model-mismatch — Cloud always reports the pinned model", async (_name, extra) => {
    reply = (hit) => ({ status: 200, body: { ...extra, answers: answersFor(hit.body) } });
    const res = await send();
    let code = "";
    try {
      readAnswers(request, res);
    } catch (e) {
      code = (e as JevError).code;
    }
    expect(code).toBe("model-mismatch");
  });

  it("accepts any 1.13 patch the server passes through", async () => {
    reply = (hit) => ({ status: 200, body: { model: "jev-1.13.7", answers: answersFor(hit.body, 0.2) } });
    expect(readAnswers(request, await send())).toEqual({ a: 0.2 });
  });

  it.each([
    ["an empty body", undefined],
    ["a JSON body", { detail: "Not Found" }],
  ])("a 404 (%s) does not blame a base URL nobody configured", async (_label, body) => {
    // Cloud's base URL comes from the connection and `jev setup` refuses to
    // change it; the likely cause is a server that predates the Jev route.
    reply = () => ({ status: 404, body });
    const e = await failure(send());
    expect(e.code).toBe("http-404");
    expect(e.message).toContain("/enforcement/v1/jev/systemone");
    expect(e.message).not.toContain("base URL you configured");
  });

  it("402 out_of_credits is out-of-credits, not provider-refused", async () => {
    reply = () => ({ status: 402, body: { error: "out_of_credits" } });
    const e = await failure(send());
    expect(e.code).toBe("out-of-credits");
    expect(normalizeJevFallbackReason(e.code)).toBe("out-of-credits");
  });

  it.each([
    [400, { error: "bad_request", message: "state is required" }],
    [401, { error: "unauthorized" }],
    [403, { error: "forbidden", message: "this key does not carry jev:evaluate" }],
    [413, { error: "payload_too_large" }],
    [422, { error: "request_rejected" }],
    [429, { error: "rate_limited" }],
    [502, { error: "upstream_error" }],
    [503, { error: "jev_unavailable" }],
  ])("HTTP %s is http-%s, a code the activity store keeps", async (status, body) => {
    const headers: Record<string, string> = status === 429 ? { "retry-after": "17" } : {};
    reply = () => ({ status, body, headers });
    const e = await failure(send());
    expect(e.code).toBe(`http-${status}`);
    expect(normalizeJevFallbackReason(e.code)).toBe(`http-${status}`);
  });

  describe("a 429's Retry-After", () => {
    let clock = 1_000_000;
    let nowSpy: { mockRestore: () => void } | null = null;
    // The throttle's bucket is stamped with this clock too, so it is reset on
    // both sides: a bucket stamped in mocked time would starve the real-time
    // tests after these.
    beforeEach(() => {
      clock = 1_000_000;
      resetJevThrottle();
      nowSpy = vi.spyOn(performance, "now").mockImplementation(() => clock);
    });
    afterEach(() => {
      nowSpy?.mockRestore();
      resetJevThrottle();
    });

    const rateLimited = (retryAfter?: string): Reply => ({
      status: 429,
      body: { error: "rate_limited" },
      headers: retryAfter === undefined ? {} : { "retry-after": retryAfter },
    });
    const answering: (hit: Hit) => Reply = (hit) => ({ status: 200, body: { model: "jev-1.13.0", answers: answersFor(hit.body, 0.3) } });

    it("holds the Cloud route back for as long as it asks — http-429, and nothing sent — then asks again", async () => {
      reply = () => rateLimited("30");
      expect((await failure(send())).code).toBe("http-429");
      expect(hits).toHaveLength(1);

      reply = answering;
      const held = await failure(send());
      expect(held.code).toBe("http-429");
      expect(held.message).toContain("Retry-After");
      expect(normalizeJevFallbackReason(held.code)).toBe("http-429");
      clock += 29_000;
      expect((await failure(send())).code).toBe("http-429");
      expect(hits).toHaveLength(1);

      clock += 1_001;
      expect(readAnswers(request, await send())).toEqual({ a: 0.3 });
      expect(hits).toHaveLength(2);
    });

    it("a missing or unreadable one is a short default; a long one is capped", async () => {
      for (const header of [undefined, "soon", "-5"]) {
        resetJevCloudCooldown();
        hits.length = 0;
        reply = () => rateLimited(header);
        await failure(send());
        reply = answering;
        clock += JEV_CLOUD_RETRY_AFTER_DEFAULT_MS - 1;
        expect((await failure(send())).code, String(header)).toBe("http-429");
        clock += 2;
        await send();
        expect(hits, String(header)).toHaveLength(2);
      }

      resetJevCloudCooldown();
      hits.length = 0;
      reply = () => rateLimited("86400");
      await failure(send());
      reply = answering;
      clock += JEV_CLOUD_RETRY_AFTER_CAP_MS + 1;
      await send();
      expect(hits).toHaveLength(2);
    });

    it("reads delay-seconds and an HTTP-date, and nothing else", () => {
      const now = Date.parse("Fri, 25 Sep 2026 12:00:00 GMT");
      expect(retryAfterMs("17", now)).toBe(17_000);
      expect(retryAfterMs(" 0 ", now)).toBe(0);
      expect(retryAfterMs("Fri, 25 Sep 2026 12:00:10 GMT", now)).toBe(10_000);
      expect(retryAfterMs("Fri, 25 Sep 2026 11:00:00 GMT", now)).toBe(0);
      expect(retryAfterMs("3600", now)).toBe(JEV_CLOUD_RETRY_AFTER_CAP_MS);
      for (const garbage of [null, undefined, "", "1.5", "-5", "later", "2026-09-25T12:00:10Z"]) {
        expect(retryAfterMs(garbage, now), String(garbage)).toBe(JEV_CLOUD_RETRY_AFTER_DEFAULT_MS);
      }
    });

    it("a 503 is an operator state: held back as http-503, a minute without a Retry-After", async () => {
      reply = () => ({ status: 503, body: { error: "jev_unavailable" } });
      expect((await failure(send())).code).toBe("http-503");
      reply = answering;
      clock += JEV_CLOUD_RETRY_AFTER_CAP_MS - 1;
      const held = await failure(send());
      // The stored cause, never a rate limit it was not.
      expect(held.code).toBe("http-503");
      expect(hits).toHaveLength(1);
      clock += 2;
      await send();
      expect(hits).toHaveLength(2);

      resetJevCloudCooldown();
      hits.length = 0;
      reply = () => ({ status: 503, body: { error: "jev_unavailable" }, headers: { "retry-after": "10" } });
      await failure(send());
      reply = answering;
      clock += 10_001;
      await send();
      expect(hits).toHaveLength(2);
    });

    it("holds back only the endpoint that said it", async () => {
      reply = () => rateLimited("30");
      await failure(send());
      reply = answering;
      const other: JevConfig = { ...cloud(), baseUrl: `http://127.0.0.1:${port}/other/enforcement/v1/jev` };
      await transportForConfig(other).transport(request, AbortSignal.timeout(5_000));
      expect(hits).toHaveLength(2);
    });

    it("a BYOK route's 429 is exactly what it was: no cool-down", async () => {
      const byok: JevConfig = { provider: "custom", apiKey: KEY, baseUrl: `http://127.0.0.1:${port}/v1`, mode: "shadow", timeoutMs: 3000 };
      const sendByok = () => transportForConfig(byok).transport(request, AbortSignal.timeout(5_000));
      reply = () => rateLimited("30");
      expect((await failure(sendByok())).code).toBe("http-429");
      reply = () => ({ status: 200, body: { model: "jev-1.13.0", answers: { a: { type: "noul", noul: 0.4 } } } });
      await sendByok();
      expect(hits).toHaveLength(2);
    });

    it("through the review a hook runs, the held-back call is a fallback with http-429 and sends nothing", async () => {
      const call = (command: string) => ({
        eventType: "PreToolUse",
        toolName: "Bash",
        toolInput: { command },
        cwd: home,
        sessionId: `cloud-retry-after-${command.length}`,
        cli: "claude",
      });
      reply = () => rateLimited("30");
      const first = await startJevReview(cloud(), call("rm -rf ./build-output-for-the-retry-after-test")).review;
      expect(first).toMatchObject({ kind: "fallback", reason: "http-429" });
      const sent = hits.length;
      expect(sent).toBeGreaterThan(0);

      reply = answering;
      clock += 1_000; // past the local rate limiter's refill, well inside the 30 s window
      const second = await startJevReview(cloud(), call("rm -rf ./build-output-for-the-retry-after-test-two")).review;
      expect(second).toMatchObject({ kind: "fallback", reason: "http-429" });
      expect(hits).toHaveLength(sent);
    });
  });

  it("a non-JSON error body is still its status", async () => {
    reply = () => ({ status: 503, body: "<html>bad gateway</html>" });
    expect((await failure(send())).code).toBe("http-503");
  });

  it("a 403 says which permission is missing, in the server's own words", async () => {
    reply = () => ({ status: 403, body: { error: "forbidden", message: "this key does not carry jev:evaluate" } });
    const e = await failure(send());
    expect(e.code).toBe("http-403");
    expect(e.message).toBe("forbidden: this key does not carry jev:evaluate");
  });

  it("an error body that echoes the key does not carry it into the message", async () => {
    reply = () => ({ status: 403, body: { error: "forbidden", message: `key ${KEY} lacks jev:evaluate` } });
    const e = await failure(send());
    expect(e.code).toBe("http-403");
    expect(e.message).toContain("[key]");
  });

  it.each([301, 302, 303, 307, 308])("a %s redirect is refused, and its target never contacted", async (status) => {
    reply = () => ({ status, headers: { location: `http://127.0.0.1:${elsewherePort}/enforcement/v1/jev/systemone` } });
    const e = await failure(send());
    expect(e.code).toBe(`http-${status}`);
    expect(e.message).toContain("redirect, which is never followed");
    expect(elsewhereHits).toHaveLength(0);
  });

  describe("through the two-tier review, as a hook runs it", () => {
    const call = (command: string) => ({
      eventType: "PreToolUse",
      toolName: "Bash",
      toolInput: { command },
      cwd: home,
      sessionId: `cloud-transport-${command.length}-${Date.now()}`,
      cli: "claude",
    });

    it("an answer is an answered review naming the model that answered", async () => {
      reply = (hit) => ({ status: 200, body: { model: "jev-1.13.0", answers: answersFor(hit.body, 0.01) } });
      const review = await startJevReview(cloud(), call("rm -rf ./build-output-for-the-cloud-answer-test")).review;
      expect(hits.length).toBeGreaterThan(0);
      expect(review.kind).toBe("answered");
      expect(review.kind === "answered" && review.model).toBe("jev-1.13.0");
    });

    it("an out-of-credits org is a fallback with a code, never a verdict", async () => {
      reply = () => ({ status: 402, body: { error: "out_of_credits" } });
      const review = await startJevReview(cloud(), call("rm -rf ./build-output-for-the-cloud-credits-test")).review;
      expect(hits.length).toBeGreaterThan(0);
      expect(review).toMatchObject({ kind: "fallback", reason: "out-of-credits" });
    });

    it("a revoked key is a fallback too", async () => {
      reply = () => ({ status: 401, body: { error: "unauthorized" } });
      const review = await startJevReview(cloud(), call("rm -rf ./build-output-for-the-cloud-revoked-test")).review;
      expect(review).toMatchObject({ kind: "fallback", reason: "http-401" });
    });
  });
});
