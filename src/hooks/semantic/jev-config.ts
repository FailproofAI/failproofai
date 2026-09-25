/**
 * The customer's own Jev configuration (BYOK) — the single opt-in to the
 * two-tier evaluator.
 *
 * `loadJevConfig()` returning null means Jev is off and the regex engine runs
 * exactly as it does without this module.
 *
 * # Global only
 *
 * The file is `~/.failproofai/jev.json` and nothing else. A repository's config
 * can never set or override it, because a cloned repo choosing the endpoint
 * that judges its own tool calls would be choosing its own verdict. So:
 *
 * - no project-scope file is ever read (`<cwd>/.failproofai/jev.json` is inert);
 * - `provider`, `baseUrl`, `model` and `accountId` come from the file at
 *   `failproofaiHome()/jev.json` only, never from the environment — a repo's
 *   `.claude/settings.json` can set env vars for a session. (`FAILPROOFAI_HOME`
 *   is not an exception to that: it relocates the ENTIRE failproofai layout,
 *   policies and all, rather than redirecting Jev in particular, and a layout
 *   pointed somewhere new has no policies to evaluate and no 0600 jev.json a
 *   checkout could have produced.)
 * - `FAILPROOFAI_JEV_API_KEY` may supply the KEY, and only when the file has
 *   none. It exists for single-session use and for people who keep keys off
 *   disk. It can never switch Jev on by itself (no file → null), never replace
 *   a key the file carries, and never change where requests go. Note the daemon
 *   forwards a hook's stdin and cwd, not its environment, so on a
 *   daemon-configured machine the file is the only channel that works.
 *
 * # Owner-only
 *
 * The file holds a credential, so it is written at 0600 and a copy that is
 * group- or world-accessible is REFUSED rather than read: returning null there
 * falls back to the regex engine, which is the safe direction (see §4 of the
 * design — without a config the path is today's, byte for byte). Any group or
 * other bit counts, not just read: a group-writable file lets someone else
 * choose the endpoint.
 *
 * Its DIRECTORY is checked too, for write bits only. A directory another user
 * can write into gives them the file's power by another route — unlink it and
 * create their own 0600 one, which every check above would then read as the
 * owner's. `jev setup` takes those bits off, so a home that some older code
 * path created at the umask is fixed the first time Jev is configured. Read
 * bits are left alone at both ends: they give nobody that power, and
 * `config.json` beside it is world-readable by design.
 *
 * # Read on every hook event, on purpose
 *
 * Deliberately uncached: one open + fstat + read of a file capped at 64 KiB is
 * microseconds, and it means `failproofai jev setup` / `remove` take effect on
 * the very next tool call — including inside the long-lived daemon worker —
 * with no restart and no stale state to reason about.
 *
 * # FailproofAI Cloud (`provider: "failproofai"`)
 *
 * The one provider whose key is NOT in this file. `failproofai config --token`
 * with a key carrying `jev:evaluate` stores that key in the `jev` slot of
 * `credentials.json` and, when there is no `jev.json` yet, writes one naming
 * this provider, the Cloud origin + `/enforcement/v1/jev` and `mode: "shadow"`.
 * So for this provider:
 *
 * - the key comes from `credentials.json` (`readJevCloudCredential`), read with
 *   the same owner-only file, directory and size checks this file gets — a
 *   loose credentials file is refused, not read, and Jev is off;
 * - an `apiKey` in `jev.json` makes the file invalid, and
 *   `FAILPROOFAI_JEV_API_KEY` is ignored: the Cloud key has exactly one home,
 *   so disconnecting or rotating it can never leave a second copy steering Jev;
 * - `baseUrl` is required, and its ORIGIN must equal the origin the credential
 *   was verified against (`jev.url`). The key is only ever sent where it was
 *   issued, and both halves of that decision live in global files.
 * - no credential at all is `not-connected`: Jev is off, and `jev status` says
 *   the machine is not connected to FailproofAI Cloud.
 *
 * # `mode: "off"`
 *
 * Every provider accepts `off | shadow | enforce`. `off` keeps the file — the
 * endpoint, and for BYOK the key — while Jev does not run at all:
 * `loadJevConfig` returns null exactly as for an absent file. It exists so the
 * dashboard can switch the Cloud route off without deleting the file that
 * `config --token` will never rewrite. An older build reads `off` as an
 * invalid mode, which is also off.
 */
