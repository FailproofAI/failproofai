/**
 * The client for Jev, and the provider layer that turns a customer's own
 * config (BYOK, `jev-config.ts`) into a transport.
 *
 * # Five routes, two wire shapes
 *
 * | Provider   | Endpoint                                              | Default model        |
 * |------------|-------------------------------------------------------|----------------------|
 * | typesafe   | `https://api.typesafe.ai/v1/systemone`                | `jev-1.13.0`         |
 * | openrouter | `https://openrouter.ai/api/v1/systemone`              | `typesafe/jev-1.13`  |
 * | vercel     | `https://ai-gateway.vercel.sh/typesafe/v1/systemone`  | `typesafe-ai/jev`    |
 * | cloudflare | `https://api.cloudflare.com/client/v4/accounts/<id>/ai/run` | `typesafe/jev` |
 * | custom     | `<baseUrl>/systemone`                                 | `jev-1.13.0`         |
 *
 * TypeSafe, OpenRouter, Vercel and a custom URL all take TypeSafe's native body
 * `{model, state, questions}` and answer `{model, answers, usage}`, so one
 * transport (`nativeTransport`) serves all four: base URL, `Bearer` key and the
 * right model id. OpenRouter additionally gets
 * `provider: {zdr: true, data_collection: "deny", allow_fallbacks: false}` so a
 * tool call is only ever routed to a zero-data-retention endpoint and never
 * silently to another model. Cloudflare Workers AI wraps the request as
 * `{model: "typesafe/jev", input: {state, questions}}` and nests the answer
 * under a job layer (`result.result`), so it keeps its own transport.
 *
 * Auth everywhere is `Authorization: Bearer <key>`. The key never appears in an
 * error message: provider error text is passed through with the key scrubbed.
 *
 * # Which Jev answered
 *
 * The decision thresholds were calibrated against Jev 1.13, so `readAnswers`
 * accepts an answer only from that family: `jev-1.13.x`, OpenRouter's
 * `typesafe/jev-1.13-<date>` snapshot, or — where the provider reports no
 * version at all (Vercel's `typesafe-ai/jev`, Cloudflare's `typesafe/jev`, a
 * custom proxy echoing its own name) — an answer the TRANSPORT marked
 * `modelUnverified`, which the evaluator records as `modelVerified: false`. A
 * reported version of another major.minor is a `model-mismatch`, and the caller
 * falls back to regex. The flag is set only by the transports in this file from
 * what the provider reported; a `modelUnverified` field in a response body is
 * never copied through.
 *
 * # Errors
 *
 * Every failure is a `JevError`, and the caller falls back to regex:
 * `timeout`, `network`, `http-<status>` (429 and every 5xx included),
 * `out-of-credits` (HTTP 402, or a 402 inside a 200 body), `upstream-error`,
 * `cloudflare-error`, `cloudflare-incomplete`, `malformed`, `model-mismatch`,
 * `config`.
 *
 * # Not an opt-in: `resolveJevProvider`
 *
 * The research harness found credentials in `~/.config/typesafe/` (or
 * `FAILPROOFAI_JEV_CONFIG_DIR`, or `TYPESAFE_API_KEY`). That lookup is kept for
 * the harness only. The product's ONLY opt-in is the global
 * `~/.failproofai/jev.json`, read by `loadJevConfig()`; the hook path always
 * builds its transport with `transportForConfig(loadJevConfig())` and never
 * falls back to `resolveJevProvider`.
 *
 * Deliberately raw `fetch` and no SDK: `policy-evaluator.ts` records a single
 * import being weighed in bytes on the hook path.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  CLOUDFLARE_ACCOUNT_ID_RE,
  isCalibratedJevModel,
  jevModelVersion,
  validateJevConfig,
  type JevConfig,
  type JevProviderKind,
} from "./jev-config";
import type { JevRequest, JevResponse } from "./types";

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
/** Cloudflare's name for Jev. Unversioned — see `unwrapCloudflare`. */
export const CLOUDFLARE_JEV_MODEL = "typesafe/jev";
/** Vercel AI Gateway's name for Jev. An alias: Vercel reports no version. */
export const VERCEL_JEV_MODEL = "typesafe-ai/jev";
export const cloudflareRunEndpoint = (accountId: string, apiBase = JEV_PROVIDER_DEFAULTS.cloudflare.baseUrl): string =>
  `${apiBase.replace(/\/+$/, "")}/accounts/${accountId}/ai/run`;

