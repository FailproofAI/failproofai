/**
 * The client for Jev, and the provider layer that turns a customer's own
 * config (BYOK, `jev-config.ts`) into a transport.
 *
 * # Six routes, two wire shapes
 *
 * | Provider    | Endpoint                                              | Default model        |
 * |-------------|-------------------------------------------------------|----------------------|
 * | typesafe    | `https://api.typesafe.ai/v1/systemone`                | `jev-1.13.0`         |
 * | openrouter  | `https://openrouter.ai/api/v1/systemone`              | `typesafe/jev-1.13`  |
 * | vercel      | `https://ai-gateway.vercel.sh/typesafe/v1/systemone`  | `typesafe-ai/jev`    |
 * | cloudflare  | `https://api.cloudflare.com/client/v4/accounts/<id>/ai/run` | `typesafe/jev` |
 * | custom      | `<baseUrl>/systemone`                                 | `jev-1.13.0`         |
 * | failproofai | `<Cloud origin>/enforcement/v1/jev/systemone`         | `jev-1.13.0`         |
 *
 * `failproofai` is FailproofAI Cloud: the machine's own Cloud key (the `jev`
 * slot of `credentials.json`, see `jev-config.ts`) as the bearer, the org's
 * plan allowance as the budget. The server forces `jev-1.13.0` and passes
 * TypeSafe's answer through with its `model`, so this route accepts only a
 * reported 1.13 model, never silence. Its documented statuses map like every
 * other route's: 402 `{"error":"out_of_credits"}` → `out-of-credits` (the body
 * never says "model execution failed"), 400/401/403/413/422/429/502/503 →
 * `http-<status>`, and a redirect is refused. After a 429 the route sends
 * nothing for as long as its `Retry-After` asks (capped; `cloudRetryAfter`).
 *
 * `baseUrl` is a BASE — the provider's version root — and `/systemone` is this
 * file's own suffix (`nativeEndpoint`). Measured 2026-09-25, unauthenticated:
 * `POST <base>/systemone` answers 403 / 401 / 400 / 401 on the four bases above
 * and NEVER 404, so a 404 from it is evidence that the base is wrong rather
 * than that the service is down — which is what `postJson` says when it sees
 * one.
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
 * # `GET <base>/models`: two shapes, and only one of them answers the question
 *
 * Measured 2026-09-25, unauthenticated except where noted:
 *
 * | base                                     | status | body                                                   |
 * |------------------------------------------|--------|--------------------------------------------------------|
 * | `https://api.typesafe.ai/v1`             | 403    | `{detail:{error_type,message}}`                        |
 * | `https://openrouter.ai/api/v1`           | 200    | `{data:[{id,canonical_slug,name,…}]}` — OpenAI shape   |
 * | `https://ai-gateway.vercel.sh/typesafe/v1` | 200  | `{models:[{name,description,release_date}]}` — TypeSafe shape |
 * | a LiteLLM proxy (`…/typesafe/v1`)        | 401    | `{error:{message,type,param,code}}`                     |
 * | the same proxy, with a key               | 200    | TypeSafe shape: `jev-latest`, `jev-preview`             |
 *
 * `readJevModelList` parses both shapes, and `parseJevModelList` reports "could
 * not read the list" rather than throwing, because a proxy may serve neither.
 *
 * The two shapes do not mean the same thing, and only one of them may be used to
 * REFUSE a model (`jev setup`, see `listDescribesSystemOne`):
 *
 * - The TypeSafe shape is the System One inventory of the base it was read from,
 *   as ALIASES. Vercel's typesafe-scoped passthrough and a LiteLLM passthrough
 *   both return it. It is not exhaustive: the models.aikin.club upstream lists
 *   only `jev-latest` and `jev-preview`, yet its `/systemone` answers
 *   `jev-1.13.0` (and "Unknown model" for `jev-1.13` or `jev-1.13.5`; measured
 *   2026-09-27). So it may refuse an unlisted alias, never a versioned id.
 * - The OpenAI shape is a gateway's chat-completions catalog, and demonstrably
 *   does not enumerate `/systemone`: OpenRouter's 458-model catalog contains no
 *   Jev entry of any spelling, while `POST https://openrouter.ai/api/v1/systemone`
 *   exists (401, not 404) and this table addresses it as `typesafe/jev-1.13`. So
 *   an OpenAI-shaped list is shown to a person and never used to refuse one.
 *
 * # Vercel names the same model twice, once per base
 *
 * `JEV_PROVIDER_DEFAULTS.vercel.model` is `typesafe-ai/jev` while Vercel's own
 * `/typesafe/v1/models` calls it `jev`. Both are real, at two different bases
 * (measured 2026-09-25):
 *
 * - `GET https://ai-gateway.vercel.sh/v1/models` — the gateway's own
 *   OpenAI-shaped catalog, 390 models — carries exactly one match:
 *   `{id: "typesafe-ai/jev", owned_by: "typesafe-ai", name: "Jev", type: "evaluation"}`.
 *   `<owner>/<model>` is how that catalog addresses every model in it
 *   (`alibaba/qwen-3-14b`, …), so the longer form is the GATEWAY-level id.
 * - `GET https://ai-gateway.vercel.sh/typesafe/v1/models` — the typesafe-scoped
 *   passthrough, which is the base we POST to — reports the provider-native
 *   `jev`.
 *
 * Which one `POST /typesafe/v1/systemone` wants cannot be settled from outside:
 * that route validates the BODY before the key (400 `model: Invalid input:
 * expected string, received undefined` with no model, 401 `Authentication
 * failed` with any model, valid or not), so an unauthenticated probe cannot
 * distinguish a model it knows from one it does not. The default is therefore
 * left as it is — it is what the route was configured and verified with — and
 * `modelListHasModel` treats a listed `jev` as covering a configured
 * `typesafe-ai/jev`, since Vercel's two catalogs differ by exactly that
 * `<owner>/` prefix. Settling it needs one authenticated request with each
 * spelling.
 *
 * # Which Jev answered
 *
 * The decision thresholds were calibrated against Jev 1.13, so `readAnswers`
 * accepts an answer only from that family: `jev-1.13.x`, OpenRouter's
 * `typesafe/jev-1.13-<date>` snapshot, or — where the provider reports no
 * version at all (Vercel's `typesafe-ai/jev` or no model, Cloudflare's
 * `typesafe/jev` or no model, a custom proxy echoing back the unversioned name
 * the customer configured for it) — an answer the TRANSPORT marked
 * `modelUnverified`, which the evaluator records as `modelVerified: false`. A
 * reported version of another major.minor is a `model-mismatch`, and the caller
 * falls back to regex; so is a custom endpoint that reports no model at all. The flag is set only by the transports in this file from
 * what the provider reported; a `modelUnverified` field in a response body is
 * never copied through.
 *
 * # Errors
 *
 * Every failure is a `JevError`, and the caller falls back to regex:
 * `timeout`, `network`, `http-<status>` (429 and every 5xx included, and every
 * 3xx: a redirect is never followed, so the answer only ever comes from the
 * configured origin),
 * `out-of-credits` and `provider-refused` (the two meanings of HTTP 402, or of
 * a 402 inside a 200 body — see `paymentRequiredCode`), `upstream-error`,
 * `cloudflare-error`, `cloudflare-incomplete`, `malformed`, `model-mismatch`,
 * `config`.
 *
 * The CODE is the stable part — the activity store keeps a closed list of them
 * (`JEV_REASON_CODE_LIST`, and its twin in `fpai-collect`) — so the provider's
 * own sentence goes in the MESSAGE, which nothing parses.
 * `providerErrorDetail` reads it out of whichever envelope arrived; all three
 * observed shapes are in that comment, and one of them (TypeSafe's
 * `{detail:{message}}`) used to be dropped on the floor, which is how "Must
 * supply an API key!" reached a person as the bare words `HTTP 403`.
 *
 * # When the provider refuses the call
 *
 * A refusal is not spread evenly over the traffic: the provider is likeliest to
 * decline exactly the calls that matter most — the curl that reads like
 * exfiltration, the file listing carrying `rm -rf /` and `dd if=/dev/zero`.
 * Both the judged call and our own question text ride in the request, so either
 * can trip it; one of our own shipped examples did, live (see
 * `download_and_run` in `policies.ts`).
 *
 * The consequence is a security property, not a nicety. A refusal degrades the
 * call to the regex policies — which is the correct fallback: every hard policy
 * still denies, and no reviewable deny is ever cleared by an answer nobody got
 * — but the degrade has to be VISIBLE, because it lands on the worst call of
 * the day rather than a random one. It is visible as `jev-fallback` /
 * `provider-refused` on the activity row and in `failproofai jev status`.
 * Filing it as `out-of-credits` was the opposite of visible: it sent the
 * operator to their billing page while that call went through on regex alone.
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
// A value, not a literal: the code has to be one the activity store's closed
// list names, and importing the constant makes a rename there a compile error
// here instead of a row quietly stored as `other`. `jev-activity.ts` is pure
// (no node imports, no semantic modules), as `combine.ts` already relies on.
import { JEV_REASON_PROVIDER_REFUSED } from "../jev-activity";
import {
  CLOUDFLARE_ACCOUNT_ID_RE,
  isCalibratedJevModel,
  isModelIdShaped,
  jevModelVersion,
  validateLoadedJevConfig,
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
  // No default base: it is the Cloud origin this machine connected to, written
  // into jev.json by `config --token` and checked against the credential's own
  // origin by the loader. The server forces `jev-1.13.0` whatever is sent.
  failproofai: { baseUrl: null, model: "jev-1.13.0" },
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
   * network, http-<status>, out-of-credits, provider-refused, upstream-error,
   * cloudflare-error, cloudflare-incomplete, malformed, model-mismatch, config.
   */
  readonly code: string;
  /**
   * An HTTP 429's `Retry-After` header, verbatim (null when it sent none).
   * Recorded for every route and read by the FailproofAI Cloud one only (see
   * `cloudRetryAfter`); a BYOK route behaves exactly as it did without it.
   */
  readonly retryAfter: string | null;
  constructor(code: string, message: string, opts: { retryAfter?: string | null } = {}) {
    super(printable(message));
    this.name = "JevError";
    this.code = code;
    this.retryAfter = opts.retryAfter ?? null;
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

/**
 * The provider's own words about a failure, from whichever envelope it uses,
 * with the key scrubbed. Every shape below was observed live; none is guessed at,
 * because a shape nobody has seen adds a branch that can only ever misread a
 * body some future provider sends.
 *
 * | shape                       | seen on                                              |
 * |-----------------------------|------------------------------------------------------|
 * | `{errors:[{message}]}`      | Cloudflare Workers AI                                |
 * | `{error:{message}}`         | OpenRouter, and LiteLLM-style proxies                |
 * | `{error:"…"}`               | gateways that report an upstream failure as a string |
 * | `{message}`                 | Vercel AI Gateway (`400 model: Invalid input: …`)    |
 * | `{detail:{message}}`        | TypeSafe direct (`403 Must supply an API key!`)      |
 * | `{detail:"…"}`              | a FastAPI 404 behind a proxy (`Not Found`)           |
 *
 * `{detail:{message}}` is the one that was missing, and it is TypeSafe's own —
 * so the provider this whole file exists to talk to was the one provider whose
 * explanation never reached a screen.
 *
 * `{error:"<code>", message:"…"}` is FailproofAI Cloud's own error body (its
 * Jev route's contract, `{"error":"forbidden","message":"… jev:evaluate …"}`).
 * Read as `{error:"…"}` alone it reported the bare word `forbidden` and dropped
 * the sentence naming the missing permission, so when both are strings both
 * are kept, code first.
 */
/**
 * Provider text with its control characters (C0, DEL, C1) replaced by spaces.
 * Error text is printed to a terminal, where OSC 52 writes the clipboard, OSC 8
 * plants a link and ESC[2J erases the real diagnostic. Every field it is used
 * for is one line.
 */
export function printable(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

export function providerErrorDetail(body: unknown, secret: string): string {
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
    if (!detail && typeof b.error === "string" && b.error && typeof b.message === "string" && b.message) {
      detail = `${b.error}: ${b.message}`;
    }
    if (!detail) detail = messageOf(b.error);
    if (!detail && typeof b.message === "string") detail = b.message;
    if (!detail) detail = messageOf(b.detail);
  }
  return printable(scrubSecret(detail, secret)).slice(0, MAX_ERROR_DETAIL);
}

/** An envelope member that is either the sentence itself or an object carrying it. */
function messageOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const m = (value as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return "";
}

/**
 * Replace every occurrence of the key. A provider echoing a credential must not
 * put it in a log line. Exported so a caller that prints an error (`jev test`)
 * can scrub it again, whatever path the text took to get there.
 */
export function scrubSecret(text: string, secret: string): string {
  return secret.length >= 4 ? text.split(secret).join("[key]") : text;
}

/**
 * Cloudflare's wording for a request it would not run the model on, seen live
 * (2026-09-21 to 24) as HTTP 402 with
 * `{"errors":[{"message":"Model execution failed (Payment error)","code":2021}]}`.
 *
 * Matched on the wording, not on the numeric code: 2021 is the only value
 * observed and nothing here knows which other codes Cloudflare files under the
 * same meaning, so testing the code would be a guess where the text is an
 * observation.
 */
const MODEL_EXECUTION_402_RE = /model execution failed/i;

/**
 * Which of the two quite different things an HTTP 402 means here, from the
 * provider's own words (already scrubbed; `""` when it sent none).
 *
 * The two are: the account really has no credits left, and the provider
 * DECLINED TO PROCESS THE REQUEST. The second is not a theory — on the
 * Cloudflare route it is reproducible: one shipped question's example text made
 * every call that selected that policy fail with 402, deterministically, on any
 * state, at well under a request a second, with no quota, size or rate
 * condition in play, and the failures stopped when a few characters of the
 * question changed (`download_and_run` in `policies.ts`). Either half of the
 * request can trip it — our questions or the judged call itself, which is why
 * an agent's own command can cause it.
 *
 * The response is all the evidence there is, and it does not settle the two in
 * general. "Model execution failed (Payment error)" is Cloudflare reporting
 * that the model RUN was refused for a payment-category reason: what we have
 * watched it mean is a content refusal, but a partner-side billing failure
 * would arrive wearing the same wrapper, and nothing in the body tells those
 * apart. So this shape is `provider-refused` — a name that says who refused and
 * that no answer arrived, and accuses the operator's balance under neither
 * reading. Any other 402 (a body that names credits, a non-JSON body, no body)
 * stays `out-of-credits`: the status's own meaning, and the only thing left to
 * call it.
 *
 * The gap that remains: a route refusing content in different words is still
 * filed as `out-of-credits`. A fallback histogram filling with `out-of-credits`
 * while the account demonstrably has money is the sign to sweep the questions
 * again, the way `policies.ts` describes.
 */
function paymentRequiredCode(detail: string): string {
  return MODEL_EXECUTION_402_RE.test(detail) ? JEV_REASON_PROVIDER_REFUSED : "out-of-credits";
}

/** Whether this URL is one THIS file built by appending its own suffix (see `nativeEndpoint`). */
function isSystemOneUrl(url: string): boolean {
  try {
    return /\/systemone$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/**
 * The message for a failed status, which is the provider's own sentence when it
 * sent one — except for a 404 on `<base>/systemone`, which needs saying rather
 * than repeating.
 *
 * `/systemone` is appended here, not typed by the customer, and every provider
 * serves it at its version root: measured 2026-09-25, an unauthenticated POST to
 * that path answers 403 / 401 / 400 / 401 on TypeSafe, OpenRouter, Vercel and a
 * LiteLLM proxy, and 404 on none of them. So a 404 there is near-certain evidence
 * that the BASE is wrong — and the body is no help, because the one seen in the
 * field said `Not Found` and nothing else. The URL is named because it is the
 * constructed one, which is what the person has to compare against what they
 * typed; it goes through `displayEndpoint`, so a base carrying a token in its
 * query string does not put it in an error message.
 */
function httpFailureMessage(status: number, url: string, detail: string, derivedBase = false): string {
  // A base URL the connection supplied is nobody's typo: a Cloud 404 is a
  // server without the route, which `jev test`'s remedy line says.
  if (status === 404 && derivedBase) return `nothing is served at ${displayEndpoint(url)}${detail ? ` (${detail})` : ""}`;
  if (status === 404 && isSystemOneUrl(url)) {
    // No `HTTP 404:` prefix: every caller prints the code beside the message.
    return (
      `nothing is served at ${displayEndpoint(url)}${detail ? ` (${detail})` : ""}. ` +
      "`/systemone` is appended to the base URL you configured, and every Jev route serves it at the provider's version root — " +
      "so this is a base URL that is wrong, not a provider that is down."
    );
  }
  return detail || `HTTP ${status}`;
}

/** A redirect, including the opaque form a browser-style fetch returns for `redirect: "manual"` (status 0). */
function isRedirect(res: Response): boolean {
  return res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400);
}

async function postJson(url: string, bearer: string, body: unknown, signal: AbortSignal, derivedBase = false): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
      // Never followed. The configured URL is the one `validateBaseUrl` checked
      // (https, or loopback http in shadow mode only); a redirect would hand the
      // answer — the thing that can clear a deny — to an origin nobody checked,
      // plain http included. No provider redirects this POST.
      redirect: "manual",
    });
  } catch (err) {
    if (signal.aborted) throw new JevError("timeout", "Jev did not answer in time");
    throw new JevError("network", scrubSecret(err instanceof Error ? err.message : String(err), bearer));
  }
  if (isRedirect(res)) {
    try {
      void res.body?.cancel().catch(() => {});
    } catch {
      // The body is irrelevant; freeing it is best effort.
    }
    const status = res.status >= 300 && res.status < 400 ? String(res.status) : "3xx";
    throw new JevError(`http-${status}`, `HTTP ${status}: the endpoint answered with a redirect, which is never followed`);
  }
  // Kept for a 429 and a 503: the statuses whose header says when to ask again.
  const retryAfter = res.status === 429 || res.status === 503 ? res.headers.get("retry-after") : null;
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    if (signal.aborted) throw new JevError("timeout", "Jev did not answer in time");
    // No provider words to read, so nothing distinguishes a refusal from an
    // empty account: the status's own meaning stands (see `paymentRequiredCode`).
    if (res.status === 402) throw new JevError("out-of-credits", "HTTP 402: the account is out of credits");
    // A 404 needs no body to be diagnosed, and the ones seen in the field carry
    // none worth reading: the URL is the diagnosis (see `httpFailureMessage`).
    if (!res.ok) throw new JevError(`http-${res.status}`, httpFailureMessage(res.status, url, "", derivedBase), { retryAfter });
    throw new JevError("malformed", "response body is not JSON");
  }
  if (res.status === 402) {
    // A refusal is only ever recognised FROM the provider's words, so a 402
    // with none is `out-of-credits` and this message fits it. Anything the
    // provider did say is the message, refusal or not.
    const detail = providerErrorDetail(parsed, bearer);
    throw new JevError(paymentRequiredCode(detail), detail || "HTTP 402: the account is out of credits");
  }
  if (!res.ok) {
    throw new JevError(`http-${res.status}`, httpFailureMessage(res.status, url, providerErrorDetail(parsed, bearer), derivedBase), { retryAfter });
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
  /** The base URL came from a connection, not from the person (FailproofAI Cloud). */
  derivedBase?: boolean;
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
      const detail = providerErrorDetail(body, opts.apiKey) || "the provider reported an error";
      // Same two meanings, one layer in; same rule (see `paymentRequiredCode`).
      if (code === 402 || code === "402") throw new JevError(paymentRequiredCode(detail), detail);
      if (typeof code === "number" && (code === 429 || code >= 500)) throw new JevError(`http-${code}`, detail);
      throw new JevError("upstream-error", detail);
    }
    throw new JevError("malformed", "Jev response has no answers object");
  }
  const usage = b.usage && typeof b.usage === "object" ? (b.usage as JevResponse["usage"]) : undefined;
  // The reported id reaches a `model-mismatch` message, so a server echoing the key there must not carry it through.
  const reported = typeof b.model === "string" && b.model.length > 0 ? scrubSecret(b.model, opts.apiKey) : null;
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
    return normalizeNative(await postJson(opts.url, opts.apiKey, body, signal, opts.derivedBase), model, opts);
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
    return unwrapCloudflare(body, request, model, token);
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
 *
 * `secret` is the token the request was sent with. Every piece of provider
 * text that can reach an error message (`errors[].message`, a job state, a
 * reported model id) is scrubbed of it: a 200 `{success: false}` is not
 * scrubbed by `postJson`, which sees only the status.
 */