import { closeSync, constants as fsConstants, fstatSync, openSync, readSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { readJevCloudCredential, type JevCloudCredential } from "../fp-config";
import { jevConfigFile } from "../fp-home";

export type { JevCloudCredential } from "../fp-config";

export type JevProviderKind = "typesafe" | "openrouter" | "vercel" | "cloudflare" | "custom" | "failproofai";

/** `off` does not run Jev at all; `shadow` logs Jev and enforces regex; `enforce` applies the combine rules. */
export type JevConfigMode = "off" | "shadow" | "enforce";

export interface JevConfig {
  provider: JevProviderKind;
  /**
   * The bearer key. For `failproofai` it is never in the FILE: the loader fills
   * it from the `jev` slot of `credentials.json` (see the header).
   */
  apiKey: string;
  /** Required for `custom` and `failproofai`; an optional override otherwise. */
  baseUrl?: string;
  /** `cloudflare` only. */
  accountId?: string;
  /** Provider-specific model id; each provider has a default. */
  model?: string;
  /** Default 3000; the reasoning is on `DEFAULT_JEV_TIMEOUT_MS` in `evaluator.ts`. */
  timeoutMs?: number;
  /**
   * Default `enforce`. `off` is accepted in a file but never reaches the hook
   * path: `loadJevConfig` returns null for it.
   */
  mode?: JevConfigMode;
}

export const DEFAULT_JEV_MODE: "shadow" | "enforce" = "enforce";

export const JEV_PROVIDER_KINDS: readonly JevProviderKind[] = ["typesafe", "openrouter", "vercel", "cloudflare", "custom", "failproofai"];

/** The provider whose key comes from this machine's FailproofAI Cloud connection. */
export const JEV_CLOUD_PROVIDER = "failproofai" as const satisfies JevProviderKind;

/**
 * Where FailproofAI Cloud serves Jev, under the Cloud origin. The transport
 * appends `/systemone` (`nativeEndpoint`), so the route is
 * `POST <origin>/enforcement/v1/jev/systemone`.
 */
export const JEV_CLOUD_BASE_PATH = "/enforcement/v1/jev";

/**
 * The `baseUrl` `config --token` writes for the Cloud base it connected to.
 *
 * Built the way every other Cloud route is — `<base>/enforcement/v1/…`, as the
 * desired-state pull does (`cloud-enrollment.ts`) — so a self-hosted Cloud
 * served under a path prefix gets its Jev route under the same prefix. For the
 * hosted product the base IS the origin. Query and fragment are dropped: a base
 * never carries either (`validateCloudUrl`).
 */
export function jevCloudBaseUrl(cloudBase: string): string {
  const url = new URL(cloudBase);
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}${JEV_CLOUD_BASE_PATH}`;
}

/** The env var that may supply the key (and nothing else) when the file carries none. */
export const JEV_API_KEY_ENV = "FAILPROOFAI_JEV_API_KEY";

/**
 * The same 3000 ms as `DEFAULT_JEV_TIMEOUT_MS` in `evaluator.ts`, which is
 * where the measurements and the tradeoff behind the number are written out.
 * In short: pooled p95 over 1,449 answered calls is 1692 ms and the tail runs
 * to 3624 ms, so 1500 ms aborted 8.4% of answers (43% of cold-process calls in
 * the worst session) and silently fell back to regex; 3000 ms aborts 0.28%.
 * Kept separate from the evaluator's copy so the config layer does not import
 * the evaluator; the two are pinned equal by a test.
 */
export const JEV_CONFIG_DEFAULT_TIMEOUT_MS = 3_000;
/** Bounds on `timeoutMs`. Every millisecond of it can be added to a tool call. */
export const MIN_JEV_TIMEOUT_MS = 100;
export const MAX_JEV_TIMEOUT_MS = 10_000;

/**
 * The Jev family the decision thresholds were calibrated against. A reported
 * version with a different major.minor is treated as degraded (the caller falls
 * back to regex), and a configured model id naming another family is refused
 * outright: every call it made would fall back anyway.
 */
export const JEV_CALIBRATED_FAMILY = { major: 1, minor: 13 } as const;

/** No legitimate config is anywhere near this; the hook path never reads more. */
const MAX_CONFIG_BYTES = 64 * 1024;

/**
 * Non-blocking open: a FIFO in the file's place would otherwise hang every
 * hook in `open()` until something wrote to it. For a regular file the flag
 * changes nothing, and the fstat below refuses anything that is not one.
 */
const OPEN_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0);

export function jevConfigPath(): string {
  return jevConfigFile();
}

// ── Model ids and versions ───────────────────────────────────────────────────

/**
 * `jev-1.13.0`, `jev-1.13`, `typesafe/jev-1.13`, `typesafe/jev-1.13-20260917`,
 * `typesafe-ai/jev-1.13.0`. Aliases (`typesafe/jev`, `typesafe-ai/jev`,
 * `~typesafe/jev-latest`) carry no version and do not match.
 */
const VERSIONED_MODEL_RE = /^(?:(?:typesafe|typesafe-ai)\/)?jev-(\d{1,4})\.(\d{1,4})(?:\.(\d{1,6}))?(?:-(\d{8}))?$/;

export interface JevModelVersion {
  major: number;
  minor: number;
  patch: number | null;
  /** OpenRouter's snapshot date, `YYYYMMDD`. */
  date: string | null;
}

/** The Jev version a model id names, or null for an alias / anything else. */
export function jevModelVersion(model: string): JevModelVersion | null {
  const m = VERSIONED_MODEL_RE.exec(model);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: m[3] === undefined ? null : Number(m[3]), date: m[4] ?? null };
}

/** True when the id names the calibrated family (any patch, any snapshot date). */
export function isCalibratedJevModel(model: string): boolean {
  const v = jevModelVersion(model);
  return v !== null && v.major === JEV_CALIBRATED_FAMILY.major && v.minor === JEV_CALIBRATED_FAMILY.minor;
}

// ── Validation ───────────────────────────────────────────────────────────────

/** A Cloudflare account id. It is interpolated into a URL path, so anything else is refused. */
export const CLOUDFLARE_ACCOUNT_ID_RE = /^[0-9a-f]{32}$/;
/** Visible ASCII only: a key goes into an HTTP header, so whitespace or a CR/LF is refused, not trimmed into shape. */
const API_KEY_RE = /^[\x21-\x7e]{1,4096}$/;
const MODEL_RE = /^[A-Za-z0-9._:/@~+-]{1,200}$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export type ValidationResult<T> =
  | { ok: true; value: T }
  /**
   * `missingKey` marks the one failure that is not a fault in the file: it
   * carries no `apiKey` and `FAILPROOFAI_JEV_API_KEY` is unset here. Callers
   * that can tell those apart (`inspectJevConfig`, and `jev status` through it)
   * use the flag rather than matching on `problem`.
   *
   * `notConnected` is its FailproofAI Cloud twin: the file names the Cloud
   * provider and this machine holds no Jev credential for it.
   */
  | { ok: false; problem: string; missingKey?: true; notConnected?: true };

/** A key is visible ASCII, one line, at most 4 KiB. The message never includes the key. */
export function validateApiKey(key: unknown): string | null {
  if (typeof key !== "string" || key.length === 0) return "the API key is empty";
  if (!API_KEY_RE.test(key)) return "the API key must be one line of visible ASCII with no spaces (at most 4096 characters)";
  return null;
}

/**
 * Query parameter names that carry a CREDENTIAL rather than a routing choice.
 *
 * Matched on the parameter's name with everything but letters and digits
 * removed, so `api_key`, `api-key`, `X-Api-Key` and `apiKey` are one rule
 * rather than four — and `?api-version=`, the parameter the query string is
 * permitted for in the first place, matches none of them.
 *
 * Substrings, because the real names are compounds: `access_token`,
 * `subscription-key`, `authToken`, `x-functions-key`. The short ones that have
 * no word to be a substring of are matched whole instead.
 */
const CREDENTIAL_PARAM_PARTS = ["key", "token", "secret", "password", "passwd", "credential", "auth", "signature"] as const;
const CREDENTIAL_PARAM_NAMES = new Set(["pw", "pass", "sig", "sid", "jwt", "bearer", "session", "code", "access"]);

/** A parameter name safe to quote back: it goes into a message the CLI prints. */
const QUOTABLE_PARAM_RE = /^[A-Za-z0-9._-]{1,40}$/;

/**
 * Why a base URL's query string may not be stored, or null when it may.
 *
 * A credential in a base URL is a mistake wherever it ends up, because the
 * config file already has an `apiKey` field that is sent as a bearer and never
 * printed — while the endpoint DERIVED from the base URL is logged, printed by
 * `jev status`, put in error messages and returned to the dashboard. So this
 * refuses the credential at the door rather than eliding it on the way out:
 * eliding leaves the secret in the file and in everything the file feeds.
 *
 * It refuses on the parameter NAME, not on the presence of a query, because
 * some proxies genuinely route on one (`?api-version=`) — see the comment on
 * the normalization below. The VALUE is checked too, through the same
 * `looksLikeCredential` that refuses a key pasted into `--model`: a parameter
 * called `t` whose value is `sk-…` is the same mistake under a name no list
 * can carry. A false refusal there turns Jev off and leaves the regex tier
 * enforcing, which is the direction this whole module errs in.
 */
function credentialQueryProblem(url: URL): string | null {
  for (const [name, value] of url.searchParams) {
    const shown = QUOTABLE_PARAM_RE.test(name) ? `?${name}=` : "one of its query parameters";
    const flat = name.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (CREDENTIAL_PARAM_PARTS.some((part) => flat.includes(part)) || CREDENTIAL_PARAM_NAMES.has(flat)) {
      return `baseUrl must not carry a credential in its query string, and ${shown} is one; put the key in the key field`;
    }
    if (looksLikeCredential(value)) {
      return `baseUrl's ${shown} value is shaped like a credential (not repeated here); put the key in the key field`;
    }
  }
  return null;
}