/** $0.042 per million input tokens; output tokens are free. */
export const JEV_USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

/**
 * Where each provider lives and which model id it knows Jev by. `baseUrl` is the
 * API base: native providers POST to `<baseUrl>/systemone`, Cloudflare to
 * `<baseUrl>/accounts/<id>/ai/run`. A config's `baseUrl` replaces it.
 */
export const JEV_PROVIDER_DEFAULTS = {
  typesafe: { baseUrl: "https://api.typesafe.ai/v1", model: "jev-1.13.0" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", model: "typesafe/jev-1.13" },
  vercel: { baseUrl: "https://ai-gateway.vercel.sh/typesafe/v1", model: VERCEL_JEV_MODEL },
  cloudflare: { baseUrl: "https://api.cloudflare.com/client/v4", model: CLOUDFLARE_JEV_MODEL },
  custom: { baseUrl: null, model: "jev-1.13.0" },
} as const satisfies Record<JevProviderKind, { baseUrl: string | null; model: string }>;

/**
 * OpenRouter provider routing: zero-data-retention endpoints only, no training
 * on the data, and no fallback to a different provider or model when the pinned
 * one is down — a fallback answer is exactly the "different model" the version
 * check exists to refuse.
 */
export const OPENROUTER_PROVIDER_PREFS = { zdr: true, data_collection: "deny", allow_fallbacks: false } as const;

export type JevTransport = (request: JevRequest, signal: AbortSignal) => Promise<JevResponse>;

export class JevError extends Error {
  /**
   * Short, stable cause used in logs and as the fallback reason: timeout,
   * network, http-<status>, out-of-credits, upstream-error, cloudflare-error,
   * cloudflare-incomplete, malformed, model-mismatch, config.
   */
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "JevError";
    this.code = code;
  }
}

// ── Research-harness credentials (NOT an opt-in) ─────────────────────────────

export function jevConfigDir(): string {
  return process.env.FAILPROOFAI_JEV_CONFIG_DIR || resolve(homedir(), ".config", "typesafe");
}

function readTrimmed(file: string): string | null {
  try {
    const v = readFileSync(file, "utf8").trim();
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

export type JevProvider =
  | { kind: "typesafe"; apiKey: string }
  | { kind: "cloudflare"; token: string; accountId: string };

/**
 * The research harness's credential lookup: a TypeSafe key (env or
 * `api_key`), else a Cloudflare token plus `cloudflare.json`. A Cloudflare
 * account id that is not 32 hex characters is treated as not configured — it
 * is interpolated into a URL path.
 *
 * NOT an opt-in and never consulted on the hook path: the product turns Jev on
 * only through `~/.failproofai/jev.json` (`loadJevConfig`), and the handler
 * always passes an explicit transport from `transportForConfig`.
 */
export function resolveJevProvider(): JevProvider | null {
  const dir = jevConfigDir();
  const apiKey = process.env.TYPESAFE_API_KEY?.trim() || readTrimmed(resolve(dir, "api_key"));
  if (apiKey) return { kind: "typesafe", apiKey };
  const token = readTrimmed(resolve(dir, "cloudflare_token"));
  if (!token) return null;
  let accountId: unknown;
  try {
    accountId = (JSON.parse(readFileSync(resolve(dir, "cloudflare.json"), "utf8")) as { accountId?: unknown }).accountId;
  } catch {
    return null;
  }
  if (typeof accountId !== "string" || !CLOUDFLARE_ACCOUNT_ID_RE.test(accountId)) return null;
  return { kind: "cloudflare", token, accountId };
}

/** Research harness only; see `resolveJevProvider`. */
export function transportFor(provider: JevProvider): JevTransport {
  return provider.kind === "typesafe" ? httpTransport(provider.apiKey) : cloudflareTransport(provider.token, provider.accountId);
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

const MAX_ERROR_DETAIL = 300;

/** The provider's own words about a failure, from whichever envelope it uses, with the key scrubbed. */
function errorDetail(body: unknown, secret: string): string {
  const b = body as {
    errors?: Array<{ message?: unknown }>;
    error?: unknown;
    message?: unknown;
    detail?: unknown;
  } | null;
  let detail = "";
  if (b && typeof b === "object") {
    if (Array.isArray(b.errors)) {
      detail = b.errors.map((e) => (typeof e?.message === "string" ? e.message : "")).filter(Boolean).join("; ");
    }
    if (!detail && b.error && typeof b.error === "object") {
      const m = (b.error as { message?: unknown }).message;
      if (typeof m === "string") detail = m;
    }
    if (!detail && typeof b.error === "string") detail = b.error;
    if (!detail && typeof b.message === "string") detail = b.message;
    if (!detail && typeof b.detail === "string") detail = b.detail;
  }
  return scrub(detail, secret).slice(0, MAX_ERROR_DETAIL);
}

/** Replace every occurrence of the key. A provider echoing a credential must not put it in a log line. */
function scrub(text: string, secret: string): string {
  return secret.length >= 4 ? text.split(secret).join("[key]") : text;
}

async function postJson(url: string, bearer: string, body: unknown, signal: AbortSignal): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal.aborted) throw new JevError("timeout", "Jev did not answer in time");
    throw new JevError("network", scrub(err instanceof Error ? err.message : String(err), bearer));
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    if (signal.aborted) throw new JevError("timeout", "Jev did not answer in time");
    if (res.status === 402) throw new JevError("out-of-credits", "HTTP 402: the account is out of credits");
    if (!res.ok) throw new JevError(`http-${res.status}`, `HTTP ${res.status}`);
    throw new JevError("malformed", "response body is not JSON");
  }
  if (res.status === 402) {
    throw new JevError("out-of-credits", errorDetail(parsed, bearer) || "HTTP 402: the account is out of credits");
  }
  if (!res.ok) {
    throw new JevError(`http-${res.status}`, errorDetail(parsed, bearer) || `HTTP ${res.status}`);
  }
  return parsed;
}