export function unwrapCloudflare(
  body: unknown,
  request: JevRequest,
  sentModel: string = CLOUDFLARE_JEV_MODEL,
  secret = "",
): JevResponse {
  const envelope = body as { success?: unknown; errors?: Array<{ message?: unknown }>; result?: unknown } | null;
  if (!envelope || typeof envelope !== "object") throw new JevError("malformed", "Cloudflare returned no object");
  if (envelope.success === false) {
    const detail = Array.isArray(envelope.errors)
      ? envelope.errors.map((e) => (typeof e?.message === "string" ? e.message : "")).filter(Boolean).join("; ")
      : "";
    // Not the refusal path: a declined request arrives as HTTP 402 and never
    // reaches here (see `paymentRequiredCode`). A 200 `{success: false}` is a
    // different failure, and `cloudflare-error` blames nobody's billing either.
    throw new JevError("cloudflare-error", scrubSecret(detail, secret).slice(0, MAX_ERROR_DETAIL) || "Cloudflare reported failure");
  }
  let inner: unknown = "result" in envelope ? envelope.result : envelope;
  // Observed live (2026-09-21): partner models add a job layer —
  // `result: {state: "Completed", result: <TypeSafe's own response>, gatewayMetadata}`.
  // Anything but a completed job is not an answer.
  const job = inner as { state?: unknown; result?: unknown } | null;
  if (job && typeof job === "object" && "state" in job && "result" in job) {
    if (job.state !== "Completed") {
      throw new JevError("cloudflare-incomplete", `Cloudflare job state ${scrubSecret(String(job.state), secret).slice(0, MAX_ERROR_DETAIL)}`);
    }
    inner = job.result;
  }
  const result = inner as Partial<JevResponse> | null;
  if (!result || typeof result !== "object" || typeof result.answers !== "object" || result.answers === null) {
    throw new JevError("malformed", "Cloudflare result has no answers");
  }
  // Echoing back the alias is not a version either.
  const reported =
    typeof result.model === "string" && result.model.length > 0 && !isAliasFor(result.model, [CLOUDFLARE_JEV_MODEL, sentModel])
      ? scrubSecret(result.model, secret)
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
    const got = typeof response.model === "string" && response.model !== "" ? response.model.slice(0, 200) : "no model id";
    throw new JevError("model-mismatch", `asked for ${request.model}, got ${got}`);
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

/**
 * A config as the loader produced it, validated again. `validateLoadedJevConfig`
 * rather than `validateJevConfig`, because the FailproofAI Cloud provider's key
 * is filled in from `credentials.json` and would be refused as a file field.
 */
function validated(cfg: JevConfig): JevConfig {
  const v = validateLoadedJevConfig(cfg);
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
  if (!base) throw new JevError("config", `provider ${cfg.provider} needs a baseUrl`);
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

// ── The model list ───────────────────────────────────────────────────────────

/**
 * Which envelope a model list arrived in. The difference decides what may be
 * DONE with it, not just how it is parsed — see the header.
 */
export type JevModelListShape =
  /** `{models:[{name, description?, release_date?}]}` — the System One inventory of this base. */
  | "typesafe"
  /** `{data:[{id, name?}]}` — a gateway's chat catalog, which does not enumerate `/systemone`. */
  | "openai";

export interface JevModelListRead {
  ok: true;
  shape: JevModelListShape;
  /** Model ids, in the order the provider gave them, deduplicated. */
  models: string[];
}

export interface JevModelListUnread {
  ok: false;
  /** Why, in words meant for a person. Never a code: nothing stores or branches on this. */
  reason: string;
  /** The HTTP status, when the read got that far. */
  status?: number;
}

export type JevModelListResult = JevModelListRead | JevModelListUnread;

/**
 * A model list read is a diagnostic, and the whole point of it is to be
 * available BEFORE a config is written — so it gets its own budget rather than
 * the config's `timeoutMs`, which is sized for the hook path (3000 ms, and every
 * millisecond of it lands on a tool call).
 */
export const JEV_MODEL_LIST_TIMEOUT_MS = 2_500;

/**
 * Names kept from one list. OpenRouter's catalog is 458 entries and a proxy's
 * could be anything; this is a terminal, and a bound here is cheaper than a
 * bound at every place that prints one.
 */
const MAX_LISTED_MODELS = 200;

/**
 * `<base>/models`, or null where there is no such thing.
 *
 * Cloudflare is the null: Workers AI has no `<base>/models` — the run endpoint is
 * `/accounts/<id>/ai/run` and its inventory lives behind a different API — so
 * nothing here can read a list for it, and every caller treats that exactly like
 * a list it failed to read.
 *
 * A base that names the full request URL (`…/v1/systemone`, which `jev setup`
 * now refuses but an older file may carry) still has its version root one
 * segment up, and that is where the list is.
 */
export function jevModelsUrl(input: JevConfig): string | null {
  const cfg = validated(input);
  // FailproofAI Cloud pins the model server-side and serves no list.
  if (cfg.provider === "cloudflare" || cfg.provider === "failproofai") return null;
  const base = cfg.baseUrl ?? JEV_PROVIDER_DEFAULTS[cfg.provider].baseUrl;
  return base ? modelsUrlForBase(base) : null;
}

/** `<base>/models` for a base URL, keeping any query string the base carried. */
export function modelsUrlForBase(base: string): string | null {
  try {
    const url = new URL(base);
    url.pathname = `${url.pathname.replace(/\/systemone$/i, "").replace(/\/+$/, "")}/models`;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * The model ids in a list body, or why it could not be read. Never throws: a
 * customer's proxy may serve neither shape, or an HTML error page, and an
 * unreadable list must leave every caller exactly where it was.
 *
 * `secret` is the key the list was fetched with. Names are scrubbed of it and
 * then kept only if they are SHAPED like model ids, because these strings come
 * from a remote endpoint and are about to be printed on a terminal — a name
 * carrying control characters, or a kilobyte of them, is not a name.
 *
 * A shape that is present but yields no usable name is reported as unread rather
 * than as "this endpoint has no models": an empty list is far likelier to be a
 * shape misread than a provider serving nothing, and "unread" is the direction
 * that changes no behaviour.
 */
export function parseJevModelList(body: unknown, secret = ""): JevModelListResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, reason: "the list endpoint did not answer with a JSON object" };
  }
  const b = body as { models?: unknown; data?: unknown };
  for (const [shape, entries, keys] of [
    ["typesafe", b.models, ["name"]],
    ["openai", b.data, ["id", "name"]],
  ] as Array<[JevModelListShape, unknown, string[]]>) {
    if (!Array.isArray(entries)) continue;
    const models = listedModelNames(entries, keys, secret);
    return models.length > 0 ? { ok: true, shape, models } : { ok: false, reason: "the list named no models this build could read" };
  }
  return { ok: false, reason: "the list endpoint answered in a shape this build does not know (neither {models:[…]} nor {data:[…]})" };
}

function listedModelNames(entries: unknown[], keys: string[], secret: string): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    for (const key of keys) {
      const raw = row[key];
      if (typeof raw !== "string" || raw === "") continue;
      const name = scrubSecret(raw, secret);
      if (isModelIdShaped(name) && !out.includes(name)) out.push(name);
      break;
    }
    if (out.length >= MAX_LISTED_MODELS) break;
  }
  return out;
}

