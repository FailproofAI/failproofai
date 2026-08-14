/**
 * `VERSION`, `config.json` and `credentials.json` — the three files a human
 * might actually open in `~/.failproofai`.
 *
 * ## Why the split
 *
 * `config.json` inherits the umask and lands at 0664 on a normal machine.
 * `credentials.json` is written 0600 and holds every token. That boundary is
 * not tidiness: it is why `ingest.json` and `cloud.json` were separate files
 * before this, and it means CI, tooling and a screen-shared `cat config.json`
 * can read a machine's configuration without ever seeing a live credential.
 *
 * ## One format, not two
 *
 * These were TOML through layout 2, for the comments — the file explained what
 * `oss` meant and why `daemon.configured` must never be hand-set. Layout 3
 * moved them to JSON so the home speaks one format end to end: one parser, one
 * escaping rule, and no `toml` dependency in either the CLI or the daemon for
 * files that were always flat key/value.
 *
 * The comments are the cost, and they were not decoration — this is the file
 * someone opens when something is wrong. That guidance now lives in
 * `failproofai config --status` and the docs, which is a worse place for it.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { version as cliVersion } from "../../package.json";
import {
  LAYOUT_VERSION,
  configFile,
  credentialsFile,
  failproofaiHome,
  legacy,
  versionFile,
} from "./fp-home";

// ── VERSION ──────────────────────────────────────────────────────────────────

export interface VersionFile {
  /** The on-disk layout this home was written by. */
  layout: number;
  /** The CLI version that last wrote it — replaces the old `last-version`. */
  cli: string;
  /** The daemon binary version installed, if any. */
  daemon?: string;
}

export type LayoutState =
  /** No home yet, or an empty one. A fresh install. */
  | { kind: "absent" }
  /** A home written by this layout. `inferred` means the layout was recovered
   *  from a landmark because `VERSION` was missing or unreadable — the caller
   *  should write the marker back. */
  | { kind: "current"; version: VersionFile; inferred?: boolean }
  /** A home from an older layout — must be reset, never half-read. */
  | { kind: "stale"; found: number }
  /** A home from a NEWER layout: a downgrade. Refuse rather than corrupt it. */
  | { kind: "future"; found: number };

/**
 * What layout the home on disk speaks.
 *
 * The `VERSION` file is the primary signal; its absence is only treated as
 * "layout 1" when the home actually contains something, because an empty or
 * missing directory is a fresh install and must not be reported as stale.
 *
 * A NEWER layout is called out separately from an older one. Both are
 * unreadable, but only one of them is fixable by re-running setup — telling a
 * user to reset a home written by a newer CLI would delete data that a simple
 * upgrade would have read fine.
 */