/** A model id that names no version and is one of the names this route is known by. */
function isAliasFor(reported: string, aliases: readonly string[]): boolean {
  return jevModelVersion(reported) === null && aliases.includes(reported);
}

// ── TypeSafe-native transport (typesafe, openrouter, vercel, custom) ─────────

export interface NativeTransportOptions {
  /** The full endpoint URL, e.g. `https://api.typesafe.ai/v1/systemone`. */
  url: string;
  apiKey: string;
  /** Sent as the body's `model`, replacing the request's. Omitted: the request's own. */
  model?: string;
  /** Extra top-level body fields — OpenRouter's `provider` routing. */
  extraBody?: Record<string, unknown>;
  /** Unversioned names this route reports for Jev; answering with one marks the response `modelUnverified`. */
  aliases?: readonly string[];
  /** Whether an answer with no `model` at all is accepted (as unverified) rather than refused. */
  allowUnreported?: boolean;
}

/**
 * A provider's body → a Jev response, built field by field so nothing but
 * `model`, `answers` and `usage` crosses over — in particular never a
 * `modelUnverified` the server chose to send.
 */
function normalizeNative(body: unknown, sentModel: string, opts: NativeTransportOptions): JevResponse {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new JevError("malformed", "Jev returned no object");
  const b = body as { model?: unknown; answers?: unknown; usage?: unknown; error?: unknown };
  if (typeof b.answers !== "object" || b.answers === null) {
    // Gateways sometimes report an upstream failure inside a 200.
    if (b.error !== undefined) {
      const code = typeof b.error === "object" && b.error !== null ? (b.error as { code?: unknown }).code : undefined;
      const detail = errorDetail(body, opts.apiKey) || "the provider reported an error";
      if (code === 402 || code === "402") throw new JevError("out-of-credits", detail);
      if (typeof code === "number" && (code === 429 || code >= 500)) throw new JevError(`http-${code}`, detail);
      throw new JevError("upstream-error", detail);
    }
    throw new JevError("malformed", "Jev response has no answers object");
  }
  const usage = b.usage && typeof b.usage === "object" ? (b.usage as JevResponse["usage"]) : undefined;
  const reported = typeof b.model === "string" && b.model.length > 0 ? b.model : null;
  let model: string;
  let unverified = false;
  if (reported === null) {
    // Nothing to check. Accepted only where the route is known not to report.
    model = opts.allowUnreported ? sentModel : "";
    unverified = opts.allowUnreported === true;
  } else {
    model = reported;
    unverified = isAliasFor(reported, opts.aliases ?? []);
  }
  return {
    model,
    answers: b.answers as JevResponse["answers"],
    ...(usage ? { usage } : {}),
    ...(unverified ? { modelUnverified: true } : {}),
  };
}

export function nativeTransport(opts: NativeTransportOptions): JevTransport {
  return async (request, signal) => {
    const model = opts.model ?? request.model;
    const body = { ...request, model, ...(opts.extraBody ?? {}) };
    return normalizeNative(await postJson(opts.url, opts.apiKey, body, signal), model, opts);
  };
}