/**
 * An endpoint base URL: https, or http to a loopback host only (a local proxy).
 * No credentials in the URL — not as userinfo, not as a query parameter — and no
 * fragment, because a key belongs in the key field, where it is sent as a bearer
 * and never printed. `validateJevConfig` further accepts the loopback http form
 * only in shadow mode.
 */
export function validateBaseUrl(raw: unknown): ValidationResult<string> {
  if (typeof raw !== "string" || raw.trim() === "") return { ok: false, problem: "baseUrl must be a non-empty string" };
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, problem: "baseUrl is not a valid URL" };
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) {
    return { ok: false, problem: "baseUrl must use https (plain http is accepted only for localhost)" };
  }
  if (url.username || url.password) return { ok: false, problem: "baseUrl must not carry credentials; put the key in the key field" };
  if (url.hash) return { ok: false, problem: "baseUrl must not have a #fragment" };
  const credentialQuery = credentialQueryProblem(url);
  if (credentialQuery) return { ok: false, problem: credentialQuery };
  // Trailing slashes come off the PATH, never the string: a query string is legal
  // (some proxies want `?api-version=`), and the endpoint path is appended to
  // the pathname, so it must never end up inside the query.
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return { ok: true, value: url.toString() };
}

export interface BaseUrlWithoutQuery {
  /** The URL with any `?query` taken off. */
  url: string;
  /** Whether there was one to take off. */
  hadQuery: boolean;
}

