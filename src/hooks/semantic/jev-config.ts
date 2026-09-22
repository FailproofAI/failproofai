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
 * - `provider`, `baseUrl`, `model` and `accountId` come from the file only,
 *   never from the environment — a repo's `.claude/settings.json` can set env
 *   vars for a session;
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
 * # Read on every hook event, on purpose
 *
 * Deliberately uncached: one open + fstat + read of a file capped at 64 KiB is
 * microseconds, and it means `failproofai jev setup` / `remove` take effect on
 * the very next tool call — including inside the long-lived daemon worker —
 * with no restart and no stale state to reason about.
 */
import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from "node:fs";
import { jevConfigFile } from "../fp-home";

export type JevProviderKind = "typesafe" | "openrouter" | "vercel" | "cloudflare" | "custom";

export interface JevConfig {
  provider: JevProviderKind;
  apiKey: string;
  /** Required for `custom`; an optional override otherwise. */
  baseUrl?: string;
  /** `cloudflare` only. */
  accountId?: string;
  /** Provider-specific model id; each provider has a default. */
  model?: string;
  /** Default 1500. */
  timeoutMs?: number;
  /** `shadow` logs Jev and enforces regex; `enforce` applies the combine rules. Default `enforce`. */
  mode?: "shadow" | "enforce";
}

export const DEFAULT_JEV_MODE: NonNullable<JevConfig["mode"]> = "enforce";

export const JEV_PROVIDER_KINDS: readonly JevProviderKind[] = ["typesafe", "openrouter", "vercel", "cloudflare", "custom"];

/** The env var that may supply the key (and nothing else) when the file carries none. */
export const JEV_API_KEY_ENV = "FAILPROOFAI_JEV_API_KEY";

/** The same 1500 ms as `DEFAULT_JEV_TIMEOUT_MS` in `evaluator.ts`: p95 measured at 710–740 ms. */
export const JEV_CONFIG_DEFAULT_TIMEOUT_MS = 1_500;
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

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; problem: string };

/** A key is visible ASCII, one line, at most 4 KiB. The message never includes the key. */
export function validateApiKey(key: unknown): string | null {
  if (typeof key !== "string" || key.length === 0) return "the API key is empty";
  if (!API_KEY_RE.test(key)) return "the API key must be one line of visible ASCII with no spaces (at most 4096 characters)";
  return null;
}

/**
 * An endpoint base URL: https, or http to a loopback host only (a local proxy).
 * No credentials in the URL and no fragment — a key belongs in the key field,
 * where it is sent as a bearer and never printed.
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
  // Trailing slashes come off the PATH, never the string: a query string is legal
  // (some proxies want `?api-version=`), and the endpoint path is appended to
  // the pathname, so it must never end up inside the query.
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return { ok: true, value: url.toString() };
}

function validateModel(raw: unknown): ValidationResult<string> {
  if (typeof raw !== "string" || !MODEL_RE.test(raw)) {
    return { ok: false, problem: "model must be 1–200 characters of letters, digits and . _ : / @ ~ + -" };
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
 */
export function validateJevConfig(raw: unknown, envKey?: string | null): ValidationResult<JevConfig> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, problem: "the file must hold a JSON object" };
  const o = raw as Record<string, unknown>;

  const provider = o.provider;
  if (typeof provider !== "string" || !(JEV_PROVIDER_KINDS as readonly string[]).includes(provider)) {
    return { ok: false, problem: `provider must be one of ${JEV_PROVIDER_KINDS.join(", ")}` };
  }
  const kind = provider as JevProviderKind;

  let apiKey: string;
  if (o.apiKey !== undefined) {
    const bad = validateApiKey(o.apiKey);
    if (bad) return { ok: false, problem: bad };
    apiKey = o.apiKey as string;
  } else if (envKey !== undefined && envKey !== null && envKey !== "") {
    const bad = validateApiKey(envKey);
    if (bad) return { ok: false, problem: `${JEV_API_KEY_ENV} is set but invalid: ${bad}` };
    apiKey = envKey;
  } else {
    return { ok: false, problem: `no API key: set apiKey in the file (failproofai jev setup), or ${JEV_API_KEY_ENV} for this session` };
  }

  const cfg: JevConfig = { provider: kind, apiKey, mode: DEFAULT_JEV_MODE, timeoutMs: JEV_CONFIG_DEFAULT_TIMEOUT_MS };

  if (o.baseUrl !== undefined) {
    const r = validateBaseUrl(o.baseUrl);
    if (!r.ok) return r;
    cfg.baseUrl = r.value;
  } else if (kind === "custom") {
    return { ok: false, problem: "provider custom needs a baseUrl" };
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
    if (o.mode !== "shadow" && o.mode !== "enforce") return { ok: false, problem: 'mode must be "shadow" or "enforce"' };
    cfg.mode = o.mode;
  }

  return { ok: true, value: cfg };
}

// ── Loading ──────────────────────────────────────────────────────────────────

export type JevConfigInspection =
  | { status: "absent"; path: string }
  | { status: "ok"; path: string; mode: number | null; keySource: "file" | "env"; config: JevConfig }
  | {
      status: "refused";
      path: string;
      /** The file's permission bits, when they are the reason. */
      mode: number | null;
      reason: "too-open" | "unreadable" | "too-large" | "not-json" | "invalid";
      problem: string;
    };

function readEnvKey(): string | null {
  const v = process.env[JEV_API_KEY_ENV];
  return v === undefined || v === "" ? null : v;
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
  const envKey = readEnvKey();
  const r = validateJevConfig(parsed, envKey);
  if (!r.ok) return { status: "refused", path, mode, reason: "invalid", problem: r.problem };
  const keySource = (parsed as Record<string, unknown>).apiKey !== undefined ? "file" : "env";
  return { status: "ok", path, mode, keySource, config: r.value };
}

/**
 * The validated global config, or null — absent, refused, or invalid all mean
 * Jev is off and the regex path runs unchanged. Never throws.
 */
export function loadJevConfig(): JevConfig | null {
  try {
    const r = inspectJevConfig();
    return r.status === "ok" ? r.config : null;
  } catch {
    return null;
  }
}

/**
 * The file's raw JSON object regardless of its permissions, for `jev setup` to
 * update in place (carry the key over a mode switch, or re-save a file that is
 * too open at 0600). Never used on the hook path.
 */
export function readJevConfigForUpdate(): Record<string, unknown> | null {
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
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
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
