#!/usr/bin/env node
/**
 * postinstall script for the failproofai package.
 *
 * 1. Warns if hooks config exists but hooks are missing from Claude Code settings.
 * 2. Tracks a package_installed telemetry event.
 *
 * No external dependencies — Node.js built-ins only.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { platform, arch, release, homedir, hostname } from "node:os";
import { createHmac } from "node:crypto";
import { trackInstallEvent } from "./install-telemetry.mjs";
import { diagnoseShadow } from "./install-diagnosis.mjs";

// Skip when running in development context (e.g. `bun install` in the source repo).
// INIT_CWD is set by npm/bun to the directory where install was invoked; it differs
// from process.cwd() only when we are being installed as a dependency by someone else.
if (!process.env.INIT_CWD || process.env.INIT_CWD === process.cwd()) process.exit(0);

// Verify server.js exists — fail the install early if the dashboard build is missing.
const serverJsPath = resolve(process.cwd(), ".next", "standalone", "server.js");
if (!existsSync(serverJsPath)) {
  console.error(
    `\n[failproofai] Error: server.js not found at:\n  ${serverJsPath}\n\n` +
    `  The package may not have been built correctly.\n` +
    `  Try reinstalling: npm install -g failproofai@latest\n`
  );
  // Await so the event lands before process.exit(1) kills the in-flight fetch —
  // a failed install is exactly the signal we most want and would otherwise lose.
  await trackInstallEvent("package_install_failed", {
    reason: "server_js_missing",
    platform: platform(),
    arch: arch(),
    node_version: process.versions.node,
  }).catch(() => {});
  process.exit(1);
}

// Detect when an older `failproofai` is shadowing this fresh install on PATH —
// classic case is a leftover `bun link` from a prior dev session, or a
// `bun install -g` whose ~/.bun/bin sorts ahead of npm's prefix. Without this
// warning the user only finds out later via a confusing runtime error from
// scripts/launch.ts pointing at the *old* install's missing build output.
try {
  let selfVersion = null;
  try {
    selfVersion = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")).version ?? null;
  } catch {}
  const diag = diagnoseShadow({ selfPackageRoot: process.cwd(), selfVersion });
  if (diag.shadowed) {
    console.warn(
      `\n[failproofai] Warning: another failproofai install is earlier on your PATH.\n` +
      `  Just installed: ${diag.selfPackageRoot}` + (diag.selfVersion ? `  (v${diag.selfVersion})` : "") + `\n` +
      `  PATH resolves : ${diag.pathFirstPath}` + (diag.pathFirstVersion ? `  (v${diag.pathFirstVersion})` : "") + `\n\n` +
      `  Your shell will run the older copy. Remove the shadow with:\n` +
      `    ${diag.recommendation}\n`
    );
  }
} catch {
  // Diagnosis is best-effort — never fail the install over a warning.
}

const FAILPROOFAI_HOOK_MARKER = "__failproofai_hook__";
const NAMESPACE = "failproofai-telemetry-v1";

function hashToId(raw) {
  return createHmac("sha256", NAMESPACE).update(raw).digest("hex");
}

/**
 * Returns the current hooks configuration state.
 * @returns {{ configured: boolean, registered: boolean, policyCount: number }}
 */
function checkHooks() {
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

  // Check if Claude Code settings have failproofai hooks
  const settingsPath = resolve(homedir(), ".claude", "settings.json");
  if (!existsSync(settingsPath)) {
    printHooksWarning();
    return { configured: true, registered: false, policyCount };
  }

  let settings;
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    printHooksWarning();
    return { configured: true, registered: false, policyCount };
  }

  if (!settings.hooks) {
    printHooksWarning();
    return { configured: true, registered: false, policyCount };
  }

  // Walk settings.hooks looking for failproofai entries
  for (const matchers of Object.values(settings.hooks)) {
    if (!Array.isArray(matchers)) continue;
    for (const matcher of matchers) {
      if (!matcher.hooks) continue;
      if (matcher.hooks.some((h) => h[FAILPROOFAI_HOOK_MARKER] === true)) {
        return { configured: true, registered: true, policyCount };
      }
    }
  }

  printHooksWarning();
  return { configured: true, registered: false, policyCount };
}

function printHooksWarning() {
  console.log(
    `\n[failproofai] Warning: hooks config exists with enabled policies, but hooks are not registered in Claude Code settings.\n` +
    `  To re-register hooks, run:\n` +
    `    failproofai policies --uninstall && failproofai policies --install\n`
  );
}

let hooksResult = { configured: false, registered: false, policyCount: 0 };
try {
  hooksResult = checkHooks();
} catch {
  // Non-critical — don't fail the install
}

if (!hooksResult.configured && !hooksResult.registered) {
  console.log(
    `\n[failproofai] Installed. Next steps:\n` +
    `  1. Run \`failproofai policies --install\` to enable safety policies.\n` +
    `  2. Run \`failproofai\` to open the dashboard (or just \`failproofai\` to start now — it'll offer to set up policies for you).\n` +
    `  Disable first-run prompt: FAILPROOFAI_NO_FIRST_RUN=1\n`
  );
}

// First-run + version_changed detection. The presence of ~/.failproofai/last-version
// is a stable signal: written on every postinstall, absent before the first one.
// Cannot piggy-back on instance-id because most users hit Tier 2 (OS machine ID)
// and never create that file.
//
// Semver comparison: a release (no prerelease tag) is greater than the same
// version with a prerelease tag (semver §11). Inside the prerelease, numeric
// identifiers are lower than non-numeric ones of the same length.
function compareSemver(a, b) {
  const parse = (v) => {
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
  const ax = pa.pre.split(/[.-]/);
  const bx = pb.pre.split(/[.-]/);
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

const currentVersion = process.env.npm_package_version ?? "unknown";
const lastVersionFile = resolve(homedir(), ".failproofai", "last-version");
let previousVersion = null;
try {
  if (existsSync(lastVersionFile)) {
    previousVersion = readFileSync(lastVersionFile, "utf8").trim() || null;
  }
} catch {}

if (previousVersion === null) {
  trackInstallEvent("first_install", {
    platform: platform(),
    arch: arch(),
    os_release: release(),
    node_version: process.versions.node,
    // `version` is carried automatically as `failproofai_version` — no explicit dup.
  }).catch(() => {});
} else {
  // Same version is a reinstall — still worth tracking; users hitting `npm install -g`
  // repeatedly is itself signal. Drop the `!==` guard so cmp===0 reaches the event.
  const cmp = compareSemver(previousVersion, currentVersion);
  trackInstallEvent("version_changed", {
    from_version: previousVersion,
    to_version: currentVersion,
    direction: cmp < 0 ? "upgrade" : cmp > 0 ? "downgrade" : "reinstall",
    platform: platform(),
    arch: arch(),
  }).catch(() => {});
}

try {
  mkdirSync(resolve(homedir(), ".failproofai"), { recursive: true });
  writeFileSync(lastVersionFile, currentVersion, "utf8");
} catch {}

// Telemetry (best-effort, fire-and-forget)
trackInstallEvent("package_installed", {
  platform: platform(),
  arch: arch(),
  os_release: release(),
  node_version: process.versions.node,
  hostname_hash: hashToId(hostname()),
  hooks_configured: hooksResult.configured,
  hooks_registered: hooksResult.registered,
  enabled_policy_count: hooksResult.policyCount,
}).catch(() => {});