/**
 * A stored base URL with its query string removed, and whether it had one.
 *
 * The refusal above is the source fix, and this is what makes the way OUT safe
 * regardless: a file written by an older build can already carry `?token=`, and
 * that file is exactly the one whose owner is being shown the URL so they can
 * repair it. So nothing that crosses the wire to the dashboard, and nothing the
 * CLI prints, carries a query string off a base URL — `displayEndpoint` does it
 * for the derived endpoint, and this does it for the base URL itself.
 *
 * Takes a string rather than a `URL` because the callers that need it most are
 * reading a REFUSED file, where the value may not parse at all. An unparseable
 * one is cut at the first `?`, which is strictly more aggressive than parsing.
 */
export function baseUrlWithoutQuery(raw: string): BaseUrlWithoutQuery {
  try {
    const url = new URL(raw);
    if (!url.search) return { url: raw, hadQuery: false };
    url.search = "";
    return { url: url.toString(), hadQuery: true };
  } catch {
    const cut = raw.indexOf("?");
    return cut < 0 ? { url: raw, hadQuery: false } : { url: raw.slice(0, cut), hadQuery: true };
  }
}

/**
 * Path suffixes that are an ENDPOINT, never a base. Longest first, so
 * `/v1/chat/completions` strips back to `/v1` rather than to `/v1/chat`.
 *
 * `/systemone` is this product's own suffix; the other four are what an OpenAI-
 * compatible base serves. Every one of them is the LAST segment of a request URL
 * whose base is its parent, which is what makes the repair unambiguous.
 */
const ENDPOINT_SUFFIXES = ["/chat/completions", "/systemone", "/completions", "/embeddings", "/models"] as const;

export interface EndpointGivenAsBase {
  /** The suffix that gave it away, e.g. `/models`. */
  suffix: string;
  /** The base that was probably meant: the same URL with the suffix taken off. */
  base: string;
}

/**
 * Whether a URL is obviously an endpoint rather than an API base, and the base it
 * implies.
 *
 * This is checked at `jev setup` only, and deliberately not in `validateBaseUrl`:
 * a config already on disk that names an endpoint as its base keeps working
 * (`nativeEndpoint` does not append a second `/systemone`), and turning Jev off on
 * an upgrade for a file that was routing correctly would be a worse failure than
 * the one this prevents.
 *
 * What it prevents: `--url https://…/typesafe/v1/models` was saved without
 * complaint, requests then went to `…/v1/models/systemone`, and the only signal
 * was `http-404: Not Found` from `jev test`. The CLI knows `/systemone` is its own
 * suffix and that a provider's base ends at a version root, so it can say so
 * before anything is written.
 */
export function endpointGivenAsBase(url: string): EndpointGivenAsBase | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  const suffix = ENDPOINT_SUFFIXES.find((s) => path.toLowerCase().endsWith(s));
  if (suffix === undefined) return null;
  parsed.pathname = path.slice(0, path.length - suffix.length) || "/";
  return { suffix, base: parsed.toString() };
}