/** TypeSafe direct at its fixed endpoint, sending the request's own model. */
export function httpTransport(apiKey: string): JevTransport {
  return nativeTransport({ url: JEV_ENDPOINT, apiKey });
}

// ── Cloudflare Workers AI ────────────────────────────────────────────────────

export interface CloudflareTransportOptions {
  /** Cloudflare's model id. Default `typesafe/jev`. */
  model?: string;
  /** Replaces `https://api.cloudflare.com/client/v4`; a URL already ending in `/ai/run` is used as is. */
  baseUrl?: string;
}

export function cloudflareTransport(token: string, accountId: string, opts: CloudflareTransportOptions = {}): JevTransport {
  if (!CLOUDFLARE_ACCOUNT_ID_RE.test(accountId)) throw new JevError("config", "Cloudflare account id must be 32 hex characters");
  const model = opts.model ?? CLOUDFLARE_JEV_MODEL;
  const endpoint = cloudflareEndpoint(accountId, opts.baseUrl);
  return async (request, signal) => {
    const body = await postJson(endpoint, token, { model, input: { state: request.state, questions: request.questions } }, signal);
    return unwrapCloudflare(body, request, model);
  };
}

function cloudflareEndpoint(accountId: string, baseUrl?: string): string {
  if (!baseUrl) return cloudflareRunEndpoint(accountId);
  const url = new URL(baseUrl);
  if (/\/ai\/run$/.test(url.pathname)) return url.toString();
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/accounts/${accountId}/ai/run`;
  return url.toString();
}

/**
 * Cloudflare's `{success, errors, result}` envelope → a Jev response.
 *
 * Cloudflare addresses Jev as `typesafe/jev`, without a version. When the
 * result says which Jev answered, `readAnswers` enforces the family exactly as
 * it does for TypeSafe. When it does not — no `model`, or only the alias echoed
 * back — the version cannot be checked from here: the response carries the
 * request's model so the answers are usable, and `modelUnverified` puts that
 * gap in the verdict log instead of hiding it.
 */
export function unwrapCloudflare(body: unknown, request: JevRequest, sentModel: string = CLOUDFLARE_JEV_MODEL): JevResponse {
  const envelope = body as { success?: unknown; errors?: Array<{ message?: string }>; result?: unknown } | null;
  if (!envelope || typeof envelope !== "object") throw new JevError("malformed", "Cloudflare returned no object");
  if (envelope.success === false) {
    const detail = Array.isArray(envelope.errors) ? envelope.errors.map((e) => e?.message).filter(Boolean).join("; ") : "";
    throw new JevError("cloudflare-error", detail || "Cloudflare reported failure");
  }
  let inner: unknown = "result" in envelope ? envelope.result : envelope;
  // Observed live (2026-09-21): partner models add a job layer —
  // `result: {state: "Completed", result: <TypeSafe's own response>, gatewayMetadata}`.
  // Anything but a completed job is not an answer.
  const job = inner as { state?: unknown; result?: unknown } | null;
  if (job && typeof job === "object" && "state" in job && "result" in job) {
    if (job.state !== "Completed") throw new JevError("cloudflare-incomplete", `Cloudflare job state ${String(job.state)}`);
    inner = job.result;
  }
  const result = inner as Partial<JevResponse> | null;
  if (!result || typeof result !== "object" || typeof result.answers !== "object" || result.answers === null) {
    throw new JevError("malformed", "Cloudflare result has no answers");
  }
  // Echoing back the alias is not a version either.
  const reported =
    typeof result.model === "string" && result.model.length > 0 && !isAliasFor(result.model, [CLOUDFLARE_JEV_MODEL, sentModel])
      ? result.model
      : null;
  return {
    model: reported ?? request.model,
    answers: result.answers,
    ...(result.usage ? { usage: result.usage } : {}),
    ...(reported === null ? { modelUnverified: true } : {}),
  };
}

// ── Answers ──────────────────────────────────────────────────────────────────

/**
 * Probabilities keyed by question id, or a JevError. Every question must come
 * back as a finite number in [0, 1], and the answer must come from the Jev
 * family the thresholds were calibrated against (1.13, any patch or snapshot),
 * or from a route that reports no version at all — which the transport has
 * marked `modelUnverified`. Thresholds mean nothing for another model.
 */
export function readAnswers(request: JevRequest, response: JevResponse): Record<string, number> {
  if (!response || typeof response !== "object" || typeof response.answers !== "object" || response.answers === null) {
    throw new JevError("malformed", "Jev response has no answers object");
  }
  if (response.modelUnverified !== true && !isCalibratedJevModel(String(response.model))) {
    throw new JevError("model-mismatch", `asked for ${request.model}, got ${String(response.model)}`);
  }
  const out: Record<string, number> = {};
  for (const id of Object.keys(request.questions)) {
    const p = response.answers[id]?.noul;
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) {
      throw new JevError("malformed", `answer for ${id} is missing or out of range`);
    }
    out[id] = p;
  }
  return out;
}