export function detectLayout(): LayoutState {
  const raw = readVersionFile();
  if (raw) {
    if (raw.layout === LAYOUT_VERSION) return { kind: "current", version: raw };
    return raw.layout > LAYOUT_VERSION
      ? { kind: "future", found: raw.layout }
      : { kind: "stale", found: raw.layout };
  }

  // No VERSION file — fall back to landmarks.
  //
  // ORDER MATTERS, because layout 3 collides with layout 1 on one of them.
  // Layout 3 put `policies-config.json` back at the home root, which is exactly
  // where layout 1 kept it. A layout-3 home that lost its VERSION would
  // therefore match a layout-1 landmark and be reported as layout 1 — and
  // `resetHome(1)` runs layout-1 MIGRATIONS, which move `policies/*.mjs` on the
  // assumption they are in layout 1's positions. In layout 3 those are the
  // user's own convention policies, sitting where they belong.
  //
  // So check for a marker only the newer layouts have first — and DISTINGUISH
  // them, because the two answers are not equally safe.
  //
  // `config.json` is layout 3's OWN file. Layout 2 wrote `config.toml`, layout 1
  // had neither, and nothing but setup writes either one. So its presence does
  // not merely prove "newer than layout 1" — it identifies THIS layout, and the
  // only thing actually missing is the marker. Reporting it as stale instead ran
  // a destructive reset over a healthy machine: `resettablePaths()` lists
  // `configFile()` and `credentialsFile()`, so the home lost its live cloud
  // token AND `daemon.configured` — which is what makes a machine fail closed.
  // A machine that dropped out of fail-closed enforcement because a marker file
  // went missing is the exact failure this module exists to prevent, and it
  // announced itself as a routine "reorganised your home" message.
  if (existsSync(configFile())) {
    // `config.json` proves layout 3 OR LATER — it cannot tell them apart, since
    // layout 4 changed nothing about it. What separates the two is solely WHERE
    // the audit's files sit, so ask that directly: any of layout 3's three
    // root-level positions still occupied means the 3 → 4 move has not run.
    //
    // When none of them exist the two layouts are IDENTICAL on disk (the step
    // would move nothing), and "current" is the correct, non-destructive answer.
    const layoutThreePositions = [
      legacy.authJson(),
      legacy.nextAudit(),
      legacy.auditSchedule(),
    ];
    if (layoutThreePositions.some((p) => existsSync(p))) return { kind: "stale", found: 3 };

    // `inferred`: the layout is right but the MARKER is missing, and nothing
    // else rewrites it — so every later command re-derives it from a landmark,
    // and the daemon version recorded in that file is gone for good
    // (`daemonVersionSkew()` reads it, and stops nudging about a stale daemon).
    // The caller re-stamps, exactly as it already does for a fresh home.
    return { kind: "current", version: { layout: LAYOUT_VERSION, cli: "" }, inferred: true };
  }

  // `config.toml` and no `config.json` is genuinely layout 2, and a reset is
  // right: its files are the ones being replaced.
  //
  // The literal 2, NOT `LAYOUT_VERSION - 1`. That expression was correct while
  // current was 3 and became a data-loss bug the moment layout 4 landed: it
  // reported a real layout-2 home as layout 3, so `planMigration` ran only the
  // 3 → 4 step — which finds none of layout 3's files, moves nothing, and stamps
  // the home as current. `config.toml` and `credentials.toml` would never be
  // carried into JSON, orphaning the cloud token and `daemon.configured` on a
  // machine that now reads as fully migrated. A landmark identifies ONE layout;
  // it is never relative to whatever this build happens to speak.
  if (existsSync(legacy.configToml())) return { kind: "stale", found: 2 };

  // Layout 1 if any of its landmarks are present, otherwise this is simply a
  // home that has not been set up yet.
  const layoutOneMarkers = [
    legacy.policyConfig(),
    legacy.cacheDir(),
    legacy.launcherMarker(),
    legacy.lastVersion(),
    legacy.cloudCredentials(),
    legacy.ingestCredentials(),
    legacy.auditDashboard(),
  ];
  return layoutOneMarkers.some((p) => existsSync(p)) ? { kind: "stale", found: 1 } : { kind: "absent" };
}

/**
 * Read a layout-2 `VERSION`, which is TOML.
 *
 * Layout 3 made this file JSON, so `JSON.parse` throws on every layout-2 home —
 * and "unreadable" is NOT a harmless answer here. It sends `detectLayout()` to
 * the landmarks, and a layout-2 home whose owner never completed setup has no
 * `config.toml` to match: it falls through every layout-1 marker too (layout 2
 * nested `policies-config.json`, so the root file layout 1 is recognised by is
 * absent) and reads as `absent` — a FRESH INSTALL. The CLI then stamps it
 * layout 3 with no reset and no migration, and
 * `policies/local-policies/policies-config.json` plus
 * `policies/custom-policies/*.mjs` are orphaned permanently: the user's enabled
 * policies revert to the defaults, their own policy files stop loading, and
 * nothing says so. Reproduced exactly that way on a seeded home.
 *
 * A regex rather than a TOML parser because removing that dependency is half
 * the point of layout 3, and this file is three flat `key = value` lines that
 * this codebase itself wrote.
 *
 * ALL THREE fields are read, including `daemon`. It is tempting to take only the
 * layout number on the grounds that the home is about to be reset — but
 * `writeVersionFile()` carries the daemon version forward from `existing?.daemon`,
 * so a field missing here is not re-derived, it is ERASED. The machine then
 * reports "daemon not installed" with the binary sitting in `bin/`, and
 * `daemonVersionSkew()` stops nudging about a stale daemon precisely when an
 * upgrade has just happened.
 */
function readLegacyTomlVersion(text: string): VersionFile | null {
  const layout = Number(/^\s*layout\s*=\s*(\d+)\s*$/m.exec(text)?.[1]);
  if (!Number.isFinite(layout)) return null;
  const str = (key: string) => new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m").exec(text)?.[1];
  return { layout, cli: str("cli") ?? "", daemon: str("daemon") };
}

export function readVersionFile(): VersionFile | null {
  let text: string;
  try {
    text = readFileSync(versionFile(), "utf8");
  } catch {
    // Absent or unreadable. The landmark check decides what that implies.
    return null;
  }
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const layout = Number(parsed.layout);
    if (!Number.isFinite(layout)) return null;
    return {
      layout,
      cli: typeof parsed.cli === "string" ? parsed.cli : "",
      daemon: typeof parsed.daemon === "string" ? parsed.daemon : undefined,
    };
  } catch {
    // Not JSON. Before concluding "no layout", try the one other format this
    // file has ever had — see `readLegacyTomlVersion` for what guessing wrong
    // costs. Genuinely corrupt content still yields null from there.
    return readLegacyTomlVersion(text);
  }
}

