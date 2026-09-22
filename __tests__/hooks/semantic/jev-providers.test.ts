// @vitest-environment node
//
// The BYOK provider layer, one provider at a time, against a mocked fetch:
// request shape, auth header, answer parsing, version handling, and the
// 429 / 402 / 5xx mapping that decides when a hook falls back to regex.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JevConfig } from "../../../src/hooks/semantic/jev-config";
import {
  CLOUDFLARE_JEV_MODEL,
  JEV_PROVIDER_DEFAULTS,
  JevError,
  OPENROUTER_PROVIDER_PREFS,
  VERCEL_JEV_MODEL,
  displayEndpoint,
  jevRoute,
  readAnswers,
  transportForConfig,
} from "../../../src/hooks/semantic/jev-client";
import { evaluateSemantic } from "../../../src/hooks/semantic/evaluator";
import type { JevRequest, JevResponse } from "../../../src/hooks/semantic/types";

const KEY = ["prov", "test", "abcdef0123456789"].join("-");
const ACCOUNT = "0123456789abcdef0123456789abcdef";

const request: JevRequest = {
  model: "jev-1.13.0",
  state: { tool: "Bash" },
  questions: { a: { type: "noul", instructions: "a" }, b: { type: "noul", instructions: "b" } },
};

interface Seen {
  url: string;
  method: string;
  auth: string | null;
  contentType: string | null;
  body: Record<string, unknown>;
}

const realFetch = globalThis.fetch;
let seen: Seen[] = [];

