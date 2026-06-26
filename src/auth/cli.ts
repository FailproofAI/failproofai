/**
 * `failproofai auth` CLI surface.
 *
 *   failproofai auth login     Email + OTP flow; writes ~/.failproofai/auth.json
 *   failproofai auth logout    Wipe auth.json (best-effort server revoke)
 *   failproofai auth whoami    Print the cached identity (or "not signed in")
 *   failproofai auth help      Usage
 *
 * Source of truth is the local cache (~/.failproofai/auth.json). Server-side
 * validation is intentionally avoided — once a token is on disk we trust it.
 * That keeps `login`, `logout`, and `whoami` consistent with each other and
 * with the dashboard, even when the api-server is unreachable.
 */

import * as readline from "node:readline";

import {
  AuthApiError,
  getApiBase,
  logoutSession,
  requestLoginCode,
  verifyLoginCode,
} from "../../lib/auth/api-server-client";
import {
  authFromTokenResponse,
  deleteAuth,
  readAuth,
  writeAuth,
} from "../../lib/auth/auth-store";
import { CliError } from "../cli-error";
import { trackHookEvent } from "../hooks/hook-telemetry";
import { getInstanceId } from "../../lib/telemetry-id";

interface AuthCliOptions {
  mode: "login" | "logout" | "whoami" | "help";
}

const HELP = `
failproofai auth — sign in to FailproofAI from the CLI

USAGE
  failproofai auth login         Start the email + OTP login flow
  failproofai auth logout        Remove ~/.failproofai/auth.json
  failproofai auth whoami        Print the currently signed-in identity
  failproofai auth help          Show this help (also: --help, -h)

ENVIRONMENT
  FAILPROOF_API_URL              Override the api-server base URL
                                 (default: https://api.befailproof.ai)
  FAILPROOFAI_AUTH_DIR           Override where auth.json is stored
                                 (default: ~/.failproofai)

EXAMPLES
  failproofai auth login
  failproofai auth whoami
  failproofai auth logout
`.trimStart();

/** Deprecated `--login` / `--logout` / `--whoami` flags map back to subcommands
 *  so shell history and older docs keep working silently. */
const LEGACY_FLAG_TO_SUB: Record<string, "login" | "logout" | "whoami"> = {
  "--login": "login",
  "--logout": "logout",
  "--whoami": "whoami",
};

const SUBCOMMANDS = new Set(["login", "logout", "whoami", "help"]);

export function parseAuthArgs(args: string[]): AuthCliOptions {
  if (args.includes("--help") || args.includes("-h")) return { mode: "help" };

  const positional: string[] = [];
  const legacy: ("login" | "logout" | "whoami")[] = [];
  for (const a of args) {
    if (a === "--help" || a === "-h") continue;
    if (a in LEGACY_FLAG_TO_SUB) {
      legacy.push(LEGACY_FLAG_TO_SUB[a]);
      continue;
    }
    if (a.startsWith("-")) {
      throw new CliError(
        `Unknown flag for auth: ${a}\nRun \`failproofai auth help\` for usage.`,
      );
    }
    positional.push(a);
  }

  const subs = [...positional, ...legacy];
  if (subs.length === 0) return { mode: "help" };
  if (subs.length > 1) {
    throw new CliError(
      `Pick one of login, logout, whoami.\nRun \`failproofai auth help\` for usage.`,
    );
  }
  const sub = subs[0];
  if (!SUBCOMMANDS.has(sub)) {
    throw new CliError(
      `Unknown auth subcommand: ${sub}\nRun \`failproofai auth help\` for usage.`,
    );
  }
  return { mode: sub as AuthCliOptions["mode"] };
}