/**
 * Stamp `VERSION`.
 *
 * `layout` defaults to {@link LAYOUT_VERSION} — every ordinary caller is saying
 * "this home now speaks what this build speaks". It is honoured when passed
 * ONLY so a failed migration can put the marker back where the home actually
 * is: the signature has always accepted `layout` (it is part of `VersionFile`)
 * and the body used to ignore it, so a caller asking for 3 silently got 4, and
 * the one place that needs to ask is the one place where being wrong strands a
 * half-migrated home as "current" forever. See `runMigrations`.
 */
export function writeVersionFile(
  v: Partial<VersionFile> & { /** Erase the daemon version rather than keeping it. */ clearDaemon?: boolean } = {},
): void {
  const existing = readVersionFile();
  const next: VersionFile = {
    layout: v.layout ?? LAYOUT_VERSION,
    cli: v.cli ?? cliVersion,
    // `undefined` means "leave whatever is there" — a CLI-only rewrite must not
    // drop a daemon version it never touched. Erasing it is therefore an
    // explicit act, used on uninstall.
    daemon: v.clearDaemon ? undefined : (v.daemon ?? existing?.daemon),
  };
  writeFileAt(
    versionFile(),
    `${JSON.stringify(
      { layout: next.layout, cli: next.cli, ...(next.daemon ? { daemon: next.daemon } : {}) },
      null,
      2,
    )}\n`,
  );
}

// ── config.json ──────────────────────────────────────────────────────────────

/**
 * How this machine relates to FailproofAI Cloud.
 *
 * `oss` is not merely "no credentials configured" — it is a hard gate. In OSS
 * mode nothing constructs a cloud URL, polls for policy, or spools an event
 * for upload. A machine that never opted in must be provably silent, not
 * silent-by-happenstance because a token lookup returned undefined.
 */
export type Mode = "oss" | "cloud";

export interface FpConfig {
  mode: Mode;
  daemon: {
    /**
     * Route hooks through the daemon — and FAIL CLOSED when it is unreachable.
     *
     * The installed binary VERSION deliberately does not live here; it is in
     * `VERSION`, which is the file about versions. Two copies could disagree,
     * and a stale one would misreport which daemon a machine is running.
     */
    configured: boolean;
  };
  collector: {
    sessions: boolean;
    hooks: boolean;
    hooksVerbosity: "all" | "decisions" | "off";
    redact: "minimal" | "off";
    environment: string;
    machineId?: string;
    /**
     * Extra locations to capture per harness, beyond the one each source ships
     * with — `collector.sources.<harness>.extra_paths` in `config.json`.
     *
     * Each entry is `label=path` or a bare `path`; the label becomes an agent-id
     * namespace (`<label>-<agentId>`), which is what keeps two copies of one
     * project from merging into a single agent. The daemon is the authority on
     * the grammar and on which harness names are real — see
     * `crates/fpai-collect/src/extra_paths.rs` and `HARNESS_KEYS` in
     * `crates/failproofaid/src/main.rs`. This side stores and edits the strings;
     * it deliberately does not re-implement the parser, because two parsers is
     * how the CLI comes to accept a path the daemon then silently drops.
     *
     * Absent for every machine that has not configured one, which is almost all
     * of them — so `writeConfig` emits nothing at all in that case and a config
     * file is byte-identical to what this version wrote before the field
     * existed.
     */
    sources?: Record<string, { extraPaths: string[] }>;
  };
  telemetry: {
    /**
     * Anonymous product telemetry. On unless switched off.
     *
     * This is the ONLY off-switch that can reach the daemon.
     * `FAILPROOFAI_TELEMETRY_DISABLED=1` is read from `process.env`, and
     * failproofaid runs as a system-scope service whose environment carries
     * essentially nothing — so a shell export is structurally incapable of
     * turning it off there. A file both sides read is the only thing that works.
     */
    enabled: boolean;
  };
  audit: {
    /**
     * Scan this machine on a schedule, and mail a digest when a scan finds
     * something harmful.
     *
     * ONE switch, not two. An earlier revision split this into `auto` (scan
     * locally, no account) and `email_enabled` (mail me, sign in), and the two
     * could only ever disagree — a machine scanning on a timer with nothing to
     * report it to is a feature that looks on and does nothing visible. The
     * reason to put a scan on a timer is to be TOLD, so scheduling and mailing
     * are the same decision and take the same switch.
     *
     * A signed-out machine with this on is therefore a real, expected state
     * rather than a contradiction: it keeps scanning and keeps its local
     * dashboard current, and the UI says "signed out" until somebody signs back
     * in. Auth gates SETTING it up, never the machine's ongoing work — a
     * refresh token expiring must not silently switch off a background feature
     * somebody configured months ago.
     *
     * OFF by default, and the asymmetry with `telemetry.enabled` above is
     * deliberate: the audit reads the CONTENTS of every session transcript on
     * disk — prompts, file contents, command output — so nothing scans on a
     * timer until somebody asks for it.
     */
    auto: boolean;
    /** Days between scheduled runs. Wall clock, so it survives suspend. */
    intervalDays: number;
  };
}

