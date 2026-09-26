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
 * carries the API key or any piece of it, not even from a file the loader
 * refused. The view has a `token` field and it holds a SOURCE — whether a key is
 * there and where it came from, which is what the panel has to say. A GET that
 * returns the key, or four characters of it, hands that to any page which can
 * reach this origin, and the dashboard has no authentication.
 *
 * So the routing fields of a refused file are copied out one by one
 * (`routingFromRaw`) rather than spread: a spread is how `apiKey` gets carried
 * along by accident the next time someone adds a field.
 *
 * ## …and neither does the model
 *
 * `model` is the one routing field that holds a free string a person types next
 * to their key, and `--model <key>` is one slip away from `--token <key>`. The
 * loader refuses such a file (`validateModel` knows the shape), and a refused
 * file's routing is exactly what this module hands back so the owner can see
 * and repair it — which would have carried the probable key into the browser
 * while the very same response said the key never comes back. So the model is
 * treated as the token is, rather than masked: `modelView()` returns the stored
 * string only where it cannot be a credential, and otherwise reports presence
 * alone. A mask would be worse on both counts — it still hands over a piece of
 * a key, and the last four characters of a model id tell nobody anything.
 *
 * It is a shape test, so it is not a proof: a short secret with no known prefix
 * can still look like a model id, and the honest bound is "the file the loader
 * would refuse cannot be echoed". Anything the loader ACCEPTS as a model is a
 * value `jev setup` would also have printed. See `JevModelView`.
 */

import { readCredentials, readJevCloudCredential } from "@/src/hooks/fp-config";
import {
  CLOUDFLARE_ACCOUNT_ID_RE,
  DEFAULT_JEV_MODE,
  JEV_API_KEY_ENV,
  JEV_CLOUD_PROVIDER,
  JEV_PROVIDER_KINDS,
  baseUrlWithoutQuery,
  inspectJevConfig,
  looksLikeCredential,
  readJevConfigForUpdate,
  type JevConfig,
  type JevProviderKind,
} from "@/src/hooks/semantic/jev-config";
import { displayEndpoint, jevRoute } from "@/src/hooks/semantic/jev-client";
import { jevStats } from "@/src/hooks/semantic/jev-stats";
import {
  reviewableProblem,
  reviewableSummary,
  surveyReviewableCoverage,
} from "@/src/hooks/policy-reviewability";

/** The loader's answers, unchanged — see `JevConfigInspection`. */
export type JevSettingsStatus = "absent" | "ok" | "key-missing" | "refused" | "off" | "not-connected" | "key-lacks-jev";

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
 * Presence of a stored key, and nothing else about it.
 *
 * It used to carry the last four characters, so the panel could say "configured,
 * ending 1eb9". That is a recognisable fragment of a live credential rendered
 * into a web page on an origin with no authentication, and it buys the reader
 * nothing they could not get by re-pasting the key: the panel already says
 * whether one is stored, where it came from, and that leaving the field blank
 * keeps it. So the fragment is not shown, and — the part that matters — it is
 * not computed and not sent.
 */
export interface JevTokenPresence {
  /** `cloud`: the key is this machine's FailproofAI Cloud key, held in `credentials.json`. */
  source: "file" | "env" | "cloud";
}

/**
 * What the panel may say about the stored model id.
 *
 *   - `default`  — nothing is stored, so the provider's own default is used.
 *   - `id`       — a stored value that is a model id, shown as itself.
 *   - `withheld` — something is stored that does not look like a model id, so it
 *                  is reported the way a token is: present, never quoted.
 *
 * The decision is `looksLikeCredential()`, the loader's own predicate for "this
 * is a key, not a model id" — the one that refuses the file in the first place,
 * not a second rule invented here. It has two deliberate carve-outs so it does
 * not refuse real ids (a `/`, which every gateway-qualified id has, and the
 * letters "jev"), and a base64 key can contain a `/`, so length is checked too:
 * every id Jev is addressed by is short — `jev-1.13.0`, `typesafe/jev-1.13`,
 * `@cf/typesafe/jev-1.13` — and nothing longer is worth showing at the risk of
 * it being a key.
 */
