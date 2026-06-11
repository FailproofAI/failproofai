/**
 * Low-level HTTP client for the FailproofAI api-server's /v0/auth/* endpoints.
 *
 * Shared by both the CLI (failproofai auth ...) and the dashboard's Next.js
 * API route proxies. Has no filesystem access — token persistence lives in
 * `./auth-store.ts`.
 *
 * The base URL is resolved from FAILPROOF_API_URL (preferred) or the legacy
 * FAILPROOFAI_API_URL, falling back to the hosted api-server. Local-dev
 * contributors should set FAILPROOF_API_URL=http://localhost:8080 (or
 * whatever port their local api-server uses) in `.env.local`.
 */

import { trackEvent } from "../telemetry";
import { isAbortError } from "../fetch-with-timeout";

export const DEFAULT_API_BASE = "https://api.befailproof.ai";

export function getApiBase(): string {
  const raw =
    process.env.FAILPROOF_API_URL ??
    process.env.FAILPROOFAI_API_URL ??
    DEFAULT_API_BASE;
  return raw.replace(/\/+$/, "");
}

export class AuthApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterSecs?: number;
  constructor(status: number, code: string, message: string, retryAfterSecs?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfterSecs = retryAfterSecs;
    this.name = "AuthApiError";
  }
}

export interface LoginRequestResponse {
  status: "code_sent";
  expires_in: number;
  resend_available_in: number;
}

export interface UserView {
  id: string;
  email: string;
}

export interface TokenResponse {
  token_type: "Bearer";
  access_token: string;
  access_expires_in: number;
  refresh_token: string;
  refresh_expires_in: number;
  user: UserView;
}

export interface RefreshResponse {
  token_type: "Bearer";
  access_token: string;
  access_expires_in: number;
  refresh_token: string;
  refresh_expires_in: number;
}

export interface MeResponse {
  id: string;
  email: string;
  status: string;
  created_at: string;
}

interface ServerErrorBody {
  // The docs describe `{ code, message }`; the live Rust server returns
  // `{ success: false, code, detail }`. We tolerate either.
  code?: string;
  message?: string;
  detail?: string;
  retry_after_secs?: number;
}

async function parseError(res: Response): Promise<AuthApiError> {
  let body: ServerErrorBody = {};
  try {
    body = (await res.json()) as ServerErrorBody;
  } catch {
    // body might be empty or non-JSON
  }
  const code = body.code ?? `http_${res.status}`;
  const message = body.message ?? body.detail ?? res.statusText ?? "request failed";
  let retryAfterSecs = body.retry_after_secs;
  if (retryAfterSecs === undefined) {
    const h = res.headers.get("retry-after");
    if (h) {
      const n = Number(h);
      if (Number.isFinite(n)) retryAfterSecs = n;
    }
  }
  // Clamp to a sane range: a misbehaving (or hostile) api-server could
  // return `-3600` or `1e20` and our UI would render "wait 1e20s" or
  // backoff loops would fire immediately on negatives. 24h is the longest
  // wait the dashboard/CLI is willing to surface as a literal duration.
  if (retryAfterSecs !== undefined) {
    retryAfterSecs = Math.max(0, Math.min(86400, retryAfterSecs));
  }
  return new AuthApiError(res.status, code, message, retryAfterSecs);
}

/** Hard cap on every auth/reminder HTTP call. Without this, a wedged DNS
 *  resolver or a hung server keeps the CLI / dashboard route stuck forever. */
const REQUEST_TIMEOUT_MS = 10_000;

function timeoutSignal(extra?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  if (!extra) return t;
  // Compose so an externally-cancelled caller still aborts. Prefer the
  // native `AbortSignal.any` (Node 20.3+, Bun 1.0.27+); fall back to a
  // hand-rolled controller for older runtimes — without this fallback
  // an `extra` signal would be silently dropped.
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (anyFn) return anyFn([t, extra]);
  const composed = new AbortController();
  const onAbort = (s: AbortSignal) => composed.abort(s.reason);
  if (t.aborted) onAbort(t);
  else t.addEventListener("abort", () => onAbort(t), { once: true });
  if (extra.aborted) onAbort(extra);
  else extra.addEventListener("abort", () => onAbort(extra), { once: true });
  return composed.signal;
}

