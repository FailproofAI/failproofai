"use server";

/**
 * Write side of the /settings "Jev" section — the dashboard's half of
 * `failproofai jev setup` / `failproofai jev remove`.
 *
 * ## One file, one writer, one validator
 *
 * The file is `~/.failproofai/jev.json`, written through the same
 * `writeJsonAtomically` the CLI's `jev setup` calls, with the same
 * `{ mode: 0o600, dirMode: 0o700 }`, after the same `validateJevConfig` the
 * loader itself runs. Nothing here re-states a rule that lives in
 * `jev-config.ts`: not the URL scheme, not "plain http only in shadow mode",
 * not "cloudflare needs an account id". A second copy of those rules is how the
 * dashboard ends up writing a file the hooks then refuse — the exact failure
 * mode this module exists to avoid.
 *
 * ## Cross-origin writes
 *
 * The dashboard is an unauthenticated local web server, so a page on any other
 * site can POST to it from the victim's own browser. That matters more here
 * than anywhere else on the surface: a cross-site write could point the
 * evaluator at the attacker's endpoint — which then sees a redacted envelope
 * for every command failproofai judges — or switch Jev on in enforce mode,
 * where its answers can clear a deny.
 *
 * `proxy.ts` already refuses cross-origin mutating requests and non-loopback
 * `Host` headers for the whole dashboard, and a Server Action is a POST, so it
 * is covered. The check is repeated HERE, against the same
 * `lib/dashboard-host` helpers so the two cannot diverge on what "loopback"
 * or "same origin" means, because this is the one write on the dashboard whose
 * payload is a credential and whose effect is the destination that credential
 * is sent to. Two layers that read the same rule from one place cost a header
 * lookup; one layer costs the whole feature if the middleware matcher is ever
 * narrowed.
 *
 * ## The token
 *
 * It arrives, it is validated, it is written at 0600, and it is never returned.
 * Both actions answer with a `JevSettingsView`, which carries a presence flag
 * and no part of the key itself — see `get-jev-config.ts`.
 *
 * A stored token is KEPT only when the provider and the base URL are both
 * unchanged and the file was owner-only. Anything else — a new provider, a
 * moved endpoint, or a file other users could have written — asks for it
 * again, because a key issued for one gateway must not be sent to another
 * unasked. That is the CLI's rule, applied slightly more strictly: the CLI
 * carries a key back to the provider's own API, and this surface does not,
 * because a form with a blank field is a weaker statement of intent than a
 * typed command.
 *
 * That rule is about a key MOVING, so it only applies where there is one to
 * move. A config written by `jev setup --key-from-env` stores no key — a hook
 * reads `FAILPROOFAI_JEV_API_KEY` at the moment it runs — and its endpoint,
 * provider and mode are therefore editable here with the token field left
 * blank: nothing travels anywhere it had not already been sent, and the key
 * stays where its owner put it, outside the file. Asking for a token instead
 * would be asking them to abandon that choice in order to change an endpoint,
 * and the refusal did it while naming "the stored token" — a thing that
 * deliberately does not exist in such a file.
 *
 * That includes a file the loader called too open. Re-saving it is the only
 * remedy the panel has for those permissions — the write is 0600 and it
 * tightens the directory — and there is no stored key to withhold, so refusing
 * would leave the file broken and buy nothing: the endpoint that gets written is
 * the one in the form, which the person can see and change, above the loader's
 * own warning about the file. For a file that DOES store a key the refusal
 * stands, because re-typing the token is what says "this key, for this
 * endpoint".
 *
 * `--key-from-env` is inferred from the file being updated rather than asked
 * for again, which is the one place this path is laxer than `jev setup`: the CLI
 * makes you re-state `--key-from-env` when the provider changes. A form that
 * offers no such flag would have no way to say it.
 *
 * ## What a save does NOT touch
 *
 * Only the fields the panel sends. Every other field in the file — `model`, a
 * `timeoutMs` set from the CLI, anything a newer failproofai wrote — is carried
 * over untouched. This is not a nicety. `model` decides which model id the
 * request names, and a self-hosted or gateway endpoint that must be told its
 * model stops answering anything at all once it is dropped — while the panel,
 * whose write passed validation, reports success. A form must not be able to
 * delete a field it does not show.
 *
 * The merge below is `jev setup`'s, field for field: spread the existing file
 * when the provider is unchanged, carry `mode` and `timeoutMs` across when it
 * is not, and set only what was named — `setOrClear` in `src/hooks/jev-cli.ts`,
 * where a flag that was not given leaves its field alone. It is written out
 * again here rather than called because that path is a terminal command
 * (`argv` in, rendered lines out, its own key prompt) that lives in the hook
 * bundle, and because this surface's key rule is deliberately stricter. What
 * keeps the two from drifting is a test that runs both over the same file and
 * compares the bytes: `__tests__/actions/update-jev-config.test.ts`, "agrees
 * with `jev setup` about what an update keeps". Extracting one shared merge
 * would be better still, and needs `src/hooks/semantic/jev-config.ts` to own
 * it.
 */