/**
 * `GET <base>/models`. Returns a reading or a reason, never a throw, because
 * every caller's fallback is to carry on as if the endpoint served no list.
 *
 * `apiKey` may be null: Vercel's and OpenRouter's lists are public, and reading
 * one with no key is better than not reading it. Redirects are not followed, for
 * the reason `postJson` gives — a list read is less dangerous than an answer, but
 * an endpoint that moves this GET somewhere unchecked has not earned the key that
 * would ride along with it.
 */
export async function readJevModelList(url: string, apiKey: string | null, signal: AbortSignal): Promise<JevModelListResult> {
  const secret = apiKey ?? "";
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      signal,
      redirect: "manual",
    });
  } catch (err) {
    if (signal.aborted) return { ok: false, reason: `it did not answer within ${JEV_MODEL_LIST_TIMEOUT_MS} ms` };
    return { ok: false, reason: printable(scrubSecret(err instanceof Error ? err.message : String(err), secret)).slice(0, MAX_ERROR_DETAIL) };
  }
  if (isRedirect(res)) {
    try {
      void res.body?.cancel().catch(() => {});
    } catch {
      // The body is irrelevant; freeing it is best effort.
    }
    return { ok: false, reason: "it answered with a redirect, which is never followed" };
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    if (signal.aborted) return { ok: false, reason: `it did not answer within ${JEV_MODEL_LIST_TIMEOUT_MS} ms` };
    return { ok: false, reason: `HTTP ${res.status}: it answered with no JSON`, status: res.status };
  }
  if (!res.ok) {
    // The provider's own sentence, from whichever envelope — which for a list
    // read is usually "Must supply an API key!", and is the answer.
    const detail = providerErrorDetail(parsed, secret);
    return { ok: false, reason: detail ? `HTTP ${res.status}: ${detail}` : `HTTP ${res.status}`, status: res.status };
  }
  return parseJevModelList(parsed, secret);
}