function isPlainHttp(url: string): boolean {
  try {
    return new URL(url).protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * The origin a bearer token would be sent to: https, or http to a loopback host
 * — the same schemes `validateBaseUrl` admits. Null for anything else, so a
 * credential naming some other scheme matches no base URL at all.
 */
function originOf(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Prefixes real credentials carry: OpenAI / OpenRouter / Anthropic / Stripe
 * (`sk-`, `sk_`, `rk_`), GitHub, GitLab, Slack, AWS, Google, Hugging Face and
 * Vercel AI Gateway (`vck_`). No Jev model id starts with any of them.
 */
const CREDENTIAL_PREFIX_RE = /^(?:(?:sk|rk)[-_]|gh[pousr]_|github_pat_|glpat-|xox[abprs]-|AKIA[0-9A-Z]{12}|AIza[0-9A-Za-z_-]{20}|hf_[A-Za-z0-9]{16}|vck_)/;

/**
 * Whether a would-be model id is shaped like a credential: a known key prefix,
 * or 32+ characters mixing letters and digits with no `/` and no "jev" — which
 * describes a pasted token, and no model id any Jev route knows. The check
 * exists so a key pasted into `--model` is refused rather than written to the
 * file, printed by `jev status`, and sent to the provider as the model.
 */
export function looksLikeCredential(s: string): boolean {
  if (CREDENTIAL_PREFIX_RE.test(s)) return true;
  return s.length >= 32 && !s.includes("/") && !/jev/i.test(s) && /[A-Za-z]/.test(s) && /[0-9]/.test(s);
}

/**
 * Whether a string is shaped like a model id. Used on names that came back from
 * a provider's `/models` endpoint and are about to be printed: those are remote
 * strings, so anything carrying a control character, an ANSI escape or a
 * kilobyte of padding is dropped rather than rendered.
 */
export function isModelIdShaped(s: string): boolean {
  return MODEL_RE.test(s);
}

function validateModel(raw: unknown): ValidationResult<string> {
  if (typeof raw !== "string" || !MODEL_RE.test(raw)) {
    return { ok: false, problem: "model must be 1–200 characters of letters, digits and . _ : / @ ~ + -" };
  }
  if (looksLikeCredential(raw)) {
    // Never quoted: it may well be a key.
    return {
      ok: false,
      problem: "model looks like an API key, not a model id (not repeated here). The key goes on stdin: failproofai jev setup --key-stdin",
    };
  }
  const v = jevModelVersion(raw);
  if (v && (v.major !== JEV_CALIBRATED_FAMILY.major || v.minor !== JEV_CALIBRATED_FAMILY.minor)) {
    return {
      ok: false,
      problem:
        `model ${raw} names Jev ${v.major}.${v.minor}, but the thresholds are calibrated for Jev ` +
        `${JEV_CALIBRATED_FAMILY.major}.${JEV_CALIBRATED_FAMILY.minor} — every call would fall back to regex`,
    };
  }
  return { ok: true, value: raw };
}

/**
 * Validate a parsed `jev.json` (or a config assembled by `jev setup`) into a
 * normalized `JevConfig`: `mode` and `timeoutMs` filled with their defaults,
 * `baseUrl` normalized, and only the fields this provider uses kept.
 *
 * `envKey` is the value of `FAILPROOFAI_JEV_API_KEY`, used only when the object
 * has no `apiKey`. Unknown top-level keys are ignored so a newer failproofai's
 * file does not switch Jev off on an older one. Problems never quote the key.
 *
 * `cloud` is the `jev` slot of `credentials.json`, and is read ONLY for the
 * FailproofAI Cloud provider, which takes its key from nowhere else: not the
 * file (an `apiKey` there is refused) and not `envKey` (ignored). The file's
 * `baseUrl` must sit on the origin the credential was verified against.
 */
export function validateJevConfig(
  raw: unknown,
  envKey?: string | null,
  cloud?: JevCloudCredential | null,
): ValidationResult<JevConfig> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, problem: "the file must hold a JSON object" };
  const o = raw as Record<string, unknown>;

  const provider = o.provider;
  if (typeof provider !== "string" || !(JEV_PROVIDER_KINDS as readonly string[]).includes(provider)) {
    return { ok: false, problem: `provider must be one of ${JEV_PROVIDER_KINDS.join(", ")}` };
  }
  const kind = provider as JevProviderKind;

  let apiKey: string;
  if (kind === JEV_CLOUD_PROVIDER) {
    // One home for the Cloud key, so revoking it at disconnect cannot leave a
    // copy behind that keeps Jev spending — and so nothing a session can set
    // (the environment) or a second file can hold decides which key is sent.
    if (o.apiKey !== undefined) {
      return {
        ok: false,
        problem:
          "provider failproofai takes its key from this machine's FailproofAI Cloud connection (credentials.json), " +
          "never from jev.json — remove apiKey from the file (not repeated here)",
      };
    }
    if (!cloud) {
      return {
        ok: false,
        problem:
          "this machine is not connected to FailproofAI Cloud with a key that carries jev:evaluate — " +
          "connect it with: failproofai config --token <key>",
        notConnected: true,
      };
    }
    const bad = validateApiKey(cloud.key);
    if (bad) return { ok: false, problem: `the FailproofAI Cloud key in credentials.json is unusable: ${bad}` };
    apiKey = cloud.key;
  } else if (o.apiKey !== undefined) {
    const bad = validateApiKey(o.apiKey);
    if (bad) return { ok: false, problem: bad };
    apiKey = o.apiKey as string;
  } else if (envKey !== undefined && envKey !== null && envKey !== "") {
    const bad = validateApiKey(envKey);
    if (bad) return { ok: false, problem: `${JEV_API_KEY_ENV} is set but invalid: ${bad}` };
    apiKey = envKey;
  } else {
    return {
      ok: false,
      problem: `no API key: set apiKey in the file (failproofai jev setup), or ${JEV_API_KEY_ENV} for this session`,
      missingKey: true,
    };
  }

  const cfg: JevConfig = { provider: kind, apiKey, mode: DEFAULT_JEV_MODE, timeoutMs: JEV_CONFIG_DEFAULT_TIMEOUT_MS };

  if (o.baseUrl !== undefined) {
    const r = validateBaseUrl(o.baseUrl);
    if (!r.ok) return r;
    cfg.baseUrl = r.value;
  } else if (kind === "custom" || kind === JEV_CLOUD_PROVIDER) {
    return { ok: false, problem: `provider ${kind} needs a baseUrl` };
  }

  if (kind === JEV_CLOUD_PROVIDER && cloud) {
    // The key goes only to the origin it was issued for. Compared as origins
    // (scheme + host + port), which is what decides where a bearer token lands;
    // the path under it is the Cloud's own routing.
    const credentialOrigin = originOf(cloud.url);
    const baseOrigin = originOf(cfg.baseUrl as string);
    if (credentialOrigin === null) {
      return { ok: false, problem: "the FailproofAI Cloud credential in credentials.json names no usable origin — reconnect: failproofai config --token <key>" };
    }
    if (baseOrigin !== credentialOrigin) {
      return {
        ok: false,
        problem:
          `baseUrl is on ${baseOrigin ?? "an unusable origin"}, but this machine's FailproofAI Cloud key was issued for ${credentialOrigin} — ` +
          "the key is only ever sent to the origin it was issued for. Point jev.json back at it: failproofai jev setup --provider failproofai",
      };
    }
  }

  if (kind === "cloudflare") {
    if (typeof o.accountId !== "string" || !CLOUDFLARE_ACCOUNT_ID_RE.test(o.accountId)) {
      // It is interpolated into a URL path, so it is refused rather than escaped.
      return { ok: false, problem: "provider cloudflare needs accountId: 32 lowercase hex characters" };
    }
    cfg.accountId = o.accountId;
  }

  if (o.model !== undefined) {
    const r = validateModel(o.model);
    if (!r.ok) return r;
    // The key pasted twice — once on stdin, once as --model — whatever its shape.
    if (r.value === apiKey) return { ok: false, problem: "model is the API key (not repeated here); give the model id, or leave --model out for the provider's default" };
    cfg.model = r.value;
  }

  if (o.timeoutMs !== undefined) {
    const t = o.timeoutMs;
    if (typeof t !== "number" || !Number.isInteger(t) || t < MIN_JEV_TIMEOUT_MS || t > MAX_JEV_TIMEOUT_MS) {
      return { ok: false, problem: `timeoutMs must be a whole number of milliseconds from ${MIN_JEV_TIMEOUT_MS} to ${MAX_JEV_TIMEOUT_MS}` };
    }
    cfg.timeoutMs = t;
  }

  if (o.mode !== undefined) {
    if (o.mode !== "off" && o.mode !== "shadow" && o.mode !== "enforce") return { ok: false, problem: 'mode must be "off", "shadow" or "enforce"' };
    cfg.mode = o.mode;
  }

  // Plain http reaches only a loopback host (`validateBaseUrl`), and nothing
  // authenticates the server there: while the local proxy is down, any process
  // of this user — the agent being judged included — can bind its port and
  // answer "none" to every question. In enforce mode that answer clears
  // reviewable denies; in shadow mode it changes nothing, and `off` sends
  // nothing at all, so enforce is the one mode it is refused in.
  if (cfg.baseUrl !== undefined && isPlainHttp(cfg.baseUrl) && cfg.mode === "enforce") {
    return {
      ok: false,
      problem:
        "plain http (to localhost) is accepted only with mode shadow: in enforce mode Jev's answers can clear a deny, " +
        "and while the local proxy is down any process on this machine could take its port and answer. Use https, or mode shadow",
    };
  }

  return { ok: true, value: cfg };
}

/**
 * Re-validate a config that was already LOADED — by `loadJevConfig` or
 * `inspectJevConfig` — before a route or a transport is built from it.
 *
 * For every BYOK provider that is `validateJevConfig` as it always was. The
 * FailproofAI Cloud provider is the one whose in-memory `apiKey` is not a file
 * field: the loader filled it from `credentials.json` after checking the base
 * URL against the credential's origin, and `validateJevConfig` would now refuse
 * the very key it put there. So the key is handed back in the credential slot,
 * under the base URL's own origin. That makes the origin check vacuous HERE, on
 * purpose: this runs on a value the loader has already vetted (or on a display
 * stand-in that is never sent), and every file on disk still meets the real
 * check on its way in.
 */
export function validateLoadedJevConfig(cfg: JevConfig): ValidationResult<JevConfig> {
  if (cfg.provider !== JEV_CLOUD_PROVIDER) return validateJevConfig(cfg);
  const { apiKey, ...rest } = cfg;
  return validateJevConfig(rest, null, { url: typeof cfg.baseUrl === "string" ? cfg.baseUrl : "", key: apiKey });
}

// ── Loading ──────────────────────────────────────────────────────────────────

export type JevConfigInspection =
  | { status: "absent"; path: string }
  | {
      status: "ok";
      path: string;
      mode: number | null;
      /** `cloud`: the `jev` slot of `credentials.json` (the FailproofAI Cloud provider). */
      keySource: "file" | "env" | "cloud";
      config: JevConfig;
    }
  | {
      /**
       * A sound file that says `mode: "off"`. Jev does not run — `loadJevConfig`
       * returns null — and nothing is wrong: the owner switched it off and kept
       * the endpoint (and, for BYOK, the key) for later. Reported apart from
       * `absent` so `jev status` and the dashboard can say "switched off"
       * rather than "not configured", and apart from `ok` so no reader that
       * takes `ok` to mean "on" can be wrong about it.
       */
      status: "off";
      path: string;
      mode: number | null;
      /** Everything the file says except the key. */
      routing: Omit<JevConfig, "apiKey">;
    }
  | {
      /**
       * The file names the FailproofAI Cloud provider and is sound, but this
       * machine holds no Jev credential (never connected with a `jev:evaluate`
       * key, or disconnected since). Jev is off. The FailproofAI Cloud twin of
       * `key-missing`: nothing is wrong with the FILE, so no reader should tell
       * its owner to rewrite it.
       */
      status: "not-connected";
      path: string;
      mode: number | null;
      routing: Omit<JevConfig, "apiKey">;
      problem: string;
    }
  | {
      /**
       * The file is sound and names `FAILPROOFAI_JEV_API_KEY` as the key's
       * source (`jev setup --key-from-env` writes exactly this), but the
       * variable is not set in THIS process. Jev is off here — `loadJevConfig`
       * returns null, as for every status but `ok` — and on wherever the
       * variable is set. Kept apart from `refused` because nothing is wrong
       * with the file: telling the owner to write a valid one would have them
       * overwrite the config they chose, and a provisioning check reading
       * `status --json` should see a configured machine, not a broken one.
       */
      status: "key-missing";
      path: string;
      mode: number | null;
      /** Everything the file says except the key, so `jev status` can show the route. */
      routing: Omit<JevConfig, "apiKey">;
      problem: string;
    }
  | {
      status: "refused";
      path: string;
      /** The file's permission bits, when they are the reason. */
      mode: number | null;
      reason: "too-open" | "unreadable" | "too-large" | "not-json" | "invalid";
      problem: string;
      /** The command that fixes it, when one does. */
      fix?: string;
    };

function readEnvKey(): string | null {
  const v = process.env[JEV_API_KEY_ENV];
  return v === undefined || v === "" ? null : v;
}

/**
 * A placeholder key, used only to answer "is this file sound apart from the
 * key?" when the variable that would supply it is unset in this process.
 * Validation stops at the missing key, so the fields after it — baseUrl,
 * accountId, model, timeoutMs, mode — are otherwise never checked, and a file
 * that is also malformed further down must still be reported as malformed. It
 * is never written, never sent, and never returned: `inspectJevConfig` copies
 * the routing fields out of the config it validates and drops the rest.
 */
const KEY_STAND_IN = "supplied-by-the-environment";

/**
 * Group- or world-WRITE bits on the directory holding the config. Anyone who
 * can write there can unlink the owner's file and leave their own 0600 one,
 * which every check on the file itself then passes. Read bits are deliberately
 * not included: a 0755 home is ordinary and gives nobody that power, while the
 * file inside it is checked for read bits too.
 */
const DIR_WRITABLE_BY_OTHERS = 0o022;

/** The config directory's mode when others can write to it, else null. */
function looseConfigDirMode(path: string): number | null {
  if (!modesAreMeaningful()) return null;
  try {
    const mode = statSync(dirname(path)).mode & 0o777;
    return (mode & DIR_WRITABLE_BY_OTHERS) !== 0 ? mode : null;
  } catch {
    // No directory, or no permission to stat it: the file read reports that.
    return null;
  }
}

/** Whether permission bits can be trusted to mean anything here. */
function modesAreMeaningful(): boolean {
  // On Windows `stat().mode` is synthesized (0o666 for any writable file), so
  // the check would refuse every file without protecting anything. Setup is
  // refused on Windows (see `isDaemonSupportedPlatform`), so this is the
  // in-process dev path only.
  return process.platform !== "win32";
}

/**
 * Everything `failproofai jev status` needs to say about the file, without the
 * key. `loadJevConfig()` is this with the reasons thrown away.
 *
 * The file is opened once and every check runs against that descriptor, so the
 * permissions checked are the permissions of the bytes read.
 */
export function inspectJevConfig(): JevConfigInspection {
  const path = jevConfigPath();
  let fd: number;
  try {
    fd = openSync(path, OPEN_FLAGS);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { status: "absent", path };
    return { status: "refused", path, mode: null, reason: "unreadable", problem: `cannot open it (${code ?? "error"})` };
  }
  let text: string;
  let mode: number | null = null;
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { status: "refused", path, mode: null, reason: "unreadable", problem: "it is not a regular file" };
    mode = st.mode & 0o777;
    if (modesAreMeaningful() && (mode & 0o077) !== 0) {
      return {
        status: "refused",
        path,
        mode,
        reason: "too-open",
        problem: `its permissions are ${mode.toString(8).padStart(4, "0")}; it holds a key, so it must be owner-only (chmod 600 ${path})`,
        fix: `chmod 600 ${path}`,
      };
    }
    const dirMode = looseConfigDirMode(path);
    if (dirMode !== null) {
      // 0600 on the file means nothing while another user can replace the file.
      return {
        status: "refused",
        path,
        mode,
        reason: "too-open",
        problem:
          `its directory ${dirname(path)} is ${dirMode.toString(8).padStart(4, "0")} — other users can write there, ` +
          `so they can put their own config in its place; it must be owner-only (chmod 700 ${dirname(path)})`,
        fix: `chmod 700 ${dirname(path)}`,
      };
    }
    if (st.size > MAX_CONFIG_BYTES) return { status: "refused", path, mode, reason: "too-large", problem: `it is larger than ${MAX_CONFIG_BYTES} bytes` };
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, off);
      if (n === 0) break;
      off += n;
    }
    text = buf.subarray(0, off).toString("utf8");
  } catch (err) {
    return { status: "refused", path, mode, reason: "unreadable", problem: `cannot read it (${(err as NodeJS.ErrnoException).code ?? "error"})` };
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Nothing useful to do.
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: "refused", path, mode, reason: "not-json", problem: "it is not valid JSON" };
  }
  const isObject = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  const fields = isObject ? (parsed as Record<string, unknown>) : null;

  // Switched off. Checked before any key is looked for, because nothing will be
  // sent: a BYOK file whose key lives in the environment, and a Cloud file on a
  // machine that has since disconnected, are both simply "off". The rest of the
  // file is still validated — with stand-ins in the key slots, which are never
  // sent anywhere — so a file that is off AND broken is reported as broken.
  if (fields?.mode === "off") {
    const r = validateJevConfig(parsed, KEY_STAND_IN, standInCloudCredential(fields));
    if (!r.ok) return { status: "refused", path, mode, reason: "invalid", problem: r.problem };
    return { status: "off", path, mode, routing: routingOf(r.value) };
  }

  if (fields?.provider === JEV_CLOUD_PROVIDER) {
    // The key lives in credentials.json, which is read with the same owner-only
    // checks as this file: a credentials file someone else could have written
    // is refused, not read, and Jev is off.
    const credential = readJevCloudCredential();
    if (credential.status === "refused") {
      return {
        status: "refused",
        path,
        mode,
        reason: credential.reason === "too-open" ? "too-open" : "unreadable",
        problem: `the FailproofAI Cloud credential was refused: ${credential.problem}`,
        ...(credential.fix ? { fix: credential.fix } : {}),
      };
    }
    // `FAILPROOFAI_JEV_API_KEY` is deliberately not passed: see the header.
    const r = validateJevConfig(parsed, null, credential.status === "ok" ? credential.credential : null);
    if (r.ok) return { status: "ok", path, mode, keySource: "cloud", config: r.value };
    if (r.notConnected === true) {
      const rest = validateJevConfig(parsed, null, standInCloudCredential(fields));
      if (!rest.ok) return { status: "refused", path, mode, reason: "invalid", problem: rest.problem };
      return { status: "not-connected", path, mode, routing: routingOf(rest.value), problem: r.problem };
    }
    return { status: "refused", path, mode, reason: "invalid", problem: r.problem };
  }

  const envKey = readEnvKey();
  const r = validateJevConfig(parsed, envKey);
  if (!r.ok) {
    if (r.missingKey === true) {
      // Nothing is wrong with the file unless the REST of it is wrong too, and
      // validation never got that far, so ask again with a stand-in key.
      const rest = validateJevConfig(parsed, KEY_STAND_IN);
      if (rest.ok) {
        return {
          status: "key-missing",
          path,
          mode,
          routing: routingOf(rest.value),
          problem: `it carries no apiKey, so the key comes from ${JEV_API_KEY_ENV} — which is not set in this environment`,
        };
      }
      return { status: "refused", path, mode, reason: "invalid", problem: rest.problem };
    }
    return { status: "refused", path, mode, reason: "invalid", problem: r.problem };
  }
  const keySource = (parsed as Record<string, unknown>).apiKey !== undefined ? "file" : "env";
  return { status: "ok", path, mode, keySource, config: r.value };
}

