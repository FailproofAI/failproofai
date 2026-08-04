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

export function writeVersionFile(v: Partial<VersionFile> = {}): void {
  const existing = readVersionFile();
  const next: VersionFile = {
    layout: LAYOUT_VERSION,
    cli: v.cli ?? cliVersion,
    daemon: v.daemon ?? existing?.daemon,
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
    /** Route hooks through the daemon — and FAIL CLOSED when it is unreachable. */
    configured: boolean;
    /** The binary version the service unit points at. */
    installedVersion?: string;
  };
  collector: {
    sessions: boolean;
    hooks: boolean;
    hooksVerbosity: "all" | "decisions" | "off";
    redact: "minimal" | "off";
    environment: string;
    machineId?: string;
  };
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
};

export function readConfig(): FpConfig {
  try {
    const parsed = parseToml(readFileSync(configFile(), "utf8")) as Record<string, unknown>;
    const mode = (parsed.mode as Record<string, unknown> | undefined)?.kind;
    const daemon = (parsed.daemon ?? {}) as Record<string, unknown>;
    const collector = (parsed.collector ?? {}) as Record<string, unknown>;
    return {
      // Anything unrecognised reads as `oss`. The failure direction matters:
      // a corrupt config must not be able to turn cloud reporting ON.
      mode: mode === "cloud" ? "cloud" : "oss",
      daemon: {
        configured: daemon.configured === true,
        installedVersion:
          typeof daemon.installed_version === "string" ? daemon.installed_version : undefined,
      },
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
      },
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
    "# \"oss\"   — fully local. Nothing is sent anywhere, ever.",
    "# \"cloud\" — reports to, and receives policy from, Failproof Cloud.",
    `kind = ${JSON.stringify(config.mode)}`,
    "",
    "[daemon]",
    "# When true, hooks route through failproofaid AND FAIL CLOSED if it is",
    "# unreachable. Never set this by hand: `failproofai config` sets it only",
    "# after verifying the service is genuinely running.",
    `configured = ${config.daemon.configured}`,
  ];
  if (config.daemon.installedVersion) {
    lines.push(`installed_version = ${JSON.stringify(config.daemon.installedVersion)}`);
  }
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
  writeFileAt(configFile(), lines.join("\n") + "\n");
}

/** Merge a partial update into the config on disk. */
export function updateConfig(patch: {
  mode?: Mode;
  daemon?: Partial<FpConfig["daemon"]>;
  collector?: Partial<FpConfig["collector"]>;
}): FpConfig {
  const current = readConfig();
  const next: FpConfig = {
    mode: patch.mode ?? current.mode,
    daemon: { ...current.daemon, ...patch.daemon },
    collector: { ...current.collector, ...patch.collector },
  };
  writeConfig(next);
  return next;
}

// ── credentials.toml ─────────────────────────────────────────────────────────

export interface FpCredentials {
  cloud?: { url: string; machineId: string; token: string };
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
      out.cloud = { url: cloud.url, machineId: cloud.machine_id, token: cloud.token };
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