export type JevModelView =
  | { kind: "default" }
  | { kind: "id"; id: string }
  | { kind: "withheld" };

/**
 * How much of this machine's enabled policy set Jev is allowed to CLEAR.
 *
 * The panel says whether Jev is on; this is what says whether the half of it
 * that clears a verdict can fire at all. A pack published before this release
 * declares no `authority`, every policy in it is therefore `hard`, and a
 * machine in that state looks perfect from every other field on the panel — the
 * endpoint answers, the fallback rate is fine, and no deny is ever cleared. See
 * `src/hooks/policy-reviewability.ts` for what is counted.
 *
 * The two sentences are computed there rather than here, so this panel and
 * `failproofai jev status` say the same thing in the same words — the same rule
 * the rest of this module follows for everything it reports.
 */
export interface JevReviewabilityView {
  /** Enabled policies whose authority could be read without running code. */
  enabled: number;
  /** Of those, the ones Jev may clear. */
  reviewable: number;
  /** The count, as one line. */
  summary: string;
  /** Why nothing can be cleared, and what fixes it; null when something can. */
  problem: string | null;
}

/**
 * This machine's FailproofAI Cloud connection, as far as Jev is concerned —
 * read from `credentials.json` on every render, with NO network call and
 * nothing secret in it: the org as the server named it at connect time, the
 * host, and whether the key carries Jev. Every token in that file is read and
 * dropped inside `cloudConnectionView`; none of it, nor any piece of it, is in
 * this object.
 */
export interface JevCloudConnectionView {
  /** A Cloud credential (policy or reporting) is stored on this machine. */
  connected: boolean;
  /** "Acme Inc (acme)" — recorded at connect time; null when it was not. */
  org: string | null;
  /** The Cloud host, e.g. `app.befailproof.ai`. */
  host: string | null;
  /**
   * Whether the key this machine connected with carries `jev:evaluate` — which
   * is exactly whether connect stored a `jev` slot. `refused`: a slot may be
   * there, but `credentials.json` is not owner-only, so Jev will not read it.
   */
  jev: "yes" | "no" | "refused";
}

export interface JevSettingsView {
  status: JevSettingsStatus;
  /** True only when a hook running right now would consult Jev. */
  on: boolean;
  /** See `JevCloudConnectionView`. Present on every status. */
  cloud: JevCloudConnectionView;
  /**
   * `~/.failproofai/jev.json`, whether or not it exists, and its permission
   * bits as `0600` when it has some.
   *
   * Both are part of this inspection because `failproofai jev status` prints
   * them, and this module is that command's answer read from the same
   * `inspectJevConfig`. The PANEL does not draw them: a config path and a mode
   * are not something anybody acts on from a browser, and the one case where
   * the bits decide anything — a file the loader refuses for being
   * group-writable — already names the file in `problem` and the `chmod` in
   * `fix`. See `jev-panel.tsx`.
   */
  path: string;
  permissions: string | null;
  provider: JevProviderKind | null;
  /**
   * The stored base URL, or "" for the provider's own API. Form value, and
   * NEVER its query string — see `baseUrlView` below for why, and
   * `baseUrlQueryWithheld` for what the panel says about the part it did not
   * get.
   */
  baseUrl: string;
  /**
   * True when the stored base URL carries a query string that `baseUrl` above
   * does not.
   *
   * The panel needs it to avoid lying twice over: the field would otherwise
   * show a URL that is not the stored one, and an untouched save would look
   * like it kept a query string the person never saw. `update-jev-config.ts`
   * keeps a stored query that the loader accepts when the field comes back
   * unchanged, and this is how the panel can say so.
   */
  baseUrlQueryWithheld: boolean;
  /** Cloudflare only; "" otherwise. Form value. */
  accountId: string;
  /**
   * The stored model, for DISPLAY only — never a form value, and never the
   * stored string when that string could be a key. The form does not offer this
   * field and the save path leaves it alone (see `update-jev-config.ts`), so
   * nothing needs it back to round-trip it.
   */
  model: JevModelView;
  /**
   * Where requests actually go, query string elided. Null when unroutable.
   *
   * The computed route, which is not what any form field holds — `baseUrl` may
   * be empty for the provider's own API, and Cloudflare's route is built from
   * `accountId`. `jev status` prints it for that reason. The panel does not: for
   * Cloudflare the route IS `/accounts/<id>/ai/run`, so a read-only row above
   * the form repeated the endpoint field and the account id field at once,
   * putting a per-account address on the page twice.
   */
  endpoint: string | null;
  mode: NonNullable<JevConfig["mode"]>;
  timeoutMs: number | null;
  token: JevTokenPresence | null;
  /** The loader's own words for why this file is refused or incomplete. */
  problem: string | null;
  /** The command that fixes it, when there is one. */
  fix: string | null;
  stats: JevSettingsStats | null;
  /** What Jev may clear here. Null when Jev is off, or when it could not be read. */
  reviewable: JevReviewabilityView | null;
}

