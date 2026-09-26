/**
 * `failproofai jev` — configure the customer's own Jev endpoint and key (BYOK),
 * the single opt-in to the two-tier hook evaluator.
 *
 *   jev --url <url> [--token <token>]
 *               the one-shot form: the same thing as `setup`, with the provider
 *               read off the URL's host
 *   jev setup   write ~/.failproofai/jev.json at 0600 from flags + a key
 *   jev status  what is configured, whether it is being used, how much of the
 *               enabled policy set Jev is allowed to clear, and how Jev has
 *               been doing (fallbacks, latency, clears) — never the key
 *   jev test    one tiny live request: latency and the Jev version that answered
 *   jev models  what `GET <base>/models` says this endpoint serves
 *   jev remove  delete the file; hooks go back to the regex engine unchanged
 *
 * # `--url` is a BASE, and the model has to exist
 *
 * Two contract mistakes cost a customer on a LiteLLM proxy real time, and both
 * were things this command already knew enough to say:
 *
 * - `--url https://…/typesafe/v1/models` was an ENDPOINT given where a BASE
 *   belongs. It saved without complaint, `/systemone` was appended to it, and the
 *   only signal was `http-404: Not Found` from `jev test`. Setup now refuses a URL
 *   whose path ends in `/models`, `/chat/completions`, `/completions`,
 *   `/embeddings` or `/systemone` and names the base it implies
 *   (`endpointGivenAsBase`).
 * - the model then still did not exist: `custom`'s default is `jev-1.13.0` and
 *   that proxy serves `jev-latest` and `jev-preview`. Setup now reads
 *   `GET <base>/models` before it writes, and refuses a model the list does not
 *   carry, naming the ones it does. When the list cannot be read — no key yet, a
 *   proxy that serves no list, Cloudflare, an unreachable host — setup proceeds
 *   exactly as it did before: this is a check where one is possible, never a
 *   dependency on a model-list endpoint existing.
 *
 * # The provider is read off the URL
 *
 * `--url` names the endpoint, and its HOST says which provider that is
 * (`PROVIDER_BY_HOST`); anything else is `custom` with that URL as its base.
 * `--provider` still overrides the inference, but a provider that contradicts
 * the URL's host — `--provider openrouter` against `api.typesafe.ai` — is
 * refused rather than guessed at, because the two spellings disagree about
 * where the key is about to be sent. `--url` is otherwise exactly
 * `--base-url`: it is validated by the same `validateBaseUrl` the loader uses
 * and refused in the same words, and when it names the provider's own API it
 * clears the override rather than writing it back.
 *
 * The provider NAME is validated before any of that, whatever else is on the
 * command line: a spelling that is not a provider — `OpenRouter`, a typo, a
 * pasted key — is refused, never replaced by the one the host implies. Two
 * combinations the URL settles rather than saves: `--provider custom` against
 * `api.cloudflare.com`, which `custom` cannot speak (Workers AI is per-account
 * and wraps its answers), and `--account-id` for any provider but cloudflare,
 * which is the only one whose route reads it. And a URL that keeps the provider
 * but leaves its API base — `https://api.typesafe.ai/v2` — is saved with a
 * warning naming the endpoint requests will actually go to, because nothing
 * else would say so until the fallback counts did.
 *
 * # The key is never echoed
 *
 * `--token <value>` exists because one command that configures Jev is worth
 * having, but it is not the recommended spelling and says so at the end of
 * every run that uses it: a command-line argument lands in shell history and
 * is readable from `ps` — from `/proc` — by anything running as this user.
 * The key otherwise arrives on stdin (`--key-stdin`), at a masked prompt when
 * stdin is a terminal, or — for people who keep keys off disk — from
 * `FAILPROOFAI_JEV_API_KEY` at run time (`--key-from-env`). `--key-stdin` on a
 * terminal uses the masked prompt too, because a cooked-mode read would echo
 * each character as it is typed. No output of this module, human or `--json`,
 * contains the key; provider error text is scrubbed of it in `jev-client.ts`,
 * and `jev test` scrubs whatever error it prints once more. Nothing here
 * repeats a value it could not use (a stray argument, an unknown provider, an
 * unreadable timeout, a model id shaped like a key, an option that is not one,
 * or an unknown subcommand that is not shaped like one): a key pasted into the
 * wrong place on the command line is already in shell history, and does not
 * also need to be on the screen.
 *
 * # A stored key stays with its host
 *
 * Re-running `setup` for the same provider keeps the stored key. When the new
 * `--base-url` moves requests to a different origin — other than the
 * provider's own API — the key is asked for again, exactly as on a provider
 * switch: for `custom` (and any override) the URL is what picks the gateway,
 * and a key issued for one gateway must not be sent to another unasked.
 *
 * A file that was open to other users is the loader's "someone else may have
 * chosen the endpoint" case, and re-saving it at 0600 must not undo that: its
 * stored key is carried only to the provider's own API. Any other endpoint it
 * names — kept or passed again with `--base-url` — needs the key again, given
 * explicitly (not at a bare prompt that would not say where it goes). `jev
 * status` shows such a file's endpoint next to its `chmod 600` hint.
 *
 * # No restart
 *
 * Hooks read the file on every event (see `loadJevConfig`), so a setup, a mode
 * switch or a remove applies on the next tool call, daemon or not.
 */
import { chmodSync, existsSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { writeJsonAtomically } from "../../lib/atomic-write";
import {
  DEFAULT_JEV_MODE,
  JEV_API_KEY_ENV,
  JEV_CLOUD_PROVIDER,
  JEV_CONFIG_DEFAULT_TIMEOUT_MS,
  JEV_PROVIDER_KINDS,
  MAX_JEV_TIMEOUT_MS,
  endpointGivenAsBase,
  inspectJevConfig,
  jevCloudBaseUrl,
  jevConfigPath,
  readJevConfigFileForUpdate,
  validateApiKey,
  validateBaseUrl,
  validateJevConfig,
  type EndpointGivenAsBase,
  type JevConfig,
  type JevProviderKind,
} from "./semantic/jev-config";
import {
  JEV_MODEL_LIST_TIMEOUT_MS,
  JEV_PROVIDER_DEFAULTS,
  JevError,
  displayEndpoint,
  jevModelsUrl,
  jevRoute,
  listDescribesSystemOne,
  modelListHasModel,
  modelsUrlForBase,
  readAnswers,
  readJevModelList,
  scrubSecret,
  transportForConfig,
  type JevModelListRead,
  type JevModelListResult,
} from "./semantic/jev-client";
import {
  reviewableProblem,
  reviewableSummary,
  surveyReviewableCoverage,
  type ReviewableCoverage,
} from "./policy-reviewability";
import { jevStats, type JevStats } from "./semantic/jev-stats";
import { readCredentials, readJevCloudCredential, type JevCloudCredential } from "./fp-config";
import type { JevRequest } from "./semantic/types";
import { emptyState, nextStep, note, optsFor, rows, rule, stack, title, warning, type RenderOpts } from "./tui";

export interface JevCliResult {
  lines: string[];
  exitCode: number;
  /** `--json`: printed verbatim instead of `lines`. */
  json?: string;
}

/** `GET <base>/models`, as `setup` and `models` reach it. */
export type JevModelListReader = (modelsUrl: string, apiKey: string | null) => Promise<JevModelListResult>;

export interface JevCliDeps {
  /** Everything piped on stdin (for `--key-stdin` off a terminal). */
  readStdin?: () => Promise<string>;
  /** A masked one-line prompt; null when cancelled. */
  promptKey?: () => Promise<string | null>;
  stdinIsTTY?: boolean;
  /** Budget for `jev test`'s single request. */
  testTimeoutMs?: number;
  /**
   * How `<base>/models` is read. The default reaches the network, which `setup`
   * did not used to do at all — so it is injectable, and a unit test that is not
   * about the list injects a reader that reads nothing rather than calling out to
   * a provider from a test run.
   */
  readModelList?: JevModelListReader;
  render?: RenderOpts;
}

/** The real reader, on its own budget: see `JEV_MODEL_LIST_TIMEOUT_MS`. */
const liveModelListReader: JevModelListReader = (url, apiKey) => readJevModelList(url, apiKey, AbortSignal.timeout(JEV_MODEL_LIST_TIMEOUT_MS));

const ok = (lines: string[], json?: string): JevCliResult => ({ lines, exitCode: 0, ...(json !== undefined ? { json } : {}) });
const fail = (lines: string[], json?: string): JevCliResult => ({ lines, exitCode: 1, ...(json !== undefined ? { json } : {}) });

export const JEV_USAGE = [
  "Usage:",
  "  failproofai jev --url <url> [--key-stdin | --token <token>] [options]",
  "  failproofai jev setup --provider <kind> [--key-stdin | --key-from-env] [options]",
  "  failproofai jev setup --provider failproofai [--mode off|shadow|enforce]   (FailproofAI Cloud: no key, no URL)",
  "  failproofai jev status [--json]",
  "  failproofai jev test [--json]",
  "  failproofai jev models [--provider <kind>] [--url <base>] [--json]",
  "  failproofai jev remove",
];

/** One live `jev test` request: small, harmless, and with an answer that is obviously right. */
export const JEV_TEST_QUESTION_ID = "jev_test";
const DEFAULT_TEST_TIMEOUT_MS = 15_000;
/** Validation-only placeholder for a config whose key comes from the environment. Never written. */
const ENV_KEY_STAND_IN = "env-key-stand-in";

// ── Argument parsing ─────────────────────────────────────────────────────────

/**
 * Every subcommand's answer to a stray argument. Never the argument itself: the
 * likeliest one is a key pasted in the wrong place, which is already in shell
 * history and does not also need to be on the screen.
 */
const STRAY_ARGUMENT = "Unexpected argument (not repeated here, in case it is a key). The key goes on stdin: --key-stdin.";

/** What a mistyped subcommand looks like, and no key does: short, lower-case letters and dashes. */
const SUBCOMMAND_SHAPE = /^[a-z][a-z-]{0,20}$/;

const VALUE_FLAGS = new Set(["--provider", "--url", "--token", "--base-url", "--account-id", "--model", "--timeout-ms", "--mode"]);
const BOOL_FLAGS = new Set(["--key-stdin", "--key-from-env", "--json"]);

/** What an option name looks like, and no key does — the same idea as `SUBCOMMAND_SHAPE`. */
const OPTION_SHAPE = /^--?[a-z][a-z0-9-]{0,30}$/;

/**
 * An unknown option, named only when it is shaped like an option name. A
 * mistyped `--token` is the one place a key is most likely to arrive glued to
 * an option (`-token=<key>`, `--tokn=<key>`), so what is echoed is the name
 * that failed to parse and never the value behind it.
 */
function unknownOption(arg: string): string {
  return OPTION_SHAPE.test(arg) ? `Unknown option: ${arg}` : "Unknown option (not repeated here, in case it carries a key).";
}

interface Parsed {
  values: Map<string, string>;
  bools: Set<string>;
  positionals: string[];
}

function parseFlags(argv: string[], allowed: Set<string>): Parsed | string {
  const values = new Map<string, string>();
  const bools = new Set<string>();
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let inline: string | undefined;
    // Split on `=` for a single dash too (`-token=<key>`): a value must never
    // survive into the "unknown option" message below.
    if (arg.startsWith("-") && arg.includes("=")) {
      inline = arg.slice(arg.indexOf("=") + 1);
      arg = arg.slice(0, arg.indexOf("="));
    }
    if (!arg.startsWith("-")) {
      positionals.push(arg);
      continue;
    }
    if (!allowed.has(arg)) return unknownOption(arg);
    if (VALUE_FLAGS.has(arg)) {
      const v = inline ?? argv[++i];
      if (v === undefined || (inline === undefined && v.startsWith("--"))) return `Missing value after ${arg}`;
      values.set(arg, v);
    } else if (BOOL_FLAGS.has(arg)) {
      if (inline !== undefined) return `${arg} takes no value`;
      bools.add(arg);
    }
  }
  return { values, bools, positionals };
}

