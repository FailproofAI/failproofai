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
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  CLOUD_POLICY_ERRORS_FILE,
  cloudManagedPolicyRoot,
  cloudOwnCheckNames,
  type CloudJevRead,
  type CloudManagedPolicyArtifact,
  type CloudPolicyError,
  type CloudPolicyErrorKind,
} from "./cloud-managed-policies";
import type { PolicyLoadFailure } from "./custom-hooks-loader";

export type { CloudPolicyError, CloudPolicyErrorKind } from "./cloud-managed-policies";

/** The message the contract fixes for "Cloud set a Jev mode and nothing can answer". */
export const JEV_UNCONFIGURED = "jev_unconfigured";

/** How a check the Jev question budget dropped is reported (CONTRACT C9.2). */
export const JEV_BUDGET = "jev_budget";

/**
 * A message with no local path in it (CONTRACT C9.5): the home directory
 * becomes `~`, and any other absolute path becomes its last segment.
 *
 * The report leaves the machine, and a path names the user — the home-relative
 * artifact path in a missing-artifact message, a loader's temp path in an
 * import error, the `chmod 600 <path>` hint of a refused `jev.json`. The daemon
 * applies the same rule again on the way out (`redact_local_paths` in
 * `cloud_client.rs`, whose tests pin the same cases), so a report never carries
 * a username whichever side wrote it. The full text stays in the local hook
 * log, where it is useful and goes nowhere.
 *
 * A path starts at a `/` that begins the text or follows whitespace, a quote,
 * an opening bracket, `=`, `,` or `:` — but not a URL's `//host` after `:`,
 * and never a `/` following any other character, so a URL (`https://host/path`)
 * and a relative path (`a/b`) are left alone while `file:///tmp/x` and
 * `open:/etc/x` are not — and runs to the next whitespace, quote, closing
 * bracket, `,` or `;`.
 */
export function redactLocalPaths(message: string, home: string | null = safeHomedir()): string {
  let text = message;
  const base = home?.replace(/\/+$/, "") ?? "";
  if (base.length > 1) {
    let out = "";
    let rest = text;
    for (let at = rest.indexOf(base); at >= 0; at = rest.indexOf(base)) {
      const next = rest.charAt(at + base.length);
      // `/home/al` must not match inside `/home/alice`.
      const whole = next === "" || next === "/" || next === ":" || PATH_END.test(next);
      out += rest.slice(0, at) + (whole ? "~" : base);
      rest = rest.slice(at + base.length);
    }
    text = out + rest;
  }
  // `:(?!\/\/(?!\/))`: a `:` not followed by a URL's `//host` — `scheme://host`
  // stays, while `file:///path` and `x:/path` are paths.
  return text.replace(/(^|[\s"'`(\[<{=,]|:(?!\/\/(?!\/)))(\/[^\s"'`)\]>},;]*)/g, (_m, lead: string, path: string) => {
    const last = path.replace(/\/+$/, "").split("/").pop() ?? "";
    return lead + (last === "" ? "/" : last);
  });
}

const PATH_END = /[\s"'`)\]>},;]/;

function safeHomedir(): string | null {
  try {
    return homedir();
  } catch {
    return null;
  }
}

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
  // Field order fixed, so equal lists are equal text. Redacted here as well as
  // in `collectCloudPolicyErrors`: this is the one way into the file.
  const list = errors.map((e) => ({ id: e.id, version: e.version, kind: e.kind, message: redactLocalPaths(e.message) }));
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
  /**
   * Set when Cloud chose a Jev mode and no provider can answer — or when Cloud
   * Jev policies are deployed, Cloud chose no mode, and nothing on this machine
   * asks Jev, so they are never asked.
   */
  jevUnconfigured?: string | null;
  /**
   * Every check the Jev question budget dropped, already shaped as entries
   * (`jevBudgetErrors` in `semantic/pack-policies.ts`, CONTRACT C9.2).
   */
  budgetDrops?: ReadonlyArray<CloudPolicyError>;
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
    // A `reviewedBy` naming a check this machine cannot ask FROM THE POLICY'S
    // OWN Jev half (CONTRACT C9.4): the policy stays hard, and a `both`
    // policy's regex half then denies what its own Jev check was deployed to
    // clear. A same-named check from an installed pack never stands in.
    //
    // Not for an `observe` policy whose Jev half the server did not send
    // (C9.3: the Jev half of an observe `both` is withheld, as an observe
    // pack's checks are not asked): its names are absent by design, and it
    // blocks nothing.
    const withheld = policy.effect === "observe" && !semanticIds.has(policy.id);
    if (policy.authority === "reviewable" && policy.reviewedBy && !withheld) {
      // Null when the policy has no Jev half deployed: then the machine-wide
      // set judges it, as any assignment always was.
      const own = cloudOwnCheckNames(input.jev, policy.id);
      const missing = policy.reviewedBy.filter((name) => !input.reviewerNames.has(name) || (own !== null && !own.has(name)));
      if (missing.length > 0) {
        const one = missing.length === 1;
        const standIns = own === null ? [] : missing.filter((name) => !own.has(name) && input.reviewerNames.has(name));
        out.push({
          id: policy.id,
          version: policy.version,
          kind: kindOf(policy.id),
          message:
            standIns.length > 0
              ? `reviewedBy names ${missing.join(", ")}, which this policy's own Jev half does not provide on this machine ` +
                `(an installed pack's check of that name never stands in), so the policy stays hard`
              : `reviewedBy names ${missing.join(", ")}, which ${one ? "is not a Jev check" : "are not Jev checks"} ` +
                `this machine can ask, so the policy stays hard`,
        });
      }
    }
  }
  out.push(...input.jev.errors);
  out.push(...(input.budgetDrops ?? []));
  if (input.jevUnconfigured) {
    out.push({ id: "jevMode", version: null, kind: "daemon", message: input.jevUnconfigured });
  }

  const seen = new Set<string>();
  return out
    .map((e) => ({ ...e, message: redactLocalPaths(e.message) }))
    .filter((e) => {
      const key = `${e.id}\u0000${e.version}\u0000${e.kind}\u0000${e.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