/**
 * Fills the key slot when a route is computed for DISPLAY only. The key does
 * not decide where requests go, but `jevRoute` validates the whole config
 * before answering, so a config whose key lives in the environment — or one the
 * loader refused — needs something in the field to get an endpoint out. Never
 * written, never sent.
 */
const KEY_STAND_IN = "display-only";

/** Longer than any model id a Jev route knows, and well inside a pasted key's length. */
const MAX_SHOWABLE_MODEL_LENGTH = 40;

/** The stored model as the panel may see it — see `JevModelView` for the rule. */
function modelView(stored: string): JevModelView {
  if (!stored) return { kind: "default" };
  if (stored.length > MAX_SHOWABLE_MODEL_LENGTH || looksLikeCredential(stored)) {
    return { kind: "withheld" };
  }
  return { kind: "id", id: stored };
}

/**
 * A stored base URL as the browser may see it: never its query string.
 *
 * `validateBaseUrl` now refuses a credential-bearing query parameter, so a file
 * written by THIS build cannot carry one. A file written by an older one can,
 * and that file is precisely the one this module hands back for repair — the
 * refused branch below copies the raw routing fields out on purpose. Only the
 * derived `endpoint` was elided (`displayEndpoint`), so the base URL carried
 * the secret through a response whose whole documented rule is that the
 * credential never comes back.
 *
 * Every branch goes through this one function rather than reading `baseUrl`
 * itself, for the reason `routingFromRaw` copies field by field: the next field
 * added should not be able to quietly reintroduce it.
 */
function baseUrlView(stored: string | undefined): { baseUrl: string; baseUrlQueryWithheld: boolean } {
  if (!stored) return { baseUrl: "", baseUrlQueryWithheld: false };
  const { url, hadQuery } = baseUrlWithoutQuery(stored);
  return { baseUrl: url, baseUrlQueryWithheld: hadQuery };
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
    // An account id is 32 hex characters; anything else in that slot of a
    // refused file may be a pasted key, and is not shown.
    accountId: CLOUDFLARE_ACCOUNT_ID_RE.test(asString(raw?.accountId)) ? asString(raw?.accountId) : "",
    model: asString(raw?.model),
    mode: modeRaw === "off" || modeRaw === "shadow" || modeRaw === "enforce" ? modeRaw : DEFAULT_JEV_MODE,
  };
}

/**
 * Whether a switched-off file still has a key to switch back on with — as a
 * SOURCE, like every other token field here. The routing the loader reports
 * for an `off` file deliberately carries no key, so this is read for presence
 * only: the raw file's `apiKey` is tested and dropped, and the Cloud
 * credential's status is read and its key never touched.
 */
function offTokenPresence(provider: JevProviderKind): JevTokenPresence | null {
  if (provider === JEV_CLOUD_PROVIDER) {
    try {
      return readJevCloudCredential().status === "ok" ? { source: "cloud" } : null;
    } catch {
      return null;
    }
  }
  const raw = readJevConfigForUpdate();
  return typeof raw?.apiKey === "string" && raw.apiKey !== "" ? { source: "file" } : null;
}

