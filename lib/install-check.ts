/**
 * Install reporting, driven from the CLI instead of an npm lifecycle script.
 *
 * This used to live in `scripts/postinstall.mjs`. Every package manager now
 * blocks dependency install scripts by default — npm 12 (`allowScripts`), pnpm,
 * bun, and Yarn ≥4.14 — and a publisher cannot opt its own package in, so a
 * postinstall hook is no longer a channel that reaches users. The first non-hook
 * CLI invocation is.
 *
 * Two constraints shape this module:
 *
 *   1. It must never run on the `--hook` fast path in bin/failproofai.mjs. That
 *      path fires on every tool call of every agent session; the check belongs
 *      in runCli() only.
 *   2. It must be free on the steady-state path. When the recorded version
 *      matches, this returns before touching anything else.
 *
 * Everything here is best-effort: telemetry must never break, delay, or fail a
 * real command.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { platform, arch, release, homedir, hostname } from "node:os";
import { createHmac } from "node:crypto";
import { trackInstallEvent } from "../scripts/install-telemetry.mjs";

const FAILPROOFAI_HOOK_MARKER = "__failproofai_hook__";
const NAMESPACE = "failproofai-telemetry-v1";

/**
 * Cap on the once-per-version report so a hanging network never stalls a command.
 *
 * A ceiling, not a cost: delivery resolves as soon as PostHog answers, measured
 * at ~1.1s from a cold process (these events are the first thing a fresh process
 * sends, so they always pay the DNS + TLS handshake). Raising this only matters
 * when the network is slow — precisely when a tight budget would silently drop
 * the report instead.
 *
 * 5s matches hook-telemetry and the postinstall script this replaces. An earlier
 * 2s left barely any headroom over a 1.85s worst case seen in testing, for a
 * saving nobody experiences on a healthy network.
 */
const REPORT_TIMEOUT_MS = 5000;

function hashToId(raw: string): string {
  return createHmac("sha256", NAMESPACE).update(raw).digest("hex");
}

function lastVersionPath(): string {
  return resolve(homedir(), ".failproofai", "last-version");
}

/**
 * Semver ordering. A release outranks the same version carrying a prerelease
 * tag (semver §11); within a prerelease, numeric identifiers rank below
 * non-numeric ones.
 *
 * Prerelease identifiers are separated by dots only (semver §9). A hyphen is a
 * legal character *inside* an identifier, so `beta-2` is one non-numeric
 * identifier compared lexically — not `beta` and `2`.
 */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(v);
    if (!m) return null;
    return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return a < b ? -1 : a > b ? 1 : 0;
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1;
  }
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  const ax = pa.pre.split(".");
  const bx = pb.pre.split(".");
  for (let i = 0; i < Math.max(ax.length, bx.length); i++) {
    const ai = ax[i], bi = bx[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    const aNum = /^\d+$/.test(ai), bNum = /^\d+$/.test(bi);
    if (aNum && bNum) {
      const d = Number(ai) - Number(bi);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (aNum) {
      return -1;
    } else if (bNum) {
      return 1;
    } else if (ai !== bi) {
      return ai < bi ? -1 : 1;
    }
  }
  return 0;
}

export interface HooksState {
  configured: boolean;
  registered: boolean;
  policyCount: number;
}

/**
 * Snapshot of the user's hook configuration, carried as properties on
 * package_installed.
 *
 * Only inspects Claude's settings, which understates `registered` for someone
 * running failproofai against another CLI. Preserved as-is from the postinstall
 * script so the event keeps its historical meaning.
 */
export function checkHooks(): HooksState {
  const hooksConfigPath = resolve(homedir(), ".failproofai", "policies-config.json");
  if (!existsSync(hooksConfigPath)) {
    return { configured: false, registered: false, policyCount: 0 };
  }

  let config;
  try {
    config = JSON.parse(readFileSync(hooksConfigPath, "utf8"));
  } catch {
    return { configured: false, registered: false, policyCount: 0 };
  }

  if (!Array.isArray(config.enabledPolicies) || config.enabledPolicies.length === 0) {
    return { configured: false, registered: false, policyCount: 0 };
  }

  const policyCount = config.enabledPolicies.length;
  const settingsPath = resolve(homedir(), ".claude", "settings.json");
  if (!existsSync(settingsPath)) return { configured: true, registered: false, policyCount };

  let settings;
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    return { configured: true, registered: false, policyCount };
  }

  if (!settings?.hooks) return { configured: true, registered: false, policyCount };

  for (const matchers of Object.values(settings.hooks)) {
    if (!Array.isArray(matchers)) continue;
    for (const matcher of matchers) {
      if (!matcher?.hooks) continue;
      if (matcher.hooks.some((h: Record<string, unknown>) => h[FAILPROOFAI_HOOK_MARKER] === true)) {
        return { configured: true, registered: true, policyCount };
      }
    }
  }

  return { configured: true, registered: false, policyCount };
}

/**
 * Report an install or upgrade, at most once per version.
 *
 * Fires first_install (nothing recorded yet) or version_changed (recorded
 * version differs), then package_installed, then records `version`. A same-version
 * run is a no-op — unlike the postinstall script this replaces, the CLI has no
 * signal that would distinguish a reinstall from an ordinary invocation, so
 * `direction: "reinstall"` is no longer reported.
 */
export async function maybeReportInstall(version: string): Promise<void> {
  try {
    const versionFile = lastVersionPath();

    let previousVersion: string | null = null;
    try {
      if (existsSync(versionFile)) {
        previousVersion = readFileSync(versionFile, "utf8").trim() || null;
      }
    } catch {
      // Unreadable marker — treat as first run rather than give up.
    }

    // Steady state: same version already reported. Costs one stat() per command.
    if (previousVersion === version) return;

    const hooks = checkHooks();

    const events: Promise<void>[] = [];
    if (previousVersion === null) {
      events.push(
        trackInstallEvent("first_install", {
          platform: platform(),
          arch: arch(),
          os_release: release(),
          node_version: process.versions.node,
        }, { version, timeoutMs: REPORT_TIMEOUT_MS }),
      );
    } else {
      const cmp = compareSemver(previousVersion, version);
      events.push(
        trackInstallEvent("version_changed", {
          from_version: previousVersion,
          to_version: version,
          direction: cmp < 0 ? "upgrade" : "downgrade",
          platform: platform(),
          arch: arch(),
        }, { version, timeoutMs: REPORT_TIMEOUT_MS }),
      );
    }

    events.push(
      trackInstallEvent("package_installed", {
        platform: platform(),
        arch: arch(),
        os_release: release(),
        node_version: process.versions.node,
        hostname_hash: hashToId(hostname()),
        hooks_configured: hooks.configured,
        hooks_registered: hooks.registered,
        enabled_policy_count: hooks.policyCount,
      }, { version, timeoutMs: REPORT_TIMEOUT_MS }),
    );

    // Record before awaiting: a dropped event is cheaper than re-reporting the
    // same version on every command because delivery kept failing.
    try {
      mkdirSync(resolve(homedir(), ".failproofai"), { recursive: true });
      writeFileSync(versionFile, version, "utf8");
    } catch {
      // best-effort
    }

    await Promise.all(events.map((p) => p.catch(() => {})));
  } catch {
    // Reporting must never break a command.
  }
}
