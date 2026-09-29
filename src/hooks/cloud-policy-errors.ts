/**
 * `cloud-policies/errors.json` — what this machine could not load from its
 * FailproofAI Cloud deployment, for the daemon to report on its next poll
 * (`policyErrors`, CONTRACT C4–C6).
 *
 * Nothing here changes a verdict. Cloud policies are read fail-open: a JS
 * policy that fails to import, a Jev artifact that fails its digest, a
 * declaration the parser drops — each costs that one policy on this machine and
 * nothing else, which is the right trade on the hook path and the wrong thing
 * to keep quiet about. Before this file the only trace was a line in the local
 * hook log, so a fleet page read "applied" for a deployment that was not.
 *
 * ## One writer per file
 *
 * The CLI writes `errors.json`; the daemon keeps its own reconcile errors in
 * `daemon-errors.json` and merges the two onto the wire. Neither writes the
 * other's file, so there is no read-modify-write race between processes.
 *
 * ## Written on change, atomically
 *
 * Computed on every hook evaluation of a Cloud-managed machine, so the write
 * has to be almost always a no-op: the new content is compared with what is on
 * disk (and with what this process last wrote, to skip even that read in the
 * warm worker) and written only when it differs — tmp file + rename, owner-only,
 * so the daemon never reads half a file.
 *
 * A machine that never had a problem never gets the file at all: an empty list
 * is written only to REPLACE a non-empty one, which is what clears the report
 * on the server. That keeps the poll parameter absent on a healthy fleet.
 */
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CLOUD_POLICY_ERRORS_FILE,
  cloudManagedPolicyRoot,
  type CloudJevRead,
  type CloudManagedPolicyArtifact,
  type CloudPolicyError,
  type CloudPolicyErrorKind,
} from "./cloud-managed-policies";
import type { PolicyLoadFailure } from "./custom-hooks-loader";

export type { CloudPolicyError, CloudPolicyErrorKind } from "./cloud-managed-policies";

/** The message the contract fixes for "Cloud set a Jev mode and nothing can answer". */
export const JEV_UNCONFIGURED = "jev_unconfigured";

export function cloudPolicyErrorsPath(): string {
  return resolve(cloudManagedPolicyRoot(), CLOUD_POLICY_ERRORS_FILE);
}

const KINDS: ReadonlySet<string> = new Set<CloudPolicyErrorKind>(["regex", "jev", "both", "daemon"]);

/** The file as the CLI last wrote it, or null when absent or unreadable. */
export function readCloudPolicyErrors(): CloudPolicyError[] | null {
  try {
    const raw = JSON.parse(readFileSync(cloudPolicyErrorsPath(), "utf8")) as { errors?: unknown };
    if (!Array.isArray(raw.errors)) return null;
    return raw.errors.filter(
      (e): e is CloudPolicyError =>
        !!e &&
        typeof e === "object" &&
        typeof (e as CloudPolicyError).id === "string" &&
        typeof (e as CloudPolicyError).message === "string" &&
        KINDS.has((e as CloudPolicyError).kind) &&
        ((e as CloudPolicyError).version === null || Number.isSafeInteger((e as CloudPolicyError).version)),
    );
  } catch {
    return null;
  }
}

/** Text this process last wrote, so the warm worker's steady state reads nothing. */
let lastWritten: { path: string; text: string } | null = null;

/** Tests only. */
export function _resetCloudPolicyErrorsCacheForTest(): void {
  lastWritten = null;
}

function serialize(errors: ReadonlyArray<CloudPolicyError>): string {
  // Field order fixed, so equal lists are equal text.
  const list = errors.map((e) => ({ id: e.id, version: e.version, kind: e.kind, message: e.message }));
  return `${JSON.stringify({ errors: list }, null, 2)}\n`;
}

/**
 * Replace `errors.json` with `errors` when that changes it. Never throws.
 *
 * - `"skipped"`: nothing to report and no file to clear, or no deployment here
 *   (no `active.json` — a disconnected or never-managed machine gets no file).
 * - `"unchanged"`: the file already says exactly this.
 * - `"written"`: it did not, and now does.
 * - `"failed"`: the write itself failed (logged nowhere: the next event retries).
 */
