// @vitest-environment node
//
// Each provider's ACTUAL API contract, one shape at a time, against a mocked
// fetch: the two model-list envelopes, the three error envelopes, the URL a base
// implies, and what a 404 from `<base>/systemone` says.
//
// Every shape asserted here was measured live on 2026-09-25 and the measurement
// is written into `jev-client.ts`'s header; the bodies below are the real ones,
// trimmed. Nothing in this file reaches the network — a test that did would be
// asserting today's weather rather than this build's parsing.
import { describe, it, expect, afterEach } from "vitest";
import {
  JEV_MODEL_LIST_TIMEOUT_MS,
  JEV_PROVIDER_DEFAULTS,
  JevError,
  listDescribesSystemOne,
  modelListHasModel,
  modelsUrlForBase,
  jevModelsUrl,
  parseJevModelList,
  providerErrorDetail,
  readJevModelList,
  transportForConfig,
  type JevModelListRead,
} from "../../../src/hooks/semantic/jev-client";
import { endpointGivenAsBase } from "../../../src/hooks/semantic/jev-config";
import type { JevConfig } from "../../../src/hooks/semantic/jev-config";
import type { JevRequest } from "../../../src/hooks/semantic/types";

const KEY = ["contract", "test", "0123456789abcdef"].join("-");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const signal = () => AbortSignal.timeout(5_000);

/** One canned response for every request, and the URLs it was asked for. */
function serve(body: unknown, status = 200, contentType = "application/json"): { urls: string[]; headers: Array<string | null> } {
  const urls: string[] = [];
  const headers: Array<string | null> = [];
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    urls.push(String(url));
    headers.push(new Headers(init.headers).get("authorization"));
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": contentType } });
  }) as unknown as typeof fetch;
  return { urls, headers };
}

// ── The three list shapes, as measured ───────────────────────────────────────

/** TypeSafe's own, which Vercel's typesafe-scoped base and a LiteLLM passthrough also return. */
const TYPESAFE_LIST = {
  models: [
    { name: "jev-latest", description: "The latest iteration of TypeSafe's System One Model: Jev", release_date: "2026-09-15" },
    { name: "jev-preview", description: "A preview of the next Jev", release_date: "2026-09-20" },
  ],
};
/** Vercel's typesafe-scoped passthrough, which names the model without an owner prefix. */
const VERCEL_LIST = { models: [{ name: "jev", description: "Jev is TypeSafe AI's System One evaluation model…", release_date: "2026-09-15" }] };
/** OpenRouter's, which is OpenAI-shaped. */
const OPENROUTER_LIST = {
  data: [
    { id: "fireworks/ember-1", canonical_slug: "fireworks/ember-1-20260923", name: "Fireworks: Ember-1" },
    { id: "z-ai/glm-5.3-prime", canonical_slug: "z-ai/glm-5.3-prime", name: "Z.AI: GLM 5.3 Prime" },
  ],
};