function reply(body: unknown, status = 200): void {
  seen = [];
  globalThis.fetch = (async (url: string | URL, init: RequestInit) => {
    const headers = new Headers(init.headers);
    seen.push({
      url: String(url),
      method: String(init.method),
      auth: headers.get("authorization"),
      contentType: headers.get("content-type"),
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
}

const signal = () => new AbortController().signal;

async function send(cfg: JevConfig, req: JevRequest = request): Promise<JevResponse> {
  return transportForConfig(cfg).transport(req, signal());
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof JevError) return e.code;
    return `non-jev:${(e as Error).name}`;
  }
  return "no-throw";
}

function codeOfSync(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return e instanceof JevError ? e.code : "non-jev";
  }
  return "no-throw";
}

const answers = { a: { type: "noul", noul: 0.25 }, b: { type: "noul", noul: 0.75 } };

const CONFIGS: Record<string, JevConfig> = {
  typesafe: { provider: "typesafe", apiKey: KEY },
  openrouter: { provider: "openrouter", apiKey: KEY },
  vercel: { provider: "vercel", apiKey: KEY },
  cloudflare: { provider: "cloudflare", apiKey: KEY, accountId: ACCOUNT },
  custom: { provider: "custom", apiKey: KEY, baseUrl: "https://jev.example.com/v1" },
};

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("transportForConfig: request shape per provider", () => {
  it("typesafe: POST api.typesafe.ai/v1/systemone, bearer key, native body with jev-1.13.0", async () => {
    reply({ model: "jev-1.13.0", answers });
    const built = transportForConfig(CONFIGS.typesafe);
    expect(built.via).toBe("typesafe");
    expect(built.model).toBe("jev-1.13.0");
    await built.transport({ ...request, model: built.model }, signal());
    expect(seen[0]).toMatchObject({
      url: "https://api.typesafe.ai/v1/systemone",
      method: "POST",
      auth: `Bearer ${KEY}`,
      contentType: "application/json",
    });
    expect(seen[0].body).toEqual({ model: "jev-1.13.0", state: request.state, questions: request.questions });
  });

  it("openrouter: POST openrouter.ai/api/v1/systemone with typesafe/jev-1.13 and zero-retention routing", async () => {
    reply({ model: "typesafe/jev-1.13-20260917", answers });
    const built = transportForConfig(CONFIGS.openrouter);
    expect(built.model).toBe("typesafe/jev-1.13");
    await built.transport(request, signal());
    expect(seen[0].url).toBe("https://openrouter.ai/api/v1/systemone");
    expect(seen[0].auth).toBe(`Bearer ${KEY}`);
    expect(seen[0].body).toEqual({
      model: "typesafe/jev-1.13",
      state: request.state,
      questions: request.questions,
      provider: { zdr: true, data_collection: "deny", allow_fallbacks: false },
    });
    expect(OPENROUTER_PROVIDER_PREFS).toEqual({ zdr: true, data_collection: "deny", allow_fallbacks: false });
  });

  it("vercel: POST ai-gateway.vercel.sh/typesafe/v1/systemone with typesafe-ai/jev", async () => {
    reply({ model: VERCEL_JEV_MODEL, answers });
    const built = transportForConfig(CONFIGS.vercel);
    expect(built.model).toBe("typesafe-ai/jev");
    await built.transport(request, signal());
    expect(seen[0].url).toBe("https://ai-gateway.vercel.sh/typesafe/v1/systemone");
    expect(seen[0].auth).toBe(`Bearer ${KEY}`);
    expect(seen[0].body).toEqual({ model: "typesafe-ai/jev", state: request.state, questions: request.questions });
  });

  it("cloudflare: POST the account's /ai/run with {model, input:{state, questions}}", async () => {
    reply({ success: true, errors: [], result: { state: "Completed", result: { model: "jev-1.13.0", answers } } });
    const built = transportForConfig(CONFIGS.cloudflare);
    expect(built.model).toBe(CLOUDFLARE_JEV_MODEL);
    await built.transport(request, signal());
    expect(seen[0].url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run`);
    expect(seen[0].auth).toBe(`Bearer ${KEY}`);
    expect(seen[0].body).toEqual({ model: "typesafe/jev", input: { state: request.state, questions: request.questions } });
  });

  it("custom: POST <baseUrl>/systemone with the native body and jev-1.13.0", async () => {
    reply({ model: "jev-1.13.0", answers });
    const built = transportForConfig(CONFIGS.custom);
    expect(built.via).toBe("custom");
    await built.transport(request, signal());
    expect(seen[0].url).toBe("https://jev.example.com/v1/systemone");
    expect(seen[0].auth).toBe(`Bearer ${KEY}`);
    expect(seen[0].body).toEqual({ model: "jev-1.13.0", state: request.state, questions: request.questions });
  });

  it("sends the configured model whatever the request carries", async () => {
    // The evaluator reads FAILPROOFAI_JEV_MODEL when no model is passed; the
    // transport must not let that (or anything else) change what is asked for.
    reply({ model: "typesafe/jev-1.13-20260917", answers });
    await send(CONFIGS.openrouter, { ...request, model: "attacker-chosen" });
    expect(seen[0].body.model).toBe("typesafe/jev-1.13");
  });

  it("honours a model override and a base URL override", async () => {
    reply({ model: "jev-1.13.1", answers });
    await send({ provider: "typesafe", apiKey: KEY, model: "jev-1.13.1", baseUrl: "https://eu.api.typesafe.ai/v1" });
    expect(seen[0].url).toBe("https://eu.api.typesafe.ai/v1/systemone");
    expect(seen[0].body.model).toBe("jev-1.13.1");
  });

  it("uses a base URL that already names /systemone as is, and keeps a query string out of the path", async () => {
    reply({ model: "jev-1.13.0", answers });
    await send({ provider: "custom", apiKey: KEY, baseUrl: "https://proxy.example.com/jev/v1/systemone" });
    expect(seen[0].url).toBe("https://proxy.example.com/jev/v1/systemone");
    reply({ model: "jev-1.13.0", answers });
    await send({ provider: "custom", apiKey: KEY, baseUrl: "https://proxy.example.com/v1?api-version=2" });
    expect(seen[0].url).toBe("https://proxy.example.com/v1/systemone?api-version=2");
  });

  it("cloudflare: a base URL override replaces the API base", async () => {
    reply({ success: true, result: { model: "jev-1.13.0", answers } });
    await send({ provider: "cloudflare", apiKey: KEY, accountId: ACCOUNT, baseUrl: "https://cf-proxy.example.com/client/v4" });
    expect(seen[0].url).toBe(`https://cf-proxy.example.com/client/v4/accounts/${ACCOUNT}/ai/run`);
  });

  it("refuses an unusable config with JevError('config') instead of building a transport", () => {
    expect(codeOfSync(() => transportForConfig({ provider: "custom", apiKey: KEY }))).toBe("config");
    expect(codeOfSync(() => transportForConfig({ provider: "cloudflare", apiKey: KEY, accountId: "../x" }))).toBe("config");
    expect(codeOfSync(() => transportForConfig({ provider: "typesafe", apiKey: "a b" }))).toBe("config");
    expect(codeOfSync(() => transportForConfig({ provider: "custom", apiKey: KEY, baseUrl: "http://evil.example.com" }))).toBe("config");
  });
});

describe("answer parsing and version handling", () => {
  it("typesafe: accepts any jev-1.13.x, refuses another major/minor or no version", async () => {
    reply({ model: "jev-1.13.4", answers, usage: { input_tokens: 42 } });
    const res = await send(CONFIGS.typesafe);
    expect(readAnswers(request, res)).toEqual({ a: 0.25, b: 0.75 });
    expect(res.modelUnverified).toBeUndefined();
    expect(res.usage?.input_tokens).toBe(42);

    for (const model of ["jev-1.14.0", "jev-2.0.0", "jev-1.12.9", "jev-latest"]) {
      reply({ model, answers });
      const other = await send(CONFIGS.typesafe);
      expect(codeOfSync(() => readAnswers(request, other))).toBe("model-mismatch");
    }
    reply({ answers });
    const unreported = await send(CONFIGS.typesafe);
    expect(codeOfSync(() => readAnswers(request, unreported))).toBe("model-mismatch");
  });

  it("openrouter: accepts the dated 1.13 snapshot, refuses another family", async () => {
    reply({ model: "typesafe/jev-1.13-20260917", answers });
    const res = await send(CONFIGS.openrouter);
    expect(readAnswers(request, res)).toEqual({ a: 0.25, b: 0.75 });
    expect(res.modelUnverified).toBeUndefined();

    reply({ model: "typesafe/jev-1.14-20270101", answers });
    const newer = await send(CONFIGS.openrouter);
    expect(codeOfSync(() => readAnswers(request, newer))).toBe("model-mismatch");
  });

  it("vercel: its unversioned alias (or no model) is accepted and marked unverified; a reported other version is refused", async () => {
    reply({ model: VERCEL_JEV_MODEL, answers });
    const alias = await send(CONFIGS.vercel);
    expect(alias.modelUnverified).toBe(true);
    expect(readAnswers(request, alias)).toEqual({ a: 0.25, b: 0.75 });

    reply({ answers });
    const bare = await send(CONFIGS.vercel);
    expect(bare.modelUnverified).toBe(true);
    expect(bare.model).toBe("typesafe-ai/jev");

    reply({ model: "jev-1.13.0", answers });
    const versioned = await send(CONFIGS.vercel);
    expect(versioned.modelUnverified).toBeUndefined();
    expect(readAnswers(request, versioned)).toEqual({ a: 0.25, b: 0.75 });

    reply({ model: "typesafe-ai/jev-2.0", answers });
    const other = await send(CONFIGS.vercel);
    expect(other.modelUnverified).toBeUndefined();
    expect(codeOfSync(() => readAnswers(request, other))).toBe("model-mismatch");
  });

  it("cloudflare: a reported version is checked; the alias or no model is unverified", async () => {
    reply({ success: true, result: { state: "Completed", result: { model: "jev-1.13.0", answers } } });
    const versioned = await send(CONFIGS.cloudflare);
    expect(versioned.modelUnverified).toBeUndefined();
    expect(readAnswers(request, versioned)).toEqual({ a: 0.25, b: 0.75 });

    reply({ success: true, result: { model: CLOUDFLARE_JEV_MODEL, answers } });
    const alias = await send(CONFIGS.cloudflare);
    expect(alias.modelUnverified).toBe(true);
    expect(readAnswers(request, alias)).toEqual({ a: 0.25, b: 0.75 });

    reply({ success: true, result: { model: "jev-1.14.0", answers } });
    const other = await send(CONFIGS.cloudflare);
    expect(codeOfSync(() => readAnswers(request, other))).toBe("model-mismatch");
  });

  it("custom: its own configured name echoed back is unverified; a real version is checked", async () => {
    const cfg: JevConfig = { provider: "custom", apiKey: KEY, baseUrl: "https://jev.example.com/v1", model: "house-jev" };
    reply({ model: "house-jev", answers });
    const echo = await send(cfg);
    expect(echo.modelUnverified).toBe(true);
    expect(readAnswers(request, echo)).toEqual({ a: 0.25, b: 0.75 });

    reply({ model: "jev-1.13.2", answers });
    expect((await send(cfg)).modelUnverified).toBeUndefined();

    reply({ model: "some-other-model", answers });
    const other = await send(cfg);
    expect(codeOfSync(() => readAnswers(request, other))).toBe("model-mismatch");
  });

  it("never trusts a modelUnverified flag sent by the server", async () => {
    reply({ model: "jev-9.9.9", answers, modelUnverified: true });
    const res = await send(CONFIGS.typesafe);
    expect(res.modelUnverified).toBeUndefined();
    expect(codeOfSync(() => readAnswers(request, res))).toBe("model-mismatch");
  });

  it("still requires every answer in range", async () => {
    reply({ model: "jev-1.13.0", answers: { a: { noul: 0.1 } } });
    expect(codeOfSync(() => readAnswers(request, { model: "jev-1.13.0", answers: { a: { noul: 0.1 } } }))).toBe("malformed");
    reply({ model: "jev-1.13.0", answers: { a: { noul: 0.1 }, b: { noul: Number.NaN } } });
    const res = await send(CONFIGS.typesafe);
    expect(codeOfSync(() => readAnswers(request, res))).toBe("malformed");
  });
});

describe("errors: 429, 402, 5xx and friends", () => {
  it.each(Object.keys(CONFIGS))("%s: 429 → JevError http-429", async (name) => {
    reply({ error: { message: "rate limited" } }, 429);
    expect(await codeOf(send(CONFIGS[name]))).toBe("http-429");
  });

  it.each(Object.keys(CONFIGS))("%s: 402 → JevError out-of-credits", async (name) => {
    reply({ error: { message: "Insufficient credits" } }, 402);
    expect(await codeOf(send(CONFIGS[name]))).toBe("out-of-credits");
  });

  it.each(Object.keys(CONFIGS))("%s: 5xx → JevError http-5xx, JSON body or not", async (name) => {
    reply({ error: { message: "upstream exploded" } }, 502);
    expect(await codeOf(send(CONFIGS[name]))).toBe("http-502");
    reply("<html>Service Unavailable</html>", 503);
    expect(await codeOf(send(CONFIGS[name]))).toBe("http-503");
    reply("", 500);
    expect(await codeOf(send(CONFIGS[name]))).toBe("http-500");
  });

  it("402 with a non-JSON body is still out-of-credits", async () => {
    reply("Payment Required", 402);
    expect(await codeOf(send(CONFIGS.openrouter))).toBe("out-of-credits");
  });

  it("an error reported inside a 200 body is not an answer", async () => {
    reply({ error: { code: 402, message: "out of credits" } });
    expect(await codeOf(send(CONFIGS.openrouter))).toBe("out-of-credits");
    reply({ error: { code: 429, message: "slow down" } });
    expect(await codeOf(send(CONFIGS.openrouter))).toBe("http-429");
    reply({ error: { code: 503, message: "no provider" } });
    expect(await codeOf(send(CONFIGS.openrouter))).toBe("http-503");
    reply({ error: { message: "something" } });
    expect(await codeOf(send(CONFIGS.vercel))).toBe("upstream-error");
    reply({ nothing: true });
    expect(await codeOf(send(CONFIGS.typesafe))).toBe("malformed");
    reply("not json at all");
    expect(await codeOf(send(CONFIGS.typesafe))).toBe("malformed");
  });

  it("maps a network failure and an abort", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await codeOf(send(CONFIGS.typesafe))).toBe("network");

    globalThis.fetch = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as unknown as typeof fetch;
    const ctl = new AbortController();
    const pending = transportForConfig(CONFIGS.typesafe).transport(request, ctl.signal);
    ctl.abort();
    expect(await codeOf(pending)).toBe("timeout");
  });

  it("scrubs the key from any provider error text", async () => {
    reply({ error: { message: `invalid key ${KEY} for this route` } }, 401);
    try {
      await send(CONFIGS.openrouter);
      throw new Error("expected a JevError");
    } catch (e) {
      expect(e).toBeInstanceOf(JevError);
      expect((e as JevError).code).toBe("http-401");
      expect((e as JevError).message).not.toContain(KEY);
      expect((e as JevError).message).toContain("[key]");
    }
  });
});