// ── Rendering helpers ────────────────────────────────────────────────────────

function modeLine(mode: NonNullable<JevConfig["mode"]>): string {
  if (mode === "off") return "off — Jev is not asked at all; the regex policies decide alone";
  return mode === "enforce"
    ? "enforce — Jev's verdicts apply: it may clear a reviewable policy's deny and add its own"
    : "shadow — Jev is asked and logged; the regex result is what is enforced";
}

/**
 * The name a provider is SHOWN by. Only the Cloud route differs from its kind:
 * `failproofai` is the value in the file, and "FailproofAI Cloud" is what the
 * person connected to.
 */
export function providerLabel(provider: JevProviderKind): string {
  return provider === JEV_CLOUD_PROVIDER ? "FailproofAI Cloud" : provider;
}

/**
 * Where requests go, as `jev status` shows it. The Cloud route shows its HOST
 * only: the path under it is the Cloud's own routing, the same on every
 * deployment, and the host is the one fact that says which Cloud this machine
 * is talking to.
 */
function shownEndpoint(provider: JevProviderKind, endpoint: string): string {
  if (provider !== JEV_CLOUD_PROVIDER) return displayEndpoint(endpoint);
  try {
    return new URL(endpoint).host;
  } catch {
    return "(invalid URL)";
  }
}

/** What `jev status` says about where the key comes from. */
const CLOUD_KEY_SOURCE = "FailproofAI Cloud connection";

/** Whether this machine holds a usable Jev credential, read owner-only. Never the key. */
function cloudCredentialPresent(): boolean {
  return cloudConnection().keyCarriesJev;
}

/**
 * The two facts `status --json` reports about the FailproofAI Cloud connection,
 * read owner-only: whether this machine is connected at all, and whether the
 * key it connected with carries Jev. Never the key.
 */
function cloudConnection(): { cloudConnected: boolean; keyCarriesJev: boolean } {
  try {
    const read = readJevCloudCredential();
    if (read.status === "ok") return { cloudConnected: true, keyCarriesJev: true };
    return { cloudConnected: read.status === "absent" && read.connected, keyCarriesJev: false };
  } catch {
    return { cloudConnected: false, keyCarriesJev: false };
  }
}

/** The one line `status` titles a connected machine whose key has no Jev with. */
const KEY_LACKS_JEV_TITLE = "off — no Jev key is stored for this machine's FailproofAI Cloud connection";

/** The `key` row for a Cloud file, saying which of the three states the connection is in. */
function cloudKeyRow(): string {
  const c = cloudConnection();
  if (c.keyCarriesJev) return CLOUD_KEY_SOURCE;
  return c.cloudConnected
    ? `${CLOUD_KEY_SOURCE} — connected, no Jev key stored for it`
    : `${CLOUD_KEY_SOURCE} — this machine is not connected`;
}

/** `0600`, or null when unknown. */
function octal(mode: number | null): string | null {
  return mode === null ? null : mode.toString(8).padStart(4, "0");
}

function permissions(mode: number | null): string {
  if (mode === null) return "unknown";
  return (mode & 0o077) === 0 ? `${octal(mode)} (owner-only)` : `${octal(mode)} (too open)`;
}

function describeError(err: unknown): { code: string; message: string } {
  if (err instanceof JevError) return { code: err.code, message: err.message };
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return { code: "timeout", message: "no answer in time" };
  return { code: "error", message: err instanceof Error ? err.message : String(err) };
}

function scrubbed(e: { code: string; message: string }, key: string): { code: string; message: string } {
  return { code: e.code, message: scrubSecret(e.message, key) };
}

/**
 * What the person should do about a failed FailproofAI Cloud request, by cause,
 * or null where the generic advice already fits. The remedies differ from a
 * BYOK provider's because the key and the budget are the Cloud connection's and
 * the org's, not anything `jev setup` holds.
 */
function cloudRemedy(code: string, message = ""): string | null {
  if (code === "http-401" || code === "http-403") {
    return "FailproofAI Cloud refused this machine's key: it was revoked, or it does not carry jev:evaluate. Reconnect with a key that does (the \"machine\" preset on the Keys page): failproofai config --token <key>";
  }
  if (code === "out-of-credits") {
    return "Your FailproofAI Cloud org has used its plan allowance (HTTP 402). Until it resets or the plan changes, hooks fall back to regex.";
  }
  if (code === "http-429") {
    // Two limits answer 429 (contract decision 18): the per-minute ones, and
    // the org's daily Jev cap, whose body says `daily_limit_reached` and whose
    // Retry-After runs to the next UTC midnight. Only the words tell them
    // apart, and "right now … at most 60 s" is wrong for the second: the
    // machine still asks again after at most 60 s, and keeps being refused.
    if (/\bdaily_limit_reached\b/.test(message)) {
      return "Daily Jev limit for this org reached; resets at 00:00 UTC. Until then hooks fall back to regex; the machine asks FailproofAI Cloud again at most once a minute (Retry-After, capped at 60 s).";
    }
    return "FailproofAI Cloud is rate-limiting Jev for this org right now. Hooks fall back to regex, and send it nothing more until the wait it asked for (Retry-After, at most 60 s) is over.";
  }
  if (code === "http-404") return "This FailproofAI Cloud does not serve Jev (its server predates the Jev route). Hooks fall back to regex until it does.";
  if (code === "http-503") {
    return (
      "This FailproofAI Cloud cannot serve Jev for your org: its deployment has no model gateway, the org is not " +
      "provisioned yet, or the gateway is down. Ask your FailproofAI Cloud admin. Hooks fall back to regex and ask " +
      "again at most once a minute."
    );
  }
  // `request_rejected`: TypeSafe refused this request itself, typically dense
  // text over Jev's token budget. The same call gets the same answer.
  if (code === "http-422") return "Jev refused this call's request, usually because it held dense text (base64, hex, minified code) over Jev's token budget. That call falls back to regex every time; this is not an outage.";
  if (code === "model-mismatch") return "FailproofAI Cloud answered with a model outside the Jev 1.13 family, so hooks would fall back to regex. This is the server's to fix.";
  // The generic advice for these names `--base-url`, which this route refuses:
  // its endpoint is the Cloud this machine connected to, changed only by
  // reconnecting.
  if (/^http-3(?:\d\d|xx)$/.test(code)) {
    return "FailproofAI Cloud answered with a redirect, and Jev requests never follow one. The URL this machine connected to is probably not the one that serves the API (a sign-in page, or an old address). Reconnect with the right one: failproofai config --token <key> --url <url>";
  }
  if (code === "network") {
    return "FailproofAI Cloud could not be reached. Check your network; if the Cloud's address has changed, reconnect: failproofai config --token <key> --url <url>";
  }
  if (code === "config") return "The config is not usable. Rebuild it from this machine's FailproofAI Cloud connection: failproofai jev setup --provider failproofai";
  return null;
}

/** What the person should do about a failed request, by cause. */
function remedy(code: string, provider?: JevProviderKind, message?: string): string {
  if (provider === JEV_CLOUD_PROVIDER) {
    const cloud = cloudRemedy(code, message);
    if (cloud) return cloud;
  }
  if (code === "http-401" || code === "http-403") return "The provider refused the key. Re-run `failproofai jev setup` with the right one.";
  if (code === "out-of-credits") return "The account is out of credits (HTTP 402). Top it up with the provider; until then hooks fall back to regex.";
  // The message from `httpFailureMessage` has already said what a 404 there
  // means; this is the part that is an instruction rather than a diagnosis.
  if (code === "http-404") {
    return "Set the base URL to the provider's version root, without the endpoint path: `failproofai jev setup --base-url <base>`. `failproofai jev models` says what a base serves.";
  }
  if (code === "http-429") return "The provider rate-limited this key. Hooks fall back to regex whenever that happens.";
  if (code.startsWith("http-5")) return "The provider had a server error. Hooks fall back to regex whenever that happens; try again shortly.";
  if (code === "timeout") return "No answer in time. Check the endpoint and your network.";
  if (code === "network") return "The endpoint could not be reached. Check the base URL and your network.";
  if (/^http-3(?:\d\d|xx)$/.test(code)) {
    return "The endpoint answered with a redirect, and Jev requests never follow one (the answer must come from the URL you configured). Set --base-url to the final URL.";
  }
  if (code === "model-mismatch") {
    return "A Jev version the thresholds were not calibrated for answered (or a custom endpoint did not say which model answered), so hooks would fall back to regex. Pin a jev-1.13 model with --model.";
  }
  if (code === "config") return "The config is not usable. Re-run `failproofai jev setup`.";
  return "Hooks would fall back to regex for this reason.";
}

/** The `jev status` activity block, from `jevStats()` (null when it could not be read). */
export function jevStatsLines(stats: JevStats | null, opts: RenderOpts = {}): string[] {
  const hours = stats ? Math.round(stats.windowMs / 3_600_000) : 24;
  const heading = rule(`last ${hours} hours`, opts);
  if (!stats) return stack(heading, note("Activity could not be read.", opts));
  if (stats.total === 0) return stack(heading, note(`No Jev evaluations recorded in the last ${hours} hours.`, opts));
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const reasons = Object.entries(stats.fallbackReasons)
    .sort((a, b) => b[1] - a[1])
    .map(([r, n]) => `${r} ×${n}`)
    .join(", ");
  const byPolicy = (counts: Record<string, number> | undefined) =>
    Object.entries(counts ?? {})
      .sort((a, b) => b[1] - a[1])
      .map(([p, n]) => `${p} ×${n}`)
      .join(", ");
  const clears = byPolicy(stats.clearsByPolicy);
  // `clearsByPolicy` counts clears that CHANGED an outcome, which only enforce
  // mode can do; in shadow mode every clear Jev would have made is in
  // `shadowClearsByPolicy` instead and this one is empty. Printing the first
  // alone would tell a shadow user "cleared nothing" — the one number they
  // turned shadow mode on to watch. The field is optional because the stats
  // module T1 builds against does not have it yet (T8 adds it).
  const shadowClears = byPolicy((stats as { shadowClearsByPolicy?: Record<string, number> }).shadowClearsByPolicy);
  const ms = (v: number | null) => (v === null ? "—" : `${Math.round(v)} ms`);
  return stack(
    heading,
    rows(
      [
        ["evaluations", String(stats.total)],
        ["fell back to regex", `${pct(stats.fallbackRate)}${reasons ? ` (${reasons})` : ""}`],
        ["latency", `p50 ${ms(stats.latencyP50Ms)} · p95 ${ms(stats.latencyP95Ms)}`],
        ["cleared", clears || "nothing"],
        ...(shadowClears ? ([["would have cleared (shadow)", shadowClears]] as Array<[string, string]>) : []),
      ],
      opts,
    ),
  );
}

// ── setup ────────────────────────────────────────────────────────────────────

