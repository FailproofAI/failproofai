/**
 * `VERSION`, `config.toml` and `credentials.toml` — the three files a human
 * might actually open in `~/.failproofai`.
 *
 * ## Why the split
 *
 * `config.toml` inherits the umask and lands at 0664 on a normal machine.
 * `credentials.toml` is written 0600 and holds every token. That boundary is
 * not tidiness: it is why `ingest.json` and `cloud.json` were separate files
 * before this, and it means CI, tooling and a screen-shared `cat config.toml`
 * can read a machine's configuration without ever seeing a live credential.
 *
 * ## Why TOML here and JSON elsewhere
 *
 * These three files are the ones a person edits by hand, so they get comments
 * and a forgiving syntax. Everything the machine writes on a hot path — the
 * builtin policy set, cursors, collector health, the spool — stays JSON,
 * parsed by the runtime's own native parser with no dependency and no import
 * cost. A TOML parser on the per-tool-call path would be paying a
 * human-ergonomics tax on a latency budget that exists precisely because
 * per-call work was too expensive.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse as parseToml } from "smol-toml";
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
  /** A home written by this layout. */
  | { kind: "current"; version: VersionFile }
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

  // No VERSION file. Layout 1 if any of its landmarks are present, otherwise
  // this is simply a home that has not been set up yet.
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

export function readVersionFile(): VersionFile | null {
  try {
    const parsed = parseToml(readFileSync(versionFile(), "utf8")) as Record<string, unknown>;
    const layout = Number(parsed.layout);
    if (!Number.isFinite(layout)) return null;
    return {
      layout,
      cli: typeof parsed.cli === "string" ? parsed.cli : "",
      daemon: typeof parsed.daemon === "string" ? parsed.daemon : undefined,
    };
  } catch {
    // Absent, unreadable, or malformed. All three mean "cannot prove a
    // layout", and the landmark check above decides what that implies.
    return null;
  }
}

export function writeVersionFile(
  v: Partial<VersionFile> & { /** Erase the daemon version rather than keeping it. */ clearDaemon?: boolean } = {},
): void {
  const existing = readVersionFile();
  const next: VersionFile = {
    layout: LAYOUT_VERSION,
    cli: v.cli ?? cliVersion,
    // `undefined` means "leave whatever is there" — a CLI-only rewrite must not
    // drop a daemon version it never touched. Erasing it is therefore an
    // explicit act, used on uninstall.
    daemon: v.clearDaemon ? undefined : (v.daemon ?? existing?.daemon),
  };
  const lines = [
    "# Written by failproofai. `layout` is what tells a newer CLI whether this",
    "# directory can be read as-is; do not edit it by hand.",
    `layout = ${next.layout}`,
    `cli = ${JSON.stringify(next.cli)}`,
  ];
  if (next.daemon) lines.push(`daemon = ${JSON.stringify(next.daemon)}`);
  writeFileAt(versionFile(), lines.join("\n") + "\n");
}

// ── config.toml ──────────────────────────────────────────────────────────────

