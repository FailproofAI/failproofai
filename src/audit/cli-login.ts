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
import {
  authFromTokenResponse,
  readAuth,
  writeAuth,
  type StoredAuth,
} from "../../lib/auth/auth-store";
import {
  ANSI_RESET,
  BAR,
  colorsEnabled,
  intro,
  outro,
  promptText,
  step,
  stepOpen,
} from "../hooks/tui";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The api-server's own bound on a submitted code (`auth/models.rs`). Matched
 * here so a paste that is obviously too long is rejected at the prompt, where
 * it can be retyped, rather than by the server — which answers
 * `validation_error` rather than `invalid_code`, a distinction the retry loop
 * below treats as fatal.
 */
const CODE_MIN = 4;
const CODE_MAX = 12;

/**
 * The spine a prompt hangs off, so the two questions sit inside the same frame
 * `intro`/`outro` draw. Empty when colour is off or output is piped: the frame
 * is decoration, and a log file should not collect box-drawing characters.
 */
function spine(): string {
  return colorsEnabled(process.stdout)
    ? `${ANSI_DIM_BAR}${BAR}${ANSI_RESET}  `
    : "";
}
const ANSI_DIM_BAR = "\x1B[2m";

/**
 * Codes are numeric (`auth/otp.rs` generates digits only), so anything else in
 * the field is packaging: "Your failproof code is 123456", a copied "123 456",
 * a stray trailing space from a double-click selection. Keeping the digits is
 * the difference between a paste that works and one that costs a fresh email.
 *
 * Applied only when the input HAS digits and something else — a field of pure
 * digits passes through untouched, so a genuinely wrong code is still reported
 * as wrong rather than silently rewritten into a different one.
 */
export function extractCode(raw: string): string {
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  const runs = trimmed.match(/\d+/g) ?? [];
  if (runs.length === 0) return trimmed;
  // A run long enough to BE a code wins outright.
  //
  // Joining every digit in the line was the whole rule, and the prompt's own
  // hint ("paste the whole line if you like") walks straight into it: the real
  // message reads `Your failproof code is 123456 (expires in 10 minutes)`, so
  // the join produced `12345610` — eight digits, which passes the 4–12
  // validator, reaches the server, and burns an attempt on a code nobody typed.
  // Anything the sentence adds after the code is short; the code is not.
  const whole = runs.find((run) => run.length >= CODE_MIN);
  if (whole) return whole;
  // Otherwise the digits really are split — a copied `123 456` — and joining
  // them is the reconstruction that was always intended.
  return runs.join("");
}

export interface SignedIn {
  id: string;
  email: string;
}

/**
 * Whether a sign-in flow actually ran.
 *
 * The caller uses it to decide whether its confirmation continues an open frame
 * or stands on its own: the `│` spine means "a flow is happening", so printing
 * one under a command that answered instantly from the session file would be a
 * frame with no beginning.
 */