// ── BYOK (T1 contract) ───────────────────────────────────────────────────────

export interface JevRoute {
  via: JevProviderKind;
  /** The URL requests are POSTed to. May carry a query string; show it with `displayEndpoint`. */
  endpoint: string;
  /** The model id sent to the provider. */
  model: string;
  modelIsDefault: boolean;
}

function nativeEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (!/\/systemone$/.test(url.pathname)) url.pathname = `${url.pathname.replace(/\/+$/, "")}/systemone`;
  return url.toString();
}

function validated(cfg: JevConfig): JevConfig {
  const v = validateJevConfig(cfg);
  if (!v.ok) throw new JevError("config", v.problem);
  return v.value;
}

/** Where a config sends its requests and which model id it names, without building anything. Throws `JevError("config")`. */
export function jevRoute(input: JevConfig): JevRoute {
  const cfg = validated(input);
  const defaults = JEV_PROVIDER_DEFAULTS[cfg.provider];
  const model = cfg.model ?? defaults.model;
  const modelIsDefault = cfg.model === undefined;
  if (cfg.provider === "cloudflare") {
    return { via: "cloudflare", endpoint: cloudflareEndpoint(cfg.accountId as string, cfg.baseUrl), model, modelIsDefault };
  }
  const base = cfg.baseUrl ?? defaults.baseUrl;
  if (!base) throw new JevError("config", "provider custom needs a baseUrl");
  return { via: cfg.provider, endpoint: nativeEndpoint(base), model, modelIsDefault };
}

/** An endpoint for display: the query string (which may hold anything) replaced by `?…`. */
export function displayEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    const shown = `${url.origin}${url.pathname}`;
    return url.search ? `${shown}?…` : shown;
  } catch {
    return "(invalid URL)";
  }
}

/**
 * The transport for a customer's own Jev config, which provider it goes
 * through, and the model id to put in the request (pass it to the evaluator as
 * `model`). The transport sends the configured model regardless, so nothing in
 * the environment can change which model a provider is asked for.
 *
 * Throws `JevError("config")` for a config that would not pass
 * `loadJevConfig()`; a caller treats that like any other Jev failure.
 */
export function transportForConfig(input: JevConfig): { transport: JevTransport; via: JevProviderKind; model: string } {
  const cfg = validated(input);
  const route = jevRoute(cfg);
  switch (cfg.provider) {
    case "cloudflare":
      return {
        transport: cloudflareTransport(cfg.apiKey, cfg.accountId as string, { model: route.model, baseUrl: cfg.baseUrl }),
        via: "cloudflare",
        model: route.model,
      };
    case "typesafe":
      return {
        transport: nativeTransport({ url: route.endpoint, apiKey: cfg.apiKey, model: route.model }),
        via: "typesafe",
        model: route.model,
      };
    case "openrouter":
      return {
        transport: nativeTransport({
          url: route.endpoint,
          apiKey: cfg.apiKey,
          model: route.model,
          extraBody: { provider: { ...OPENROUTER_PROVIDER_PREFS } },
        }),
        via: "openrouter",
        model: route.model,
      };
    case "vercel":
      return {
        transport: nativeTransport({
          url: route.endpoint,
          apiKey: cfg.apiKey,
          model: route.model,
          aliases: [VERCEL_JEV_MODEL, route.model],
          allowUnreported: true,
        }),
        via: "vercel",
        model: route.model,
      };
    case "custom":
      return {
        transport: nativeTransport({
          url: route.endpoint,
          apiKey: cfg.apiKey,
          model: route.model,
          // A proxy echoing the name it was configured with has said nothing
          // about the version; one reporting a real Jev version is checked.
          aliases: [route.model],
          allowUnreported: true,
        }),
        via: "custom",
        model: route.model,
      };
  }
}
