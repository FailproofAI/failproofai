/**
 * Email-OTP sign-in, in the terminal.
 *
 * The dashboard has had this since the beginning, as two API routes. The CLI
 * had nothing, which meant the one surface that works on a headless box could
 * not do the one thing scheduling requires. This is the same flow through the
 * same functions — `requestLoginCode` / `verifyLoginCode` from
 * `api-server-client`, `writeAuth` from `auth-store` — writing the same
 * `~/.failproofai/audit/session.json`.
 *
 * Sharing the store is what makes "the CLI and the dashboard are always in
 * sync" true by construction rather than by discipline: there is one file and
 * one writer, so signing in here shows up there on the next read, and signing
 * out there ends the session the scheduled audit was going to report under.
 */
import { AuthApiError, requestLoginCode, verifyLoginCode } from "../../lib/auth/api-server-client";
import { authFromTokenResponse, readAuth, writeAuth } from "../../lib/auth/auth-store";
import { promptText } from "../hooks/tui";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface SignedIn {
  id: string;
  email: string;
}

export class LoginError extends Error {}

/**
 * Whether this terminal can run an interactive prompt.
 *
 * Checked BEFORE anything is written, so a CI runner or a cron line gets one
 * clear sentence instead of a hang on a `readline` nobody will ever answer.
 */
export function canPrompt(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * Return the current session, or run the OTP flow to create one.
 *
 * Deliberately NOT `whoAmI()`: that round-trips to `/v0/auth/me` and returns
 * null on a network blip, which here would mean re-prompting a signed-in user
 * for a code because their wifi dropped. The local file is the source of truth
 * for "is somebody signed in on this machine"; whether the token still works is
 * the reporting path's problem, and it already handles that by pausing digests
 * rather than failing.
 */
export async function ensureSignedIn(): Promise<SignedIn> {
  const existing = readAuth();
  if (existing) return existing.user;

  if (!canPrompt()) {
    throw new LoginError(
      "Signing in needs an interactive terminal, and this one is not.\n" +
        "Run `failproofai audit --schedule` from a shell you are sitting at,\n" +
        "or sign in from the dashboard — both write the same session file.",
    );
  }

  return runLogin();
}

/** The two prompts. Exported so a test can drive it without the caller. */
export async function runLogin(): Promise<SignedIn> {
  process.stdout.write("\nScheduled audits email you when a scan finds something,\nso this needs an address to send to.\n\n");

  const email = await promptText({
    message: "your email",
    hint: "you@yourdomain.com",
    validate: (v) => (EMAIL_RE.test(v.trim()) ? null : "that doesn't look like an email"),
  });
  if (email === null) throw new LoginError("Cancelled.");

  const address = email.trim().toLowerCase();
  try {
    const sent = await requestLoginCode(address);
    process.stdout.write(
      `\nCode sent to ${address}. It expires in ${Math.ceil(sent.expires_in / 60)} minutes.\n\n`,
    );
  } catch (err) {
    throw new LoginError(describeAuthError(err, "Could not send a login code"));
  }

  // Three attempts, matching the server's own per-code cap. Looping forever
  // would keep a person typing at a code the server stopped accepting after
  // the fifth try, and one attempt would punish a typo with a fresh email.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const code = await promptText({
      message: "the code",
      hint: "123456",
      validate: (v) => (v.trim().length >= 4 ? null : "codes are at least 4 characters"),
    });
    if (code === null) throw new LoginError("Cancelled.");

    try {
      const tokens = await verifyLoginCode(address, code.trim());
      writeAuth(authFromTokenResponse(tokens));
      process.stdout.write(`\nSigned in as ${tokens.user.email}.\n`);
      return { id: tokens.user.id, email: tokens.user.email };
    } catch (err) {
      const wrongCode = err instanceof AuthApiError && err.code === "invalid_code";
      if (wrongCode && attempt < 3) {
        process.stderr.write("That code is wrong or expired. Try again.\n\n");
        continue;
      }
      throw new LoginError(describeAuthError(err, "Could not verify that code"));
    }
  }
  throw new LoginError("Too many wrong codes. Run the command again for a fresh one.");
}

/**
 * A sentence a person can act on.
 *
 * `AuthApiError` carries the server's own code, and two of them have a remedy
 * worth naming rather than passing through: a rate limit is a wait, and an
 * unreachable server on a machine pointed at localhost is almost always an
 * api-server that is not running.
 */
function describeAuthError(err: unknown, prefix: string): string {
  if (err instanceof AuthApiError) {
    if (err.code === "rate_limited") {
      const wait = err.retryAfterSecs;
      return `${prefix}: too many attempts.${wait ? ` Try again in ${wait}s.` : ""}`;
    }
    if (err.status === 0 || err.code === "timeout") {
      return (
        `${prefix}: the api-server did not respond.\n` +
        `It is at ${apiBaseForMessage()} — check that it is running,\n` +
        `or set FAILPROOF_API_URL to point somewhere else.`
      );
    }
    return `${prefix}: ${err.message}`;
  }
  return `${prefix}: ${err instanceof Error ? err.message : String(err)}`;
}

function apiBaseForMessage(): string {
  return process.env.FAILPROOF_API_URL ?? process.env.FAILPROOFAI_API_URL ?? "https://api.befailproof.ai";
}
