/**
 * Lightweight PostHog telemetry for npm install/uninstall lifecycle scripts.
 *
 * Uses fetch() directly — no external dependencies, Node.js built-ins only.
 * Mirrors the pattern used in src/hooks/hook-telemetry.ts.
 */
import { createHmac, randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, platform, arch, hostname, cpus } from "node:os";
import { join } from "node:path";

const NAMESPACE = "failproofai-telemetry-v1";
const API_KEY = "phc_Ac1Ww1GqKc0z1SyrRWbmatEeQdlOQIsDEEdP8l8JRgX";
const CAPTURE_URL = "https://us.i.posthog.com/capture/";
// Mirrors POSTHOG_PRODUCT in src/posthog-key.ts — this standalone npm-lifecycle
// script can't import the TS module at install time, so the literal is inlined.
const PRODUCT = "failproofai-oss";

function hashToId(raw) {
  return createHmac("sha256", NAMESPACE).update(raw).digest("hex");
}

function getInstanceId() {
  // Tier 1: existing ~/.failproofai/instance-id file (consistent with server-side ID)
  const idDir = join(homedir(), ".failproofai");
  const idFile = join(idDir, "instance-id");
  try {
    const existing = readFileSync(idFile, "utf-8").trim();
    if (existing) return existing;
  } catch {}

  // Tier 2: OS-native machine ID (hashed, survives cache deletion)
  try {
    const p = platform();
    if (p === "linux") {
      for (const machineIdPath of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
        try {
          const id = readFileSync(machineIdPath, "utf-8").trim();
          if (id) return hashToId(id);
        } catch {}
      }
    } else if (p === "darwin") {
      const out = execSync("ioreg -rd1 -c IOPlatformExpertDevice", {
        encoding: "utf-8",
        timeout: 3000,
      });
      const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (m?.[1]) return hashToId(m[1]);
    } else if (p === "win32") {
      const out = execSync(
        'reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid',
        { encoding: "utf-8", timeout: 3000 }
      );
      const m = out.match(/MachineGuid\s+REG_SZ\s+(\S+)/);
      if (m?.[1]) return hashToId(m[1]);
    }
  } catch {}

  // Tier 3: hashed system properties
  try {
    const sysProps = [
      hostname(),
      homedir(),
      platform(),
      arch(),
      cpus()[0]?.model ?? "",
    ].join(":");
    return hashToId(sysProps);
  } catch {}

  // Tier 4: random UUID written to file for future consistency
  const id = randomUUID();
  try {
    mkdirSync(idDir, { recursive: true });
    writeFileSync(idFile, id, "utf-8");
  } catch {}
  return id;
}

/**
 * Track a named event to PostHog. No-op when telemetry is disabled.
 *
 * `opts.version` must be supplied by callers outside an npm lifecycle script:
 * npm only sets npm_package_version while running one, and these events now
 * fire from the CLI (see lib/install-check.ts) because package managers block
 * install scripts by default.
 *
 * @param {string} event
 * @param {Record<string, unknown>} [properties]
 * @param {{ version?: string, timeoutMs?: number }} [opts]
 */
export async function trackInstallEvent(event, properties = {}, opts = {}) {
  if (process.env.FAILPROOFAI_TELEMETRY_DISABLED === "1") return;

  const version = opts.version ?? process.env.npm_package_version ?? "unknown";
  const body = JSON.stringify({
    api_key: process.env.FAILPROOFAI_POSTHOG_KEY ?? API_KEY,
    event,
    distinct_id: getInstanceId(),
    properties: {
      ...properties,
      $lib: "failproofai-install",
      failproofai_version: version,
      product: PRODUCT,
    },
  });

  await fetch(
    process.env.FAILPROOFAI_POSTHOG_HOST
      ? `${process.env.FAILPROOFAI_POSTHOG_HOST}/capture/`
      : CAPTURE_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
    }
  );
}