/** The origin requests go to for this provider and base URL (the provider's own API when none), or null. */
function originOf(provider: JevProviderKind, baseUrl: unknown): string | null {
  const base = typeof baseUrl === "string" ? baseUrl : JEV_PROVIDER_DEFAULTS[provider].baseUrl;
  if (!base) return null;
  try {
    const origin = new URL(base.trim()).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

/**
 * Whether a same-provider re-run's base URL sends requests to a new host, and
 * which. Not a move: the same origin, an unusable URL (validation reports it),
 * or the provider's own API, which is where its key belongs anyway.
 */
function movedHost(provider: JevProviderKind, before: unknown, after: unknown): { from: string | null; to: string } | null {
  const to = originOf(provider, after);
  if (to === null) return null;
  const from = originOf(provider, before);
  if (to === from || to === originOf(provider, undefined)) return null;
  return { from, to };
}

/**
 * The provider each known host IS, so `failproofai jev --url <url>` needs no
 * `--provider`. Exact hosts only: a neighbouring name (`eu.api.typesafe.ai`, a
 * corporate proxy) is `custom`, which reaches the same TypeSafe-compatible API
 * at the URL given, and `--provider` is there to say otherwise.
 */
const PROVIDER_BY_HOST: Readonly<Record<string, JevProviderKind>> = {
  "api.typesafe.ai": "typesafe",
  "openrouter.ai": "openrouter",
  "ai-gateway.vercel.sh": "vercel",
  "api.cloudflare.com": "cloudflare",
};

/** The provider a validated URL names, or `custom` for a host that is nobody's. */
function providerForUrl(url: string): JevProviderKind {
  try {
    return PROVIDER_BY_HOST[new URL(url).hostname.toLowerCase()] ?? "custom";
  } catch {
    return "custom";
  }
}

/**
 * The account id a Cloudflare URL already carries, or null.
 *
 * Cloudflare's run endpoint IS per-account — `…/client/v4/accounts/<id>/ai/run`
 * — so the id is in the canonical URL, and asking for it again as a flag asks
 * for something the person has already typed. The first real attempt to
 * configure Cloudflare pasted exactly that URL and was refused with "pass the
 * account id as well", with the id visible in the string being rejected.
 *
 * Read from the path only, never from a query or fragment, and only on a host
 * this build already recognises as Cloudflare's, so nothing else can inject one.
 */
export function accountIdFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (PROVIDER_BY_HOST[parsed.hostname.toLowerCase()] !== "cloudflare") return null;
    const m = /\/accounts\/([0-9a-f]{32})(?:\/|$)/i.exec(parsed.pathname);
    return m ? m[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Whether a validated URL is exactly where this provider's requests already go. */
function isProviderDefaultUrl(kind: JevProviderKind, url: string): boolean {
  const base = JEV_PROVIDER_DEFAULTS[kind].baseUrl;
  if (!base) return false;
  const normalized = validateBaseUrl(base);
  return normalized.ok && normalized.value === url;
}

/**
 * A saved `baseUrl` that keeps the provider but leaves its API base — `--url
 * https://api.typesafe.ai/v2`, or a v1 path this provider does not serve.
 * Nothing refuses it: it is a valid https URL, on the right host, for a
 * provider that exists. But a provider serves its API at one base, so requests
 * would go to a path it does not answer and every evaluation would fall back to
 * regex — which is worth saying while the person is still looking at the
 * screen. Null when there is nothing to say: no override at all; `custom`,
 * whose URL IS the address; another host, which may well be the customer's own
 * proxy, whose layout this cannot know; or an override that lands on the
 * provider's own endpoint anyway (the full endpoint path given as the base,
 * which works).
 */
function offProviderBase(cfg: JevConfig, endpoint: string): { endpoint: string; api: string } | null {
  if (cfg.baseUrl === undefined || cfg.provider === "custom") return null;
  const apiBase = JEV_PROVIDER_DEFAULTS[cfg.provider].baseUrl;
  if (!apiBase) return null;
  try {
    if (new URL(cfg.baseUrl).host !== new URL(apiBase).host) return null;
    const api = jevRoute({ ...cfg, baseUrl: undefined }).endpoint;
    return api === endpoint ? null : { endpoint: displayEndpoint(endpoint), api: displayEndpoint(api) };
  } catch {
    return null;
  }
}

/**
 * The refusal for a URL that is an endpoint where a base belongs.
 *
 * Both URLs go through `displayEndpoint`, which replaces a query string with
 * `?…`: a proxy base may legitimately carry `?api-version=` — or a token — and a
 * refusal is not a reason to print one. That does make the suggested command a
 * shape rather than something to paste, which is the right trade: the person has
 * their own URL, and the point of the line is which segment to drop.
 */
function endpointAsBaseRefusal(flag: string, given: string, found: EndpointGivenAsBase): string[] {
  return [
    `Not saved: ${flag} names an endpoint, not an API base — its path ends in ${found.suffix}.`,
    `A Jev request goes to <base>/systemone, and failproofai appends that itself, so ${displayEndpoint(given)} would be asked at ${displayEndpoint(`${given.replace(/\/+$/, "")}/systemone`)}.`,
    "Give the base it sits under:",
    `  failproofai jev ${flag} ${displayEndpoint(found.base)}`,
    "",
    "Nothing was written.",
  ];
}

/** At most this many names in one refusal or one rendered list; the rest are counted. */
const MAX_SHOWN_MODELS = 20;

/** Model names for one line, bounded — the list came from a provider and may be long. */
function shownModels(models: string[]): string {
  if (models.length <= MAX_SHOWN_MODELS) return models.join(", ");
  return `${models.slice(0, MAX_SHOWN_MODELS).join(", ")} … and ${models.length - MAX_SHOWN_MODELS} more`;
}

/**
 * The list this config's endpoint serves, when it both could be read AND is
 * authoritative about `<base>/systemone` AND does not carry the configured model
 * — i.e. the one case that is worth refusing. Null in every other case, so a
 * caller's "carry on unchanged" path is the default rather than the exception.
 *
 * `apiKey` is passed separately because a `--key-from-env` config in a shell with
 * no variable set holds a stand-in, which must not be sent anywhere; the public
 * lists (Vercel's, OpenRouter's) answer without a key anyway.
 */
async function modelAbsentFromList(
  cfg: JevConfig,
  model: string,
  apiKey: string | null,
  read: JevModelListReader,
): Promise<{ list: JevModelListRead; url: string } | null> {
  let url: string | null;
  try {
    url = jevModelsUrl(cfg);
  } catch {
    return null;
  }
  if (url === null) return null;
  let list: JevModelListResult;
  try {
    list = await read(url, apiKey);
  } catch {
    // A reader that throws is a reader that read nothing, which is the case this
    // whole check is required to survive.
    return null;
  }
  if (!list.ok || !listDescribesSystemOne(list) || modelListHasModel(list, model)) return null;
  return { list, url };
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString("utf8");
}

async function maskedPrompt(): Promise<string | null> {
  const { promptText } = await import("./tui");
  return promptText({ message: "Jev API key", mask: true, validate: (v) => validateApiKey(v) });
}

/** What a run that put the key in argv ends with, saved or refused: the key is in history either way. */
const TOKEN_HISTORY_WARNING = [
  "--token was on the command line: your shell history has it, and while this command ran any process of yours could read it from the process list.",
  "Prefer piping the key in — `failproofai jev --url <url> --key-stdin < key-file` — and rotate this one if it matters.",
];

async function setup(argv: string[], deps: JevCliDeps, opts: RenderOpts): Promise<JevCliResult> {
  const r = await setupRun(argv, deps, opts);
  // A save says it in its own place; every refusal says it here.
  const tokenGiven = argv.some((a, i) => a.startsWith("--token=") || (a === "--token" && i + 1 < argv.length));
  return r.exitCode === 0 || !tokenGiven ? r : { ...r, lines: [...r.lines, "", ...TOKEN_HISTORY_WARNING] };
}

async function setupRun(argv: string[], deps: JevCliDeps, opts: RenderOpts): Promise<JevCliResult> {
  const parsed = parseFlags(argv, new Set([...VALUE_FLAGS, "--key-stdin", "--key-from-env"]));
  if (typeof parsed === "string") return fail([parsed, "", ...JEV_USAGE]);
  if (parsed.positionals.length > 0) return fail([STRAY_ARGUMENT, "", ...JEV_USAGE]);
  const { values, bools } = parsed;
  if (bools.has("--key-stdin") && bools.has("--key-from-env")) return fail(["Use one of --key-stdin and --key-from-env, not both."]);
  // One source for the key, so no run has to decide which of two the person
  // meant. The message names the recommended one first.
  if (values.has("--token") && (bools.has("--key-stdin") || bools.has("--key-from-env"))) {
    return fail([
      `Use one of --key-stdin, --key-from-env and --token, not more than one.`,
      "",
      "  failproofai jev --url <url> --key-stdin < key-file",
      "Nothing was written.",
    ]);
  }
  if (values.has("--url") && values.has("--base-url")) {
    return fail(["--url and --base-url are the same thing; give one of them.", "", "Nothing was written."]);
  }

  // The provider NAME is checked before anything else on the command line is
  // used. With `--url` present, an unknown or miscapitalized spelling used to
  // be dropped on the floor and replaced by the provider the URL's host
  // implies: the run wrote a config for a provider nobody had named and exited
  // 0, and neither this refusal nor the contradiction refusal below could be
  // reached that way. The value is still never echoed — the likeliest wrong
  // thing after `--provider` is a pasted key.
  const namedProvider = values.get("--provider");
  if (namedProvider !== undefined && !(JEV_PROVIDER_KINDS as readonly string[]).includes(namedProvider)) {
    return fail([
      "Unknown provider (not repeated here, in case it is a key).",
      `Providers: ${JEV_PROVIDER_KINDS.join(", ")} — exactly as spelled here, lower-case.`,
      "",
      "Nothing was written.",
    ]);
  }

  // FailproofAI Cloud has a setup of its own: its endpoint and key come from the
  // machine's connection, so none of the flags below that choose them apply.
  // Reached by naming it, or by re-running setup (a mode switch, say) over a
  // Cloud file without naming another provider or a URL — never by a URL: a
  // `--url` is a BYOK endpoint whatever host it names (`PROVIDER_BY_HOST`
  // deliberately has no Cloud entry).
  if (
    namedProvider === JEV_CLOUD_PROVIDER ||
    (namedProvider === undefined &&
      !values.has("--url") &&
      !values.has("--base-url") &&
      readJevConfigFileForUpdate()?.raw.provider === JEV_CLOUD_PROVIDER)
  ) {
    return cloudSetup(values, bools, opts);
  }

  // `--url` is `--base-url` that also picks the provider. It is validated here,
  // by the loader's own `validateBaseUrl`, so a URL is refused in the same
  // words whichever way it arrived — and so the host below is a parsed host,
  // never a value that was echoed before it was known to be a URL.
  let urlProvider: { kind: JevProviderKind; host: string } | null = null;
  const urlArg = values.get("--url");
  if (urlArg !== undefined) {
    const checkedUrl = validateBaseUrl(urlArg);
    if (!checkedUrl.ok) return fail([`Not saved: ${checkedUrl.problem}.`, "", "Nothing was written."]);
    const normalized = checkedUrl.value;
    urlProvider = { kind: providerForUrl(normalized), host: new URL(normalized).host };
    // Checked above, so this is a provider kind or nothing: a spelling that is
    // not one is refused there rather than quietly becoming the host's.
    const explicit = (values.get("--provider") as JevProviderKind | undefined) ?? null;
    // An explicit provider wins — except where it disagrees with the host about
    // which gateway this is, which is a disagreement about where the key goes.
    // `custom` is not a disagreement: it is the "treat this URL as itself" ask.
    if (explicit !== null && explicit !== "custom" && urlProvider.kind !== "custom" && explicit !== urlProvider.kind) {
      return fail([
        `--provider ${explicit} and --url disagree: ${urlProvider.host} is ${urlProvider.kind}'s endpoint, not ${explicit}'s.`,
        "Drop --provider to take the provider from the URL, or give the URL that provider's own endpoint.",
        "",
        "Nothing was written.",
      ]);
    }
    // The one host where "treat this URL as itself" cannot be honoured. A
    // `custom` route POSTs the TypeSafe-native body to `<url>/systemone` and
    // reads a bare answer back; Workers AI answers at `/accounts/<id>/ai/run`
    // and wraps its answer in `result`, which is why it has a provider of its
    // own. Saved as `custom` it would ask for the `--account-id` it then had
    // nowhere to put, and every call would fall back to regex.
    if (explicit === "custom" && urlProvider.kind === "cloudflare") {
      return fail([
        `Not saved: ${urlProvider.host} is Cloudflare Workers AI, which provider custom cannot reach — its endpoint is per-account and its answers are wrapped, and a custom endpoint is asked in TypeSafe's own shape at <url>/systemone.`,
        "Use the provider that speaks it: --provider cloudflare --account-id <32 hex characters> — or drop --provider, since the URL already says cloudflare.",
        "",
        "Nothing was written.",
      ]);
    }
    const kind = explicit ?? urlProvider.kind;
    if (explicit === null) values.set("--provider", kind);
    // Cloudflare's endpoint IS per-account, so the run URL copied out of the
    // dashboard already names the account. Read it from there rather than
    // demanding a value that is sitting in the string being read — the first
    // person to configure Cloudflare pasted exactly that URL and was told to
    // "pass the account id as well", with the id visible in the refusal.
    //
    // Set into `values` here, while the URL is still in scope, because the
    // block below deletes `--url` once it has moved the address to
    // `--base-url`. Everything downstream then treats it as a flag that was
    // given, including the 32-hex validation.
    if (kind === "cloudflare") {
      const fromUrl = accountIdFromUrl(normalized);
      const given = values.get("--account-id");
      if (fromUrl !== null && given === undefined) {
        values.set("--account-id", fromUrl);
      } else if (fromUrl !== null && given !== undefined && given.toLowerCase() !== fromUrl) {
        // Preferring either one silently would send every request to an account
        // the person did not name on the line they are looking at.
        return fail([
          "Not saved: --account-id and the account id in --url are different.",
          `  --url names ${fromUrl}`,
          `  --account-id names ${given.toLowerCase()}`,
          "Drop one of them.",
          "",
          "Nothing was written.",
        ]);
      }
    }
    // The provider's own API is where its key belongs anyway, so a URL naming
    // it clears the override instead of writing the same address into the file
    // (`custom` has no API of its own — its URL is the whole address).
    values.set("--base-url", kind !== "custom" && isProviderDefaultUrl(kind, normalized) ? "default" : normalized);
    values.delete("--url");
  }

  // An endpoint given where a base belongs, whichever flag carried it — `--url`
  // has already become `--base-url` above, so the flag NAMED here is the one the
  // person typed. Before the key is asked for, and before anything is written:
  // the fix is one segment, and nothing should be stored or prompted for first.
  const baseArg = values.get("--base-url");
  if (baseArg !== undefined && baseArg !== "default") {
    const checkedBase = validateBaseUrl(baseArg);
    // An unusable URL is refused by validation below, in its own words; this
    // check only has something to say about one that parses.
    if (checkedBase.ok) {
      const asEndpoint = endpointGivenAsBase(checkedBase.value);
      if (asEndpoint) return fail(endpointAsBaseRefusal(urlArg !== undefined ? "--url" : "--base-url", checkedBase.value, asEndpoint));
    }
  }

  const existingFile = readJevConfigFileForUpdate();
  const existing = existingFile?.raw ?? null;
  const providerArg = values.get("--provider");
  const provider = providerArg ?? (typeof existing?.provider === "string" ? existing.provider : undefined);
  if (!provider) {
    return fail([
      "--provider is required the first time.",
      `Providers: ${JEV_PROVIDER_KINDS.join(", ")}`,
      "",
      "  failproofai jev setup --provider cloudflare --account-id <id> --key-stdin < key-file",
    ]);
  }
  if (!(JEV_PROVIDER_KINDS as readonly string[]).includes(provider)) {
    return fail(["Unknown provider (not repeated here, in case it is a key).", `Providers: ${JEV_PROVIDER_KINDS.join(", ")}`]);
  }
  const kind = provider as JevProviderKind;
  const sameProvider = existing !== null && existing.provider === provider;

  // Same provider: update in place, keeping the key and every field not named
  // (including ones a newer failproofai wrote). A different provider starts
  // over: a key, model or URL for one gateway means nothing to another. Mode
  // and timeout are provider-neutral, so they carry across.
  const next: Record<string, unknown> = sameProvider ? { ...existing } : { provider };
  if (!sameProvider && existing) {
    if (existing.mode !== undefined) next.mode = existing.mode;
    if (existing.timeoutMs !== undefined) next.timeoutMs = existing.timeoutMs;
  }
  next.provider = provider;

  const setOrClear = (flag: string, field: string) => {
    const v = values.get(flag);
    if (v === undefined) return;
    if (v === "default") delete next[field];
    else next[field] = v;
  };
  setOrClear("--base-url", "baseUrl");
  setOrClear("--model", "model");
  if (values.has("--account-id")) {
    // Only Cloudflare's endpoint is per-account, and `validateJevConfig` keeps
    // `accountId` for no other provider: writing it for one of those would put
    // a field in the file that nothing reads, while `jev status` showed an
    // endpoint that does not contain it. Refused rather than written and
    // ignored. (The value is never echoed: it is 32 hex characters, or a
    // pasted key.)
    if (kind !== "cloudflare") {
      return fail([
        `Not saved: --account-id is Cloudflare's, and provider ${kind} has no use for one — nothing would read it.`,
        kind === "custom"
          ? "A custom endpoint's URL is the whole address: if the account belongs in it, it goes in --url."
          : "Drop --account-id, or ask for Cloudflare: --provider cloudflare with its own API URL.",
        "",
        "Nothing was written.",
      ]);
    }
    next.accountId = values.get("--account-id");
  }
  if (values.has("--mode")) next.mode = values.get("--mode");
  if (values.has("--timeout-ms")) {
    const raw = values.get("--timeout-ms") as string;
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n)) return fail(["Could not read --timeout-ms. Give a whole number of milliseconds."]);
    next.timeoutMs = n;
  }

  // Cloudflare's endpoint is per-account, so a URL that turns out to be
  // Cloudflare's needs one. Named here rather than left to validation, which
  // knows the field and not the flag — and this run never said "cloudflare",
  // the URL did. Only when Cloudflare is what is being saved: a URL on that
  // host with another provider asked for is settled above, and nothing here
  // demands an id the file would not keep.
  if (kind === "cloudflare" && urlProvider?.kind === "cloudflare" && typeof next.accountId !== "string") {
    // Reached only when the URL did not carry one either — a bare
    // `/client/v4`, say. The URL form is named as well as the flag, because it
    // is the address the dashboard hands out.
    return fail([
      `Not saved: ${urlProvider.host} is Cloudflare Workers AI, whose endpoint is per-account.`,
      "Pass the account id as well: --account-id <32 hex characters>,",
      "or give the full run URL, which already contains it:",
      "  https://api.cloudflare.com/client/v4/accounts/<id>/ai/run",
      "",
      "Nothing was written.",
    ]);
  }

  // A key stored for one host is not carried to another (see the header). A
  // file that was open to other users is the loader's "someone else may have
  // chosen the endpoint" case, so the URL it names is measured against the
  // provider's own API, not trusted as the host the key already went to —
  // whether it is carried over or passed again with --base-url.
  const untrustedFile = sameProvider && existingFile?.tooOpen === true;
  const hostMove =
    sameProvider && (values.has("--base-url") || untrustedFile)
      ? movedHost(kind, untrustedFile ? undefined : existing?.baseUrl, next.baseUrl)
      : null;
  if (hostMove) delete next.apiKey;

  // The key. A config that takes it from the environment stores none, and
  // stays that way across a re-run for the same provider.
  let keyNote: string;
  let keyFromEnv = false;
  let tokenOnCommandLine = false;
  const envKey = process.env[JEV_API_KEY_ENV];
  const envKeyNote = () =>
    envKey
      ? `not stored — read from ${JEV_API_KEY_ENV} when a hook runs`
      : `not stored — ${JEV_API_KEY_ENV} is not set in this shell, and Jev stays off wherever it is not`;
  if (bools.has("--key-from-env")) {
    delete next.apiKey;
    keyFromEnv = true;
    keyNote = envKeyNote();
  } else if (bools.has("--key-stdin")) {
    const tty = deps.stdinIsTTY ?? Boolean(process.stdin.isTTY);
    // On a terminal a cooked-mode read echoes each keystroke, so a person
    // typing or pasting there gets the masked prompt instead.
    const raw = tty ? await (deps.promptKey ?? maskedPrompt)() : await (deps.readStdin ?? readAllStdin)();
    if (raw === null) return fail(["Cancelled; nothing was written."]);
    const key = raw.trim();
    const bad = validateApiKey(key);
    if (bad) return fail([`Not saved: ${bad}.`]);
    next.apiKey = key;
    keyNote = "set from stdin";
  } else if (values.has("--token")) {
    // Trimmed like the stdin key, and validated by the same rule, so the same
    // paste is accepted or refused identically whichever way it arrived. The
    // refusal quotes the rule, never the value.
    const key = (values.get("--token") as string).trim();
    const bad = validateApiKey(key);
    if (bad) return fail([`Not saved: ${bad}.`]);
    next.apiKey = key;
    tokenOnCommandLine = true;
    keyNote = "set from --token — this shell's history has it too";
  } else if (typeof next.apiKey === "string") {
    keyNote = "kept from the existing config";
  } else if (sameProvider && !hostMove) {
    keyFromEnv = true;
    keyNote = envKeyNote();
  } else {
    const tty = deps.stdinIsTTY ?? Boolean(process.stdin.isTTY);
    if (hostMove && untrustedFile) {
      // Not even at a terminal: a bare "Jev API key" prompt would not say where
      // the key is going, and here that is exactly the question.
      const perms = octal(existingFile?.mode ?? null) ?? "unknown";
      const named = values.has("--base-url");
      return fail([
        named
          ? `${jevConfigPath()} was open to other users (${perms}), so its stored key is not carried to ${hostMove.to}.`
          : `${jevConfigPath()} was open to other users (${perms}), so the endpoint it names — ${hostMove.to} — may not be one you chose, and its stored key is not carried there.`,
        "If that endpoint is yours, give the key for it again:",
        `  failproofai jev setup${named ? " --base-url <url>" : ""} --key-stdin < key-file`,
        "",
        kind === "custom"
          ? "If it is not, give your own --base-url along with its key."
          : "If it is not, send requests back to the provider's own API, which keeps the stored key: failproofai jev setup --base-url default",
        "Nothing was written.",
      ]);
    }
    if (!tty && hostMove) {
      return fail([
        `The new base URL sends requests to ${hostMove.to}${hostMove.from ? `, not ${hostMove.from}` : ""}.`,
        "A stored key is not carried to a different host. Give the key for that endpoint again:",
        "  failproofai jev setup --base-url <url> --key-stdin < key-file",
        "",
        `Or store no key and supply ${JEV_API_KEY_ENV} per session (--key-from-env).`,
        "Nothing was written.",
      ]);
    }
    if (!tty) {
      return fail([
        "No key given, and there is no terminal to ask on.",
        "",
        "Pass it on stdin, which keeps it out of `ps` and shell history:",
        `  failproofai jev setup --provider ${provider} --key-stdin < key-file`,
        "",
        `Or store no key and supply ${JEV_API_KEY_ENV} per session (--key-from-env).`,
      ]);
    }
    const raw = await (deps.promptKey ?? maskedPrompt)();
    if (raw === null) return fail(["Cancelled; nothing was written."]);
    const key = raw.trim();
    const bad = validateApiKey(key);
    if (bad) return fail([`Not saved: ${bad}.`]);
    next.apiKey = key;
    keyNote = hostMove ? `set at the prompt, for ${hostMove.to}` : "set at the prompt";
  }

  // With the key in the environment the FILE is what is being checked, so a
  // stand-in fills the key when the variable is unset here. A variable that is
  // set but malformed is checked for real, and refused.
  const checked = validateJevConfig(next, keyFromEnv ? envKey || ENV_KEY_STAND_IN : null);
  if (!checked.ok) return fail([`Not saved: ${checked.problem}.`, "", "Nothing was written."]);
  const cfg = checked.value;

  // The model, against what the endpoint says it serves. This is the second half
  // of the LiteLLM-proxy failure: the URL was fixed and the default model still
  // did not exist there, which nothing said until `jev test` returned a 404 and
  // the person curled the endpoint by hand.
  //
  // Never a hard requirement: a list that cannot be read (no key yet, a proxy
  // that serves none, Cloudflare, an unreachable host, a shape nobody knows) and
  // a list that is not authoritative about `/systemone` both fall through to the
  // write, so this can only ever turn a silent misconfiguration into a refusal —
  // it can never turn a working setup into a failing one.
  const routeForCheck = ((): ReturnType<typeof jevRoute> | null => {
    try {
      return jevRoute(cfg);
    } catch {
      return null;
    }
  })();
  if (routeForCheck !== null) {
    // The stand-in is not a key and must not be sent; the public lists answer
    // without one, so the read is still worth making.
    const listKey = keyFromEnv && !envKey ? null : cfg.apiKey;
    const absent = await modelAbsentFromList(cfg, routeForCheck.model, listKey, deps.readModelList ?? liveModelListReader);
    if (absent) {
      return fail([
        `Not saved: ${displayEndpoint(absent.url)} does not list ${routeForCheck.model}, so every request would fail there.`,
        `  it serves: ${shownModels(absent.list.models)}`,
        routeForCheck.modelIsDefault
          ? `${routeForCheck.model} is this build's default for provider ${provider}, and this endpoint names Jev differently — so --model is not optional here. Add it to the command you just ran:`
          : "Pick one of the names above:",
        `  --model ${absent.list.models[0]}`,
        "",
        "Nothing was written.",
      ]);
    }
  }

  const path = jevConfigPath();
  try {
    writeJsonAtomically(path, next, { mode: 0o600, dirMode: 0o700 });
  } catch (err) {
    return fail([`Could not write ${path}: ${(err as NodeJS.ErrnoException).code ?? "error"}.`]);
  }
  let fileMode: number | null = null;
  try {
    fileMode = statSync(path).mode & 0o777;
  } catch {
    // Reported as unknown below.
  }
  // `writeJsonAtomically` creates the directory at 0700, but leaves a
  // pre-existing one alone — and older code paths create ~/.failproofai at the
  // umask, which on a umask-002 machine is group-writable. A directory others
  // can write into defeats the file's 0600 (they replace the file and the key
  // goes to their endpoint), so the one command that puts a key there takes
  // that away. Exactly the write bits the loader refuses, and no more: read
  // bits give nobody that power, and config.json in the same directory is
  // world-readable by design.
  const dir = dirname(path);
  let tightenedDir: { path: string; to: string } | null = null;
  if (process.platform !== "win32") {
    try {
      const before = statSync(dir).mode & 0o777;
      if ((before & 0o022) !== 0) {
        const after = before & ~0o022;
        chmodSync(dir, after);
        tightenedDir = { path: dir, to: after.toString(8).padStart(4, "0") };
      }
    } catch {
      // Not fatal: the loader reports a directory it will not read from.
    }
  }

  const route = jevRoute(cfg);
  const offBase = offProviderBase(cfg, route.endpoint);
  return ok(
    stack(
      title("failproofai jev setup", `saved · ${provider} · ${cfg.mode ?? DEFAULT_JEV_MODE}`, opts),
      rows(
        [
          ["provider", provider],
          ["endpoint", displayEndpoint(route.endpoint)],
          ["model", route.modelIsDefault ? `${route.model} (provider default)` : route.model],
          ["mode", modeLine(cfg.mode ?? DEFAULT_JEV_MODE)],
          ["timeout", `${cfg.timeoutMs} ms`],
          ["key", keyNote],
          ["config", path],
          ["permissions", permissions(fileMode)],
        ],
        opts,
      ),
      // Saved, and saved as asked — but saying only "saved" would leave someone
      // to discover from the fallback counts that the URL they gave is not an
      // API base. So the file is written and what it will do is named.
      offBase
        ? warning(
            [
              `Saved as given, but ${provider}'s API is at ${offBase.api}, and this URL sends requests to ${offBase.endpoint} instead.`,
              `Unless something of yours answers Jev requests at that path, every evaluation will fail there and hooks will fall back to regex — \`failproofai jev test\` says which it is in one request. To send requests back to ${provider}'s own API: failproofai jev setup --base-url default`,
            ],
            opts,
          )
        : null,
      tightenedDir
        ? note(
            `${tightenedDir.path} was writable by other users, who could have replaced this file whatever its own permissions were; it is now ${tightenedDir.to}.`,
            opts,
          )
        : null,
      // Said once, after the key is safely stored: the file is 0600, but the
      // command line it came on is not — it is in this shell's history file and
      // was readable from /proc by anything running as this user while the
      // process lived.
      tokenOnCommandLine ? warning(TOKEN_HISTORY_WARNING, opts) : null,
      note("Hooks read this file on every tool call — no restart. Without it they run the regex policies exactly as before.", opts),
      // Switched off, `jev test` only answers "not run — switched off": a next
      // step that leads nowhere is worse than none.
      (cfg.mode ?? DEFAULT_JEV_MODE) === "off" ? null : nextStep("failproofai jev test", "Check it with one live request:", opts),
    ),
  );
}

// ── setup: FailproofAI Cloud ─────────────────────────────────────────────────

/** How `inspectJevConfig` opens a refusal that is about credentials.json. */
const CLOUD_CREDENTIAL_REFUSED = "the FailproofAI Cloud credential was refused";

/**
 * `jev setup --provider failproofai`, and any setup run over a Cloud file.
 *
 * The Cloud route has nothing to choose but its mode and timeout: the endpoint
 * is `<Cloud base>/enforcement/v1/jev` on the origin the machine connected to,
 * the key is the connection's own (`credentials.json`, never this file) and the
 * model is pinned by the server. So every flag that would choose one of those is
 * refused — naming it would be asking for something this route cannot honour —
 * and the file is rebuilt from the connection. An `apiKey` a hand-edited file
 * carries is dropped, which is also what makes such a file valid again.
 *
 * A mode or timeout change on an existing Cloud file does not need the machine
 * to be connected: it changes nothing about where a key goes. Creating one,
 * or rebuilding its endpoint, does.
 */
async function cloudSetup(values: Map<string, string>, bools: Set<string>, opts: RenderOpts): Promise<JevCliResult> {
  const refusedFlag = (["--token", "--url", "--base-url", "--account-id", "--model"] as const).find((f) => values.has(f)) ??
    (["--key-stdin", "--key-from-env"] as const).find((f) => bools.has(f));
  if (refusedFlag !== undefined) {
    const why =
      refusedFlag === "--model"
        ? `FailproofAI Cloud runs ${JEV_PROVIDER_DEFAULTS.failproofai.model}, pinned on the server; there is no model to choose.`
        : refusedFlag === "--account-id"
          ? "--account-id is Cloudflare's; FailproofAI Cloud has no use for one."
          : refusedFlag === "--url" || refusedFlag === "--base-url"
            ? "FailproofAI Cloud's endpoint is the one this machine connected to; to change it, reconnect: failproofai config --token <key> --url <url>"
            : "FailproofAI Cloud's key is this machine's connection key, kept in credentials.json and never in jev.json; to change it, reconnect: failproofai config --token <key>";
    return fail([`Not saved: ${refusedFlag} does not apply to provider failproofai. ${why}`, "", "Nothing was written."]);
  }

  const existing = readJevConfigFileForUpdate();
  const sameProvider = existing?.raw.provider === JEV_CLOUD_PROVIDER;
  const credential = readJevCloudCredential();
  if (credential.status === "refused") {
    return fail([`Not saved: ${credential.problem}.`, "", "Nothing was written."]);
  }

  const next: Record<string, unknown> = sameProvider ? { ...existing!.raw } : { provider: JEV_CLOUD_PROVIDER };
  // Never a key in a Cloud file, and nothing only another provider reads.
  delete next.apiKey;
  delete next.accountId;
  if (!sameProvider && existing?.raw.timeoutMs !== undefined) next.timeoutMs = existing.raw.timeoutMs;
  // Shadow unless told otherwise, as `config --token` starts it: Jev on a new
  // route is logged before it is allowed to clear anything. A mode already in a
  // Cloud file is kept.
  const mode = values.get("--mode") ?? (sameProvider && typeof next.mode === "string" ? next.mode : "shadow");
  next.mode = mode;
  if (values.has("--timeout-ms")) {
    const rawTimeout = values.get("--timeout-ms") as string;
    const n = Number(rawTimeout);
    if (!/^\d+$/.test(rawTimeout) || !Number.isSafeInteger(n)) return fail(["Could not read --timeout-ms. Give a whole number of milliseconds."]);
    next.timeoutMs = n;
  }

  let keySource: JevCloudCredential | null = null;
  if (credential.status === "ok") {
    keySource = credential.credential;
    // The endpoint, from the connection: kept when it is already on the
    // credential's origin, else rebuilt — under the policy connection's base
    // when that is on the same origin, so a path prefix survives.
    const onOrigin = (u: unknown) => {
      try {
        return typeof u === "string" && new URL(u).origin === new URL(credential.credential.url).origin;
      } catch {
        return false;
      }
    };
    if (!onOrigin(next.baseUrl)) {
      const policyBase = readCredentials().cloud?.url;
      next.baseUrl = jevCloudBaseUrl(onOrigin(policyBase) ? (policyBase as string) : credential.credential.url);
    }
  } else if (!sameProvider || typeof next.baseUrl !== "string") {
    return fail([
      credential.connected
        ? "Not saved: this machine is connected to FailproofAI Cloud, but no Jev key is stored for that connection."
        : "Not saved: this machine is not connected to FailproofAI Cloud with a key that carries jev:evaluate.",
      "Connect it with one that does (the \"machine\" preset) — that also turns Jev on, in shadow mode, when there is no jev.json yet:",
      "  failproofai config --token <key>",
      "",
      "Nothing was written.",
    ]);
  }

  // The loader's own rules, with the connection's key or — for a mode switch
  // on a machine that is not connected right now — a stand-in on the file's own
  // origin, which is never written or sent.
  let standInOrigin = "";
  try {
    standInOrigin = new URL(String(next.baseUrl)).origin;
  } catch {
    standInOrigin = "";
  }
  const checked = validateJevConfig(next, null, keySource ?? { url: standInOrigin, key: ENV_KEY_STAND_IN });
  if (!checked.ok) return fail([`Not saved: ${checked.problem}.`, "", "Nothing was written."]);

  const path = jevConfigPath();
  try {
    writeJsonAtomically(path, next, { mode: 0o600, dirMode: 0o700 });
  } catch (err) {
    return fail([`Could not write ${path}: ${(err as NodeJS.ErrnoException).code ?? "error"}.`]);
  }
  if (process.platform !== "win32") {
    try {
      const dir = dirname(path);
      const before = statSync(dir).mode & 0o777;
      if ((before & 0o022) !== 0) chmodSync(dir, before & ~0o022);
    } catch {
      // Not fatal: the loader reports a directory it will not read from.
    }
  }
  let fileMode: number | null = null;
  try {
    fileMode = statSync(path).mode & 0o777;
  } catch {
    // Reported as unknown below.
  }

  const cfg = checked.value;
  const route = jevRoute(cfg);
  const shownMode = cfg.mode ?? DEFAULT_JEV_MODE;
  return ok(
    stack(
      title("failproofai jev setup", `saved · FailproofAI Cloud · ${shownMode}`, opts),
      rows(
        [
          ["provider", providerLabel(JEV_CLOUD_PROVIDER)],
          ["endpoint", shownEndpoint(JEV_CLOUD_PROVIDER, route.endpoint)],
          ["model", `${route.model} (pinned by FailproofAI Cloud)`],
          ["mode", modeLine(shownMode)],
          ["timeout", `${cfg.timeoutMs} ms`],
          // Which of the three states the connection is in — the same row
          // `status` shows. "Not connected" on a machine that IS connected, with
          // a key that lacks Jev, sent its owner to reconnect with that same key.
          ["key", keySource ? CLOUD_KEY_SOURCE : cloudKeyRow()],
          ["config", path],
          ["permissions", permissions(fileMode)],
        ],
        opts,
      ),
      note("Hooks read this file on every tool call — no restart. Calls are charged to your FailproofAI Cloud org's plan.", opts),
      // With no usable key, `jev test` only answers "not run": the step that
      // helps is the connection. Switched off, there is no step to take.
      shownMode === "off"
        ? null
        : keySource
          ? nextStep("failproofai jev test", "Check it with one live request:", opts)
          : nextStep(
              "failproofai config --token <key>",
              "Jev stays off until this machine is connected with a key that carries jev:evaluate (the \"machine\" preset on the dashboard's Keys page):",
              opts,
            ),
    ),
  );
}

// ── status ───────────────────────────────────────────────────────────────────

/**
 * Where a file would send requests, for display, whether or not it loads. Only
 * the routing fields are used — the key and model do not decide where requests
 * go — and shadow mode lets a loopback http URL through validation. Null when
 * it names nothing recognisable.
 */
/**
 * The route a config with no stored key would take, for display. The key does
 * not decide where requests go, so a stand-in fills it; null when the routing
 * fields do not make a usable route (`inspectJevConfig` has already validated
 * them, so that is a belt-and-braces null).
 */
function routeForRouting(routing: Omit<JevConfig, "apiKey">): ReturnType<typeof jevRoute> | null {
  try {
    return jevRoute({ ...routing, apiKey: ENV_KEY_STAND_IN, ...displayOnlyCloudOrigin(routing) });
  } catch {
    return null;
  }
}

/**
 * For DISPLAY only, like the stand-in key beside it: a FailproofAI Cloud route
 * is built only against the origin of the credential it was validated with
 * (`validateLoadedJevConfig`), and a config shown here has no credential behind
 * it, so the file's own origin stands in. Nothing built with it is ever sent.
 */
function displayOnlyCloudOrigin(routing: { provider?: unknown; baseUrl?: unknown }): { credentialOrigin?: string } {
  if (routing.provider !== JEV_CLOUD_PROVIDER || typeof routing.baseUrl !== "string") return {};
  try {
    return { credentialOrigin: new URL(routing.baseUrl).origin };
  } catch {
    return {};
  }
}

function namedEndpoint(raw: Record<string, unknown> | null): string | null {
  if (!raw || typeof raw.provider !== "string" || !(JEV_PROVIDER_KINDS as readonly string[]).includes(raw.provider)) return null;
  const routing: Record<string, unknown> = { provider: raw.provider, apiKey: ENV_KEY_STAND_IN, mode: "shadow", ...displayOnlyCloudOrigin(raw) };
  if (raw.baseUrl !== undefined) routing.baseUrl = raw.baseUrl;
  if (raw.accountId !== undefined) routing.accountId = raw.accountId;
  try {
    return displayEndpoint(jevRoute(routing as unknown as JevConfig).endpoint);
  } catch {
    return typeof raw.baseUrl === "string" ? displayEndpoint(raw.baseUrl) : null;
  }
}

/**
 * What Jev may clear here, or null when it could not be worked out. `status`
 * answers "is this thing working", and a settings read that threw would replace
 * that answer with a stack trace — the survey reads three files it does not
 * own, and none of them is worth the whole command.
 */
function safeCoverage(): ReviewableCoverage | null {
  try {
    return surveyReviewableCoverage();
  } catch {
    return null;
  }
}

async function status(argv: string[], opts: RenderOpts): Promise<JevCliResult> {
  const parsed = parseFlags(argv, new Set(["--json"]));
  if (typeof parsed === "string") return fail([parsed, "", ...JEV_USAGE]);
  if (parsed.positionals.length > 0) return fail([STRAY_ARGUMENT, "", ...JEV_USAGE]);
  const asJson = parsed.bools.has("--json");

  const inspection = inspectJevConfig();
  let stats: JevStats | null = null;
  try {
    stats = await jevStats();
  } catch {
    stats = null;
  }
  const legacy = process.env.FAILPROOFAI_EVALUATOR === "legacy";
  // Only where a clear could actually happen. A file that is absent, refused or
  // keyless means hooks run the regex policies whatever any policy's authority
  // says, and an authority count there would answer a question nobody is in a
  // position to ask yet.
  const coverage = inspection.status === "ok" ? safeCoverage() : null;
  const coverageProblem = coverage ? reviewableProblem(coverage) : null;

  if (asJson) {
    const base: Record<string, unknown> = { path: inspection.path, status: inspection.status, legacyOverride: legacy, stats };
    if (inspection.status === "refused") {
      Object.assign(base, { reason: inspection.reason, problem: inspection.problem, permissions: octal(inspection.mode) });
      if (inspection.reason === "too-open") {
        const named = namedEndpoint(readJevConfigFileForUpdate()?.raw ?? null);
        if (named) base.endpoint = named;
      }
    }
    if (inspection.status === "key-missing") {
      // Configured, just not usable in THIS environment: a provisioning check
      // must be able to tell that from a file it should rewrite, so the routing
      // is reported exactly as for `ok`, with `keySource: "env"` and a reason.
      const route = routeForRouting(inspection.routing);
      Object.assign(base, {
        permissions: octal(inspection.mode),
        provider: inspection.routing.provider,
        providerLabel: providerLabel(inspection.routing.provider),
        ...(route ? { endpoint: displayEndpoint(route.endpoint), model: route.model, modelIsDefault: route.modelIsDefault } : {}),
        mode: inspection.routing.mode,
        timeoutMs: inspection.routing.timeoutMs,
        keySource: "env",
        keyEnvVar: JEV_API_KEY_ENV,
        reason: "no-env-key",
        problem: inspection.problem,
      });
    }
    if (inspection.status === "off" || inspection.status === "not-connected" || inspection.status === "key-lacks-jev") {
      // Configured and deliberately (off) or circumstantially (not connected,
      // or connected with a key that has no Jev) not running. The routing is
      // reported exactly as for `ok`, so a provisioning check can tell any of
      // them from a file it should rewrite.
      const r = inspection.routing;
      const route = routeForRouting(r);
      const cloud = r.provider === JEV_CLOUD_PROVIDER;
      Object.assign(base, {
        permissions: octal(inspection.mode),
        provider: r.provider,
        providerLabel: providerLabel(r.provider),
        ...(route ? { endpoint: shownEndpoint(r.provider, route.endpoint), model: route.model, modelIsDefault: route.modelIsDefault } : {}),
        mode: r.mode,
        timeoutMs: r.timeoutMs,
        // Read from the credentials file rather than inferred from the status:
        // `off` is decided before any key is looked for, so it says nothing
        // about the connection either way.
        ...(cloud ? { keySource: "cloud", keySourceLabel: CLOUD_KEY_SOURCE, ...cloudConnection() } : {}),
        ...(inspection.status === "off" ? { reason: "switched-off" } : { reason: inspection.status, problem: inspection.problem }),
      });
    }
    if (inspection.status === "ok") {
      const { config: cfg } = inspection;
      const route = jevRoute(cfg);
      Object.assign(base, {
        permissions: octal(inspection.mode),
        provider: cfg.provider,
        providerLabel: providerLabel(cfg.provider),
        endpoint: shownEndpoint(cfg.provider, route.endpoint),
        model: route.model,
        modelIsDefault: route.modelIsDefault,
        mode: cfg.mode,
        timeoutMs: cfg.timeoutMs,
        keySource: inspection.keySource,
        ...(inspection.keySource === "cloud" ? { keySourceLabel: CLOUD_KEY_SOURCE, cloudConnected: true, keyCarriesJev: true } : {}),
        // How much of this machine's policy set Jev is allowed to clear, and
        // why it is none when it is none. A provisioning check that turns Jev
        // on has no other way to find out that the half it turned on cannot
        // fire — the call counts look identical either way.
        ...(coverage
          ? {
              reviewablePolicies: {
                enabled: coverage.enabled,
                reviewable: coverage.reviewable,
                customPolicyFiles: coverage.customFiles,
                problem: coverageProblem,
              },
            }
          : {}),
      });
    }
    const json = JSON.stringify(base, null, 2);
    return inspection.status === "refused" ? fail([], json) : ok([], json);
  }

  const legacyNote = legacy
    ? warning(
        [
          "FAILPROOFAI_EVALUATOR=legacy is set in this shell: sessions started from it skip Jev when their hooks evaluate in-process.",
          "The daemon does not see this shell's environment.",
        ],
        opts,
      )
    : null;

  if (inspection.status === "absent") {
    return ok(
      stack(
        title("failproofai jev status", "off", opts),
        emptyState(
          {
            what: `Jev is off: there is no ${inspection.path}. Hooks run the regex policies exactly as before.`,
            hint: "Turn it on with your own Jev endpoint and key:",
            cmd: "failproofai jev setup --provider <typesafe|openrouter|vercel|cloudflare|custom> --key-stdin",
          },
          opts,
        ),
        note(
          cloudCredentialPresent()
            ? "Or through FailproofAI Cloud, on your org's plan — this machine's key already carries jev:evaluate: failproofai jev setup --provider failproofai"
            : "Or through FailproofAI Cloud, on your org's plan, with no key of your own: connect with a key that carries jev:evaluate (the \"machine\" preset) — failproofai config --token <key>",
          opts,
        ),
        jevStatsLines(stats, opts),
      ),
    );
  }

  if (inspection.status === "key-missing") {
    // Not a refusal: this is the file `setup --key-from-env` writes, doing what
    // it was asked to. Saying "write a valid one" here would tell its owner to
    // undo the one choice they made, so it reads like `absent` — off HERE —
    // and the next step is the variable, not a rewrite.
    const route = routeForRouting(inspection.routing);
    return ok(
      stack(
        title("failproofai jev status", "off in this shell", opts),
        note(
          `Jev is off in this shell: ${inspection.path} stores no key and takes it from ${JEV_API_KEY_ENV}, which is not set here. ` +
            "The config is fine; hooks run the regex policies wherever the variable is unset — including under the daemon, which does not see a shell's environment.",
          opts,
        ),
        rows(
          [
            ["provider", inspection.routing.provider],
            ...((route
              ? [
                  ["endpoint", displayEndpoint(route.endpoint)],
                  ["model", route.modelIsDefault ? `${route.model} (provider default)` : route.model],
                ]
              : []) as Array<[string, string]>),
            ["mode", modeLine(inspection.routing.mode ?? DEFAULT_JEV_MODE)],
            ["config", inspection.path],
            ["permissions", permissions(inspection.mode)],
            ["key", `from ${JEV_API_KEY_ENV} — not set in this shell`],
          ],
          opts,
        ),
        nextStep(`failproofai jev setup --key-stdin < key-file`, `Set ${JEV_API_KEY_ENV} for this shell, or store the key in the file instead:`, opts),
        legacyNote,
        jevStatsLines(stats, opts),
      ),
    );
  }

  if (inspection.status === "off") {
    // Switched off, not broken and not absent: the file is kept so switching
    // back on needs no key and no endpoint re-typed. Said as "off" first,
    // because that is the whole answer to "is Jev running?".
    const r = inspection.routing;
    const route = routeForRouting(r);
    return ok(
      stack(
        title("failproofai jev status", "off (switched off)", opts),
        note(`Jev is switched off in ${inspection.path}: it is not asked about any tool call, and hooks run the regex policies exactly as before.`, opts),
        rows(
          [
            ["provider", providerLabel(r.provider)],
            ...((route ? [["endpoint", shownEndpoint(r.provider, route.endpoint)]] : []) as Array<[string, string]>),
            ["mode", modeLine("off")],
            ["config", inspection.path],
            ...((r.provider === JEV_CLOUD_PROVIDER ? [["key", cloudKeyRow()]] : []) as Array<[string, string]>),
          ],
          opts,
        ),
        nextStep("failproofai jev setup --mode shadow", "Switch it back on (shadow logs Jev and keeps enforcing regex; enforce lets it clear), here or from the dashboard:", opts),
        legacyNote,
        jevStatsLines(stats, opts),
      ),
    );
  }

  if (inspection.status === "not-connected") {
    // The Cloud route's `key-missing`: nothing is wrong with the file, and the
    // remedy is the connection, not a rewrite.
    const r = inspection.routing;
    const route = routeForRouting(r);
    return ok(
      stack(
        title("failproofai jev status", "off — this machine is not connected to FailproofAI Cloud", opts),
        note(
          `Jev is off: ${inspection.path} sends Jev requests through FailproofAI Cloud, and this machine holds no FailproofAI Cloud key that carries jev:evaluate. ` +
            "Hooks run the regex policies exactly as before.",
          opts,
        ),
        rows(
          [
            ["provider", providerLabel(r.provider)],
            ...((route ? [["endpoint", shownEndpoint(r.provider, route.endpoint)]] : []) as Array<[string, string]>),
            ["mode", modeLine(r.mode ?? DEFAULT_JEV_MODE)],
            ["config", inspection.path],
            ["key", `${CLOUD_KEY_SOURCE} — not connected`],
          ],
          opts,
        ),
        nextStep(
          "failproofai config --token <key>",
          "Connect with a key that carries jev:evaluate (the \"machine\" preset on the dashboard's Keys page), or switch Jev off: failproofai jev remove",
          opts,
        ),
        legacyNote,
        jevStatsLines(stats, opts),
      ),
    );
  }

  if (inspection.status === "key-lacks-jev") {
    // Connected, so "not connected" would be false and send its owner to
    // reconnect with the same key. The remedy is a key WITH Jev.
    const r = inspection.routing;
    const route = routeForRouting(r);
    return ok(
      stack(
        title("failproofai jev status", KEY_LACKS_JEV_TITLE, opts),
        note(
          `Jev is off: ${inspection.path} sends Jev requests through FailproofAI Cloud, and no Jev key is stored for this machine's connection: its key lacks jev:evaluate, or the last connect could not confirm that. ` +
            "Hooks run the regex policies exactly as before.",
          opts,
        ),
        rows(
          [
            ["provider", providerLabel(r.provider)],
            ...((route ? [["endpoint", shownEndpoint(r.provider, route.endpoint)]] : []) as Array<[string, string]>),
            ["mode", modeLine(r.mode ?? DEFAULT_JEV_MODE)],
            ["config", inspection.path],
            ["key", `${CLOUD_KEY_SOURCE} — connected, no Jev key stored for it`],
          ],
          opts,
        ),
        nextStep(
          "failproofai config --token <key>",
          "Run it again with this machine's key to re-check what it carries; a key without jev:evaluate needs the \"machine\" preset on the dashboard's Keys page. Or keep Jev off for good: failproofai jev setup --mode off",
          opts,
        ),
        legacyNote,
        jevStatsLines(stats, opts),
      ),
    );
  }

  if (inspection.status === "refused") {
    // A file other users could change may name an endpoint its owner never
    // chose, and `chmod 600` would start trusting it with the key — so say
    // where it points before suggesting that.
    const raw = readJevConfigFileForUpdate()?.raw ?? null;
    const named = inspection.reason === "too-open" ? namedEndpoint(raw) : null;
    const cloudFile = raw?.provider === JEV_CLOUD_PROVIDER;
    // The Cloud route's key file is credentials.json, and a refusal can be
    // about THAT file: its fix is a chmod on it, and the key it holds was put
    // there by `config --token`, not by anything `jev setup` could re-ask for.
    const credentialRefused = cloudFile && inspection.problem.startsWith(CLOUD_CREDENTIAL_REFUSED);
    return fail(
      stack(
        title("failproofai jev status", "off (config refused)", opts),
        warning([`Jev is off: ${inspection.path} was refused — ${inspection.problem}.`, "Hooks run the regex policies exactly as before."], opts),
        named ? rows([["endpoint it names", named]], opts) : null,
        credentialRefused
          ? nextStep(
              inspection.fix ?? "failproofai config --token <key>",
              "credentials.json holds the key Jev sends to FailproofAI Cloud, and other users could change it. Make it owner-only (or reconnect, which rewrites it at 0600):",
              opts,
            )
          : inspection.reason === "too-open"
            ? nextStep(
                // Either the file or the directory it sits in; `fix` says which.
                inspection.fix ?? `chmod 600 ${inspection.path}`,
                "Other users could change this file, so check that endpoint is one you chose. Then make it owner-only (or re-run `failproofai jev setup`, which asks for the key again unless the endpoint is the provider's own):",
                opts,
              )
            : cloudFile
              ? nextStep("failproofai jev setup --provider failproofai", "Rewrite it from this machine's FailproofAI Cloud connection:", opts)
              : nextStep("failproofai jev setup --provider <kind> --key-stdin", "Write a valid one:", opts),
        legacyNote,
        jevStatsLines(stats, opts),
      ),
    );
  }

  const { config: cfg } = inspection;
  const route = jevRoute(cfg);
  const mode = cfg.mode ?? DEFAULT_JEV_MODE;
  return ok(
    stack(
      title("failproofai jev status", legacy ? "on (legacy override in this shell)" : `on · ${mode}`, opts),
      rows(
        [
          ["provider", providerLabel(cfg.provider)],
          ["endpoint", shownEndpoint(cfg.provider, route.endpoint)],
          ["model", route.modelIsDefault ? `${route.model} (provider default)` : route.model],
          ["mode", modeLine(mode)],
          ["timeout", `${cfg.timeoutMs} ms`],
          ["config", inspection.path],
          ["permissions", permissions(inspection.mode)],
          [
            "key",
            inspection.keySource === "cloud"
              ? CLOUD_KEY_SOURCE
              : inspection.keySource === "file"
                ? "set in the config file"
                : `from ${JEV_API_KEY_ENV} (this shell only; the daemon does not see it)`,
          ],
        ],
        opts,
      ),
      coverage ? note(reviewableSummary(coverage), opts) : null,
      coverageProblem ? warning([coverageProblem], opts) : null,
      legacyNote,
      jevStatsLines(stats, opts),
    ),
  );
}

// ── test ─────────────────────────────────────────────────────────────────────

export function jevTestRequest(model: string): JevRequest {
  return {
    model,
    state: { word: "blue" },
    questions: {
      [JEV_TEST_QUESTION_ID]: {
        type: "noul",
        instructions: "Is state.word the name of a colour?",
        criteria: { true: "It names a colour", false: "It does not name a colour" },
      },
    },
  };
}

async function test(argv: string[], deps: JevCliDeps, opts: RenderOpts): Promise<JevCliResult> {
  const parsed = parseFlags(argv, new Set(["--json"]));
  if (typeof parsed === "string") return fail([parsed, "", ...JEV_USAGE]);
  if (parsed.positionals.length > 0) return fail([STRAY_ARGUMENT, "", ...JEV_USAGE]);
  const asJson = parsed.bools.has("--json");

  const inspection = inspectJevConfig();
  if (inspection.status !== "ok") {
    const why =
      inspection.status === "absent"
        ? `There is no ${inspection.path}; nothing to test.`
        : inspection.status === "key-missing"
          ? `${inspection.path} takes its key from ${JEV_API_KEY_ENV}, which is not set in this shell, so there is no key to test with.`
          : inspection.status === "off"
            ? `Jev is switched off in ${inspection.path} (mode off), so nothing is sent.`
            : inspection.status === "not-connected"
              ? `${inspection.path} sends Jev requests through FailproofAI Cloud, and this machine is not connected to it with a key that carries jev:evaluate.`
              : inspection.status === "key-lacks-jev"
                ? `${inspection.path} sends Jev requests through FailproofAI Cloud, and no Jev key is stored for this machine's connection.`
                : `${inspection.path} was refused — ${inspection.problem}.`;
    const code =
      inspection.status === "absent"
        ? "not-configured"
        : inspection.status === "key-missing"
          ? "no-env-key"
          : inspection.status === "off"
            ? "switched-off"
            : inspection.status === "not-connected" || inspection.status === "key-lacks-jev"
              ? inspection.status
              : "config";
    const fixCmd =
      inspection.status === "key-missing"
        ? "failproofai jev setup --key-stdin < key-file"
        : inspection.status === "off"
          ? "failproofai jev setup --mode shadow"
          : inspection.status === "not-connected" || inspection.status === "key-lacks-jev"
            ? "failproofai config --token <key>"
            : "failproofai jev setup --provider <kind> --key-stdin";
    const fixLead =
      inspection.status === "key-missing"
        ? `Set ${JEV_API_KEY_ENV} for this shell, or store the key in the file:`
        : inspection.status === "off"
          ? "Switch it back on:"
          : inspection.status === "not-connected"
            ? "Connect with a key that carries jev:evaluate:"
            : inspection.status === "key-lacks-jev"
              ? "Reconnect with a key that carries jev:evaluate:"
              : undefined;
    const json = asJson ? JSON.stringify({ ok: false, error: { code, message: why } }, null, 2) : undefined;
    return fail(stack(title("failproofai jev test", "not run", opts), note(why, opts), nextStep(fixCmd, fixLead, opts)), json);
  }

  const cfg = inspection.config;
  let route: ReturnType<typeof jevRoute>;
  let built: ReturnType<typeof transportForConfig>;
  try {
    route = jevRoute(cfg);
    built = transportForConfig(cfg);
  } catch (err) {
    const e = scrubbed(describeError(err), cfg.apiKey);
    return fail([`Not run: ${e.message}`], asJson ? JSON.stringify({ ok: false, error: e }, null, 2) : undefined);
  }

  const request = jevTestRequest(built.model);
  // `validateJevConfig` always fills this in; the fallback is the same constant
  // it fills it with, imported rather than copied — a copy of it here was left
  // behind at 1500 ms when the default became 3000.
  const budget = cfg.timeoutMs ?? JEV_CONFIG_DEFAULT_TIMEOUT_MS;
  const started = performance.now();
  try {
    const response = await built.transport(request, AbortSignal.timeout(deps.testTimeoutMs ?? DEFAULT_TEST_TIMEOUT_MS));
    const answers = readAnswers(request, response);
    const latencyMs = Math.round(performance.now() - started);
    const verified = response.modelUnverified !== true;
    const within = latencyMs <= budget;
    const p = answers[JEV_TEST_QUESTION_ID];
    const inputTokens = typeof response.usage?.input_tokens === "number" ? response.usage.input_tokens : null;
    // "ok" means a hook would use this answer: in time, and right about "blue".
    const problem = !within ? "over-timeout" : p < 0.5 ? "unexpected-answer" : null;
    const done = problem ? fail : ok;
    if (asJson) {
      return done(
        [],
        JSON.stringify(
          {
            ok: problem === null,
            ...(problem ? { problem } : {}),
            provider: cfg.provider,
            endpoint: displayEndpoint(route.endpoint),
            model: built.model,
            reportedModel: verified ? response.model : null,
            modelVerified: verified,
            latencyMs,
            timeoutMs: budget,
            withinTimeout: within,
            answer: p,
            inputTokens,
          },
          null,
          2,
        ),
      );
    }
    const status =
      problem === "over-timeout" ? `over timeout · ${latencyMs} ms` : problem ? `wrong answer · p = ${p.toFixed(3)}` : `ok · ${latencyMs} ms`;
    return done(
      stack(
        title("failproofai jev test", status, opts),
        rows(
          [
            ["provider", cfg.provider],
            ["endpoint", displayEndpoint(route.endpoint)],
            ["model asked", built.model],
            [
              "answered by",
              verified ? `${response.model} (Jev 1.13 family — verified)` : `not reported — ${cfg.provider} names Jev only by an alias (modelVerified: false)`,
            ],
            ["latency", `${latencyMs} ms — ${within ? `within the ${budget} ms timeout` : `OVER the ${budget} ms timeout: hooks would fall back to regex`}`],
            ["answer", `p = ${p.toFixed(3)} that "blue" names a colour${p >= 0.5 ? "" : " (expected high)"}`],
            ...(inputTokens !== null ? ([["input tokens", String(inputTokens)]] as Array<[string, string]>) : []),
          ],
          opts,
        ),
        note(
          "One request, sent directly: the hook path's cache and rate limit were not involved, and a fresh process pays DNS and TLS setup that the daemon's warm worker does not.",
          opts,
        ),
        problem === "over-timeout"
          ? nextStep("failproofai jev setup --timeout-ms <n>", `Give hooks longer (up to ${MAX_JEV_TIMEOUT_MS} ms), or use a faster route:`, opts)
          : null,
      ),
    );
  } catch (err) {
    const latencyMs = Math.round(performance.now() - started);
    // jev-client scrubs provider text already; this is the last line of that
    // defence, for any error text that reached here some other way.
    const e = scrubbed(describeError(err), cfg.apiKey);
    // An answer after the hook budget is a `timeout` to every hook, whatever it
    // finally said (a Cloud route maps its own upstream timeout to 502).
    const late = latencyMs > budget;
    if (asJson) return fail([], JSON.stringify({ ok: false, provider: cfg.provider, latencyMs, timeoutMs: budget, withinTimeout: !late, error: e }, null, 2));
    return fail(
      stack(
        title("failproofai jev test", `failed · ${e.code}`, opts),
        rows(
          [
            ["provider", cfg.provider],
            ["endpoint", displayEndpoint(route.endpoint)],
            ["model asked", built.model],
            ["error", `${e.code}: ${e.message}`],
            ["after", late ? `${latencyMs} ms — OVER the ${budget} ms timeout: hooks would fall back to regex (timeout)` : `${latencyMs} ms`],
          ],
          opts,
        ),
        note(
          late
            ? `Hooks stop waiting after ${budget} ms, so they record this as \`timeout\`, not ${e.code}: the provider or FailproofAI Cloud is slow or failing upstream.`
            : remedy(e.code, cfg.provider, e.message),
          opts,
        ),
      ),
    );
  }
}

// ── models ───────────────────────────────────────────────────────────────────

/** What a shape means, which decides what the names in it can be used for. */
function shapeMeans(shape: JevModelListRead["shape"]): string {
  return shape === "typesafe"
    ? "TypeSafe's own inventory — the aliases <base>/systemone answers to; versioned ids such as jev-1.13.0 are accepted without being listed"
    : "an OpenAI-shaped gateway catalog — it lists what the gateway serves, not what <base>/systemone answers to, so it is shown and never used to refuse a model";
}

/**
 * `failproofai jev models` — what `GET <base>/models` says an endpoint serves.
 *
 * The question a person asks after `jev test` fails, and the one the LiteLLM-proxy
 * customer answered by curling the endpoint by hand. With no flags it asks the
 * configured route; `--provider` asks a provider's own API and `--url` any base.
 *
 * The stored key is sent only to the origin it was stored for. `--url` takes a URL
 * off the command line, and a key issued for one gateway must not go to another
 * because a diagnostic named it — the same rule `setup` applies when a new
 * `--base-url` moves the host. Vercel's and OpenRouter's lists are public, so an
 * unkeyed read is often still an answer, and the output says which it was.
 */
async function models(argv: string[], deps: JevCliDeps, opts: RenderOpts): Promise<JevCliResult> {
  const parsed = parseFlags(argv, new Set(["--json", "--provider", "--url"]));
  if (typeof parsed === "string") return fail([parsed, "", ...JEV_USAGE]);
  if (parsed.positionals.length > 0) return fail([STRAY_ARGUMENT, "", ...JEV_USAGE]);
  const asJson = parsed.bools.has("--json");
  const { values } = parsed;

  // Checked before anything else uses it, and never echoed — the same rule
  // `setup` follows, for the same reason: the likeliest wrong value is a key.
  const named = values.get("--provider");
  if (named !== undefined && !(JEV_PROVIDER_KINDS as readonly string[]).includes(named)) {
    return fail([
      "Unknown provider (not repeated here, in case it is a key).",
      `Providers: ${JEV_PROVIDER_KINDS.join(", ")} — exactly as spelled here, lower-case.`,
    ]);
  }

  // The configured route, for the default base, for the key, and for the model to
  // mark. `key-missing` counts: the file's routing is sound, it just has no key
  // here, and a public list answers anyway.
  const inspection = inspectJevConfig();
  const routing: Omit<JevConfig, "apiKey"> | null =
    inspection.status === "ok"
      ? inspection.config
      : inspection.status === "key-missing" ||
          inspection.status === "off" ||
          inspection.status === "not-connected" ||
          inspection.status === "key-lacks-jev"
        ? inspection.routing
        : null;
  const storedKey = inspection.status === "ok" ? inspection.config.apiKey : null;

  let provider: JevProviderKind;
  let base: string | null;
  const urlArg = values.get("--url");
  if (urlArg !== undefined) {
    const checked = validateBaseUrl(urlArg);
    if (!checked.ok) return fail([`Cannot read a model list: ${checked.problem}.`]);
    const asEndpoint = endpointGivenAsBase(checked.value);
    if (asEndpoint) return fail(endpointAsBaseRefusal("--url", checked.value, asEndpoint));
    base = checked.value;
    provider = (named as JevProviderKind | undefined) ?? providerForUrl(base);
  } else if (named !== undefined) {
    provider = named as JevProviderKind;
    base = JEV_PROVIDER_DEFAULTS[provider].baseUrl;
    if (base === null && provider === JEV_CLOUD_PROVIDER) {
      return fail([
        `FailproofAI Cloud serves no model list: it runs ${JEV_PROVIDER_DEFAULTS.failproofai.model}, pinned on the server, and every answer is checked against the Jev 1.13 family.`,
      ]);
    }
    if (base === null) {
      return fail(["Provider custom has no API of its own — its URL is the whole address.", "  failproofai jev models --url <base>"]);
    }
  } else if (routing !== null) {
    provider = routing.provider;
    base = routing.baseUrl ?? JEV_PROVIDER_DEFAULTS[routing.provider].baseUrl;
  } else {
    return fail([
      `Jev is not configured here (no ${inspection.path}), so there is no endpoint to ask.`,
      "Name one:",
      "  failproofai jev models --provider vercel",
      "  failproofai jev models --url https://your-proxy.example.com/typesafe/v1",
    ]);
  }

  // Cloudflare is the one route with no `<base>/models`: Workers AI runs models at
  // `/accounts/<id>/ai/run` and keeps its inventory behind a different API, so
  // there is nothing here to read rather than something that failed to read.
  // FailproofAI Cloud serves no list either: it pins the model server-side
  // (`jev-1.13.0`), so there is nothing to choose and nothing to read.
  const modelsUrl = provider === "cloudflare" || provider === JEV_CLOUD_PROVIDER || base === null ? null : modelsUrlForBase(base);
  if (modelsUrl === null) {
    return fail([
      provider === "cloudflare"
        ? "Cloudflare Workers AI serves no <base>/models: its models are listed through the Cloudflare API, not through the Jev base URL."
        : provider === JEV_CLOUD_PROVIDER
          ? `FailproofAI Cloud serves no model list: it runs ${JEV_PROVIDER_DEFAULTS.failproofai.model}, pinned on the server, and every answer is checked against the Jev 1.13 family.`
          : "That base URL names no endpoint a model list could be read from.",
    ]);
  }

  const askOrigin = originOf(provider, base);
  const configuredOrigin = routing !== null ? originOf(routing.provider, routing.baseUrl) : null;
  const sameOrigin = askOrigin !== null && askOrigin === configuredOrigin;
  const apiKey = sameOrigin ? storedKey : null;
  // Only meaningful for the route that is actually configured: marking a name on
  // some other host as "configured" would be saying something untrue.
  const configuredModel = sameOrigin && routing !== null ? (routing.model ?? JEV_PROVIDER_DEFAULTS[routing.provider].model) : null;

  let list: JevModelListResult;
  try {
    list = await (deps.readModelList ?? liveModelListReader)(modelsUrl, apiKey);
  } catch (err) {
    list = { ok: false, reason: scrubSecret(err instanceof Error ? err.message : String(err), apiKey ?? "") };
  }

  const shown = displayEndpoint(modelsUrl);
  const keyNote = apiKey
    ? "the configured key for this origin"
    : sameOrigin
      ? `none stored here — set ${JEV_API_KEY_ENV}, or store one with \`failproofai jev setup --key-stdin\``
      : storedKey !== null
        ? "none sent: a stored key belongs to the endpoint it was stored for"
        : "none: nothing is configured for this endpoint, and some lists are public";

  if (!list.ok) {
    if (asJson) {
      return fail([], JSON.stringify({ ok: false, provider, endpoint: shown, error: { code: "model-list-unread", message: list.reason } }, null, 2));
    }
    return fail(
      stack(
        title("failproofai jev models", "not read", opts),
        rows(
          [
            ["provider", provider],
            ["endpoint", shown],
            ["key", keyNote],
            ["reason", list.reason],
          ],
          opts,
        ),
        note(
          "Not every endpoint serves a model list — a proxy may expose only /systemone — and nothing depends on one: setup and hooks work without it.",
          opts,
        ),
      ),
    );
  }

  if (asJson) {
    return ok(
      [],
      JSON.stringify({ ok: true, provider, endpoint: shown, shape: list.shape, models: list.models, configuredModel, keySent: apiKey !== null }, null, 2),
    );
  }
  const listed = list.models.slice(0, MAX_SHOWN_MODELS);
  return ok(
    stack(
      title("failproofai jev models", `${list.models.length} · ${provider}`, opts),
      rows(
        [
          ["provider", provider],
          ["endpoint", shown],
          ["key", keyNote],
          ["list", shapeMeans(list.shape)],
        ],
        opts,
      ),
      rows(
        listed.map((name) => [name, name === configuredModel ? "configured" : ""] as [string, string]),
        opts,
      ),
      list.models.length > listed.length ? note(`… and ${list.models.length - listed.length} more.`, opts) : null,
      configuredModel !== null && !modelListHasModel(list, configuredModel) && listDescribesSystemOne(list)
        ? warning(
            [
              `The configured model ${configuredModel} is not one of these, so every evaluation would fail at this endpoint and hooks would fall back to regex.`,
              `Point it at one of them: failproofai jev setup --model ${list.models[0]}`,
            ],
            opts,
          )
        : null,
    ),
  );
}

// ── remove ───────────────────────────────────────────────────────────────────

function remove(argv: string[], opts: RenderOpts): JevCliResult {
  const parsed = parseFlags(argv, new Set());
  if (typeof parsed === "string") return fail([parsed, "", ...JEV_USAGE]);
  if (parsed.positionals.length > 0) return fail([STRAY_ARGUMENT, "", ...JEV_USAGE]);
  const path = jevConfigPath();
  if (!existsSync(path)) {
    return ok(stack(title("failproofai jev remove", "nothing to do", opts), note(`There is no ${path}; Jev is already off.`, opts)));
  }
  try {
    unlinkSync(path);
  } catch (err) {
    return fail([`Could not remove ${path}: ${(err as NodeJS.ErrnoException).code ?? "error"}.`]);
  }
  return ok(
    stack(
      title("failproofai jev remove", "off", opts),
      note(`Removed ${path}. Jev is off; hooks run the regex policies exactly as before, from the next tool call.`, opts),
      process.env[JEV_API_KEY_ENV] ? note(`${JEV_API_KEY_ENV} is still set in this shell. Without the file it does nothing.`, opts) : null,
    ),
  );
}

// ── dispatch ─────────────────────────────────────────────────────────────────

/** Dispatch for `failproofai jev <sub> ...`. Never prints; the caller does. */
export async function runJevCommand(argv: string[], deps: JevCliDeps = {}): Promise<JevCliResult> {
  const opts = deps.render ?? optsFor(process.stdout);
  const [sub, ...rest] = argv;
  // `failproofai jev --url <url> --token <token>` — the one-shot form. An argv
  // that opens with an option is `setup` with that option: nothing else here
  // takes one in the subcommand slot, and the two spellings then parse through
  // exactly the same code.
  if (sub !== undefined && sub.startsWith("-")) return setup(argv, deps, opts);
  switch (sub) {
    case "setup":
      return setup(rest, deps, opts);
    case "status":
      return status(rest, opts);
    case "test":
      return test(rest, deps, opts);
    case "models":
      return models(rest, deps, opts);
    case "remove":
      return remove(rest, opts);
    default: {
      // The subcommand slot takes a pasted key as readily as any flag does
      // (`failproofai jev <key>`, having forgotten `setup --key-stdin`), so it
      // is repeated only when it is shaped like a subcommand — which no key is.
      const nameLike = sub !== undefined && SUBCOMMAND_SHAPE.test(sub);
      return fail([
        !sub ? "A subcommand is required." : nameLike ? `Unknown subcommand: ${sub}` : "Unknown subcommand (not repeated here, in case it is a key).",
        "",
        ...JEV_USAGE,
      ]);
    }
  }
}
