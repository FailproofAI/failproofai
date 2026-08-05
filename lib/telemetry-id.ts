import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { telemetryIdFile } from "../src/hooks/fp-home";

const NAMESPACE = "failproofai-telemetry-v1";
const ID_DIR = path.join(os.homedir(), ".failproofai");
const ID_FILE = path.join(ID_DIR, "instance-id");

let cachedId: string | undefined;

export function hashToId(raw: string): string {
  return crypto.createHmac("sha256", NAMESPACE).update(raw).digest("hex");
}

export function getPlatformMachineId(): string | undefined {
  try {
    const platform = os.platform();
    if (platform === "linux") {
      for (const p of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
        try {
          const id = fs.readFileSync(p, "utf-8").trim();
          if (id) return id;
        } catch {}
      }
    } else if (platform === "darwin") {
      const out = execSync("ioreg -rd1 -c IOPlatformExpertDevice", {
        encoding: "utf-8",
        timeout: 3000,
      });
      const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (m?.[1]) return m[1];
    } else if (platform === "win32") {
      const out = execSync(
        'reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid',
        { encoding: "utf-8", timeout: 3000 },
      );
      const m = out.match(/MachineGuid\s+REG_SZ\s+(\S+)/);
      if (m?.[1]) return m[1];
    }
  } catch {}
  return undefined;
}

export function getSystemPropertiesId(): string {
  return [
    os.hostname(),
    os.homedir(),
    os.platform(),
    os.arch(),
    os.cpus()[0]?.model ?? "",
  ].join(":");
}

function getFileBasedId(): string {
  try {
    const existing = fs.readFileSync(ID_FILE, "utf-8").trim();
    if (existing) return existing;
  } catch {}
  const id = crypto.randomUUID();
  try {
    fs.mkdirSync(ID_DIR, { recursive: true });
    fs.writeFileSync(ID_FILE, id, "utf-8");
  } catch {}
  return id;
}

/**
 * Publish the resolved id where **failproofaid** can read it.
 *
 * The daemon cannot re-derive this. Tier 2 below hashes `os.arch()` and
 * `os.cpus()[0].model`, which are Node's own formatting — Node says `x64` where
 * Rust says `x86_64` — and a near-miss there does not fail, it silently files
 * one machine under two different PostHog persons with nothing in the data to
 * say so. So the CLI writes what it resolved and the daemon reads it
 * (`telemetry_id_path()` in `crates/failproofaid/src/paths.rs`).
 *
 * Deliberately NOT gated on the telemetry opt-out. This sends nothing — it
 * writes one anonymous HMAC to a local file — and gating it would mean a machine
 * that opted out and later opted back in reported under a different identity
 * until the next CLI run. The gate belongs on the sending, which is where both
 * this process and the daemon apply it.
 *
 * Every failure is swallowed. This runs on the hook path, and a telemetry id
 * that could not be published is worth exactly nothing next to a tool call that
 * did not complete. The read-and-compare is what keeps the common case to one
 * small `readFileSync` rather than a write per process.
 */
function publishInstanceId(id: string): void {
  let target: string;
  try {
    target = telemetryIdFile();
    if (fs.readFileSync(target, "utf-8").trim() === id) return;
  } catch {
    // Absent or unreadable — fall through and try to write it.
    try {
      target = telemetryIdFile();
    } catch {
      return;
    }
  }
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // tmp → rename, and the tmp name carries the pid: two CLI processes racing
    // here is ordinary (every hook call resolves an id), and a shared temp name
    // would let one truncate the file the other is renaming into place, leaving
    // a torn id that the daemon would then adopt as a permanent, wrong person.
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, id, { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(tmp, target);
  } catch {}
}

/**
 * Returns a stable, anonymous machine ID for telemetry.
 *
 * Uses a 3-tier strategy:
 * 1. OS-native machine ID (most stable — survives cache deletion)
 * 2. Hashed system properties (fallback — less stable if hostname changes)
 * 3. File-based random UUID at `~/.failproofai/instance-id` (final fallback)
 *
 * All raw values are HMAC-hashed with an app-specific namespace so no PII
 * is transmitted. The result is cached in-process to avoid repeated I/O, and
 * published once per process for the daemon (see `publishInstanceId`).
 */
export function getInstanceId(): string {
  if (cachedId) return cachedId;

  const machineId = getPlatformMachineId();
  if (machineId) {
    cachedId = hashToId(machineId);
    publishInstanceId(cachedId);
    return cachedId;
  }

  const sysProps = getSystemPropertiesId();
  if (sysProps) {
    cachedId = hashToId(sysProps);
    publishInstanceId(cachedId);
    return cachedId;
  }

  cachedId = getFileBasedId();
  publishInstanceId(cachedId);
  return cachedId;
}
