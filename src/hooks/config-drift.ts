/**
 * Has a vendor's hook-config format moved out from under what we installed?
 *
 * This is the drift class that costs the most and shows the least. When a
 * vendor changes the *shape* of its hook config, our installed entry stops
 * being valid and the CLI runs with NO enforcement at all — not one policy
 * degraded, every policy on that CLI, silently. Copilot 1.0.71 turned `hooks`
 * from an array into an object and rejected older files wholesale; goose treats
 * a `matcher: "*"` as an invalid regex matching nothing; droid rejects the
 * wrapper its own published docs prescribed and says so only in a log nobody
 * reads. Five of the eleven incidents on record are this class.
 *
 * ## Why there is no schema file here
 *
 * The obvious design is a template per (cli, version) describing the expected
 * config shape. That would be a THIRD copy of something we already state twice —
 * once in `writeHookEntries`, once in the file on disk — and a third copy is a
 * third thing that can drift. So the expectation is not data: it is
 * `writeHookEntries` itself, and the question this module asks is
 *
 *     "if you reinstalled right now, would this file change?"
 *
 * We regenerate into a copy of the user's own settings and compare. A vendor
 * format change lands in `writeHookEntries` when we fix it, so every machine
 * that has not been reinstalled since then reports drift, with no schema to
 * ship, no version table to maintain, and nothing that can disagree with the
 * code because it *is* the code.
 *
 * ## What it deliberately cannot see
 *
 * A config the vendor rejects produces no hook events, and this module never
 * learns that — it reads our file, not their behaviour. `hooksInstalledInSettings`
 * has the same blind spot and returned `true` throughout both production
 * incidents, because it reads our own marker out of our own file. Proving the
 * vendor *accepted* a config needs an independent witness: either the vendor's
 * own transcript, or a lab that drives the real CLI and checks a hook fired.
 * This module answers a narrower question honestly rather than the whole one
 * badly.
 */
import { existsSync, readFileSync } from "node:fs";
import { getIntegration, settingsPathsFor } from "./integrations";
import { resolveFailproofaiBinary } from "./manager";
import {
  FAILPROOFAI_HOOK_MARKER,
  INTEGRATION_TYPES,
  type HookScope,
  type IntegrationType,
} from "./types";

/** What we found for one (cli, scope, settings file). */
export type DriftStatus =
  /** Our entry is present and byte-identical to what we would write today. */
  | "ok"
  /** No failproofai entry in this file. Not installed here — not necessarily wrong. */
  | "absent"
  /** Ours is there, but reinstalling would change the file's SHAPE: the format moved. */
  | "stale"
  /**
   * Structurally identical to what we would write; only string values differ —
   * almost always our own install path. Informational, never a finding.
   */
  | "stale_path"
  /** The file could not be read or parsed. Never treated as "fine". */
  | "unreadable"
  /** This repo's own dev configs. Never ours to rewrite — see `isDogfoodCommand`. */
  | "dogfood"
  /**
   * Regenerating this integration would touch the filesystem, so we refuse to
   * ask. "We cannot tell" reported out loud beats a number we obtained by
   * writing to a user's disk during a read-only check.
   */
  | "unsupported";

export interface ConfigDriftReport {
  cli: IntegrationType;
  scope: HookScope;
  settingsPath: string;
  status: DriftStatus;
  /** Present on `unreadable`; the error class, never the file's contents. */
  detail?: string;
}

/**
 * A command routing through this repo's dev launcher rather than an installed
 * binary.
 *
 * These are the committed dogfood configs — `.claude/settings.json` and its ten
 * siblings — and they carry the same `__failproofai_hook__` marker a real
 * install does, so every marker-keyed check claims them. Regenerating one
 * rewrites `node scripts/dev-hook.mjs` into `npx -y failproofai`, which points
 * enforcement at the *published* package while the developer is editing the
 * working tree: a silently wrong result, and the exact thing CLAUDE.md forbids
 * doing by hand. `dogfood-configs.test.ts` fails loudly if it ever happens,
 * which is the backstop rather than the guard.
 */
export function isDogfoodCommand(command: string): boolean {
  return command.includes("dev-hook.mjs");
}

