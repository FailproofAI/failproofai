/**
 * A minimal client for Jev, reachable two ways:
 *
 * - TypeSafe directly: `POST https://api.typesafe.ai/v1/systemone` with a
 *   TypeSafe key, body `{model, state, questions}`.
 * - Cloudflare Workers AI: `POST https://api.cloudflare.com/client/v4/accounts/
 *   <account>/ai/run` with a Cloudflare API token, body
 *   `{model: "typesafe/jev", input: {state, questions}}`. The answer is
 *   TypeSafe's own response, wrapped twice: Cloudflare's
 *   `{success, errors, result}` envelope around a job layer
 *   `{state: "Completed", result, gatewayMetadata}` (observed live).
 *
 * Credentials live in files under `~/.config/typesafe/` (or
 * `FAILPROOFAI_JEV_CONFIG_DIR`): `api_key` for TypeSafe, or `cloudflare_token`
 * plus `cloudflare.json` (`{"accountId": "…"}`) for Cloudflare. `TYPESAFE_API_KEY`
 * also works. Files are the path that works on a daemon machine: the daemon
 * protocol forwards a hook's stdin and cwd to the warm worker, never the
 * shell's environment.
 *
 * Both endpoints are fixed hosts with no override. A repository's
 * `.claude/settings.json` can set environment variables for a session, so a
 * configurable endpoint would let a cloned repo point the evaluator at a server
 * that answers "nothing is dangerous". Redirecting the config directory only
 * ever reaches the real TypeSafe or Cloudflare API.
 *
 * Deliberately raw `fetch` and no SDK: `policy-evaluator.ts` records a single
 * import being weighed in bytes on the hook path.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { JevConfig, JevProviderKind } from "./jev-config";
import type { JevRequest, JevResponse } from "./types";

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
/** Cloudflare's name for Jev. Unversioned — see `unwrapCloudflare`. */
export const CLOUDFLARE_JEV_MODEL = "typesafe/jev";
const CLOUDFLARE_ACCOUNT_ID_RE = /^[0-9a-f]{32}$/;
export const cloudflareRunEndpoint = (accountId: string): string =>
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run`;

/** $0.042 per million input tokens; output tokens are free. */
export const JEV_USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

export type JevTransport = (request: JevRequest, signal: AbortSignal) => Promise<JevResponse>;

export class JevError extends Error {
  /** Short, stable cause used in logs: timeout, network, http-429, cloudflare-error, malformed, model-mismatch. */
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "JevError";
    this.code = code;
  }
}

// ── Credentials ──────────────────────────────────────────────────────────────

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
 * Which way to reach Jev, or null if neither is configured. A TypeSafe key
 * wins over Cloudflare when both exist. A Cloudflare account id that is not
 * 32 hex characters is treated as not configured — it is interpolated into a
 * URL path.
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

export function transportFor(provider: JevProvider): JevTransport {
  return provider.kind === "typesafe" ? httpTransport(provider.apiKey) : cloudflareTransport(provider.token, provider.accountId);
}

// ── Transports ───────────────────────────────────────────────────────────────

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
    throw new JevError("network", err instanceof Error ? err.message : String(err));
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    if (!res.ok) throw new JevError(`http-${res.status}`, `HTTP ${res.status}`);
    throw new JevError("malformed", "response body is not JSON");
  }
  if (!res.ok) {
    const errors = (parsed as { errors?: Array<{ message?: string }> })?.errors;
    const detail = Array.isArray(errors) ? errors.map((e) => e?.message).filter(Boolean).join("; ") : "";
    throw new JevError(`http-${res.status}`, detail || `HTTP ${res.status}`);
  }
  return parsed;
}

export function httpTransport(apiKey: string): JevTransport {
  return async (request, signal) => (await postJson(JEV_ENDPOINT, apiKey, request, signal)) as JevResponse;
}

export function cloudflareTransport(token: string, accountId: string): JevTransport {
  if (!CLOUDFLARE_ACCOUNT_ID_RE.test(accountId)) throw new JevError("config", "Cloudflare account id must be 32 hex characters");
  const endpoint = cloudflareRunEndpoint(accountId);
  return async (request, signal) => {
    const body = await postJson(
      endpoint,
      token,
      { model: CLOUDFLARE_JEV_MODEL, input: { state: request.state, questions: request.questions } },
      signal,
    );
    return unwrapCloudflare(body, request);
  };
}

/**
 * Cloudflare's `{success, errors, result}` envelope → a Jev response.
 *
 * Cloudflare addresses Jev as `typesafe/jev`, without a version. When the
 * result says which Jev answered, `readAnswers` enforces the pin exactly as it
 * does for TypeSafe. When it does not, the version cannot be checked from
 * here: the response carries the pinned name so the answers are usable, and
 * `modelUnverified` puts that gap in the verdict log instead of hiding it.
 */
export function unwrapCloudflare(body: unknown, request: JevRequest): JevResponse {
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
  const reported = typeof result.model === "string" && result.model !== CLOUDFLARE_JEV_MODEL ? result.model : null;
  return {
    model: reported ?? request.model,
    answers: result.answers,
    ...(result.usage ? { usage: result.usage } : {}),
    ...(reported === null ? { modelUnverified: true } : {}),
  };
}

/**
 * Probabilities keyed by question id, or a JevError. Every question must come
 * back as a finite number in [0, 1], and the model must be the one pinned —
 * thresholds were set against a specific model and mean nothing for another.
 */
export function readAnswers(request: JevRequest, response: JevResponse): Record<string, number> {
  if (!response || typeof response !== "object" || typeof response.answers !== "object" || response.answers === null) {
    throw new JevError("malformed", "Jev response has no answers object");
  }
  if (response.model !== request.model) {
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

/**
 * The transport for a customer's own Jev config. T0 stub: TypeSafe direct and
 * Cloudflare only, through the existing transports. T1 replaces it with the
 * provider layer (OpenRouter, Vercel, custom URL, version handling).
 */
export function transportForConfig(cfg: JevConfig): { transport: JevTransport; via: JevProviderKind; model: string } {
  if (cfg.provider === "typesafe") {
    return { transport: httpTransport(cfg.apiKey), via: "typesafe", model: cfg.model ?? "jev-1.13.0" };
  }
  if (cfg.provider === "cloudflare") {
    return { transport: cloudflareTransport(cfg.apiKey, cfg.accountId ?? ""), via: "cloudflare", model: cfg.model ?? "jev-1.13.0" };
  }
  throw new JevError("config", `provider ${cfg.provider} is not supported yet`);
}