/**
 * Whether a reading is authoritative about what `<base>/systemone` accepts, and
 * so may be used to REFUSE a model rather than only to show one.
 *
 * Only the TypeSafe shape is. The evidence is in the header: OpenRouter serves an
 * OpenAI-shaped catalog of 458 models with no Jev entry in it, while its
 * `/systemone` exists and is addressed as `typesafe/jev-1.13` — so refusing on an
 * OpenAI-shaped list would refuse a route that works.
 */
export function listDescribesSystemOne(list: JevModelListRead): boolean {
  return list.shape === "typesafe";
}

/**
 * Whether a list covers a configured model id.
 *
 * Exact match, or the id without an `<owner>/` prefix. That second case is
 * measured, not a convenience: Vercel names one model `typesafe-ai/jev` in its
 * gateway catalog and `jev` in the typesafe-scoped list at the base we POST to,
 * differing by exactly that prefix (see the header).
 *
 * A versioned id (`jev-1.13.0`) always counts: a list names aliases, and cannot
 * prove one absent (see the header).
 */
export function modelListHasModel(list: JevModelListRead, model: string): boolean {
  if (jevModelVersion(model) !== null) return true;
  if (list.models.includes(model)) return true;
  const slash = model.lastIndexOf("/");
  return slash > 0 && list.models.includes(model.slice(slash + 1));
}