/**
 * `jevRoute` for display, swallowing the throw a file that names no usable
 * route produces.
 *
 * A FailproofAI Cloud config is only routed against the origin of the
 * credential it was validated with (`validateLoadedJevConfig`). The loaded
 * config carries it; a display stand-in built here — for a file that is off,
 * refused, or has no credential behind it — gets the file's own origin, like
 * the stand-in key beside it. Nothing built here is ever sent.
 */
function endpointFor(cfg: JevConfig): string | null {
  try {
    return displayEndpoint(jevRoute(displayOnlyCloudOrigin(cfg)).endpoint);
  } catch {
    return null;
  }
}

function displayOnlyCloudOrigin(cfg: JevConfig): JevConfig {
  if (cfg.provider !== JEV_CLOUD_PROVIDER || cfg.credentialOrigin || typeof cfg.baseUrl !== "string") return cfg;
  try {
    return { ...cfg, credentialOrigin: new URL(cfg.baseUrl).origin };
  } catch {
    return cfg;
  }
}

/**
 * The fallback rate and the counts behind it, for the one line on the panel
 * that says whether Jev is working. Read only when Jev is on, or may be for
 * hooks whose environment has the key: on a machine with no config the numbers
 * are all zero and the line would be noise.
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
 * The authority counts, for a machine where a clear could actually happen.
 *
 * Off means the regex policies decide whatever any policy's authority says, so
 * there is nothing to report and the panel shows no row. Never throws, for the
 * same reason `statsOrNull` does not: the panel renders without the line rather
 * than without the panel.
 */
function reviewableOrNull(on: boolean): JevReviewabilityView | null {
  if (!on) return null;
  try {
    // The launch directory, as every other dashboard read resolves project
    // config: the standalone server chdirs into the package, and `jev status`
    // counts the project it is run in.
    const coverage = surveyReviewableCoverage(process.env.FAILPROOFAI_LAUNCH_CWD || process.cwd());
    return {
      enabled: coverage.enabled,
      reviewable: coverage.reviewable,
      summary: reviewableSummary(coverage),
      problem: reviewableProblem(coverage),
    };
  } catch {
    return null;
  }
}

/**
 * The Cloud connection row, from the local files only. `readCredentials`
 * returns every token on the machine; this function takes the three
 * non-secret facts out and lets the rest go, so the object it returns — and
 * therefore the page — never holds a key. Never throws.
 */