/**
 * How this machine relates to Failproof Cloud.
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
     * with — `[collector.sources.<harness>] extra_paths` in `config.toml`.
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
     * Scan this machine's agent history on a schedule.
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

export function readConfig(): FpConfig {
  try {
    const parsed = parseToml(readFileSync(configFile(), "utf8")) as Record<string, unknown>;
    const mode = (parsed.mode as Record<string, unknown> | undefined)?.kind;
    const daemon = (parsed.daemon ?? {}) as Record<string, unknown>;
    const collector = (parsed.collector ?? {}) as Record<string, unknown>;
    const telemetry = (parsed.telemetry ?? {}) as Record<string, unknown>;
    const audit = (parsed.audit ?? {}) as Record<string, unknown>;
    return {
      // Anything unrecognised reads as `oss`. The failure direction matters:
      // a corrupt config must not be able to turn cloud reporting ON.
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
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

export function writeConfig(config: FpConfig): void {
  const c = config.collector;
  const lines = [
    "# failproofai configuration. Safe to edit by hand.",
    "# Credentials are NOT here — see credentials.toml (owner-only).",
    "",
    "[mode]",
    "# \"oss\"   — fully local. No transcripts, hook activity or policy leave",
    "#           this machine.",
    "# \"cloud\" — reports to, and receives policy from, Failproof Cloud.",
    `kind = ${JSON.stringify(config.mode)}`,
    "",
    "[daemon]",
    "# When true, hooks route through failproofaid AND FAIL CLOSED if it is",
    "# unreachable. Never set this by hand: `failproofai config` sets it only",
    "# after verifying the service is genuinely running.",
    `configured = ${config.daemon.configured}`,
  ];
  lines.push(
    "",
    "[collector]",
    "# Session transcripts carry prompts, file contents and command output.",
    `sessions = ${c.sessions}`,
    "# Hook decisions: which policy fired and what it decided. No file contents.",
    `hooks = ${c.hooks}`,
    `hooks_verbosity = ${JSON.stringify(c.hooksVerbosity)}`,
    `redact = ${JSON.stringify(c.redact)}`,
    `environment = ${JSON.stringify(c.environment)}`,
  );
  if (c.machineId) lines.push(`machine_id = ${JSON.stringify(c.machineId)}`);
  // Sub-tables MUST come after every scalar of `[collector]`, or TOML reads the
  // scalars that follow as belonging to the last sub-table opened. They are also
  // emitted only when non-empty, so a machine that never configured one gets a
  // file byte-identical to what this function produced before the field existed
  // — the same reasoning as `[telemetry]` below.
  for (const [name, src] of Object.entries(c.sources ?? {})) {
    if (!src.extraPaths?.length) continue;
    lines.push(
      "",
      `[collector.sources.${name}]`,
      "# Extra locations to capture for this harness, beyond its default one.",
      "# Each entry is \"label=path\" or a bare \"path\"; the label namespaces agent",
      "# ids as <label>-<agentId> so two copies of one project stay distinct.",
      `extra_paths = [${src.extraPaths.map((p) => JSON.stringify(p)).join(", ")}]`,
    );
  }
  // Written ONLY when switched off. A default install therefore carries no
  // [telemetry] block at all, but an operator who added one by hand keeps it:
  // writeConfig regenerates this file wholesale, so emitting the key only when
  // it is set is what stops a later rewrite from silently switching telemetry
  // back on underneath them.
  if (!config.telemetry.enabled) {
    lines.push("", "[telemetry]", "enabled = false");
  }
  // Written ALWAYS, unlike [telemetry] directly above — the two are opposites
  // on purpose. Telemetry ships on and is deliberately not advertised in the
  // file; the scheduled audit ships off and is meant to be FOUND, and a switch
  // nobody can see is the same as a switch that does not exist. Emitting both
  // keys unconditionally also makes "a user's setting survives a rewrite" total
  // rather than conditional: every field the struct carries is on disk, so
  // there is no value of this block that a later regeneration can drop.
  lines.push(
    "",
    "[audit]",
    "# Scan this machine's agent history on a schedule and refresh the audit",
    "# dashboard. OFF by default: the scan reads the CONTENTS of every session",
    "# transcript on disk, so it waits to be asked. It runs as a separate",
    "# short-lived process — never on the hook path.",
    `auto = ${config.audit.auto}`,
    `interval_days = ${config.audit.intervalDays}`,
  );
  writeFileAt(configFile(), lines.join("\n") + "\n");
}

/** Merge a partial update into the config on disk. */
export function updateConfig(patch: {
  mode?: Mode;
  daemon?: Partial<FpConfig["daemon"]>;
  collector?: Partial<FpConfig["collector"]>;
  telemetry?: Partial<FpConfig["telemetry"]>;
  audit?: Partial<FpConfig["audit"]>;
}): FpConfig {
  const current = readConfig();
  const next: FpConfig = {
    mode: patch.mode ?? current.mode,
    daemon: { ...current.daemon, ...patch.daemon },
    collector: { ...current.collector, ...patch.collector },
    telemetry: { ...current.telemetry, ...patch.telemetry },
    audit: { ...current.audit, ...patch.audit },
  };
  writeConfig(next);
  return next;
}

// ── credentials.toml ─────────────────────────────────────────────────────────

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

export function readCredentials(): FpCredentials {
  try {
    const parsed = parseToml(readFileSync(credentialsFile(), "utf8")) as Record<string, unknown>;
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
  } catch {
    return {};
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
export function writeCredentials(creds: FpCredentials): void {
  const lines: string[] = [
    "# failproofai credentials — owner-only (0600). Do not commit.",
  ];
  if (creds.cloud) {
    lines.push(
      "",
      "[cloud]",
      `url = ${JSON.stringify(creds.cloud.url)}`,
      `machine_id = ${JSON.stringify(creds.cloud.machineId)}`,
      ...(creds.cloud.machineLabel
        ? [`machine_label = ${JSON.stringify(creds.cloud.machineLabel)}`]
        : []),
      `token = ${JSON.stringify(creds.cloud.token)}`,
    );
  }
  if (creds.ingest) {
    lines.push(
      "",
      "[ingest]",
      `url = ${JSON.stringify(creds.ingest.url)}`,
      `key = ${JSON.stringify(creds.ingest.key)}`,
    );
  }
  if (creds.org && (creds.org.id || creds.org.slug || creds.org.name)) {
    lines.push("", "[org]");
    if (creds.org.id) lines.push(`id = ${JSON.stringify(creds.org.id)}`);
    if (creds.org.slug) lines.push(`slug = ${JSON.stringify(creds.org.slug)}`);
    if (creds.org.name) lines.push(`name = ${JSON.stringify(creds.org.name)}`);
  }
  if (creds.auth && (creds.auth.sessionToken || creds.auth.email)) {
    lines.push("", "[auth]");
    if (creds.auth.baseUrl) lines.push(`base_url = ${JSON.stringify(creds.auth.baseUrl)}`);
    if (creds.auth.sessionToken) lines.push(`session_token = ${JSON.stringify(creds.auth.sessionToken)}`);
    if (creds.auth.expiresAt) lines.push(`expires_at = ${creds.auth.expiresAt}`);
    if (creds.auth.email) lines.push(`email = ${JSON.stringify(creds.auth.email)}`);
  }

  const home = failproofaiHome();
  mkdirSync(home, { recursive: true });
  try {
    if (statSync(home).mode & 0o077) chmodSync(home, 0o700);
  } catch {
    // Not fatal: the file's own 0600 is the primary protection.
  }
  writeFileSync(credentialsFile(), lines.join("\n") + "\n", { mode: 0o600 });
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