// ── FailproofAI Cloud: Retry-After ───────────────────────────────────────────
//
// FailproofAI Cloud rate-limits Jev per org and globally, and its 429 carries
// `Retry-After: <seconds to the window's end>` (contract §2). Every call that
// ignores it spends a round trip — up to the hook's whole timeout, on the tool
// call's critical path — to learn the same 429, and adds to the load that
// caused it. So after a 429 the Cloud route goes quiet for as long as the
// server asked: calls fall back at once with the same `http-429`, and send
// nothing.
//
// Module-level, like the throttle's cache and bucket (`jev-throttle.ts`): the
// daemon's warm worker builds a new transport per hook event and lives for
// hours, so the process is what has to remember. Keyed by the endpoint, so a
// reconnect to another Cloud is not held to the old one's window.
//
// The Cloud route only. A BYOK provider's 429 keeps doing exactly what it did
// (the throttle empties its bucket), because nothing here knows what its
// `Retry-After` means or whether it sends one.

/** The longest cool-down a Retry-After can set: a hook never goes quiet for longer on the server's say-so. */
export const JEV_CLOUD_RETRY_AFTER_CAP_MS = 60_000;
/** The cool-down after a 429 whose Retry-After is missing or unreadable. */
export const JEV_CLOUD_RETRY_AFTER_DEFAULT_MS = 5_000;