function prompt(question: string, opts: { hidden?: boolean } = {}): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  if (opts.hidden && process.stdin.isTTY) {
    const r = rl as unknown as {
      _writeToOutput: (s: string) => void;
      output: NodeJS.WritableStream;
    };
    const orig = r._writeToOutput.bind(rl);
    r._writeToOutput = (s: string): void => {
      if (s.length > 0 && s !== "\r\n" && s !== "\n") orig("*");
      else orig(s);
    };
  }
  return new Promise((resolve) => {
    rl.question(question, (answer: string) => {
      rl.close();
      if (opts.hidden && process.stdin.isTTY) process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const PINK = "\x1b[38;5;204m";
const GREEN = "\x1b[38;5;120m";
const RED = "\x1b[38;5;197m";

function emailLooksValid(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function runLogin(): Promise<void> {
  const existing = readAuth();
  if (existing) {
    // Treat the on-disk session as valid only when its refresh window hasn't
    // already lapsed locally. We don't hit /me here (the file header explicitly
    // avoids server validation so login/logout/whoami stay coherent offline),
    // but the local exp claim is enough to recognise an obviously-stale file
    // and let the user re-authenticate instead of bouncing them out.
    const nowSecs = Math.floor(Date.now() / 1000);
    const refreshUsable = existing.refresh_expires_at > nowSecs;
    if (refreshUsable) {
      await trackHookEvent(getInstanceId(), "audit_cli_auth_login_completed", {
        source: "cli",
        status: "already_signed_in",
        user_id: existing.user.id,
      });
      process.stdout.write(
        `${DIM}already signed in as${RESET} ${existing.user.email} ${DIM}(use \`failproofai auth logout\` to switch accounts)${RESET}\n`,
      );
      return;
    }
    process.stdout.write(
      `${DIM}stored session for ${existing.user.email} has expired — re-authenticating.${RESET}\n`,
    );
    // Overwrite cleanly so a half-broken file doesn't survive next startup.
    deleteAuth();
  }
  // Fire-and-forget: the interactive `email:` / `code:` prompts that follow keep
  // the process alive well past the 5s fetch, and awaiting would stall the prompt.
  void trackHookEvent(getInstanceId(), "audit_cli_auth_login_started", {
    source: "cli",
    api_base: getApiBase(),
    replaced_stale: existing !== null,
  });

  process.stdout.write(`${PINK}━━ failproofai auth ━━${RESET}\n`);
  process.stdout.write(`${DIM}api: ${getApiBase()}${RESET}\n\n`);

  let email = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    email = await prompt("email: ");
    if (emailLooksValid(email)) break;
    process.stdout.write(`${RED}that doesn't look like an email — try again.${RESET}\n`);
    email = "";
  }
  if (!email) {
    await trackHookEvent(getInstanceId(), "audit_cli_auth_login_completed", {
      source: "cli",
      status: "aborted_invalid_email",
    });
    throw new CliError("Could not read a valid email after 3 attempts.");
  }

  try {
    const r = await requestLoginCode(email);
    // Fire-and-forget: the `code:` prompt loop below keeps the process alive.
    void trackHookEvent(getInstanceId(), "audit_otp_requested", {
      source: "cli",
      status: "success",
      expires_in: r.expires_in,
      resend_available_in: r.resend_available_in,
    });
    process.stdout.write(
      `\n${GREEN}code sent.${RESET} ${DIM}check ${email} — expires in ${r.expires_in}s.${RESET}\n`,
    );
  } catch (err) {
    const isApi = err instanceof AuthApiError;
    await trackHookEvent(getInstanceId(), "audit_otp_requested", {
      source: "cli",
      status: "failed",
      error_code: isApi ? err.code : "upstream_unreachable",
      http_status: isApi ? err.status : null,
    });
    if (isApi && err.code === "rate_limited") {
      throw new CliError(
        `Rate limited — try again in ${err.retryAfterSecs ?? "a few"} seconds.`,
      );
    }
    if (isApi) {
      throw new CliError(`Login request failed (${err.code}): ${err.message}`);
    }
    throw new CliError(
      `Could not reach the api-server at ${getApiBase()}.\n` +
        `Check your network, or set FAILPROOF_API_URL to point at a different host.`,
    );
  }

  let tokenResp;
  let verifyAttempts = 0;
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = await prompt("code:  ", { hidden: true });
    if (!code) continue;
    verifyAttempts += 1;
    try {
      tokenResp = await verifyLoginCode(email, code);
      break;
    } catch (err) {
      const isApi = err instanceof AuthApiError;
      await trackHookEvent(getInstanceId(), "audit_otp_verified", {
        source: "cli",
        status: "failed",
        attempt: verifyAttempts,
        error_code: isApi ? err.code : "upstream_unreachable",
        http_status: isApi ? err.status : null,
      });
      if (isApi && err.status === 401) {
        process.stdout.write(`${RED}code rejected — try again.${RESET}\n`);
        continue;
      }
      if (isApi) {
        throw new CliError(`Verify failed (${err.code}): ${err.message}`);
      }
      throw new CliError(
        `Could not reach the api-server at ${getApiBase()}.`,
      );
    }
  }
  if (!tokenResp) {
    await trackHookEvent(getInstanceId(), "audit_cli_auth_login_completed", {
      source: "cli",
      status: "exhausted_attempts",
      attempts: verifyAttempts,
    });
    throw new CliError("Too many bad codes — start over.");
  }

  writeAuth(authFromTokenResponse(tokenResp));
  await trackHookEvent(getInstanceId(), "audit_otp_verified", {
    source: "cli",
    status: "success",
    attempt: verifyAttempts,
    user_id: tokenResp.user.id,
    email: tokenResp.user.email,
  });
  // Bridge the anonymous local instance ID to the server-issued user identity.
  // PostHog can stitch together "anonymous machine X did Y" events emitted
  // before sign-in with "user Z" events that follow, by joining on
  // `local_random_id` (== this event's distinct_id). The verified email +
  // `$set` persist the account onto the device person. The dashboard's
  // /api/auth/login-verify emits the same event with
  // `source: "audit_set_reminder_auth_dialog"`; this is the CLI sibling —
  // without it, anyone who signs in via `failproofai auth login` stays
  // unjoined to their pre-auth events.
  await trackHookEvent(getInstanceId(), "audit_user_identity_linked", {
    source: "cli",
    user_id: tokenResp.user.id,
    email: tokenResp.user.email,
    local_random_id: getInstanceId(),
    $set: { email: tokenResp.user.email, user_id: tokenResp.user.id },
  });
  await trackHookEvent(getInstanceId(), "audit_cli_auth_login_completed", {
    source: "cli",
    status: "success",
    attempts: verifyAttempts,
    user_id: tokenResp.user.id,
  });
  process.stdout.write(
    `\n${GREEN}✓ signed in as ${tokenResp.user.email}${RESET}\n` +
      `${DIM}session saved to ~/.failproofai/auth.json (mode 0600)${RESET}\n`,
  );
}

async function runLogout(): Promise<void> {
  const existing = readAuth();
  if (!existing) {
    await trackHookEvent(getInstanceId(), "audit_cli_auth_logout_completed", {
      source: "cli",
      had_session: false,
      upstream: "noop",
    });
    process.stdout.write(`${DIM}not signed in. nothing to do.${RESET}\n`);
    return;
  }
  // Best-effort server revoke — failure does not block the local wipe.
  let upstream: "revoked" | "failed" = "revoked";
  try {
    await logoutSession(existing.access_token, existing.refresh_token);
  } catch (err) {
    if (err instanceof AuthApiError && err.status === 401) {
      // already invalid server-side
    } else {
      upstream = "failed";
    }
  }
  deleteAuth();
  await trackHookEvent(getInstanceId(), "audit_cli_auth_logout_completed", {
    source: "cli",
    had_session: true,
    upstream,
    user_id: existing.user.id,
  });
  process.stdout.write(
    `${GREEN}✓ signed out as ${existing.user.email}.${RESET}\n`,
  );
}

async function runWhoami(): Promise<void> {
  const existing = readAuth();
  if (!existing) {
    await trackHookEvent(getInstanceId(), "audit_cli_auth_whoami", {
      source: "cli",
      authenticated: false,
    });
    process.stdout.write(`${DIM}not signed in — run \`failproofai auth login\` to sign in.${RESET}\n`);
    process.exitCode = 1;
    return;
  }
  await trackHookEvent(getInstanceId(), "audit_cli_auth_whoami", {
    source: "cli",
    authenticated: true,
    user_id: existing.user.id,
  });
  process.stdout.write(
    `${GREEN}✓${RESET} ${existing.user.email} ${DIM}(${existing.user.id})${RESET}\n`,
  );
}

export async function runAuthCli(args: string[]): Promise<void> {
  const opts = parseAuthArgs(args);
  if (opts.mode === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (opts.mode === "login") return runLogin();
  if (opts.mode === "logout") return runLogout();
  return runWhoami();
}