/**
 * Days between scheduled audits when nothing says otherwise, and the bounds a
 * hand-written value is held to.
 *
 * Both ends fail quietly, which is why they are clamped at all. A measured full
 * scan is ~104 seconds over 3,277 transcripts and grows with history, so an
 * interval under a day spends minutes of disk every day re-reading transcripts
 * that have barely changed. At the other end a typo'd `interval_days = 3650`
 * reads as "never", which on a status line is indistinguishable from the
 * feature being broken — and "never" already has its own switch, `auto = false`.
 */
export const DEFAULT_AUDIT_INTERVAL_DAYS = 7;
const MIN_AUDIT_INTERVAL_DAYS = 1;
const MAX_AUDIT_INTERVAL_DAYS = 90;

/**
 * Resolve `interval_days`, refusing anything that is not a whole number of days.
 *
 * 0, a negative, a fraction below a day, and any non-number all resolve to the
 * DEFAULT rather than clamping up to the 1-day floor. A `0` almost certainly
 * means "off", and reading it as a DAILY 104-second scan of every transcript on
 * the machine is the loudest possible way to get that wrong. A too-large value
 * is clamped DOWN to 90 instead, because that is the conservative direction of
 * the two available: falling back to 7 there would scan an order of magnitude
 * more often than was asked for.
 */
function readIntervalDays(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_AUDIT_INTERVAL_DAYS;
  const days = Math.floor(raw);
  if (days < MIN_AUDIT_INTERVAL_DAYS) return DEFAULT_AUDIT_INTERVAL_DAYS;
  return Math.min(days, MAX_AUDIT_INTERVAL_DAYS);
}

export const DEFAULT_CONFIG: FpConfig = {
  mode: "oss",
  daemon: { configured: false },
  collector: {
    sessions: false,
    hooks: true,
    hooksVerbosity: "decisions",
    redact: "minimal",
    environment: "local",
  },
  telemetry: { enabled: true },
  audit: { auto: false, intervalDays: DEFAULT_AUDIT_INTERVAL_DAYS },
};

/**
 * `[collector.sources.*]` → the in-memory shape, dropping anything unusable.
 *
 * Entries are kept as written rather than normalised. The daemon parses them
 * (label derivation, overlap rejection, `~` expansion) and reports what it
 * rejected at startup; normalising here would give the two sides two answers
 * and hide the daemon's rejection behind a value the CLI had already rewritten.
 * The only things dropped are shapes that could not survive a round trip at
 * all — a non-array, or a non-string element.
 *
 * `undefined` rather than `{}` when nothing is configured, so `writeConfig`
 * emits no table and an untouched config file keeps its exact previous bytes.
 */
function readSources(raw: unknown): FpConfig["collector"]["sources"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, { extraPaths: string[] }> = {};
  for (const [name, table] of Object.entries(raw as Record<string, unknown>)) {
    if (!table || typeof table !== "object" || Array.isArray(table)) continue;
    const entries = (table as Record<string, unknown>).extra_paths;
    if (!Array.isArray(entries)) continue;
    const paths = entries.filter((e): e is string => typeof e === "string" && e.trim() !== "");
    if (paths.length > 0) out[name] = { extraPaths: paths };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * {@link readConfig}, plus the raw object it was projected from.
 *
 * `readConfig` is a WHITELIST PROJECTION, not a merge: it names every key it
 * understands and builds a fresh `FpConfig`. Paired with a `writeConfig` that
 * regenerates the file wholesale, that means **any key this build does not know
 * is erased on the next write** — and that is a data-loss bug with no layout
 * change involved at all. Two CLI versions on the same layout round-trip the
 * file and silently delete each other's keys, and most releases do not bump the
 * layout, so `detectLayout()`'s `future` refusal never fires to protect it.
 *
 * `collector.sources` is the live example: added inside layout 3, so a CLI that
 * predates it drops every extra path a user typed on the first `updateConfig()`
 * call — from `harness add-path`, which is the one command whose entire output is
 * that key.
 *
 * So every mutation path reads the raw object and hands it back to `writeConfig`,
 * which preserves what it does not own. `readConfig` stays as it was for the many
 * read-only callers that genuinely only want the projection.
 */
export function readConfigRaw(): { raw: Record<string, unknown>; config: FpConfig } {
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(configFile(), "utf8")) as unknown;
    // An array or a scalar is not a config object, and spreading one into the
    // merge below would produce index keys. Anything unusable reads as empty,
    // which is what the projection already falls back to.
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      raw = parsed as Record<string, unknown>;
    }
  } catch {
    // Absent or unparseable. `readConfig` returns defaults for the same input;
    // an empty raw means the write below carries nothing forward, which is the
    // only honest answer when the previous bytes could not be read.
  }
  return { raw, config: readConfig() };
}