/**
 * Is there any sign of us in this file, whatever shape it is in?
 *
 * `hooksInstalledInSettings` looks for our entry in the shape we EXPECT, so a
 * vendor that changes its config format makes it answer "not installed" for a
 * file that plainly contains our hook. That is the difference between
 * "you never installed here" — leave it alone — and "your entry is here and we
 * no longer recognise the shape around it", which is the strongest drift signal
 * available and precisely the Copilot 1.0.71 case: `hooks` went from an array
 * to an object, older files were rejected wholesale, and the session ran
 * unhooked in silence.
 *
 * Deliberately a raw-text check rather than a structural one: the whole premise
 * is that we can no longer parse the structure the way we thought.
 *
 * The bar is our name appearing at all, not our name next to `--hook`. Three
 * integrations register a PATH rather than a command — opencode, pi and
 * openclaw all point at a plugin file — so a `--hook` requirement missed them
 * entirely: an opencode config whose shim had been deleted read as "never
 * installed" rather than "installed and broken". Nothing else puts the string
 * `failproofai` in a vendor's hook config, and the cost of being wrong is
 * bounded anyway: this only runs when we are NOT properly installed, so a hit
 * means "there is a trace of us here and we are not working", which is worth
 * saying whatever put it there.
 */
function hasFailproofaiTrace(raw: string): boolean {
  if (raw.includes(FAILPROOFAI_HOOK_MARKER)) return true;
  return raw.includes("failproofai");
}

function containsDogfood(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (typeof value === "string") return isDogfoodCommand(value);
  if (Array.isArray(value)) return value.some((v) => containsDogfood(v, depth + 1));
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((v) => containsDogfood(v, depth + 1));
  }
  return false;
}

/**
 * Compare the installed file against what `writeHookEntries` would produce now.
 *
 * Regenerates into a SECOND read of the same file rather than a clone of the
 * first, so per-integration normalisation in `readSettings` (copilot and cursor
 * both inject `version: 1` when absent) lands on both sides and cannot show up
 * as a phantom difference.
 */
function inspectOne(
  cli: IntegrationType,
  scope: HookScope,
  settingsPath: string,
  binaryPath: string,
  cwd: string,
): ConfigDriftReport {
  const integration = getIntegration(cli);
  const base: Omit<ConfigDriftReport, "status"> = { cli, scope, settingsPath };

  if (!existsSync(settingsPath)) return { ...base, status: "absent" };

  let current: Record<string, unknown>;
  let regenerated: Record<string, unknown>;
  try {
    current = integration.readSettings(settingsPath);
    regenerated = integration.readSettings(settingsPath);
  } catch (err) {
    // A hand-edited or truncated file. Reporting "ok" here would be the
    // comfortable lie; reporting the class of failure lets someone act.
    return { ...base, status: "unreadable", detail: errorClass(err) };
  }

  if (containsDogfood(current)) return { ...base, status: "dogfood" };

  let installedHere: boolean;
  try {
    installedHere = integration.hooksInstalledInSettings(scope, cwd);
  } catch {
    installedHere = false;
  }
  if (!installedHere) {
    let raw = "";
    try {
      raw = readFileSync(settingsPath, "utf8");
    } catch {
      return { ...base, status: "unreadable", detail: "read" };
    }
    // Our entry is in there; we just cannot see it through the shape we expect.
    if (hasFailproofaiTrace(raw)) {
      // Prefer the precise cause when we have it. A registration pointing at a
      // shim that is missing or stale reads as "not installed" to the
      // integration's own check, and reporting that as "unrecognised shape"
      // sends the reader looking at the wrong file.
      const sidecar = inspectSidecars(integration, binaryPath, scope, settingsPath);
      if (sidecar) return { ...base, ...sidecar };
      return { ...base, status: "stale", detail: "unrecognised-shape" };
    }
    return { ...base, status: "absent" };
  }

  try {
    // `pure` matters for exactly one integration and is harmless for the other
    // eleven: OpenCode's writer also generates its plugin shim on disk, and a
    // read-only check that called it rewrote a real tracked file. The shim is
    // still checked — as a sidecar, below.
    integration.writeHookEntries(regenerated, binaryPath, scope, { pure: true });
  } catch (err) {
    return { ...base, status: "unreadable", detail: errorClass(err) };
  }

  // A settings file can match perfectly while the file it POINTS AT is stale.
  // OpenCode's registration names a generated shim with the binary path baked
  // in, so a shim written by a path that has since moved leaves a registration
  // that still reads correct and an installation that does nothing. Reporting
  // `ok` there is the comfortable lie this module exists to refuse.
  const sidecar = inspectSidecars(integration, binaryPath, scope, settingsPath);
  if (sidecar) return { ...base, ...sidecar };

  if (stableStringify(current) === stableStringify(regenerated)) return { ...base, status: "ok" };
  // Shape first. A difference confined to string VALUES is nearly always our
  // own path — the detector running from a repo checkout while the global
  // install wrote the file, or an install that moved. Reporting that as drift
  // makes every developer machine cry wolf and buries the real thing. The
  // incidents that matter are structural: copilot turning `hooks` from an array
  // into an object, factory rejecting a wrapper, goose's matcher key appearing
  // where it must not.
  const shapeChanged = structuralSignature(current) !== structuralSignature(regenerated);
  return { ...base, status: shapeChanged ? "stale" : "stale_path" };
}

