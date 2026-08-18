/**
 * Which template a machine writes its hook configs from.
 *
 * Three sources, in order, each falling back to the next:
 *
 *   1. a file named by `FAILPROOFAI_TEMPLATE_FILE` — how the lab proves a
 *      CANDIDATE template actually works before anyone publishes it;
 *   2. the contracts pack this machine last fetched, which is how a vendor's
 *      format change reaches machines without waiting for an npm release;
 *   3. the template bundled in this build, which is always present.
 *
 * ## Why a fetched template needs a gate the bundled one does not
 *
 * Repair verifies its work by regenerating from the template and comparing. That
 * proves the file matches the template — not that the vendor accepts it. So a
 * WRONG template verifies green, rolls back nothing, and leaves a file that
 * looks perfect while the CLI ignores it. Every machine, quietly, within a day.
 *
 * A bundled template cannot do that unnoticed: it goes through CI, a human, and
 * staggered npm adoption. A fetched one has none of those, so the checks below
 * stand in for them:
 *
 * - **`validateTemplate()`** — a template describes shape and may never carry
 *   content. Without this, whoever controls the pack controls the command that
 *   runs on every tool call on every machine.
 * - **It may not drop an enforcement point.** A candidate that stops installing
 *   `PreToolUse` or `Stop` where this build installs them is rejected, because
 *   that is what disabling enforcement looks like from here — indistinguishable,
 *   in the file, from a legitimate format change.
 * - **Anything unusable falls back to bundled rather than failing.** A machine
 *   with a corrupt pack must keep enforcing with what it shipped with.
 *
 * What none of this proves is that the vendor accepts the result. Only driving
 * the CLI shows that, which is why source 1 exists and why the lab is what
 * publishes.
 */
import { readFileSync } from "node:fs";
import { HOOK_TEMPLATES, validateTemplate, type HookTemplate } from "./config-template";
import { readCachedPack } from "./contract-pack-client";
import { canonicalizeEventType } from "./handler";
import type { IntegrationType } from "./types";

export type TemplateOrigin = "bundled" | "pack" | "file";

export interface ResolvedTemplate {
  template: HookTemplate;
  origin: TemplateOrigin;
  /** Why a non-bundled template was refused, when one was offered and rejected. */
  rejected?: string;
}

/**
 * Resolution is cached per process.
 *
 * `writeHookEntries` is called once per event per install, so re-reading and
 * re-validating a pack on each call would turn one install into hundreds of file
 * reads. Nothing here is on the hook path, and a process that outlives a pack
 * refresh is a CLI invocation measured in seconds.
 */
let cache: Map<string, ResolvedTemplate> | null = null;

/** Drop the memo. For tests, and for a long-lived process that refetched a pack. */
export function resetTemplateSourceForTests(): void {
  cache = null;
}

function canonicalEvents(template: HookTemplate, cli: string): Set<string> {
  const out = new Set<string>();
  for (const event of template.events) {
    try {
      out.add(canonicalizeEventType(event, cli as IntegrationType));
    } catch {
      out.add(event);
    }
  }
  return out;
}

/**
 * Events a fetched template may not drop.
 *
 * `PreToolUse` is where a tool call is denied. `Stop` is where the five
 * `require-*-before-stop` builtins gate a turn from finishing. Losing either is
 * the loss no later check would catch: the config stays valid, the vendor
 * accepts it, and nothing ever fires.
 *
 * Deliberately short. Vendors genuinely add and remove events, and refusing
 * every reduction would make the channel useless — so only the two that ARE the
 * enforcement are held, and only where this build already installs them, which
 * leaves CLIs that have no such event (goose, hermes) unaffected.
 */
const PROTECTED_EVENTS = ["PreToolUse", "Stop"] as const;

/** Would accepting this template weaken enforcement? */
function weakensEnforcement(candidate: HookTemplate, bundled: HookTemplate, cli: string): string | null {
  const before = canonicalEvents(bundled, cli);
  const after = canonicalEvents(candidate, cli);
  for (const event of PROTECTED_EVENTS) {
    if (before.has(event) && !after.has(event)) {
      return `it stops installing ${event}, which this build installs and enforces on`;
    }
  }
  return null;
}

/** A template from an untrusted source, or a reason it was refused. */
function vet(raw: unknown, bundled: HookTemplate, cli: string): { ok: HookTemplate } | { no: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { no: "not an object" };
  const candidate = raw as HookTemplate;

  const problems = validateTemplate(candidate);
  if (problems.length > 0) return { no: problems.join("; ") };

  const weaker = weakensEnforcement(candidate, bundled, cli);
  if (weaker) return { no: weaker };

  return { ok: candidate };
}

function fromFile(bundled: HookTemplate, cli: string): ResolvedTemplate | null {
  const path = process.env.FAILPROOFAI_TEMPLATE_FILE;
  if (!path) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { template: bundled, origin: "bundled", rejected: `${path} could not be read` };
  }
  // A candidate file may hold one template or a map of them, so the lab can
  // prove one CLI or a whole set with the same switch.
  const record = raw as Record<string, unknown>;
  const offered = record[cli] !== undefined ? record[cli] : raw;
  const vetted = vet(offered, bundled, cli);
  return "ok" in vetted
    ? { template: vetted.ok, origin: "file" }
    : { template: bundled, origin: "bundled", rejected: vetted.no };
}

function fromPack(bundled: HookTemplate, cli: string): ResolvedTemplate | null {
  const pack = readCachedPack() as { templates?: Record<string, unknown> } | null;
  const offered = pack?.templates?.[cli];
  if (offered === undefined) return null;
  const vetted = vet(offered, bundled, cli);
  return "ok" in vetted
    ? { template: vetted.ok, origin: "pack" }
    : { template: bundled, origin: "bundled", rejected: vetted.no };
}

/**
 * The template this machine should write `cli`'s config from, and where it came
 * from.
 *
 * Never throws: the bundled template is always a valid answer, and a machine
 * that cannot read a pack must keep enforcing rather than stop.
 */
export function resolveTemplate(cli: string): ResolvedTemplate {
  cache ??= new Map();
  const memo = cache.get(cli);
  if (memo) return memo;

  const bundled = HOOK_TEMPLATES[cli];
  if (!bundled) throw new Error(`no bundled hook template for ${cli}`);

  let resolved: ResolvedTemplate = { template: bundled, origin: "bundled" };
  try {
    resolved = fromFile(bundled, cli) ?? fromPack(bundled, cli) ?? resolved;
  } catch {
    // Any surprise reading an untrusted source leaves the machine on what it
    // shipped with, which is the whole point of having a floor.
  }
  cache.set(cli, resolved);
  return resolved;
}

/** The template alone, for the call sites that only need to write a file. */
export function templateFor(cli: string): HookTemplate {
  return resolveTemplate(cli).template;
}