export function readConfig(): FpConfig {
  try {
    const parsed = JSON.parse(readFileSync(configFile(), "utf8")) as Record<string, unknown>;
    return projectConfig(parsed);
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

/**
 * Project a parsed config object onto {@link FpConfig}.
 *
 * Split out of `readConfig` so the layout-2 → 3 carry can run the SAME
 * projection over a `config.toml` it parsed itself, rather than a second reader
 * that has to be kept in step with this one. The two formats use identical key
 * names (`hooks_verbosity`, `machine_id`, `interval_days`,
 * `sources.<h>.extra_paths`), so the only difference between them is how the
 * bytes become an object — and once that is a parameter there is nothing left to
 * drift. Every failure-direction decision below is therefore made once, for both.
 */
export function projectConfig(parsed: Record<string, unknown>): FpConfig {
  {
    const mode = (parsed.mode as Record<string, unknown> | undefined)?.kind;
    const daemon = (parsed.daemon ?? {}) as Record<string, unknown>;
    const collector = (parsed.collector ?? {}) as Record<string, unknown>;
    const telemetry = (parsed.telemetry ?? {}) as Record<string, unknown>;
    const audit = (parsed.audit ?? {}) as Record<string, unknown>;
    return {
      // Anything unrecognised reads as `oss`. The failure direction matters: a
      // corrupt config must not be able to turn cloud reporting ON.
      //
      // This is a real check rather than `?? "oss"`, which only caught a MISSING
      // mode and passed every present-but-unknown value straight through — so
      // `"enterprise"`, or a typo like `"clod"`, became the machine's mode. The
      // test named for this branch was writing a TOML body into a `.json` file,
      // so the parse failed, the whole function fell to its defaults, and the
      // assertion passed without the branch ever running.
      mode: mode === "cloud" ? "cloud" : "oss",
      daemon: { configured: daemon.configured === true },
      collector: {
        sessions: collector.sessions === true,
        hooks: collector.hooks !== false,
        hooksVerbosity:
          collector.hooks_verbosity === "all" || collector.hooks_verbosity === "off"
            ? collector.hooks_verbosity
            : "decisions",
        redact: collector.redact === "off" ? "off" : "minimal",
        environment:
          typeof collector.environment === "string" ? collector.environment : "local",
        machineId: typeof collector.machine_id === "string" ? collector.machine_id : undefined,
        sources: readSources(collector.sources),
      },
      // Only an explicit `false` switches it off. Absent, or any other value,
      // reads as on — the shipped default, and what a config with no
      // [telemetry] block at all means.
      telemetry: { enabled: telemetry.enabled !== false },
      // Mirror image of telemetry above: only an explicit `true` switches the
      // scheduled scan on. Absent, misspelled, or `"yes"` all read as off,
      // because the failure direction here is a machine that starts reading
      // every transcript it can find on a timer nobody set.
      audit: { auto: audit.auto === true, intervalDays: readIntervalDays(audit.interval_days) },
      // Same shape as `audit.auto` above and for the same reason: only an
      // explicit `true` opts in. Anything else — absent, misspelled, `"yes"` —
      // reads as off, because the failure direction is a machine that starts
      // mailing a report nobody asked for to an org address it never sees.
    };
  }
}

/**
 * Every key `writeConfig` owns, as a path into the emitted JSON.
 *
 * Ownership is what makes preserving unknown keys safe in BOTH directions, and
 * getting the direction wrong is a bug either way:
 *
 *  - An **owned** key absent from the projection is a DELIBERATE OMISSION and
 *    must be deleted. `writeConfig` uses absence to express state — `telemetry`
 *    is emitted only when switched off, `machine_id` only when set, `sources`
 *    only when non-empty. Merging blindly over the old bytes would resurrect
 *    them, so switching telemetry back on would leave `enabled: false` in the
 *    file and the opt-out would become un-revokable.
 *  - An **unowned** key belongs to a build that knows more than this one and
 *    must survive. That is the bug this list exists to fix; see
 *    {@link readConfigRaw}.
 *
 * A `"*"` segment matches every key at that level. `collector.sources` is keyed
 * by harness name, so its paths cannot be enumerated — and owning the subtree
 * wholesale would delete a future per-harness sibling of `extra_paths`, which is
 * the same class of loss one level down.
 *
 * Held honest by `config-round-trip.test.ts`, which populates every optional
 * field, runs `writeConfig`, and asserts the emitted key set is exactly this.
 */
const OWNED_CONFIG_KEYS: readonly (readonly string[])[] = [
  ["mode", "kind"],
  ["daemon", "configured"],
  ["collector", "sessions"],
  ["collector", "hooks"],
  ["collector", "hooks_verbosity"],
  ["collector", "redact"],
  ["collector", "environment"],
  ["collector", "machine_id"],
  ["collector", "sources", "*", "extra_paths"],
  ["telemetry", "enabled"],
  ["audit", "auto"],
  ["audit", "interval_days"],
];

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Remove one owned path, pruning any container the removal emptied.
 *
 * The pruning is not tidiness. Without it, deleting `telemetry.enabled` from a
 * file that held nothing else under `[telemetry]` leaves `telemetry: {}` — so a
 * default install would stop producing the byte-identical file that
 * `readSources` and `writeConfig` both document, and every fixture asserting
 * exact bytes would drift. A container that still holds an UNKNOWN key is never
 * pruned, which is the whole point.
 */
function deleteOwnedPath(node: Record<string, unknown>, path: readonly string[]): void {
  const [head, ...rest] = path;
  if (head === undefined) return;
  const keys = head === "*" ? Object.keys(node) : [head];
  for (const key of keys) {
    if (rest.length === 0) {
      delete node[key];
      continue;
    }
    const child = node[key];
    if (!isPlainObject(child)) continue;
    deleteOwnedPath(child, rest);
    if (Object.keys(child).length === 0) delete node[key];
  }
}

/** Deep-merge `patch` onto `base`, recursing only where both sides are objects. */
function mergeOnto(base: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    const existing = base[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      mergeOnto(existing, value);
    } else {
      base[key] = value;
    }
  }
}

/**
 * Regenerates the keys `config.json` owns, preserving every key it does not.
 *
 * The layout-2 file was hand-written TOML carrying its own documentation — what
 * `oss` meant, why `daemon.configured` must never be hand-set. JSON cannot hold
 * a comment, so that guidance now lives in `failproofai config --status` and the
 * docs. It is a real loss on the one file a user opens when something is wrong;
 * the trade is one serialisation format across the whole home instead of two.
 *
 * `raw` is the object the projection came from — pass it whenever you have one
 * ({@link readConfigRaw} returns both together). Omitting it re-reads the file,
 * which is the safe default: a caller who forgets still preserves, where the
 * alternative silently erases. Pass `{}` deliberately to write a clean file.
 */
export function writeConfig(config: FpConfig, raw?: Record<string, unknown>): void {
  const c = config.collector;
  const out: Record<string, unknown> = {
    mode: { kind: config.mode },
    daemon: { configured: config.daemon.configured },
    collector: {
      sessions: c.sessions,
      hooks: c.hooks,
      hooks_verbosity: c.hooksVerbosity,
      redact: c.redact,
      environment: c.environment,
      // Omitted when unset rather than written null: the Rust side treats an
      // absent machine_id as "derive one", and an explicit null is not that.
      ...(c.machineId ? { machine_id: c.machineId } : {}),
      // Extra capture paths per harness. Emitted ONLY when non-empty, so a
      // machine that never configured one gets a file byte-identical to what
      // this function produced before the field existed — the same reasoning as
      // `telemetry` below. (In TOML this also had to come after every scalar of
      // `[collector]`, or the scalars after it read as belonging to the
      // sub-table. JSON has no such ordering hazard, which is one of the things
      // the format change buys.)
      ...(Object.entries(c.sources ?? {}).some(([, s]) => s.extraPaths?.length)
        ? {
            sources: Object.fromEntries(
              Object.entries(c.sources ?? {})
                .filter(([, s]) => s.extraPaths?.length)
                .map(([name, s]) => [name, { extra_paths: s.extraPaths }]),
            ),
          }
        : {}),
    },
    // Written ONLY when switched off. A default install therefore carries no
    // telemetry block at all, but an operator who switched it off keeps it:
    // this function regenerates the file wholesale, so emitting the key only
    // when it is set is what stops a later rewrite from silently switching
    // telemetry back on underneath them.
    ...(config.telemetry.enabled ? {} : { telemetry: { enabled: false } }),
    // Written ALWAYS, unlike telemetry directly above — the two are opposites
    // on purpose. Telemetry ships on and is deliberately not advertised;
    // the scheduled audit ships off and is meant to be FOUND, and a switch
    // nobody can see is the same as a switch that does not exist. Emitting both
    // keys unconditionally also makes "a user's setting survives a rewrite"
    // total rather than conditional.
    audit: { auto: config.audit.auto, interval_days: config.audit.intervalDays },
  };
  // Start from the previous bytes, strip the keys this build owns — so an
  // omission above really removes — then lay the projection on top. What is left
  // untouched in between is exactly the set of keys a newer build wrote and this
  // one has never heard of.
  const merged = structuredClone(raw ?? readConfigRaw().raw);
  for (const path of OWNED_CONFIG_KEYS) deleteOwnedPath(merged, path);
  mergeOnto(merged, out);
  writeFileAt(configFile(), `${JSON.stringify(merged, null, 2)}\n`);
}

/** Merge a partial update into the config on disk. */
export function updateConfig(patch: {
  mode?: Mode;
  daemon?: Partial<FpConfig["daemon"]>;
  collector?: Partial<FpConfig["collector"]>;
  telemetry?: Partial<FpConfig["telemetry"]>;
  audit?: Partial<FpConfig["audit"]>;
}): FpConfig {
  // `readConfigRaw`, not `readConfig` — this is the function EVERY mutation path
  // goes through (the wizard, `harness add-path`, `healDaemonFlag`, the telemetry
  // opt-out), so carrying the raw object here is what makes unknown-key
  // preservation total rather than per-caller.
  const { raw, config: current } = readConfigRaw();
  const next: FpConfig = {
    mode: patch.mode ?? current.mode,
    daemon: { ...current.daemon, ...patch.daemon },
    collector: { ...current.collector, ...patch.collector },
    telemetry: { ...current.telemetry, ...patch.telemetry },
    audit: { ...current.audit, ...patch.audit },
  };
  writeConfig(next, raw);
  return next;
}

// ── credentials.json ─────────────────────────────────────────────────────────

export interface FpCredentials {
  cloud?: { url: string; machineId: string; token: string; machineLabel?: string };
  /**
   * Which organisation this machine's credentials report into, as the server
   * named it at connect time (`/v1/auth/introspect`).
   *
   * ONE table, not a field on `[cloud]` and `[ingest]` both: it describes the
   * TOKEN, and connect uses the same token for both capabilities, so two copies
   * could only ever drift or disagree. It also has to survive the case that
   * motivated recording it at all — an `events:add`-only key, which configures
   * ingest and never writes `[cloud]`.
   *
   * Recorded so `--status` can answer "where does this machine's data go?"
   * with no network call: the question asked when a dashboard looks empty, and
   * the one a key pasted from the wrong org gets silently wrong. Absent against
   * a server predating introspect, and in files written by an older CLI.
   */
  org?: { id?: string; slug?: string; name?: string };
  ingest?: { url: string; key: string };
  auth?: { baseUrl?: string; sessionToken?: string; expiresAt?: number; email?: string };
}

/**
 * Every key `writeCredentials` owns. Same contract as {@link OWNED_CONFIG_KEYS},
 * same reason — `readCredentials` is a whitelist projection too, and
 * `writeCredentials` regenerates the file wholesale.
 *
 * `org` is the live example on this side: its own doc records that it is "absent
 * against a server predating introspect, and in files written by an older CLI" —
 * which is precisely a key an older CLI would delete on write, taking with it the
 * only local answer to "where does this machine's data go?".
 */
const OWNED_CREDENTIAL_KEYS: readonly (readonly string[])[] = [
  ["cloud", "url"],
  ["cloud", "machine_id"],
  ["cloud", "machine_label"],
  ["cloud", "token"],
  ["org", "id"],
  ["org", "slug"],
  ["org", "name"],
  ["ingest", "url"],
  ["ingest", "key"],
  ["auth", "base_url"],
  ["auth", "session_token"],
  ["auth", "expires_at"],
  ["auth", "email"],
];

/** {@link readCredentials}, plus the raw object it was projected from. */
export function readCredentialsRaw(): { raw: Record<string, unknown>; credentials: FpCredentials } {
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(credentialsFile(), "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      raw = parsed as Record<string, unknown>;
    }
  } catch {
    // Absent or unparseable — nothing to carry forward.
  }
  return { raw, credentials: readCredentials() };
}