const cloudCooldown = { endpoint: "", until: Number.NEGATIVE_INFINITY, code: "http-429" };

/** Forget any cool-down. For tests, which share this module's state within a file. */
export function resetJevCloudCooldown(): void {
  cloudCooldown.endpoint = "";
  cloudCooldown.until = Number.NEGATIVE_INFINITY;
  cloudCooldown.code = "http-429";
}

/** RFC 9110's IMF-fixdate, the one HTTP-date form a sender generates: `Sun, 06 Nov 1994 08:49:37 GMT`. */
const IMF_FIXDATE_RE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * How long a `Retry-After` asks for, in ms, within [0, cap]. Delay-seconds
 * (what FailproofAI Cloud sends) or an IMF-fixdate; anything else — absent,
 * negative, fractional, garbage — is the small default. Matched by shape
 * before `Date.parse` sees it, because that parser reads `-5` or `1.5` as a
 * date in the past, which would be no cool-down at all.
 */
export function retryAfterMs(header: string | null | undefined, nowEpochMs: number = Date.now()): number {
  const raw = header?.trim() ?? "";
  let ms: number;
  if (/^\d{1,10}$/.test(raw)) {
    ms = Number(raw) * 1000;
  } else if (IMF_FIXDATE_RE.test(raw) && Number.isFinite(Date.parse(raw))) {
    ms = Date.parse(raw) - nowEpochMs;
  } else {
    return JEV_CLOUD_RETRY_AFTER_DEFAULT_MS;
  }
  return Math.min(JEV_CLOUD_RETRY_AFTER_CAP_MS, Math.max(0, ms));
}

