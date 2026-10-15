/**
 * Redrive authentication refusals only after a verified ingest-key replacement.
 * Queues from a different (or unconfirmed) org are retained, never sent.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomically } from "../../lib/atomic-write";
import { failedDir, stateDir } from "./fp-home";
import { flushRequestPath } from "./flush-cli";

export function previousOrgDirectory(id?: string): string {
  const safe = id && /^[A-Za-z0-9_-]{1,128}$/.test(id)
    ? id
    : id ? createHash("sha256").update(id).digest("hex") : "unknown";
  return join(stateDir(), "previous-org", safe);
}

export function recoverCredentialRefusals(sameOrg: boolean, oldOrgId?: string): number {
  const dir = failedDir();
  if (!existsSync(dir)) return 0;
  let recovered = 0;
  for (const name of readdirSync(dir)) {
    if (!/\.c(401|403)\.jsonl$/.test(name) || name.startsWith(".")) continue;
    const targetDir = sameOrg ? dir : join(previousOrgDirectory(oldOrgId), "failed");
    mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    const targetName = sameOrg ? name.replace(/\.c(401|403)(?=\.jsonl$)/, "") : name;
    const target = join(targetDir, targetName);
    // Never overwrite the only copy of another undelivered batch.
    if (existsSync(target)) continue;
    renameSync(join(dir, name), target);
    recovered++;
  }
  if (sameOrg && recovered > 0) writeJsonAtomically(flushRequestPath(), { requestedAtMs: Date.now() });
  return recovered;
}
