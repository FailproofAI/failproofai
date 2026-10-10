/**
 * `cloud-policies/errors.json` — what this machine could not load from its
 * FailproofAI Cloud deployment, for the daemon to report on its next poll
 * (`policyErrors`, CONTRACT C4–C6).
 *
 * Nothing here changes a verdict. Cloud policies are read fail-open: a JS
 * policy that fails to import costs that one policy on this machine and
 * nothing else, which is the right trade on the hook path and the wrong thing
 * to keep quiet about. Before this file the only trace was a line in the local
 * hook log, so a fleet page read "applied" for a deployment that was not. The
 * same goes for FailproofAI Cloud's Jev (CONTRACT C10): a Jev mode this machine
 * cannot act on, and an installed pack's check Cloud dropped for the question
 * budget, are said here rather than only in a local log.
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
  JEV_BUDGET_FILE,
  cloudManagedPolicyRoot,
  type CloudJevState,
  type CloudManagedPolicyArtifact,
  type CloudPolicyError,
  type CloudPolicyErrorKind,
} from "./cloud-managed-policies";
import type { PolicyLoadFailure } from "./custom-hooks-loader";
import { packsRoot } from "./pack-manifest";

export type { CloudPolicyError, CloudPolicyErrorKind } from "./cloud-managed-policies";

/** The message the contract fixes for "Cloud set a Jev mode and this machine has no Cloud Jev credential". */
export const JEV_UNCONFIGURED = "jev_unconfigured";

/**
 * The message the contract fixes for "Cloud set a Jev mode on a machine
 * connected for decisions only" (`--no-transcripts`), which never runs Jev
 * (CONTRACT C10.2).
 */
export const TRANSCRIPTS_DISABLED = "transcripts_disabled";

/** How an installed pack's check FailproofAI Cloud dropped for the question budget is reported (C10.5). */
export const JEV_BUDGET = "jev_budget";

/**
 * How an installed pack's check is reported when FailproofAI Cloud dropped it
 * because one of the org's Cloud checks has the same name (Cloud wins the name,
 * D-S-2). It is not a budget problem, and its remedy differs.
 */
export const JEV_NAME_CLASH = "jev_name_clash";

/** Is `e` one of the pack-check drops `jev-budget.json` records? */
export function isPackDropEntry(e: Pick<CloudPolicyError, "id" | "message">): boolean {
  return e.id.startsWith("pack:") && (e.message.startsWith(JEV_BUDGET) || e.message.startsWith(JEV_NAME_CLASH));
}

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
    writeAtomic(path, text);
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
  /** Cloud's Jev state (its own problems — an unreadable mode — are in `errors`). */
  jev: Pick<CloudJevState, "errors">;
  /**
   * Why Cloud's `observe`/`enforce` mode cannot run here: `transcripts_disabled`,
   * `jev_unconfigured`, or `jev_unconfigured: <detail>`
   * (`loadJevConfigForCloudMode`). Null when it runs, or Cloud's mode does not ask.
   */
  jevProblem?: string | null;
  /** Installed packs' checks FailproofAI Cloud dropped for the budget ({@link readJevBudgetDrops}). */
  budgetDrops?: ReadonlyArray<CloudPolicyError>;
  /** FailproofAI Cloud Jev rate-limited or unavailable here (`semantic/cloud-jev-health.ts`). */
  health?: ReadonlyArray<CloudPolicyError>;
  /** Schema-3 deployment, but the running hook could not identify its agent. */
  agentScopeUnresolved?: boolean;
}

/**
 * A Cloud JS assignment's kind, as far as this machine can tell: `both` when
 * the server derived a reviewer list for it (only a `both` policy gets one,
 * CONTRACT C1), else `regex`.
 */
function kindOf(policy: Pick<CloudManagedPolicyArtifact, "authority" | "reviewedBy">): CloudPolicyErrorKind {
  return policy.authority === "reviewable" && (policy.reviewedBy?.length ?? 0) > 0 ? "both" : "regex";
}