export function readCredentials(): FpCredentials {
  try {
    return projectCredentials(
      JSON.parse(readFileSync(credentialsFile(), "utf8")) as Record<string, unknown>,
    );
  } catch {
    return {};
  }
}

/**
 * Project a parsed credentials object onto {@link FpCredentials}.
 *
 * Split out for the reason {@link projectConfig} is: the layout-2 → 3 carry
 * parses `credentials.toml` itself and needs the SAME validation, not a copy of
 * it. The validation is the part worth not duplicating — "a cloud block without
 * a token is not a cloud block" is a security property, and two readers
 * disagreeing about it is how a half-written credential gets treated as live.
 */
export function projectCredentials(parsed: Record<string, unknown>): FpCredentials {
  {
    const cloud = parsed.cloud as Record<string, unknown> | undefined;
    const ingest = parsed.ingest as Record<string, unknown> | undefined;
    const auth = parsed.auth as Record<string, unknown> | undefined;
    const out: FpCredentials = {};
    if (
      cloud &&
      typeof cloud.url === "string" &&
      typeof cloud.machine_id === "string" &&
      typeof cloud.token === "string" &&
      cloud.url &&
      cloud.token
    ) {
      const machineLabel =
        typeof cloud.machine_label === "string" && cloud.machine_label ? cloud.machine_label : undefined;
      out.cloud = { url: cloud.url, machineId: cloud.machine_id, token: cloud.token, machineLabel };
    }
    const org = parsed.org as Record<string, unknown> | undefined;
    if (org) {
      // Every field independently optional: a server may send fewer than three,
      // and a partial org record is still better than none for `--status`.
      const pick = (v: unknown) => (typeof v === "string" && v ? v : undefined);
      const built = { id: pick(org.id), slug: pick(org.slug), name: pick(org.name) };
      if (built.id || built.slug || built.name) out.org = built;
    }
    if (ingest && typeof ingest.url === "string" && typeof ingest.key === "string" && ingest.url && ingest.key) {
      out.ingest = { url: ingest.url, key: ingest.key };
    }
    if (auth) {
      out.auth = {
        baseUrl: typeof auth.base_url === "string" ? auth.base_url : undefined,
        sessionToken: typeof auth.session_token === "string" ? auth.session_token : undefined,
        expiresAt: typeof auth.expires_at === "number" ? auth.expires_at : undefined,
        email: typeof auth.email === "string" ? auth.email : undefined,
      };
    }
    return out;
  }
}