import { chmodSync, existsSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { headers } from "next/headers";
import { writeJsonAtomically } from "@/lib/atomic-write";
import {
  hostnameFromHostHeader,
  isLoopbackHostname,
  resolveDashboardHost,
} from "@/lib/dashboard-host";
import {
  JEV_PROVIDER_KINDS,
  jevConfigPath,
  readJevConfigFileForUpdate,
  validateApiKey,
  validateBaseUrl,
  validateJevConfig,
} from "@/src/hooks/semantic/jev-config";
import { getJevSettingsAction, type JevSettingsView } from "./get-jev-config";

/**
 * What the panel sends — the four fields the form owns, and the token.
 *
 * Every field is a string; "" means "not set". There is deliberately no `model`:
 * the form does not show one, so it has nothing to say about it, and a field
 * this type does not carry is a field `saveJevConfigAction` cannot clear.
 */
export interface JevConfigInput {
  provider: string;
  /** "" routes to the provider's own API. */
  baseUrl: string;
  /** Cloudflare only. */
  accountId: string;
  /** "shadow" | "enforce". */
  mode: string;
  /** "" keeps the key where it is: the stored one, or the environment's. */
  token: string;
}

export type JevWriteResult =
  | { ok: true; view: JevSettingsView }
  /**
   * Returned, never thrown. Next masks a thrown server-action error before the
   * browser sees it — the client gets an opaque digest and no message — so a
   * validation problem the user could act on would arrive as "something went
   * wrong". The same reasoning as `SetAutoAuditResult` next door.
   */
  | {
      ok: false;
      problem: string;
      /** The one failure whose remedy is "type the token again", so the panel can say so on the field. */
      needsToken?: true;
    };

/**
 * The refusal text for every cross-origin shape, deliberately identical.
 *
 * Naming which check failed is a probing aid on an unauthenticated surface, and
 * the legitimate caller — the dashboard's own page — can never see this string.
 */
const CROSS_ORIGIN_REFUSAL =
  "this request did not come from the dashboard in your browser, so nothing was written.";

/** Validation-only placeholder for a config whose key comes from the environment. Never written. */
const ENV_KEY_STAND_IN = "env-key-stand-in";

/**
 * Refuse anything that is not a same-machine, same-origin call.
 *
 * A transcription of `proxy.ts`'s rule, built from the same
 * `lib/dashboard-host` helpers rather than its own idea of loopback:
 *
 *   - on a loopback bind the `Host` must be loopback (this is what defeats DNS
 *     rebinding, whose whole trick is arriving with an attacker-controlled Host
 *     that its own Origin then matches);
 *   - a mutating call with an `Origin` must have one whose full authority
 *     equals that Host — another app on localhost:3000 is a different origin;
 *   - no `Origin` at all is a non-browser caller, allowed only on a loopback
 *     bind, where it is necessarily a local process that could edit
 *     `jev.json` directly anyway. On a deliberately non-loopback bind
 *     (`--host`, `FAILPROOFAI_DASHBOARD_HOST`) that describes every curl on the
 *     network segment, so it is refused.
 */
async function crossOriginRefusal(): Promise<string | null> {
  let h: Headers;
  try {
    h = await headers();
  } catch {
    // No request context at all. Nothing legitimate reaches these actions that
    // way, and a write of a credential is not the place to assume otherwise.
    return CROSS_ORIGIN_REFUSAL;
  }
  const bindHost = resolveDashboardHost(undefined, process.env.FAILPROOFAI_DASHBOARD_HOST);
  const boundToLoopback = isLoopbackHostname(bindHost);
  const hostHeader = h.get("host");

  if (boundToLoopback) {
    if (!hostHeader || !isLoopbackHostname(hostnameFromHostHeader(hostHeader))) {
      return CROSS_ORIGIN_REFUSAL;
    }
  }

  const origin = h.get("origin");
  if (!origin) return boundToLoopback ? null : CROSS_ORIGIN_REFUSAL;

  let originHost: string | null = null;
  try {
    // "null" (sandboxed iframes, some redirects) is a real Origin value; the
    // URL constructor throws on it, which is the behaviour we want.
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    originHost = null;
  }
  return originHost && originHost === (hostHeader ?? "").toLowerCase() ? null : CROSS_ORIGIN_REFUSAL;
}

/** A base URL reduced to the thing that decides whether a key may travel: its origin. */
function originOf(raw: string): string | null {
  if (!raw) return null;
  const r = validateBaseUrl(raw);
  if (!r.ok) return null;
  try {
    const o = new URL(r.value).origin;
    return o === "null" ? null : o;
  } catch {
    return null;
  }
}

/**
 * `~/.failproofai` at the umask is group-writable on a umask-002 machine, and a
 * directory others can write into defeats the file's 0600 — they unlink it and
 * leave their own, which every check on the file then passes. The one command
 * that puts a key there takes those bits off, so the one PAGE that does must
 * too. Exactly the write bits the loader refuses and no more.
 */
function tightenConfigDir(path: string): void {
  if (process.platform === "win32") return;
  const dir = dirname(path);
  try {
    const before = statSync(dir).mode & 0o777;
    if ((before & 0o022) !== 0) chmodSync(dir, before & ~0o022);
  } catch {
    // Not fatal: the loader reports a directory it will not read from, and the
    // panel shows that reason.
  }
}

/**
 * Save the Jev configuration, exactly as `failproofai jev setup` would.
 *
 * Returns the re-read view on success rather than echoing the input, so the
 * panel confirms against what is actually on disk — including the permissions,
 * the resolved endpoint and the provider default model it did not type.
 */
export async function saveJevConfigAction(input: JevConfigInput): Promise<JevWriteResult> {
  const refusal = await crossOriginRefusal();
  if (refusal) return { ok: false, problem: refusal };

  const provider = input.provider.trim();
  if (!(JEV_PROVIDER_KINDS as readonly string[]).includes(provider)) {
    return { ok: false, problem: `provider must be one of ${JEV_PROVIDER_KINDS.join(", ")}` };
  }

  const baseUrl = input.baseUrl.trim();
  if (baseUrl) {
    // Checked here, before anything is decided about the token, so an
    // unparseable URL is reported as an unparseable URL rather than as "that
    // endpoint is not the one the token was given for" — which is what a URL
    // that resolves to no origin would otherwise look like below.
    const url = validateBaseUrl(baseUrl);
    if (!url.ok) return { ok: false, problem: url.problem };
  }

  const existingFile = readJevConfigFileForUpdate();
  const existing = existingFile?.raw ?? null;
  const sameProvider = existing !== null && existing.provider === provider;

  // Same provider: update in place, keeping every field not named here —
  // `model`, a `timeoutMs` set from the CLI, and ones a newer failproofai wrote,
  // none of which this form knows about or may drop. A different provider starts
  // over: a key, model or URL for one gateway means nothing to another. Mode and
  // timeout are provider-neutral, so they carry across, exactly as `jev setup`
  // carries them.
  const next: Record<string, unknown> = sameProvider ? { ...existing } : {};
  if (!sameProvider && existing) {
    if (existing.mode !== undefined) next.mode = existing.mode;
    if (existing.timeoutMs !== undefined) next.timeoutMs = existing.timeoutMs;
  }
  next.provider = provider;

  if (baseUrl) next.baseUrl = baseUrl;
  else delete next.baseUrl;

  // `model` is NOT touched here, and that is the point: `JevConfigInput` has no
  // model, so the spread above is the whole story for it. The CLI's `setOrClear`
  // clears a field only for `--model default`, which is a thing a person typed;
  // an empty input from a form that never offered the field is not.

  const accountId = input.accountId.trim();
  if (provider === "cloudflare") {
    if (accountId) next.accountId = accountId;
    else delete next.accountId;
  } else {
    // An account id means nothing anywhere else, and leaving a stale one behind
    // would show up in `jev status` as a field this provider ignores.
    delete next.accountId;
  }

  if (input.mode === "shadow" || input.mode === "enforce") next.mode = input.mode;

  // Where the key may travel. Unchanged provider AND unchanged origin, from a
  // file only its owner could have written — anything else asks again.
  const routeHeld =
    sameProvider &&
    existingFile?.tooOpen !== true &&
    originOf(baseUrl) === originOf(typeof existing?.baseUrl === "string" ? existing.baseUrl : "");

  /** Whether the file has a key in it at all. */
  const storesKey = typeof existing?.apiKey === "string" && existing.apiKey !== "";

  /**
   * Whether the file being updated is one whose owner chose to keep the key OUT
   * of it — `jev setup --key-from-env`, which the loader reports as
   * `key-missing`, or as `ok` with `keySource: "env"` where the variable is set.
   *
   * Every refusal below is about a STORED key being carried somewhere it was not
   * issued for, and there is none here: a hook reads
   * `FAILPROOFAI_JEV_API_KEY` at the moment it runs, so the endpoint, the
   * provider and the mode can all be edited with the token field left blank and
   * nothing moves.
   *
   * It is the loader's own validator that decides, with a stand-in in the one
   * slot that is deliberately empty — so a file that is merely BROKEN, and a
   * machine with no file at all, are not mistaken for a deliberate choice and
   * silently saved without any key. Those still ask for the token.
   */
  const keyFromEnvConfig =
    existing !== null && !storesKey && validateJevConfig(existing, ENV_KEY_STAND_IN).ok;

  const token = input.token.trim();
  if (token) {
    const bad = validateApiKey(token);
    if (bad) return { ok: false, problem: bad, needsToken: true };
    next.apiKey = token;
  } else if (!routeHeld && !keyFromEnvConfig) {
    return {
      ok: false,
      needsToken: true,
      problem: !storesKey
        ? // Nothing stored to carry and no deliberate absence to preserve: the
          // only thing missing is a key, and no sentence here may imply there
          // is one on disk.
          "enter the token for this provider."
        : sameProvider && existingFile?.tooOpen === true
          ? // The loader's "someone else may have chosen this endpoint" case. The
            // stored token is not carried anywhere from a file other users could
            // have written, whatever endpoint it names.
            `${jevConfigPath()} was open to other users, so the endpoint it names may not be one you chose and its stored token is not reused. check the endpoint above, then enter the token for it.`
          : sameProvider
            ? "that endpoint is not the one the stored token was given for, so it is not sent there. enter the token for it."
            : "enter the token for this provider.",
    };
  }
  // Otherwise the key stays exactly where it is: a stored one is carried over by
  // the spread above, and a config that takes it from the environment keeps
  // taking it from the environment.

  // A config with no stored key takes it from `FAILPROOFAI_JEV_API_KEY` when a
  // hook runs. That is a shape `jev setup --key-from-env` writes and this
  // surface preserves but never creates, so the rest of the file still has to
  // be checked — hence a stand-in in the one slot that is deliberately empty.
  // It is never written and never sent.
  const keyFromEnv = next.apiKey === undefined;
  const checked = validateJevConfig(next, keyFromEnv ? ENV_KEY_STAND_IN : null);
  if (!checked.ok) {
    return {
      ok: false,
      problem: checked.problem,
      ...(checked.missingKey === true ? { needsToken: true as const } : {}),
    };
  }

  const path = jevConfigPath();
  try {
    writeJsonAtomically(path, next, { mode: 0o600, dirMode: 0o700 });
  } catch (err) {
    return {
      ok: false,
      problem: `could not write ${path} (${(err as NodeJS.ErrnoException).code ?? "error"}).`,
    };
  }
  tightenConfigDir(path);

  return { ok: true, view: await getJevSettingsAction() };
}

/**
 * Delete `~/.failproofai/jev.json`. Hooks go back to the regex engine on the
 * very next tool call — the loader reads the file per event, so there is
 * nothing to restart and nothing to un-cache.
 *
 * Removing a file that is not there succeeds: the user asked for Jev to be off,
 * and it is.
 */
export async function removeJevConfigAction(): Promise<JevWriteResult> {
  const refusal = await crossOriginRefusal();
  if (refusal) return { ok: false, problem: refusal };

  const path = jevConfigPath();
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch (err) {
      return {
        ok: false,
        problem: `could not remove ${path} (${(err as NodeJS.ErrnoException).code ?? "error"}).`,
      };
    }
  }
  return { ok: true, view: await getJevSettingsAction() };
}