export interface EnsureSignedIn {
  user: SignedIn;
  prompted: boolean;
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
 * The stored session, unless its refresh token has already expired.
 *
 * The check is a comparison against a number that is already in the file, so it
 * keeps the offline-friendly property the doc below argues for: no request, no
 * network failure mode, nothing new that a dropped wifi connection can break.
 * What it removes is the case where every one of those is fine and the session
 * is simply dead — revoked from another machine, or past its refresh window.
 *
 * Without it `--schedule` printed `reports to <email>` and exited 0 on a
 * session that cannot mint another access token, so the user configured
 * digests, was shown the destination, and then heard nothing for up to a full
 * interval (90 days at the maximum) with the only signal a line in the journal.
 * The dashboard already refuses this exact state in `setAutoAuditAction`, so
 * the two surfaces disagreed on the one thing this feature claims is in sync.
 *
 * Expiry is treated as "sign in again", not as an error: the OTP prompt below
 * is the remedy, and falling through to it is what makes this recoverable in
 * one command instead of needing the file removed by hand.
 */
function sessionStillValid(auth: StoredAuth | null): StoredAuth | null {
  if (!auth) return null;
  // Seconds, per StoredAuth. A file whose value is missing was normalised to
  // `access_expires_at` by `readAuth`, so this is always a real number.
  return auth.refresh_expires_at * 1000 > Date.now() ? auth : null;
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
export async function ensureSignedIn(preset?: string): Promise<EnsureSignedIn> {
  const existing = sessionStillValid(readAuth());
  if (existing) {
    // A machine already reports as somebody. An `--email` naming a DIFFERENT
    // address is refused rather than honoured: silently re-pointing where a
    // machine's digests go is the kind of change nobody notices until they
    // stop arriving, and the flag reads as "sign me in", not "switch accounts".
    if (preset && !sameAddress(preset, existing.user.email)) {
      throw new LoginError(
        `This machine is already signed in as ${existing.user.email}.\n` +
          `To report as ${preset.trim().toLowerCase()} instead, sign out first — ` +
          `from the dashboard, or by removing ~/.failproofai/audit/session.json.`,
      );
    }
    return { user: existing.user, prompted: false };
  }

  if (!canPrompt()) {
    throw new LoginError(
      "Signing in needs an interactive terminal, and this one is not.\n" +
        "Run `failproofai audit --schedule` from a shell you are sitting at,\n" +
        "or sign in from the dashboard — both write the same session file.",
    );
  }

  return { user: await runLogin(preset), prompted: true };
}

/** Addresses compare case-insensitively, because a mail server does. */
function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Reject an address the flag supplied before anything is drawn or sent.
 *
 * Returned as a message rather than thrown so the caller can fail at the CLI
 * boundary, next to where the day count is checked — a typo'd flag should look
 * like a usage error, not like a sign-in that opened a frame and gave up.
 */
export function invalidEmail(address: string): string | null {
  return EMAIL_RE.test(address.trim())
    ? null
    : `\`--email\` needs an email address (got: ${address}).`;
}

/**
 * The two prompts, inside the frame `failproofai config` uses.
 *
 * Same logo, same `│` spine, same `◆ / ◇` step glyphs, same pink `└` close —
 * because this is the same product asking, and a sign-in that looked like a
 * different tool would be the one moment the seam showed. It is also the only
 * moment this command asks for something personal, which is the moment worth
 * spending the frame on.
 *
 * Exported so a test can drive it without the caller.
 */
export async function runLogin(preset?: string): Promise<SignedIn> {
  intro("scheduled audits need somewhere to send the report");

  let address: string;
  if (preset) {
    // Supplied on the command line, so the question is already answered — but
    // it is still SHOWN, as a settled step, because it is the address a code is
    // about to be sent to and the flag is exactly where a typo hides.
    address = preset.trim().toLowerCase();
    step("your email", address);
  } else {
    const email = await promptText({
      prefix: spine(),
      message: "your email",
      hint: "you@yourdomain.com",
      validate: (v) => (EMAIL_RE.test(v.trim()) ? null : "that doesn't look like an email"),
    });
    if (email === null) {
      outro("Cancelled — nothing was changed.", { ok: false });
      throw new LoginError("Cancelled.");
    }
    address = email.trim().toLowerCase();
  }
  let expiresInMin = 10;
  try {
    const sent = await requestLoginCode(address);
    expiresInMin = Math.max(1, Math.ceil(sent.expires_in / 60));
  } catch (err) {
    outro("Could not send a login code.", { ok: false });
    throw new LoginError(describeAuthError(err, "Could not send a login code"));
  }

  // The address is echoed back on the settled step rather than left to memory:
  // a typo in it is the single most likely reason no code arrives, and this is
  // the last place it can be noticed before somebody starts waiting.
  step("code sent", `to ${address} · expires in ${expiresInMin} min`);

  // Three attempts, matching the server's own per-code cap. Looping forever
  // would keep a person typing at a code the server stopped accepting after
  // the fifth try, and one attempt would punish a typo with a fresh email.
  const ATTEMPTS = 3;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    stepOpen(attempt === 1 ? "the code from that email" : "try that code again");
    const typed = await promptText({
      prefix: spine(),
      message: "code",
      // Unmasked on purpose. A login code is single-use and expires in minutes,
      // so hiding it protects nothing and costs the one thing that matters at
      // this prompt: seeing your own typo before pressing enter.
      hint:
        attempt === 1
          ? "123456 · paste the whole line if you like"
          : `attempt ${attempt} of ${ATTEMPTS}`,
      validate: (v) => {
        // No digits at all is not a mistyped code, it is not a code — caught
        // here rather than spent as one of the server's five attempts.
        if (!/\d/.test(v)) return "a code is digits — paste the line from the email";
        const code = extractCode(v);
        if (code.length < CODE_MIN) return "that looks too short to be the code";
        if (code.length > CODE_MAX) return "that looks too long — paste just the code";
        return null;
      },
    });
    if (typed === null) {
      outro("Cancelled — nothing was changed.", { ok: false });
      throw new LoginError("Cancelled.");
    }

    try {
      const tokens = await verifyLoginCode(address, extractCode(typed));
      writeAuth(authFromTokenResponse(tokens));
      step("signed in", tokens.user.email);
      return { id: tokens.user.id, email: tokens.user.email };
    } catch (err) {
      const wrongCode = err instanceof AuthApiError && err.code === "invalid_code";
      if (wrongCode && attempt < ATTEMPTS) {
        step(
          "that code was wrong or expired",
          `${ATTEMPTS - attempt} more ${ATTEMPTS - attempt === 1 ? "try" : "tries"} before it asks for a new one`,
        );
        continue;
      }
      outro("Could not verify that code.", { ok: false });
      throw new LoginError(describeAuthError(err, "Could not verify that code"));
    }
  }
  outro("Too many wrong codes.", { ok: false });
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