describe("routes and display", () => {
  it("names each provider's endpoint and default model", () => {
    expect(jevRoute(CONFIGS.typesafe)).toEqual({ via: "typesafe", endpoint: "https://api.typesafe.ai/v1/systemone", model: "jev-1.13.0", modelIsDefault: true });
    expect(jevRoute(CONFIGS.openrouter).endpoint).toBe("https://openrouter.ai/api/v1/systemone");
    expect(jevRoute(CONFIGS.vercel).endpoint).toBe("https://ai-gateway.vercel.sh/typesafe/v1/systemone");
    expect(jevRoute(CONFIGS.cloudflare).endpoint).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run`);
    expect(jevRoute(CONFIGS.custom).endpoint).toBe("https://jev.example.com/v1/systemone");
    expect(JEV_PROVIDER_DEFAULTS.openrouter.model).toBe("typesafe/jev-1.13");
    expect(jevRoute({ ...CONFIGS.vercel, model: "typesafe-ai/jev" }).modelIsDefault).toBe(false);
  });

  it("hides a query string when displaying an endpoint", () => {
    expect(displayEndpoint("https://proxy.example.com/v1/systemone?token=abc")).toBe("https://proxy.example.com/v1/systemone?…");
    expect(displayEndpoint("https://api.typesafe.ai/v1/systemone")).toBe("https://api.typesafe.ai/v1/systemone");
  });
});

describe("through evaluateSemantic, as the handler will call it", () => {
  let home: string;
  const savedHome = process.env.FAILPROOFAI_HOME;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "fp-jev-prov-"));
    process.env.FAILPROOFAI_HOME = home;
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.FAILPROOFAI_HOME;
    else process.env.FAILPROOFAI_HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  const input = {
    eventType: "PreToolUse",
    toolName: "Bash",
    toolInput: { command: "rm -rf ./build" },
    cwd: "/work/project",
    userSaid: ["clean the build output"],
  };

  /** Answer every question asked, low, in the provider's own envelope. */
  function answerAll(provider: string, model: string, status = 200) {
    seen = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { questions?: Record<string, unknown>; input?: { questions: Record<string, unknown> } };
      seen.push({ url, method: "POST", auth: null, contentType: null, body: body as Record<string, unknown> });
      const qs = body.questions ?? body.input?.questions ?? {};
      const out = Object.fromEntries(Object.keys(qs).map((id) => [id, { type: "noul", noul: 0.01 }]));
      const native = { model, answers: out };
      const payload = provider === "cloudflare" ? { success: true, result: { state: "Completed", result: native } } : native;
      return new Response(JSON.stringify(payload), { status });
    }) as typeof fetch;
  }

  it.each([
    ["typesafe", "jev-1.13.0", true],
    ["openrouter", "typesafe/jev-1.13-20260917", true],
    ["vercel", "typesafe-ai/jev", false],
    ["cloudflare", "jev-1.13.0", true],
    ["custom", "jev-1.13.0", true],
  ])("%s answers → ok, modelVerified %s", async (provider, model, verified) => {
    answerAll(provider, model);
    const built = transportForConfig(CONFIGS[provider]);
    const out = await evaluateSemantic(input, { transport: built.transport, model: built.model, intent: "v1" });
    expect(out.status).toBe("ok");
    if (out.status === "ok") {
      expect(out.modelVerified).toBe(verified);
      expect(out.questionCount).toBeGreaterThan(0);
    }
    expect(seen.length).toBe(1);
  });

  it("402 → degraded with reason out-of-credits", async () => {
    reply({ error: { message: "Insufficient credits" } }, 402);
    const built = transportForConfig(CONFIGS.openrouter);
    const out = await evaluateSemantic(input, { transport: built.transport, model: built.model, intent: "v1" });
    expect(out).toMatchObject({ status: "degraded", reason: "out-of-credits" });
  });

  it("429 and 5xx → degraded (the caller falls back to regex)", async () => {
    const built = transportForConfig(CONFIGS.typesafe);
    reply({}, 429);
    expect(await evaluateSemantic(input, { transport: built.transport, model: built.model, intent: "v1" })).toMatchObject({ status: "degraded", reason: "http-429" });
    reply({}, 503);
    expect(await evaluateSemantic(input, { transport: built.transport, model: built.model, intent: "v1" })).toMatchObject({ status: "degraded", reason: "http-503" });
  });

  it("a different major/minor → degraded with reason model-mismatch", async () => {
    answerAll("typesafe", "jev-1.14.0");
    const built = transportForConfig(CONFIGS.typesafe);
    const out = await evaluateSemantic(input, { transport: built.transport, model: built.model, intent: "v1" });
    expect(out).toMatchObject({ status: "degraded", reason: "model-mismatch" });
  });
});
