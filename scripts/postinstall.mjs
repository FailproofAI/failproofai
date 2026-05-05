#!/usr/bin/env node
/**
 * postinstall script for the failproofai package.
 *
 * 1. Warns if hooks config exists but hooks are missing from Claude Code settings.
 * 2. Tracks a package_installed telemetry event.
 *
 * No external dependencies — Node.js built-ins only.
 */
import { existsSync, readFileSync } from "node:fs";
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

// Telemetry (best-effort, fire-and-forget)
trackInstallEvent("package_installed", {
  platform: platform(),
  arch: arch(),
  os_release: release(),
  hostname_hash: hashToId(hostname()),
  hooks_configured: hooksResult.configured,
  hooks_registered: hooksResult.registered,
  enabled_policy_count: hooksResult.policyCount,
}).catch(() => {});