function pathFromUrl(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: timeoutSignal(init.signal ?? undefined) });
  } catch (err) {
    const isTimeout = isAbortError(err);
    // Low-cardinality "api-server is down" counter. We only attach the
    // request path (not the full URL) and a coarse kind so it stays a
    // cheap signal in PostHog. No-ops on the CLI side when telemetry
    // has not been initialised.
    trackEvent("api_server_unreachable", {
      kind: isTimeout ? "timeout" : "network",
      path: pathFromUrl(url),
      method: typeof init.method === "string" ? init.method : "GET",
    });
    if (isTimeout) {
      throw new AuthApiError(
        0,
        "timeout",
        `request to ${url} timed out after ${REQUEST_TIMEOUT_MS}ms`,
      );
    }
    throw err;
  }
}

async function postJson<T>(path: string, body: unknown, init?: { accessToken?: string }): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init?.accessToken) headers["authorization"] = `Bearer ${init.accessToken}`;
  const res = await fetchWithTimeout(`${getApiBase()}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as T;
}

async function getJson<T>(path: string, accessToken: string): Promise<T> {
  const res = await fetchWithTimeout(`${getApiBase()}${path}`, {
    method: "GET",
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as T;
}

export async function requestLoginCode(email: string): Promise<LoginRequestResponse> {
  return postJson<LoginRequestResponse>("/v0/auth/login/request", { email });
}

export async function verifyLoginCode(email: string, code: string): Promise<TokenResponse> {
  return postJson<TokenResponse>("/v0/auth/login/verify", { email, code });
}

export async function refreshAccessToken(refreshToken: string): Promise<RefreshResponse> {
  return postJson<RefreshResponse>("/v0/auth/token/refresh", {
    refresh_token: refreshToken,
  });
}

export async function logoutSession(accessToken: string, refreshToken: string): Promise<void> {
  await postJson<void>(
    "/v0/auth/logout",
    { refresh_token: refreshToken },
    { accessToken },
  );
}

export async function fetchMe(accessToken: string): Promise<MeResponse> {
  return getJson<MeResponse>("/v0/auth/me", accessToken);
}

export interface ServerReminder {
  user_id: string;
  email: string;
  fire_at: number; // unix seconds
  set_at: number;  // unix seconds
}

export async function scheduleReminder(
  accessToken: string,
  body: { in_days?: number; at?: number },
): Promise<ServerReminder> {
  const res = await postJson<{ reminder: ServerReminder }>(
    "/v0/reminders",
    body,
    { accessToken },
  );
  return res.reminder;
}

export async function cancelReminder(accessToken: string): Promise<void> {
  const res = await fetchWithTimeout(`${getApiBase()}/v0/reminders`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 204 || res.ok) return;
  throw await parseError(res);
}

export interface InviteSendResult {
  /** Recipients that were dispatched successfully. */
  sent: string[];
  /** Recipients that failed (bad address, bounce, rate-limit, etc.). */
  failed: string[];
}

/**
 * Send invite emails to a batch of friends. The api-server pulls the sender's
 * email from the access-token claims and Cc's them on every outbound message
 * so the recipient sees who invited them.
 *
 * Contract is handed over to the platform team separately.
 */
export async function sendInvites(
  accessToken: string,
  to: string[],
): Promise<InviteSendResult> {
  return postJson<InviteSendResult>(
    "/v0/invite",
    { to },
    { accessToken },
  );
}

interface JwtClaims {
  sub: string;
  email: string;
  iss?: string;
  aud?: string;
  iat?: number;
  exp: number;
  token_type?: string;
}

/**
 * Decode the JWT payload without verifying the signature. Safe for client-side
 * reading (sub, email, exp). Returns null if the token is malformed.
 *
 * Strictly validates base64url before decoding: `Buffer.from(s, 'base64url')`
 * silently truncates on illegal characters (`+`, `/`, whitespace, embedded
 * NULs) rather than throwing, and the truncated bytes can happen to parse as
 * JSON with a numeric `exp` field, producing synthetic "valid" claims from a
 * corrupted token.
 */
const BASE64URL_RE = /^[A-Za-z0-9_-]+={0,2}$/;

export function decodeJwt(token: string): JwtClaims | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    // Header and payload must both be syntactically valid base64url. Empty
    // segments are also rejected (Buffer.from("","base64url") would return
    // an empty buffer that JSON.parse correctly throws on, but rejecting
    // upfront is cheaper and clearer).
    if (!BASE64URL_RE.test(parts[0])) return null;
    if (!BASE64URL_RE.test(parts[1])) return null;
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const parsed = JSON.parse(json) as JwtClaims;
    if (typeof parsed.exp !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}