/**
 * Everything wrong with this machine's Cloud deployment, as `errors.json`
 * entries: deduplicated, in a stable order. Pure.
 *
 * What is NOT here any more (CONTRACT C10): Jev artifact and declaration
 * failures and a `reviewedBy` naming a missing check — the machine holds no
 * Cloud Jev check to fail, and cannot tell which names Cloud has. A `both`
 * policy on a machine whose Cloud mode does not ask simply stays hard; the
 * server knows the mode it set.
 */
export function collectCloudPolicyErrors(input: CloudPolicyErrorInputs): CloudPolicyError[] {
  const out: CloudPolicyError[] = [];
  if (input.manifestError) {
    out.push({ id: "active.json", version: null, kind: "daemon", message: `Cloud policies could not be loaded: ${input.manifestError}` });
  }
  if (input.agentScopeUnresolved) {
    out.push({
      id: "agentScope", version: null, kind: "daemon",
      message: "agent_scope_unresolved: this hook's agent profile is unknown; targeted Cloud policies did not match",
    });
  }
  for (const policy of input.jsPolicies) {
    const failure = input.jsFailures?.get(policy.id);
    if (failure) {
      out.push({ id: policy.id, version: policy.version, kind: kindOf(policy), message: `policy did not load (${failure.type}): ${failure.reason}` });
    }
  }
  out.push(...input.jev.errors);
  out.push(...(input.budgetDrops ?? []));
  if (input.jevProblem) {
    out.push({ id: "jevMode", version: null, kind: "daemon", message: input.jevProblem });
  }
  out.push(...(input.health ?? []));

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

// ── Installed packs' checks FailproofAI Cloud dropped for the budget ─────────
//
// FailproofAI Cloud puts its own checks first in the one question budget and
// drops whole installed-pack question groups, last first, when the two do not
// fit together (CONTRACT C10.4 step 5); its reply names them (`droppedLocal`).
// Which groups a call carries depends on the tool, so a report of only the
// latest reply's drops would flap from call to call. So the drops are kept,
// as a union, in `jev-budget.json` for the machine, deployment and Jev mode
// they happened under — a new deployment or mode starts afresh, which is how
// a drop that no longer happens stops being reported — and `errors.json`
// carries them as `{id: "pack:<packId>", kind: "daemon", message: "jev_budget:
// dropped <name>"}`. A check dropped because an org Cloud check has its name
// is recorded the same way, as `jev_name_clash: <name> (the FailproofAI Cloud
// check is used)`. A drop of a pack no longer installed is not reported, here
// or by the daemon's poll, which also drops the report once the deployment it
// was recorded under is no longer the active one.

/** What a set of budget drops is keyed by: they are true of this deployment only. */
export interface JevBudgetKey {
  machineId: string;
  deployment: number | null;
  jevMode: "observe" | "enforce";
}

/** One dropped pack check; `clash` when Cloud dropped it for a same-named Cloud check. */
export interface JevPackDrop {
  packId: string;
  name: string;
  clash?: true;
}

interface JevBudgetRecord extends JevBudgetKey {
  dropped: JevPackDrop[];
}

export function jevBudgetPath(): string {
  return resolve(cloudManagedPolicyRoot(), JEV_BUDGET_FILE);
}

function readJevBudgetRecord(): JevBudgetRecord | null {
  try {
    const raw = JSON.parse(readFileSync(jevBudgetPath(), "utf8")) as Partial<JevBudgetRecord>;
    if (
      typeof raw.machineId !== "string" ||
      !(raw.deployment === null || Number.isSafeInteger(raw.deployment)) ||
      (raw.jevMode !== "observe" && raw.jevMode !== "enforce") ||
      !Array.isArray(raw.dropped)
    ) {
      return null;
    }
    const dropped = raw.dropped
      .filter((d): d is JevPackDrop => !!d && typeof d.packId === "string" && typeof d.name === "string")
      .map((d) => ({ packId: d.packId, name: d.name, ...(d.clash === true ? { clash: true as const } : {}) }));
    return { machineId: raw.machineId, deployment: raw.deployment as number | null, jevMode: raw.jevMode, dropped };
  } catch {
    return null;
  }
}

const sameKey = (a: JevBudgetKey, b: JevBudgetKey): boolean =>
  a.machineId === b.machineId && a.deployment === b.deployment && a.jevMode === b.jevMode;

const dropKey = (d: JevPackDrop): string => `${d.packId}\u0000${d.name}\u0000${d.clash === true}`;

function budgetEntries(dropped: ReadonlyArray<JevPackDrop>): CloudPolicyError[] {
  return [...dropped]
    .sort((a, b) => (dropKey(a) < dropKey(b) ? -1 : dropKey(a) > dropKey(b) ? 1 : 0))
    .map((d) => ({
      id: `pack:${d.packId}`,
      version: null,
      kind: "daemon" as const,
      message: d.clash ? `${JEV_NAME_CLASH}: ${d.name} (the FailproofAI Cloud check is used)` : `${JEV_BUDGET}: dropped ${d.name}`,
    }));
}

/**
 * The ids of the installed packs, read straight off `installed.json` (no
 * artifact is verified: only the ids are wanted). An empty set when no pack is
 * installed; null when the file exists and cannot be read, which filters
 * nothing ("cannot tell" is not "not installed"). Never throws.
 */
export function installedPackIds(): ReadonlySet<string> | null {
  try {
    const path = resolve(packsRoot(), "installed.json");
    if (!existsSync(path)) return new Set();
    const raw = JSON.parse(readFileSync(path, "utf8")) as { packs?: unknown };
    if (!Array.isArray(raw.packs)) return null;
    return new Set(
      raw.packs.map((p) => (p && typeof p === "object" ? (p as { id?: unknown }).id : null)).filter((id): id is string => typeof id === "string"),
    );
  } catch {
    return null;
  }
}

/**
 * The drops recorded for exactly this machine, deployment and mode, as
 * `errors.json` entries — none for any other key, and none of a pack that is
 * no longer installed (`installed`, when known). Never throws.
 */
export function readJevBudgetDrops(key: JevBudgetKey, installed: ReadonlySet<string> | null = null): CloudPolicyError[] {
  const record = readJevBudgetRecord();
  if (!record || !sameKey(record, key)) return [];
  return budgetEntries(installed ? record.dropped.filter((d) => installed.has(d.packId)) : record.dropped);
}

/**
 * Add the pack checks FailproofAI Cloud just dropped to the record for `key`
 * (starting afresh when the key changed), and to `errors.json` at once, so the
 * report does not wait for the next hook. Both writes are atomic, owner-only,
 * and happen only when something changed. Never throws: a report must not
 * cost a hook its answer.
 */
export function recordJevBudgetDrops(key: JevBudgetKey, drops: ReadonlyArray<JevPackDrop>): void {
  try {
    if (drops.length === 0 || !existsSync(resolve(cloudManagedPolicyRoot(), "active.json"))) return;
    const current = readJevBudgetRecord();
    const base = current && sameKey(current, key) ? current.dropped : [];
    const seen = new Set(base.map(dropKey));
    const added: JevPackDrop[] = [];
    for (const d of drops) {
      const id = dropKey(d);
      if (seen.has(id)) continue;
      seen.add(id);
      added.push({ packId: d.packId, name: d.name, ...(d.clash === true ? { clash: true as const } : {}) });
    }
    if (current && sameKey(current, key) && added.length === 0) return;
    const record: JevBudgetRecord = { ...key, dropped: [...base, ...added] };
    writeAtomic(jevBudgetPath(), `${JSON.stringify(record, null, 2)}\n`);
    // Merged into the report as it stands: every other entry kept, the pack
    // budget drops replaced by this deployment's.
    const report = (readCloudPolicyErrors() ?? []).filter((e) => !isPackDropEntry(e));
    writeCloudPolicyErrors([...report, ...budgetEntries(record.dropped)]);
  } catch {
    // The next event records it again.
  }
}

function writeAtomic(path: string, text: string): void {
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
}
