/**
 * Persistence layer for the signed-in session.
 *
 * Tokens live at `~/.failproofai/audit/session.json` with mode 0600 (layout 4;
 * `auth.json` at the home root before that). The dashboard's Next.js API routes
 * and the audit child both read and write through here, so a session survives
 * across dashboard runs and is the same one a scheduled report uses.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { writeJsonAtomically } from "../atomic-write";
import { auditDir, auditSessionFile } from "../../src/hooks/fp-home";
import {
  AuthApiError,
  decodeJwt,
  fetchMe,
  refreshAccessToken,
  type MeResponse,
} from "./api-server-client";

export interface StoredAuth {
  access_token: string;
  refresh_token: string;
  access_expires_at: number; // unix seconds
  refresh_expires_at: number; // unix seconds (best-effort; not strictly verified server-side)
  user: { id: string; email: string };
}

/**
 * Where the session file lives.
 *
 * `FAILPROOFAI_AUTH_DIR` overrides it OUTRIGHT — the override names the
 * directory the two files sit in directly, with no `audit/` beneath it, which is
 * the contract it has always had and what every test using it expects. Without
 * the override the paths come from `fp-home.ts`, which as of layout 4 puts them
 * under `audit/` with the rest of what the audit owns.
 */
export function getAuthDir(): string {
  const override = process.env.FAILPROOFAI_AUTH_DIR;
  if (override) return override;
  return auditDir();
}

export function getAuthFilePath(): string {
  const override = process.env.FAILPROOFAI_AUTH_DIR;
  return override ? join(override, "session.json") : auditSessionFile();
}

export function readAuth(): StoredAuth | null {
  const p = getAuthFilePath();
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw) as Partial<StoredAuth>;
    if (
      typeof parsed.access_token !== "string" ||
      typeof parsed.refresh_token !== "string" ||
      typeof parsed.access_expires_at !== "number" ||
      typeof parsed.user !== "object" ||
      !parsed.user ||
      typeof (parsed.user as { id?: unknown }).id !== "string" ||
      typeof (parsed.user as { email?: unknown }).email !== "string"
    ) {
      return null;
    }
    return {
      access_token: parsed.access_token,
      refresh_token: parsed.refresh_token,
      access_expires_at: parsed.access_expires_at,
      refresh_expires_at:
        typeof parsed.refresh_expires_at === "number"
          ? parsed.refresh_expires_at
          : parsed.access_expires_at,
      user: {
        id: (parsed.user as { id: string }).id,
        email: (parsed.user as { email: string }).email,
      },
    };
  } catch {
    return null;
  }
}

export function writeAuth(auth: StoredAuth): void {
  writeJsonAtomically(getAuthFilePath(), auth);
}

export function deleteAuth(): void {
  const p = getAuthFilePath();
  if (existsSync(p)) rmSync(p, { force: true });
}

/** Convert verify/refresh response into the on-disk shape. */
export function authFromTokenResponse(token: {
  access_token: string;
  refresh_token: string;
  access_expires_in: number;
  refresh_expires_in: number;
  user?: { id: string; email: string };
}, existingUser?: { id: string; email: string }): StoredAuth {
  const now = Math.floor(Date.now() / 1000);
  const user = token.user ?? existingUser;
  if (!user) {
    throw new Error("authFromTokenResponse: missing user identity");
  }
  return {
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    access_expires_at: now + token.access_expires_in,
    refresh_expires_at: now + token.refresh_expires_in,
    user,
  };
}

/**
 * Return a fresh access token, refreshing in-place if the current one is
 * within the leeway window of expiry. Mutates auth.json on disk on success.
 * Returns null if the stored session is gone or the refresh failed (caller
 * should treat that as "logged out").
 */
const REFRESH_LEEWAY_SECS = 60;

/**
 * In-flight refresh dedup. Without this, two concurrent callers (e.g.
 * the dashboard's `/api/auth/status` poll and a scheduled audit's report
 * in flight) both observe the same expired access token, both call
 * `refreshAccessToken(auth.refresh_token)` with the same refresh token,
 * and the api-server treats the second call as token-replay and revokes
 * every session for that user — a silent logout. Keying on the refresh
 * token avoids accidentally sharing a refresh across logins/logouts in
 * the same process.
 */
const inFlightRefreshes = new Map<string, Promise<StoredAuth>>();

async function dedupedRefresh(auth: StoredAuth): Promise<StoredAuth> {
  const existing = inFlightRefreshes.get(auth.refresh_token);
  if (existing) return existing;
  const p = (async () => {
    const refreshed = await refreshAccessToken(auth.refresh_token);
    const next = authFromTokenResponse(refreshed, auth.user);
    writeAuth(next);
    return next;
  })();
  inFlightRefreshes.set(auth.refresh_token, p);
  try {
    return await p;
  } finally {
    inFlightRefreshes.delete(auth.refresh_token);
  }
}

export async function getValidAccessToken(): Promise<StoredAuth | null> {
  const auth = readAuth();
  if (!auth) return null;
  const now = Math.floor(Date.now() / 1000);
  if (auth.access_expires_at - now > REFRESH_LEEWAY_SECS) return auth;
  // Either expired or close to expiring — try to refresh.
  try {
    return await dedupedRefresh(auth);
  } catch (err) {
    if (err instanceof AuthApiError && err.status === 401) {
      // Session unrecoverable — wipe.
      deleteAuth();
      return null;
    }
    // Network errors etc — surface to caller as null so the UI can recover.
    return null;
  }
}

/**
 * Verify with the server that the stored access token is still valid.
 * Refreshes once on 401. Returns the live /me response and the (possibly
 * refreshed) stored auth, or null if the session can't be recovered.
 */
export async function whoAmI(): Promise<{ me: MeResponse; auth: StoredAuth } | null> {
  const fresh = await getValidAccessToken();
  if (!fresh) return null;
  try {
    const me = await fetchMe(fresh.access_token);
    return { me, auth: fresh };
  } catch (err) {
    if (err instanceof AuthApiError && err.status === 401) {
      // Maybe the leeway wasn't enough — try one more refresh and retry.
      const reread = readAuth();
      if (!reread) return null;
      try {
        const next = await dedupedRefresh(reread);
        const me = await fetchMe(next.access_token);
        return { me, auth: next };
      } catch (retryErr) {
        // Symmetry with `getValidAccessToken`: wipe the session only on an
        // unambiguous 401. A transient timeout/5xx during the retry-fetchMe
        // must NOT throw away the freshly-written valid tokens, otherwise a
        // brief api-server hiccup silently logs the user out.
        if (retryErr instanceof AuthApiError && retryErr.status === 401) {
          deleteAuth();
        }
        return null;
      }
    }
    return null;
  }
}

/** Reads the JWT exp claim for diagnostics. */
export function readAccessExpiry(auth: StoredAuth): number | null {
  const claims = decodeJwt(auth.access_token);
  return claims?.exp ?? null;
}