describe("parseJevModelList: the shapes a provider actually answers in", () => {
  it("reads TypeSafe's own `{models:[{name}]}`", () => {
    expect(parseJevModelList(TYPESAFE_LIST)).toEqual({ ok: true, shape: "typesafe", models: ["jev-latest", "jev-preview"] });
  });

  it("reads OpenAI's `{data:[{id}]}`, preferring the id over the display name", () => {
    expect(parseJevModelList(OPENROUTER_LIST)).toEqual({ ok: true, shape: "openai", models: ["fireworks/ember-1", "z-ai/glm-5.3-prime"] });
  });

  it("falls back to `name` for a `data` entry carrying no id", () => {
    expect(parseJevModelList({ data: [{ name: "jev" }] })).toEqual({ ok: true, shape: "openai", models: ["jev"] });
  });

  it.each([
    ["not an object", "a string body"],
    ["an array", [{ name: "jev" }]],
    ["neither key", { object: "list", things: [{ name: "jev" }] }],
    ["null", null],
  ])("reports %s as unread rather than throwing", (_what, body) => {
    const r = parseJevModelList(body);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/shape|JSON object/);
  });

  it("reports a present-but-empty list as unread, which changes no behaviour", () => {
    // Likelier a shape misread than a provider serving nothing, and "unread" is
    // the reading that refuses nobody.
    for (const body of [{ models: [] }, { data: [] }, { models: [{ description: "no name" }] }]) {
      expect(parseJevModelList(body).ok).toBe(false);
    }
  });

  it("drops a name that is not shaped like a model id — these get printed on a terminal", () => {
    const r = parseJevModelList({ models: [{ name: "jev-ok" }, { name: "esc\u001b[31mape" }, { name: "x".repeat(300) }] });
    expect(r).toMatchObject({ ok: true, shape: "typesafe" });
    if (r.ok) expect(r.models).toEqual(["jev-ok"]);
  });

  it("never lets a name that echoed the key through", () => {
    // Scrubbed first, and the `[key]` marker is then not model-id-shaped, so the
    // name is dropped as well. Both halves matter: the scrub is what holds if the
    // shape rule ever widens.
    const r = parseJevModelList({ models: [{ name: "jev-ok" }, { name: `jev-${KEY}` }] }, KEY);
    if (!r.ok) throw new Error("expected a reading");
    expect(r.models).toEqual(["jev-ok"]);
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it("deduplicates, keeping the provider's order", () => {
    const r = parseJevModelList({ models: [{ name: "jev-latest" }, { name: "jev-latest" }, { name: "jev-preview" }] });
    if (!r.ok) throw new Error("expected a reading");
    expect(r.models).toEqual(["jev-latest", "jev-preview"]);
  });
});

describe("what a list may be used FOR", () => {
  const read = (body: unknown): JevModelListRead => {
    const r = parseJevModelList(body);
    if (!r.ok) throw new Error("expected a reading");
    return r;
  };

  it("only the TypeSafe shape describes <base>/systemone", () => {
    // OpenRouter's 458-model catalog carries no Jev entry of any spelling, while
    // its /systemone exists and this build addresses it as typesafe/jev-1.13 — so
    // refusing on an OpenAI-shaped list would refuse a route that works.
    expect(listDescribesSystemOne(read(TYPESAFE_LIST))).toBe(true);
    expect(listDescribesSystemOne(read(OPENROUTER_LIST))).toBe(false);
    expect(modelListHasModel(read(OPENROUTER_LIST), JEV_PROVIDER_DEFAULTS.openrouter.model)).toBe(false);
  });

  it("a listed `jev` covers a configured `typesafe-ai/jev`, which is the same model at Vercel's other base", () => {
    expect(modelListHasModel(read(VERCEL_LIST), JEV_PROVIDER_DEFAULTS.vercel.model)).toBe(true);
    expect(modelListHasModel(read(VERCEL_LIST), "jev")).toBe(true);
    // Only the owner prefix is forgiven; a different model is still a different model.
    expect(modelListHasModel(read(VERCEL_LIST), "typesafe-ai/jev-preview")).toBe(false);
    expect(modelListHasModel(read(TYPESAFE_LIST), "jev-1.13.0")).toBe(false);
  });
});

describe("readJevModelList", () => {
  it("GETs <base>/models with the key, and parses the answer", async () => {
    const seen = serve(TYPESAFE_LIST);
    const r = await readJevModelList("https://models.aikin.club/typesafe/v1/models", KEY, signal());
    expect(r).toEqual({ ok: true, shape: "typesafe", models: ["jev-latest", "jev-preview"] });
    expect(seen.urls).toEqual(["https://models.aikin.club/typesafe/v1/models"]);
    expect(seen.headers).toEqual([`Bearer ${KEY}`]);
  });

  it("sends no Authorization header when there is no key — Vercel's and OpenRouter's lists are public", async () => {
    const seen = serve(VERCEL_LIST);
    expect(await readJevModelList("https://ai-gateway.vercel.sh/typesafe/v1/models", null, signal())).toMatchObject({ ok: true, models: ["jev"] });
    expect(seen.headers).toEqual([null]);
  });

  it("returns the provider's own words for a failed status, with the key scrubbed", async () => {
    serve({ error: { message: `Authentication Error, no api key ${KEY}`, type: "auth_error", code: "401" } }, 401);
    const r = await readJevModelList("https://models.aikin.club/typesafe/v1/models", KEY, signal());
    expect(r).toMatchObject({ ok: false, status: 401 });
    if (!r.ok) {
      expect(r.reason).toContain("HTTP 401");
      expect(r.reason).toContain("Authentication Error");
      expect(r.reason).not.toContain(KEY);
    }
  });

  it("reports TypeSafe's 403 in TypeSafe's own words, which used to be dropped", async () => {
    serve({ detail: { error_type: "authentication_error", message: "Must supply an API key! Check your request and try again." } }, 403);
    const r = await readJevModelList("https://api.typesafe.ai/v1/models", KEY, signal());
    if (r.ok) throw new Error("expected an unread list");
    expect(r.reason).toBe("HTTP 403: Must supply an API key! Check your request and try again.");
  });

  it("never throws: a non-JSON body, a redirect, a network error and an abort are all readings", async () => {
    serve("<html>nginx</html>", 502, "text/html");
    expect(await readJevModelList("https://p.example.com/v1/models", null, signal())).toMatchObject({ ok: false, status: 502 });

    globalThis.fetch = (async () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example.com/models" } })) as unknown as typeof fetch;
    const redirected = await readJevModelList("https://p.example.com/v1/models", KEY, signal());
    expect(redirected).toMatchObject({ ok: false });
    if (!redirected.ok) expect(redirected.reason).toContain("redirect");

    globalThis.fetch = (async () => {
      throw new TypeError(`fetch failed for ${KEY}`);
    }) as unknown as typeof fetch;
    const failed = await readJevModelList("https://p.example.com/v1/models", KEY, signal());
    if (failed.ok) throw new Error("expected an unread list");
    expect(failed.reason).not.toContain(KEY);

    globalThis.fetch = ((_u: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as unknown as typeof fetch;
    const ctl = new AbortController();
    const pending = readJevModelList("https://p.example.com/v1/models", KEY, ctl.signal);
    ctl.abort();
    const aborted = await pending;
    if (aborted.ok) throw new Error("expected an unread list");
    expect(aborted.reason).toContain(String(JEV_MODEL_LIST_TIMEOUT_MS));
  });
});

describe("the models URL a base implies", () => {
  it.each([
    ["https://api.typesafe.ai/v1", "https://api.typesafe.ai/v1/models"],
    ["https://openrouter.ai/api/v1", "https://openrouter.ai/api/v1/models"],
    ["https://ai-gateway.vercel.sh/typesafe/v1", "https://ai-gateway.vercel.sh/typesafe/v1/models"],
    ["https://models.aikin.club/typesafe/v1/", "https://models.aikin.club/typesafe/v1/models"],
    // A base that names the whole request URL still has its version root one
    // segment up, and that is where the list is.
    ["https://models.aikin.club/typesafe/v1/systemone", "https://models.aikin.club/typesafe/v1/models"],
    ["https://proxy.example.com/v1?api-version=2", "https://proxy.example.com/v1/models?api-version=2"],
  ])("%s → %s", (base, expected) => {
    expect(modelsUrlForBase(base)).toBe(expected);
  });

  it("has none for Cloudflare, whose inventory is behind a different API", () => {
    const cloudflare: JevConfig = { provider: "cloudflare", apiKey: KEY, accountId: "0123456789abcdef0123456789abcdef" };
    expect(jevModelsUrl(cloudflare)).toBeNull();
    expect(jevModelsUrl({ provider: "typesafe", apiKey: KEY })).toBe("https://api.typesafe.ai/v1/models");
    expect(jevModelsUrl({ provider: "custom", apiKey: KEY, baseUrl: "https://models.aikin.club/typesafe/v1" })).toBe(
      "https://models.aikin.club/typesafe/v1/models",
    );
  });
});

// ── The three error envelopes ────────────────────────────────────────────────

describe("providerErrorDetail: the provider's own sentence, whichever envelope carried it", () => {
  it.each([
    [
      "TypeSafe direct, 403 — `{detail:{message}}`",
      { detail: { error_type: "authentication_error", message: "Must supply an API key! Check your request and try again." } },
      "Must supply an API key! Check your request and try again.",
    ],
    [
      "a LiteLLM proxy, 401 — `{error:{message}}`",
      { error: { message: "Authentication Error, No api key passed in.", type: "auth_error", param: "None", code: "401" } },
      "Authentication Error, No api key passed in.",
    ],
    [
      "Vercel AI Gateway, 400 — a bare `{message}`",
      { message: "model: Invalid input: expected string, received undefined", error_type: "invalid_request" },
      "model: Invalid input: expected string, received undefined",
    ],
    ["Cloudflare, 402 — `{errors:[{message}]}`", { errors: [{ message: "Model execution failed (Payment error)", code: 2021 }] }, "Model execution failed (Payment error)"],
    ["a FastAPI 404 behind a proxy — `{detail:\"…\"}`", { detail: "Not Found" }, "Not Found"],
    ["a gateway reporting a string error", { error: "upstream unavailable" }, "upstream unavailable"],
    ["nothing to read", { ok: false }, ""],
  ])("%s", (_name, body, expected) => {
    expect(providerErrorDetail(body, KEY)).toBe(expected);
  });

  it("scrubs the key out of whichever envelope echoed it", () => {
    expect(providerErrorDetail({ detail: { message: `bad key ${KEY}` } }, KEY)).toBe("bad key [key]");
    expect(providerErrorDetail({ message: `bad key ${KEY}` }, KEY)).toBe("bad key [key]");
    expect(providerErrorDetail({ error: { message: `bad key ${KEY}` } }, KEY)).toBe("bad key [key]");
  });
});

describe("through a transport: the code stays stable and the words reach the message", () => {
  const request: JevRequest = { model: "jev-1.13.0", state: {}, questions: { a: { type: "noul", instructions: "a" } } };
  const send = (cfg: JevConfig) => transportForConfig(cfg).transport(request, signal());

  it.each([
    [
      "typesafe",
      { provider: "typesafe", apiKey: KEY } as JevConfig,
      403,
      { detail: { error_type: "authentication_error", message: "Must supply an API key! Check your request and try again." } },
      "http-403",
      "Must supply an API key! Check your request and try again.",
    ],
    [
      "a LiteLLM proxy",
      { provider: "custom", apiKey: KEY, baseUrl: "https://models.aikin.club/typesafe/v1" } as JevConfig,
      401,
      { error: { message: "Authentication Error, No api key passed in.", code: "401" } },
      "http-401",
      "Authentication Error, No api key passed in.",
    ],
    [
      "vercel",
      { provider: "vercel", apiKey: KEY } as JevConfig,
      400,
      { message: "model: Invalid input: expected string, received undefined", error_type: "invalid_request" },
      "http-400",
      "model: Invalid input: expected string, received undefined",
    ],
  ])("%s", async (_name, cfg, status, body, code, message) => {
    serve(body, status);
    try {
      await send(cfg);
      throw new Error("expected a JevError");
    } catch (err) {
      expect(err).toBeInstanceOf(JevError);
      expect((err as JevError).code).toBe(code);
      expect((err as JevError).message).toBe(message);
    }
  });

  it("names the constructed URL on a 404 from <base>/systemone, and says the suffix is ours", async () => {
    // The reported failure, verbatim: --url named `…/typesafe/v1/models`, so
    // requests went to `…/v1/models/systemone` and said only `Not Found`.
    serve({ detail: "Not Found" }, 404);
    try {
      await send({ provider: "custom", apiKey: KEY, baseUrl: "https://models.aikin.club/typesafe/v1/models" });
      throw new Error("expected a JevError");
    } catch (err) {
      expect(err).toBeInstanceOf(JevError);
      const e = err as JevError;
      // The code is what the activity store keeps, and it does not move.
      expect(e.code).toBe("http-404");
      expect(e.message).toContain("https://models.aikin.club/typesafe/v1/models/systemone");
      expect(e.message).toContain("`/systemone` is appended to the base URL you configured");
      expect(e.message).toContain("version root");
      expect(e.message).toContain("Not Found");
    }
  });

  it("says it with no body to read either, because the URL is the diagnosis", async () => {
    serve("<html>404</html>", 404, "text/html");
    try {
      await send({ provider: "typesafe", apiKey: KEY });
      throw new Error("expected a JevError");
    } catch (err) {
      expect((err as JevError).code).toBe("http-404");
      expect((err as JevError).message).toContain("https://api.typesafe.ai/v1/systemone");
    }
  });

  it("hides a query string from the 404 message, which may carry a token", async () => {
    serve({}, 404);
    try {
      await send({ provider: "custom", apiKey: KEY, baseUrl: `https://proxy.example.com/v1?token=${KEY}` });
      throw new Error("expected a JevError");
    } catch (err) {
      const message = (err as JevError).message;
      expect(message).toContain("https://proxy.example.com/v1/systemone?…");
      expect(message).not.toContain(KEY);
    }
  });

  it("leaves every other status saying exactly what it said before", async () => {
    serve({ error: { message: "slow down" } }, 429);
    await expect(send({ provider: "typesafe", apiKey: KEY })).rejects.toMatchObject({ code: "http-429", message: "slow down" });
    serve({}, 503);
    await expect(send({ provider: "typesafe", apiKey: KEY })).rejects.toMatchObject({ code: "http-503", message: "HTTP 503" });
  });
});

// ── An endpoint given where a base belongs ───────────────────────────────────

describe("endpointGivenAsBase", () => {
  it.each([
    ["https://models.aikin.club/typesafe/v1/models", "/models", "https://models.aikin.club/typesafe/v1"],
    ["https://api.typesafe.ai/v1/systemone", "/systemone", "https://api.typesafe.ai/v1"],
    ["https://openrouter.ai/api/v1/chat/completions", "/chat/completions", "https://openrouter.ai/api/v1"],
    ["https://proxy.example.com/v1/completions", "/completions", "https://proxy.example.com/v1"],
    ["https://proxy.example.com/v1/embeddings", "/embeddings", "https://proxy.example.com/v1"],
    // Trailing slashes, and the longest suffix winning over its own tail.
    ["https://proxy.example.com/v1/models/", "/models", "https://proxy.example.com/v1"],
    ["https://PROXY.example.com/V1/Models", "/models", "https://proxy.example.com/V1"],
  ])("%s ends in %s, so the base is %s", (url, suffix, base) => {
    expect(endpointGivenAsBase(url)).toEqual({ suffix, base });
  });

  it("has nothing to say about a base", () => {
    for (const url of [
      "https://api.typesafe.ai/v1",
      "https://openrouter.ai/api/v1",
      "https://ai-gateway.vercel.sh/typesafe/v1",
      "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/run",
      "https://proxy.example.com/",
      "https://proxy.example.com/modelsomething",
      "not a url",
    ]) {
      expect(endpointGivenAsBase(url)).toBeNull();
    }
  });

  it("leaves a bare host as `/` rather than an empty path", () => {
    expect(endpointGivenAsBase("https://proxy.example.com/models")).toEqual({ suffix: "/models", base: "https://proxy.example.com/" });
  });
});