/**
 * Compare every file an integration owns beyond its settings file against what
 * it would write now. Returns a verdict only when something is wrong.
 */
function inspectSidecars(
  integration: ReturnType<typeof getIntegration>,
  binaryPath: string,
  scope: HookScope,
  settingsPath: string,
): { status: DriftStatus; detail?: string } | null {
  let sidecars: { path: string; content: string }[];
  try {
    sidecars = integration.sidecarFiles?.(binaryPath, scope, settingsPath) ?? [];
  } catch {
    return { status: "unreadable", detail: "sidecar" };
  }

  for (const file of sidecars) {
    let actual: string;
    try {
      actual = readFileSync(file.path, "utf8");
    } catch {
      // Registered but the file it names is gone: the CLI loads nothing.
      return { status: "stale", detail: "sidecar-missing" };
    }
    if (isDogfoodCommand(actual)) return { status: "dogfood" };
    if (actual !== file.content) return { status: "stale", detail: "sidecar-stale" };
  }
  return null;
}

/** Error CLASS only — never the message, which can quote file contents. */
function errorClass(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return code ?? err.constructor.name;
  }
  return "unknown";
}

/**
 * Key-order-independent serialisation.
 *
 * `writeHookEntries` mutates in place, so a regenerated object can carry the
 * same content with keys in a different order. Comparing raw `JSON.stringify`
 * would report that as drift and send someone chasing a file that is correct.
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Keys, nesting and types — every string, number and boolean collapsed to a
 * type token. Two files with the same signature differ only in values.
 */
function structuralSignature(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(structuralSignature).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${structuralSignature(v)}`);
    return `{${entries.join(",")}}`;
  }
  return value === null ? "z" : typeof value === "string" ? "s" : typeof value === "number" ? "n" : "b";
}

export interface DetectOptions {
  /** Restrict to these CLIs. Default: all of them. */
  clis?: readonly IntegrationType[];
  /** Restrict to these scopes. Default: every scope the integration supports. */
  scopes?: readonly HookScope[];
  /** Project-scope root. Default: the process cwd. */
  cwd?: string;
}

/**
 * Inspect every (cli, scope) pair and report what we found.
 *
 * Never throws: a single unreadable file or a broken integration must not hide
 * the other eleven CLIs' results, because the whole point is finding the one
 * that is quietly wrong.
 */
export function detectConfigDrift(opts: DetectOptions = {}): ConfigDriftReport[] {
  const cwd = opts.cwd ?? process.cwd();
  const clis = opts.clis ?? INTEGRATION_TYPES;

  let binaryPath: string;
  try {
    binaryPath = resolveFailproofaiBinary();
  } catch {
    // Without the binary path we cannot regenerate anything comparable, and a
    // guess would manufacture drift on every machine.
    return [];
  }

  const out: ConfigDriftReport[] = [];
  for (const cli of clis) {
    let integration: ReturnType<typeof getIntegration>;
    try {
      integration = getIntegration(cli);
    } catch {
      continue;
    }
    const supported = integration.scopes;
    const scopes = (opts.scopes ?? supported).filter((s: HookScope) => supported.includes(s));
    for (const scope of scopes) {
      let paths: string[];
      try {
        // Usually one; Hermes returns one per profile, and a missed profile
        // runs unhooked in silence.
        paths = settingsPathsFor(integration, scope, cwd);
      } catch {
        continue;
      }
      for (const settingsPath of paths) {
        try {
          out.push(inspectOne(cli, scope, settingsPath, binaryPath, cwd));
        } catch (err) {
          out.push({ cli, scope, settingsPath, status: "unreadable", detail: errorClass(err) });
        }
      }
    }
  }
  return out;
}

/** The reports worth showing a human: everything except a clean or absent one. */
export function driftFindings(reports: readonly ConfigDriftReport[]): ConfigDriftReport[] {
  return reports.filter((r) => r.status === "stale" || r.status === "unreadable");
}
