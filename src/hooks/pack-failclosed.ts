/**
 * What a machine does when a pack it was told to enforce will not load.
 *
 * ## Why this exists at all
 *
 * Every content-load failure in this codebase fails OPEN, and that was sound
 * only while the builtin policies shipped compiled in and kept enforcing
 * underneath. Once the builtins ARE a pack, the same behaviour becomes zero
 * enforcement at exit 0 on a machine that reports healthy — so the layer that
 * used to be allowed to degrade quietly now has to deny.
 *
 * ## The line: recorded expectation, never an empty manifest
 *
 * A machine with no packs is a fresh machine, not a broken one. `installed.json`
 * being ABSENT is silence; being present and unreadable is a failure. So the
 * trigger is always "something was declared and is not running", never
 * "nothing is running".
 *
 * ## Why the deny is narrow
 *
 * An unreachable daemon denies everything, correctly: no evaluation happened, so
 * nothing can be known safe. An unloadable pack is different — the missing
 * guards are ENUMERABLE, because every declared policy must carry a `match`. So
 * the deny matches only the events and tools those policies claimed, and
 * `getPoliciesForEvent` narrows it for free.
 *
 * `UserPromptSubmit` is exempt no matter what a missing policy declared, and
 * instructs instead. handler.ts records why from a real machine: a blanket deny
 * takes `UserPromptSubmit` with it and locks the user out of their agent
 * entirely. The one event that can tell a human what happened is the one event
 * that must never deny.
 */
import type { PackError, ResolvedPack } from "./pack-manifest";
import type { PolicyLoadFailure } from "./custom-hooks-loader";
import type { HookEventType } from "./types";
import type { PolicyMatcher } from "./policy-types";

/** A guard that was expected to run and did not. */
export interface MissingGuard {
  packId: string;
  packVersion: string | null;
  policies: string[];
  match: PolicyMatcher;
  reason: string;
}

/**
 * Load classifications that are PERMANENT, and so may deny.
 *
 * `load_timeout` is deliberately absent. It is transient and load-dependent, and
 * a machine-wide deny triggered by one slow disk moment persists until a human
 * intervenes — in the warm worker, where every evaluation is serialized behind
 * one queue, the denials themselves add load. Timeouts warn and are recorded.
 */
export const PERMANENT_LOAD_FAILURES: ReadonlySet<string> = new Set([
  "module_not_found",
  "syntax_error",
  "runtime_error",
  "path_missing",
]);

function unionMatch(matchers: PolicyMatcher[]): PolicyMatcher {
  const events = new Set<HookEventType>();
  const toolNames = new Set<string>();
  let anyEvent = false;
  let anyTool = false;
  for (const m of matchers) {
    if (!m.events || m.events.length === 0) anyEvent = true;
    else for (const e of m.events) events.add(e);
    if (!m.toolNames || m.toolNames.length === 0) anyTool = true;
    else for (const t of m.toolNames) toolNames.add(t);
  }
  const scoped: PolicyMatcher = {};
  // Every declared event is kept, INCLUDING UserPromptSubmit. This says where
  // the missing guards applied; how to answer there is the caller's decision —
  // and on UserPromptSubmit the answer is `instruct`, so the human is told
  // without being locked out of the agent that could fix it. Filtering the event
  // out here instead made that branch unreachable.
  if (!anyEvent) scoped.events = [...events];
  if (!anyTool) scoped.toolNames = [...toolNames];
  return scoped;
}

/**
 * Work out which guards a machine expected and is not running.
 *
 * `enabledFor` answers "did the user actually take this policy" — a pack the
 * user took 3 of 40 from is not a failure because the other 37 did not load.
 * `disabled` is the `disabledCustomPolicies` set, keyed `pack:<id>@<ver>:<name>`.
 */
export function missingGuards(input: {
  errors: PackError[];
  packs: ResolvedPack[];
  /** Policy names a pack registered, keyed by pack id. */
  registered: Map<string, Set<string>>;
  /** Packs handed to the loader whose entry artifact failed to import. */
  failed: Map<string, PolicyLoadFailure>;
  disabled: ReadonlySet<string>;
}): MissingGuard[] {
  const out: MissingGuard[] = [];

  // (a) Declared in installed.json, never resolved.
  for (const err of input.errors) {
    // An observe pack denying on failure would deny for something that, had it
    // loaded, would have allowed.
    if (err.effect === "observe") continue;
    const declared = err.declared ?? [];
    out.push({
      packId: err.id ?? "(unnamed pack)",
      packVersion: null,
      policies: declared.map((p) => p.name),
      // No declared policies means nothing to narrow with, so this one is
      // unavoidably blanket — minus the never-deny events.
      match: declared.length > 0 ? unionMatch(declared.map((p) => p.match)) : unionMatch([{}]),
      reason: err.reason,
    });
  }

  // (c) Resolved, but registered less than it declared.
  for (const pack of input.packs) {
    if (pack.effect === "observe") continue;
    const loadFailure = input.failed.get(pack.id);
    if (loadFailure && PERMANENT_LOAD_FAILURES.has(loadFailure.type)) {
      const taken = pack.enabled ?? pack.policies.map((p) => p.name);
      const unavailable = pack.policies.filter(
        (p) =>
          taken.includes(p.name) &&
          !input.disabled.has(`pack:${pack.id}@${pack.version}:${p.name}`),
      );
      if (unavailable.length > 0) {
        out.push({
          packId: pack.id,
          packVersion: pack.version,
          policies: unavailable.map((p) => p.name),
          match: unionMatch(unavailable.map((p) => p.match)),
          reason: `artifact failed to load: ${loadFailure.reason}`,
        });
      }
      continue;
    }
    const registered = input.registered.get(pack.id);
    // A pack absent from both maps was never handed to the loader at all.
    // Guessing failure from "no registrations" cannot distinguish that from a
    // pause skip or a pack that legitimately registers nothing.
    if (!registered) continue;

    const taken = pack.enabled ?? pack.policies.map((p) => p.name);
    const missing = pack.policies.filter(
      (p) =>
        taken.includes(p.name) &&
        !registered.has(p.name) &&
        !input.disabled.has(`pack:${pack.id}@${pack.version}:${p.name}`),
    );
    if (missing.length === 0) continue;
    out.push({
      packId: pack.id,
      packVersion: pack.version,
      policies: missing.map((p) => p.name),
      match: unionMatch(missing.map((p) => p.match)),
      reason: `declared ${missing.length} polic${missing.length === 1 ? "y" : "ies"} its artifact did not register`,
    });
  }

  // A guard that ended up matching no event at all cannot say anything.
  return out.filter((g) => !(g.match.events && g.match.events.length === 0));
}

/**
 * The message a human reads.
 *
 * Recovery is a HUMAN terminal action and the text has to name the command,
 * because the agent cannot run it: `block-failproofai-commands` denies every
 * `failproofai` invocation from a tool call, deliberately and unconditionally.
 */
export function packFailureReason(guards: MissingGuard[]): string {
  const named = guards
    .map((g) => {
      const where = g.packVersion ? `${g.packId}@${g.packVersion}` : g.packId;
      const what = g.policies.length > 0 ? `: ${g.policies.slice(0, 4).join(", ")}` : "";
      return `${where} (${g.reason})${what}`;
    })
    .join("; ");
  return (
    `Blocked because a policy pack this machine is configured to enforce is not running — ${named}. ` +
    `Enforcement you were told you had is missing, so this is refused rather than allowed silently. ` +
    `A human needs to run: failproofai policies, then failproofai policies add <source> (or failproofai config). ` +
    `The agent cannot run those itself.`
  );
}
