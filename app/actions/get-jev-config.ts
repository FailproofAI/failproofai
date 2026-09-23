"use server";

/**
 * Read side of the /settings "Jev" section. Writes live in
 * `update-jev-config.ts`, mirroring the get-scheduled-audit /
 * update-scheduled-audit split next door.
 *
 * ## CLI ⟷ dashboard parity
 *
 * Every field comes from the same `~/.failproofai/jev.json` the hooks read, via
 * the same `inspectJevConfig()` that backs `failproofai jev status` — so the
 * two surfaces cannot disagree about what is configured, and neither can
 * disagree with what a hook will actually do on the next tool call. There is no
 * dashboard-side copy of this state.
 *
 * ## The token never comes back
 *
 * This is the rule the whole module is built around: nothing returned here
 * carries the API key, not even from a file the loader refused. The view has a
 * `token` field, and it holds a SOURCE and at most the last four characters —
 * enough for a person to recognise which key they stored, useless to anyone who
 * did not already have it. A GET that returns the key would hand it to any page
 * that can reach this origin, and the dashboard has no authentication.
 *
 * So the routing fields of a refused file are copied out one by one
 * (`routingFromRaw`) rather than spread: a spread is how `apiKey` gets carried
 * along by accident the next time someone adds a field.
 */

import {
  DEFAULT_JEV_MODE,
  JEV_API_KEY_ENV,
  JEV_PROVIDER_KINDS,
  inspectJevConfig,
  readJevConfigForUpdate,
  type JevConfig,
  type JevProviderKind,
} from "@/src/hooks/semantic/jev-config";
import { displayEndpoint, jevRoute } from "@/src/hooks/semantic/jev-client";
import { jevStats } from "@/src/hooks/semantic/jev-stats";

/** The loader's four answers, unchanged — see `JevConfigInspection`. */
export type JevSettingsStatus = "absent" | "ok" | "key-missing" | "refused";

/** What Jev has been doing lately, from `jevStats()`. Not a new pipeline. */
export interface JevSettingsStats {
  windowMs: number;
  /** Gate evaluations Jev was consulted on: answered or fell back. */
  total: number;
  answered: number;
  fallbacks: number;
  /** Share of `total` that fell back to the regex engine, 0..1. */
  fallbackRate: number;
}

/**
 * Presence of a stored key, never the key.
 *
 * `hint` is the last four characters, and only for a key long enough that four
 * characters are a negligible share of it. A short key gets no hint at all
 * rather than a proportionally large piece of itself.
 */
export interface JevTokenPresence {
  source: "file" | "env";
  hint: string | null;
}

export interface JevSettingsView {
  status: JevSettingsStatus;
  /** True only when a hook running right now would consult Jev. */
  on: boolean;
  /** `~/.failproofai/jev.json`, whether or not it exists. */
  path: string;
  /** The file's permission bits as `0600`, or null when it has none to show. */
  permissions: string | null;
  provider: JevProviderKind | null;
  /** The stored base URL, or "" for the provider's own API. Form value. */
  baseUrl: string;
  /** Cloudflare only; "" otherwise. Form value. */
  accountId: string;
  /** "" means the provider's default model. Form value. */
  model: string;
  /** Where requests actually go, query string elided. Null when unroutable. */
  endpoint: string | null;
  mode: NonNullable<JevConfig["mode"]>;
  timeoutMs: number | null;
  token: JevTokenPresence | null;
  /** The loader's own words for why this file is refused or incomplete. */
  problem: string | null;
  /** The command that fixes it, when there is one. */
  fix: string | null;
  stats: JevSettingsStats | null;
}

const MIN_HINTABLE_KEY_LENGTH = 12;

/**
 * Fills the key slot when a route is computed for DISPLAY only. The key does
 * not decide where requests go, but `jevRoute` validates the whole config
 * before answering, so a config whose key lives in the environment — or one the
 * loader refused — needs something in the field to get an endpoint out. Never
 * written, never sent.
 */
const KEY_STAND_IN = "display-only";

/** The last four characters of a key, or null when the key is too short to spare them. */
function maskedHint(key: string): string | null {
  return key.length >= MIN_HINTABLE_KEY_LENGTH ? key.slice(-4) : null;
}