/**
 * The Cloud transport, quiet for as long as the last 429's Retry-After asked —
 * and after a 503 too. The server's 503 is an operator state (no model
 * gateway, an org not provisioned yet, the gateway down) that waiting does not
 * fix, so without a Retry-After it holds the longest this ever does, and a held
 * call keeps the code that started it rather than reading as a rate limit.
 */
function cloudRetryAfter(endpoint: string, transport: JevTransport): JevTransport {
  return async (request, signal) => {
    const now = performance.now();
    if (cloudCooldown.endpoint === endpoint && now < cloudCooldown.until) {
      const seconds = Math.max(1, Math.ceil((cloudCooldown.until - now) / 1000));
      throw new JevError(
        cloudCooldown.code,
        cloudCooldown.code === "http-503"
          ? `FailproofAI Cloud could not serve Jev; asking again in ${seconds}s, so this one was not sent`
          : `FailproofAI Cloud asked for no Jev requests for ${seconds}s more (Retry-After), so this one was not sent`,
      );
    }
    try {
      return await transport(request, signal);
    } catch (err) {
      if (err instanceof JevError && (err.code === "http-429" || err.code === "http-503")) {
        cloudCooldown.endpoint = endpoint;
        cloudCooldown.code = err.code;
        cloudCooldown.until =
          performance.now() +
          (err.code === "http-503" && err.retryAfter === null ? JEV_CLOUD_RETRY_AFTER_CAP_MS : retryAfterMs(err.retryAfter));
      }
      throw err;
    }
  };
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
          // A proxy echoing back an UNVERSIONED name the customer configured for
          // it (`--model house-jev`) has said nothing about the version, the way
          // Vercel's alias has not; that answer is used and marked unverified.
          // One reporting a real Jev version is checked. One reporting no model
          // at all is refused: unlike Vercel and Cloudflare, nothing is known
          // about what sits behind a custom URL, so silence is not accepted.
          aliases: [route.model],
          allowUnreported: false,
        }),
        via: "custom",
        model: route.model,
      };
    case "failproofai":
      return {
        transport: cloudRetryAfter(
          route.endpoint,
          nativeTransport({
            url: route.endpoint,
            apiKey: cfg.apiKey,
            model: route.model,
            // FailproofAI Cloud forces `jev-1.13.0` server-side and passes
            // TypeSafe's answer through untouched, `model` included — so an
            // answer that names no model, or an alias, is not one this route
            // produces, and is refused (`model-mismatch`) rather than trusted.
            // `readAnswers` then holds the reported id to the 1.13 family.
            allowUnreported: false,
            derivedBase: true,
          }),
        ),
        via: "failproofai",
        model: route.model,
      };
  }
}