/**
 * Write credentials at 0600, tightening the home that holds them.
 *
 * A 0600 file inside a 0775 directory is still reachable by every local user,
 * so the directory is tightened too. `mode` on `writeFileSync` applies only
 * when the file is CREATED, so an existing over-permissive file keeps its mode
 * without the explicit chmod.
 */
export function writeCredentials(creds: FpCredentials, raw?: Record<string, unknown>): void {
  const out: Record<string, unknown> = {};
  if (creds.cloud) {
    out.cloud = {
      url: creds.cloud.url,
      machine_id: creds.cloud.machineId,
      ...(creds.cloud.machineLabel ? { machine_label: creds.cloud.machineLabel } : {}),
      token: creds.cloud.token,
    };
  }
  if (creds.ingest) {
    out.ingest = { url: creds.ingest.url, key: creds.ingest.key };
  }
  if (creds.org && (creds.org.id || creds.org.slug || creds.org.name)) {
    out.org = {
      ...(creds.org.id ? { id: creds.org.id } : {}),
      ...(creds.org.slug ? { slug: creds.org.slug } : {}),
      ...(creds.org.name ? { name: creds.org.name } : {}),
    };
  }
  if (creds.auth && (creds.auth.sessionToken || creds.auth.email)) {
    out.auth = {
      ...(creds.auth.baseUrl ? { base_url: creds.auth.baseUrl } : {}),
      ...(creds.auth.sessionToken ? { session_token: creds.auth.sessionToken } : {}),
      ...(creds.auth.expiresAt ? { expires_at: creds.auth.expiresAt } : {}),
      ...(creds.auth.email ? { email: creds.auth.email } : {}),
    };
  }

  // Same three-step as `writeConfig`: previous bytes, minus the keys this build
  // owns, plus the projection. An unowned key here is a credential a newer build
  // stored, and deleting one costs the machine an enrolment it cannot re-derive.
  const merged = structuredClone(raw ?? readCredentialsRaw().raw);
  for (const path of OWNED_CREDENTIAL_KEYS) deleteOwnedPath(merged, path);
  mergeOnto(merged, out);

  const home = failproofaiHome();
  mkdirSync(home, { recursive: true });
  try {
    if (statSync(home).mode & 0o077) chmodSync(home, 0o700);
  } catch {
    // Not fatal: the file's own 0600 is the primary protection.
  }
  writeFileSync(credentialsFile(), `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(credentialsFile(), 0o600);
  } catch {
    /* best effort on filesystems without POSIX modes */
  }
}

/** True when this machine has any cloud credential at all. */
export function hasCloudCredentials(): boolean {
  const c = readCredentials();
  return Boolean(c.cloud || c.ingest);
}

function writeFileAt(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
}