function octal(mode: number | null): string | null {
  return mode === null ? null : mode.toString(8).padStart(4, "0");
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * The routing fields of a raw `jev.json`, for a file the loader refused — so
 * the panel can show what it names and the form can offer it back for repair.
 *
 * Copied field by field, deliberately. `apiKey` is the reason: a spread of the
 * parsed object would carry it into a value this module hands to the browser,
 * and it would keep doing so silently as fields are added.
 */
function routingFromRaw(raw: Record<string, unknown> | null): {
  provider: JevProviderKind | null;
  baseUrl: string;
  accountId: string;
  model: string;
  mode: NonNullable<JevConfig["mode"]>;
} {
  const providerRaw = asString(raw?.provider);
  const provider = (JEV_PROVIDER_KINDS as readonly string[]).includes(providerRaw)
    ? (providerRaw as JevProviderKind)
    : null;
  const modeRaw = raw?.mode;
  return {
    provider,
    baseUrl: asString(raw?.baseUrl),
    accountId: asString(raw?.accountId),
    model: asString(raw?.model),
    mode: modeRaw === "shadow" || modeRaw === "enforce" ? modeRaw : DEFAULT_JEV_MODE,
  };
}

/** `jevRoute` for display, swallowing the throw a file that names no usable route produces. */
function endpointFor(cfg: JevConfig): string | null {
  try {
    return displayEndpoint(jevRoute(cfg).endpoint);
  } catch {
    return null;
  }
}

/**
 * The fallback rate and the counts behind it, for the one line on the panel
 * that says whether Jev is working. Read only when Jev is actually on: on a
 * machine with no config the numbers are all zero and the line would be noise.
 *
 * `jevStats()` never throws and derives from the activity store the activity
 * tab already reads, so this adds no pipeline and no persisted state.
 */
async function statsOrNull(on: boolean): Promise<JevSettingsStats | null> {
  if (!on) return null;
  try {
    const s = await jevStats();
    return {
      windowMs: s.windowMs,
      total: s.total,
      answered: s.answered,
      fallbacks: s.fallbacks,
      fallbackRate: s.fallbackRate,
    };
  } catch {
    // The panel renders without the line rather than without the panel.
    return null;
  }
}

/**
 * Everything /settings shows about Jev, and nothing it must not.
 *
 * Never throws: every branch of `inspectJevConfig` is a state the panel can
 * draw, and a settings page whose job is to say whether a security feature is
 * on must not be replaced by an error boundary when the answer is "badly".
 */
export async function getJevSettingsAction(): Promise<JevSettingsView> {
  const inspection = inspectJevConfig();
  const base = {
    path: inspection.path,
    permissions: null as string | null,
    provider: null as JevProviderKind | null,
    baseUrl: "",
    accountId: "",
    model: "",
    endpoint: null as string | null,
    mode: DEFAULT_JEV_MODE,
    timeoutMs: null as number | null,
    token: null as JevTokenPresence | null,
    problem: null as string | null,
    fix: null as string | null,
  };

  if (inspection.status === "ok") {
    const cfg = inspection.config;
    return {
      ...base,
      status: "ok",
      on: true,
      permissions: octal(inspection.mode),
      provider: cfg.provider,
      baseUrl: cfg.baseUrl ?? "",
      accountId: cfg.accountId ?? "",
      model: cfg.model ?? "",
      endpoint: endpointFor(cfg),
      mode: cfg.mode ?? DEFAULT_JEV_MODE,
      timeoutMs: cfg.timeoutMs ?? null,
      // The only place a key is touched on this path, and only its length and
      // last four characters leave the function.
      token: { source: inspection.keySource, hint: maskedHint(cfg.apiKey) },
      stats: await statsOrNull(true),
    };
  }

  if (inspection.status === "key-missing") {
    const r = inspection.routing;
    return {
      ...base,
      status: "key-missing",
      on: false,
      permissions: octal(inspection.mode),
      provider: r.provider,
      baseUrl: r.baseUrl ?? "",
      accountId: r.accountId ?? "",
      model: r.model ?? "",
      endpoint: endpointFor({ ...r, apiKey: KEY_STAND_IN }),
      mode: r.mode ?? DEFAULT_JEV_MODE,
      timeoutMs: r.timeoutMs ?? null,
      // The file names the environment as the source and the variable is not
      // set here, so there is nothing present to hint at.
      token: null,
      problem: inspection.problem,
      fix: `set ${JEV_API_KEY_ENV}, or save a token here`,
      stats: null,
    };
  }

  if (inspection.status === "refused") {
    // Show what the file names so the owner can see whether the endpoint is one
    // they chose — the same question `jev status` puts to them. Routing only.
    const r = routingFromRaw(readJevConfigForUpdate());
    return {
      ...base,
      status: "refused",
      on: false,
      permissions: octal(inspection.mode),
      provider: r.provider,
      baseUrl: r.baseUrl,
      accountId: r.accountId,
      model: r.model,
      // Shown for the same reason `jev status` shows it: the owner needs to see
      // whether the endpoint a file they may not have written names is one they
      // chose. Null when the routing fields do not make a usable route.
      endpoint:
        r.provider === null
          ? null
          : endpointFor({
              provider: r.provider,
              apiKey: KEY_STAND_IN,
              ...(r.baseUrl ? { baseUrl: r.baseUrl } : {}),
              ...(r.accountId ? { accountId: r.accountId } : {}),
              ...(r.model ? { model: r.model } : {}),
              mode: r.mode,
            }),
      mode: r.mode,
      problem: inspection.problem,
      fix: inspection.fix ?? null,
      stats: null,
    };
  }

  return { ...base, status: "absent", on: false, stats: null };
}