/** Everything a validated config says except its key — copied field by field, so the key cannot ride along. */
function routingOf(cfg: JevConfig): Omit<JevConfig, "apiKey"> {
  const routing: Omit<JevConfig, "apiKey"> = { provider: cfg.provider, mode: cfg.mode, timeoutMs: cfg.timeoutMs };
  if (cfg.baseUrl !== undefined) routing.baseUrl = cfg.baseUrl;
  if (cfg.accountId !== undefined) routing.accountId = cfg.accountId;
  if (cfg.model !== undefined) routing.model = cfg.model;
  return routing;
}

/**
 * A Cloud credential that stands in for a missing one, on the file's own origin,
 * so the rest of a Cloud file can be validated when there is no key to check it
 * with. Like `KEY_STAND_IN` it is never written and never sent; an unparseable
 * `baseUrl` gets a placeholder origin and is refused by `validateBaseUrl` first.
 */
function standInCloudCredential(fields: Record<string, unknown>): JevCloudCredential {
  let url = "https://stand-in.invalid";
  if (typeof fields.baseUrl === "string") {
    try {
      url = new URL(fields.baseUrl.trim()).origin;
    } catch {
      // Keep the placeholder.
    }
  }
  return { url, key: KEY_STAND_IN };
}

/**
 * The validated global config, or null — absent, refused, invalid, switched
 * off, a key-from-the-environment file in an environment that does not set it,
 * or a FailproofAI Cloud file on a machine with no Cloud credential all mean
 * Jev is off and the regex path runs unchanged. Never throws.
 *
 * `mode: "off"` never comes out of here: `inspectJevConfig` reports it as its
 * own status, and the check below is the belt to that brace — an off config
 * reaching the hook path would be read as the default mode, `enforce`.
 */