function cloudConnectionView(): JevCloudConnectionView {
  let connected = false;
  let org: string | null = null;
  let host: string | null = null;
  try {
    const creds = readCredentials();
    const url = creds.cloud?.url ?? creds.ingest?.url ?? null;
    connected = url !== null;
    if (url !== null) {
      try {
        host = new URL(url).host;
      } catch {
        host = null;
      }
    }
    const o = creds.org;
    org = o ? (o.name && o.slug ? `${o.name} (${o.slug})` : (o.name ?? o.slug ?? o.id ?? null)) : null;
  } catch {
    // An unreadable file is "not connected" here, as it is to `config --status`.
  }
  let jev: JevCloudConnectionView["jev"] = "no";
  try {
    const slot = readJevCloudCredential().status;
    jev = slot === "ok" ? "yes" : slot === "refused" ? "refused" : "no";
  } catch {
    jev = "no";
  }
  return { connected, org, host, jev };
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
    cloud: cloudConnectionView(),
    path: inspection.path,
    permissions: null as string | null,
    provider: null as JevProviderKind | null,
    baseUrl: "",
    baseUrlQueryWithheld: false,
    accountId: "",
    model: { kind: "default" } as JevModelView,
    endpoint: null as string | null,
    mode: DEFAULT_JEV_MODE,
    timeoutMs: null as number | null,
    token: null as JevTokenPresence | null,
    problem: null as string | null,
    fix: null as string | null,
    reviewable: null as JevReviewabilityView | null,
  };

  if (inspection.status === "ok") {
    const cfg = inspection.config;
    return {
      ...base,
      status: "ok",
      on: true,
      permissions: octal(inspection.mode),
      provider: cfg.provider,
      ...baseUrlView(cfg.baseUrl),
      accountId: cfg.accountId ?? "",
      // A loadable config's model already passed `validateModel`, so this can
      // only be an id — run through the same gate anyway, because the gate is
      // what keeps that true if the loader's rules ever loosen.
      model: modelView(cfg.model ?? ""),
      endpoint: endpointFor(cfg),
      mode: cfg.mode ?? DEFAULT_JEV_MODE,
      timeoutMs: cfg.timeoutMs ?? null,
      // The key is read here and nothing derived from it leaves the function —
      // not a mask, not a fragment, not its length.
      token: { source: inspection.keySource },
      stats: await statsOrNull(true),
      reviewable: reviewableOrNull(true),
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
      ...baseUrlView(r.baseUrl),
      accountId: r.accountId ?? "",
      model: modelView(r.model ?? ""),
      endpoint: endpointFor({ ...r, apiKey: KEY_STAND_IN }),
      mode: r.mode ?? DEFAULT_JEV_MODE,
      timeoutMs: r.timeoutMs ?? null,
      // The file names the environment as the source and the variable is not
      // set here, so there is nothing present to hint at.
      token: null,
      problem: inspection.problem,
      fix: `set ${JEV_API_KEY_ENV}, or save a token here`,
      // Off in THIS process's environment only; hooks that have the variable
      // still consult Jev, and the activity store records what they did.
      stats: await statsOrNull(true),
    };
  }

  if (inspection.status === "off" || inspection.status === "not-connected" || inspection.status === "key-lacks-jev") {
    // Configured, and not running: switched off by its owner, or a FailproofAI
    // Cloud file on a machine with no Cloud key — not connected at all, or
    // connected with a key that has no Jev. Routing only, as for
    // `key-missing` — the loader's routing object carries no key to leak.
    const r = inspection.routing;
    return {
      ...base,
      status: inspection.status,
      on: false,
      permissions: octal(inspection.mode),
      provider: r.provider,
      ...baseUrlView(r.baseUrl),
      accountId: r.accountId ?? "",
      model: modelView(r.model ?? ""),
      endpoint: endpointFor({ ...r, apiKey: KEY_STAND_IN }),
      mode: r.mode ?? DEFAULT_JEV_MODE,
      timeoutMs: r.timeoutMs ?? null,
      token: inspection.status === "off" ? offTokenPresence(r.provider) : null,
      problem: inspection.status === "off" ? null : inspection.problem,
      fix:
        inspection.status === "not-connected"
          ? "connect this machine with a key that carries jev:evaluate: failproofai config --token <key>"
          : inspection.status === "key-lacks-jev"
            ? "reconnect this machine with a key that carries jev:evaluate: failproofai config --token <key>"
            : null,
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
      ...baseUrlView(r.baseUrl),
      accountId: r.accountId,
      // This is the branch the rule exists for: a file whose `model` slot holds
      // a pasted key IS a refused file, and these fields are copied raw.
      model: modelView(r.model),
      // Shown for the same reason `jev status` shows it: the owner needs to see
      // whether the endpoint a file they may not have written names is one they
      // chose. Null when the routing fields do not make a usable route.
      //
      // The model is left out of this probe deliberately. It does not appear in
      // any endpoint — `jevRoute` puts it in the request body, not the URL — but
      // `jevRoute` validates the whole config first, so a refused model would
      // hide the one field the owner is being asked to check.
      endpoint:
        r.provider === null
          ? null
          : endpointFor({
              provider: r.provider,
              apiKey: KEY_STAND_IN,
              ...(r.baseUrl ? { baseUrl: r.baseUrl } : {}),
              ...(r.accountId ? { accountId: r.accountId } : {}),
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