export function writeCloudPolicyErrors(errors: ReadonlyArray<CloudPolicyError>): "written" | "unchanged" | "skipped" | "failed" {
  try {
    const root = cloudManagedPolicyRoot();
    if (!existsSync(resolve(root, "active.json"))) return "skipped";
    const path = cloudPolicyErrorsPath();
    const text = serialize(errors);
    if (lastWritten && lastWritten.path === path && lastWritten.text === text && existsSync(path)) return "unchanged";
    let current: string | null = null;
    try {
      current = readFileSync(path, "utf8");
    } catch {
      current = null;
    }
    if (current === text) {
      lastWritten = { path, text };
      return "unchanged";
    }
    if (current === null && errors.length === 0) return "skipped";
    const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
    try {
      writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
      chmodSync(tmp, 0o600);
      renameSync(tmp, path);
    } catch (err) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // Nothing useful to do.
      }
      throw err;
    }
    lastWritten = { path, text };
    return "written";
  } catch {
    // A report that cannot be written must not cost a hook its answer.
    return "failed";
  }
}

export interface CloudPolicyErrorInputs {
  /** `readActiveCloudManagedPolicies` threw: the whole JS half is not enforcing. */
  manifestError?: string | null;
  /** What the JS reader returned. */
  jsPolicies: ReadonlyArray<CloudManagedPolicyArtifact>;
  /** Import failures by Cloud policy id (`LoadAllResult.cloudFailures`). */
  jsFailures?: ReadonlyMap<string, PolicyLoadFailure>;
  /** The Cloud Jev read (its own drops are already in `errors`). */
  jev: CloudJevRead;
  /**
   * The Jev check names this machine can ask, for every agent — not the
   * per-agent registration set, or the report would flip with each event's
   * agent and rewrite the file on every call.
   */
  reviewerNames: ReadonlySet<string>;
  /** Set when Cloud chose a Jev mode and no provider can answer. */
  jevUnconfigured?: string | null;
}

/**
 * Everything wrong with this machine's Cloud deployment, as `errors.json`
 * entries: deduplicated, in a stable order. Pure.
 */
export function collectCloudPolicyErrors(input: CloudPolicyErrorInputs): CloudPolicyError[] {
  const out: CloudPolicyError[] = [];
  const semanticIds = new Set(input.jev.semanticIds);
  const kindOf = (id: string): CloudPolicyErrorKind => (semanticIds.has(id) ? "both" : "regex");

  if (input.manifestError) {
    out.push({ id: "active.json", version: null, kind: "daemon", message: `Cloud policies could not be loaded: ${input.manifestError}` });
  }
  for (const policy of input.jsPolicies) {
    const failure = input.jsFailures?.get(policy.id);
    if (failure) {
      out.push({ id: policy.id, version: policy.version, kind: kindOf(policy.id), message: `policy did not load (${failure.type}): ${failure.reason}` });
    }
    // A `reviewedBy` naming a check this machine cannot ask: the policy stays
    // hard, and a `both` policy's regex half then denies what its own Jev
    // check was deployed to clear.
    if (policy.authority === "reviewable" && policy.reviewedBy) {
      const missing = policy.reviewedBy.filter((name) => !input.reviewerNames.has(name));
      if (missing.length > 0) {
        out.push({
          id: policy.id,
          version: policy.version,
          kind: kindOf(policy.id),
          message:
            `reviewedBy names ${missing.join(", ")}, which ${missing.length === 1 ? "is not a Jev check" : "are not Jev checks"} ` +
            `this machine can ask, so the policy stays hard`,
        });
      }
    }
  }
  out.push(...input.jev.errors);
  if (input.jevUnconfigured) {
    out.push({ id: "jevMode", version: null, kind: "daemon", message: input.jevUnconfigured });
  }

  const seen = new Set<string>();
  return out.filter((e) => {
    const key = `${e.id}\u0000${e.version}\u0000${e.kind}\u0000${e.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