export function loadJevConfig(): JevConfig | null {
  try {
    const r = inspectJevConfig();
    return r.status === "ok" && r.config.mode !== "off" ? r.config : null;
  } catch {
    return null;
  }
}

export interface JevConfigFileForUpdate {
  raw: Record<string, unknown>;
  /** The file's permission bits (null where they mean nothing). */
  mode: number | null;
  /**
   * Group or other bits were set on the file, or write bits on its directory:
   * the loader refuses this file, and someone other than its owner may have
   * written it — so the endpoint it names is not trusted with the key it holds
   * (see `jev setup`). A directory others can write into means the same thing,
   * because the file in it can simply be replaced.
   */
  tooOpen: boolean;
}

/**
 * The file's raw JSON object regardless of its permissions, with those
 * permissions, for `jev setup` to update in place (carry the key over a mode
 * switch, or re-save a file that is too open at 0600) and for `jev status` to
 * show what a refused file names. Never used on the hook path.
 */
export function readJevConfigFileForUpdate(): JevConfigFileForUpdate | null {
  const path = jevConfigPath();
  let fd: number;
  try {
    fd = openSync(path, OPEN_FLAGS);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_CONFIG_BYTES) return null;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, off);
      if (n === 0) break;
      off += n;
    }
    const parsed: unknown = JSON.parse(buf.subarray(0, off).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const meaningful = modesAreMeaningful();
    const mode = meaningful ? st.mode & 0o777 : null;
    const tooOpen = mode !== null && ((mode & 0o077) !== 0 || looseConfigDirMode(path) !== null);
    return { raw: parsed as Record<string, unknown>, mode, tooOpen };
  } catch {
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Nothing useful to do.
    }
  }
}

/** `readJevConfigFileForUpdate()` without the permissions. */
export function readJevConfigForUpdate(): Record<string, unknown> | null {
  return readJevConfigFileForUpdate()?.raw ?? null;
}
