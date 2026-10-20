/**
 * The CLI half of "Log in to FailproofAI Cloud" — `failproofai config`'s
 * browser login.
 *
 * The CLI asks the dashboard for a link, a person approves it in a browser
 * (signing up, signing in, picking or creating an org on the way), and the CLI
 * — polling with a secret only it holds — sees the approval and, once setup has
 * finished, claims a freshly minted machine key. The server side is
 * `server/src/routes/cli_login.rs` in AgentEye; the relay is the dashboard's
 * `/api/auth/cli/*`.
 *
 * Three calls, each with an injectable `fetch` so tests never reach the network:
 *   start → { verificationUrl, pollSecret, expiresIn, interval }
 *   poll  → pending / slow_down / approved (org + who) / denied / expired / …
 *   claim → the key, exactly once. Called at APPLY, after the daemon installs:
 *           an approval that is never claimed leaves no key behind.
 *
 * Every call refuses to follow a redirect, for the reason `introspectKey` gives:
 * a dashboard that does not know a path can answer with a login page, and a 200
 * from that must never read as success.
 */

export const LOGIN_START_PATH = "/api/auth/cli/start";
export const LOGIN_POLL_PATH = "/api/auth/cli/poll";
export const LOGIN_CLAIM_PATH = "/api/auth/cli/claim";

const TIMEOUT_MS = 10_000;

export interface LoginOrg {
  id?: string;
  slug?: string;
  name?: string;
}

export type StartResult =
  | { kind: "ok"; verificationUrl: string; pollSecret: string; expiresIn: number; interval: number }
  /** This cloud predates browser login. Pasting a key still works. */
  | { kind: "unsupported" }
  | { kind: "refused"; reason: string }
  | { kind: "unreachable"; reason: string };

export type PollResult =
  | { kind: "pending"; interval?: number }
  | { kind: "slow_down" }
  | { kind: "approved"; org: LoginOrg; approvedBy?: string; keyName?: string; permissions: string[] }
  | { kind: "denied" }
  | { kind: "expired" }
  | { kind: "claimed" }
  /** The server no longer knows this request (swept, or never existed). */
  | { kind: "unknown" }
  | { kind: "unreachable"; reason: string };

export type ClaimResult =
  | {
      kind: "ok";
      key: string;
      keyId?: string;
      keyName?: string;
      org: LoginOrg;
      permissions: string[];
      approvedBy?: string;
    }
  | { kind: "expired" }
  /** The person who approved can no longer grant this key. */
  | { kind: "revoked" }
  | { kind: "refused"; reason: string }
  | { kind: "unreachable"; reason: string };

type Fetch = typeof fetch;

async function postJson(
  origin: string,
  path: string,
  body: unknown,
  fetchImpl: Fetch,
): Promise<{ status: number; json: Record<string, unknown> | null } | { error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${origin.replace(/\/+$/, "")}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: controller.signal,
    });
    let json: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = await res.json();
      json = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json };
  } catch (err) {
    // Deliberately not the URL: setup is often run while screen-sharing.
    return { error: err instanceof Error ? (err.name === "AbortError" ? "timed out" : err.message) : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

function org(v: unknown): LoginOrg {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  return { id: str(o.id), slug: str(o.slug), name: str(o.name) };
}

function permissions(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((p): p is string => typeof p === "string") : [];
}

/**
 * Only an http(s) link is ever handed to the browser opener. The URL comes from
 * the server, and `xdg-open` / `open` will happily act on any scheme they know.
 */
export function isOpenableUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/** What the browser page should call this machine and its OS. */
export function machineOs(platform: NodeJS.Platform = process.platform): string {
  return platform === "darwin" ? "macOS" : platform === "win32" ? "windows" : platform;
}

export async function startLogin(
  origin: string,
  machine: { label: string; os: string; cliVersion: string },
  fetchImpl: Fetch = fetch,
): Promise<StartResult> {
  const r = await postJson(
    origin,
    LOGIN_START_PATH,
    { machine_label: machine.label, machine_os: machine.os, cli_version: machine.cliVersion },
    fetchImpl,
  );
  if ("error" in r) return { kind: "unreachable", reason: r.error };
  // No such route, or the web app redirecting an unknown path: a cloud from
  // before this feature. Not an error — the key prompt still connects it.
  if (r.status === 404 || (r.status >= 300 && r.status < 400)) return { kind: "unsupported" };
  if (r.status === 429) return { kind: "refused", reason: "too many login attempts from here — wait a minute" };
  if (r.status !== 201 || !r.json) {
    return r.status >= 500
      ? { kind: "unreachable", reason: `the server answered ${r.status}` }
      : { kind: "refused", reason: str(r.json?.error) ?? `the server answered ${r.status}` };
  }
  const verificationUrl = str(r.json.verification_url);
  const pollSecret = str(r.json.poll_secret);
  if (!verificationUrl || !pollSecret || !isOpenableUrl(verificationUrl)) {
    // A 201 without the fields is something other than this API.
    return { kind: "unsupported" };
  }
  const n = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : d);
  return {
    kind: "ok",
    verificationUrl,
    pollSecret,
    expiresIn: n(r.json.expires_in, 600),
    interval: n(r.json.interval, 2),
  };
}

export async function pollLogin(origin: string, pollSecret: string, fetchImpl: Fetch = fetch): Promise<PollResult> {
  const r = await postJson(origin, LOGIN_POLL_PATH, { poll_secret: pollSecret }, fetchImpl);
  if ("error" in r) return { kind: "unreachable", reason: r.error };
  if (r.status === 404) return { kind: "unknown" };
  if (r.status !== 200 || !r.json) return { kind: "unreachable", reason: `the server answered ${r.status}` };
  const j = r.json;
  switch (j.status) {
    case "pending":
      return { kind: "pending", interval: typeof j.interval === "number" ? j.interval : undefined };
    case "slow_down":
      return { kind: "slow_down" };
    case "approved":
      return {
        kind: "approved",
        org: org(j.org),
        approvedBy: str(j.approved_by),
        keyName: str(j.key_name),
        permissions: permissions(j.permissions),
      };
    case "denied":
      return { kind: "denied" };
    case "expired":
      return { kind: "expired" };
    case "claimed":
      return { kind: "claimed" };
    default:
      return { kind: "unknown" };
  }
}

export async function claimLogin(origin: string, pollSecret: string, fetchImpl: Fetch = fetch): Promise<ClaimResult> {
  const r = await postJson(origin, LOGIN_CLAIM_PATH, { poll_secret: pollSecret }, fetchImpl);
  if ("error" in r) return { kind: "unreachable", reason: r.error };
  const j = r.json ?? {};
  if (r.status === 201) {
    const key = str(j.api_key);
    if (!key) return { kind: "refused", reason: "the server answered without a key" };
    return {
      kind: "ok",
      key,
      keyId: str(j.key_id),
      keyName: str(j.key_name),
      org: org(j.org),
      permissions: permissions(j.permissions),
      approvedBy: str(j.approved_by),
    };
  }
  if (r.status === 410) return { kind: "expired" };
  if (r.status === 403 && j.error === "approval_revoked") return { kind: "revoked" };
  if (r.status >= 500) return { kind: "unreachable", reason: `the server answered ${r.status}` };
  return {
    kind: "refused",
    reason: str(j.status) ? `the login request is ${String(j.status)}` : `the server answered ${r.status}`,
  };
}
