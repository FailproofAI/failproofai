/**
 * The screen bare `failproofai` prints when the local dashboard is up: the
 * logomark, the wordmark header, a DASHBOARD block, at most one attention line,
 * LINKS and the key hint. The design target is `reference/screens.js` → `launch`
 * in the TUI redesign handoff.
 *
 * Pure on purpose: facts in, lines out. Reading the machine is
 * `launch-facts.ts`, and noticing that the server is listening is
 * `launch-ready.ts`, so every state of this screen is asserted without starting
 * a server.
 *
 * Every top-level name here is long and specific. The CLI ships as one
 * scope-hoisted bundle, and a short name that matches a local inside a builtin
 * policy or an audit detector makes the bundler rename that local, which
 * changes the audit cache key and rescans every user's history (see
 * `screenKit` in `src/hooks/tui.ts`).
 */
import { screenKit } from "../src/hooks/tui";

/** The links the screen ends on. `https://` stays: GNOME/VTE and others only
 *  make a link clickable when it carries a scheme. The docs root is the live
 *  docs' home page (`docs/index.mdx`); the `/introduction` page #461 pointed at
 *  was removed when the docs site was rebuilt (#699) and has no redirect. */
export const LAUNCH_SCREEN_LINKS: ReadonlyArray<readonly [string, string]> = [
  ["docs", "https://docs.befailproof.ai"],
  ["discord", "https://discord.befailproof.ai/"],
  ["github", "https://github.com/failproofai/failproofai"],
  ["reddit", "https://www.reddit.com/r/failproofai/"],
];

export interface LaunchScreenFacts {
  /** The address to open, from the bind address and port (`dashboardBrowseUrl`). */
  url: string;
  /** The server is listening. False when it was still starting at the deadline, or in dev mode. */
  live: boolean;
  /** The `policies` value (`describePoliciesOn`). */
  policies: string;
  /** The `agents` value (`describeTracedAgents`). */
  agents: string;
  /** The `cloud` value (`describeCloudConnection`). */
  cloud: string;
  /** Set when the bind address is reachable from other machines. Outranks every other warning. */
  exposed?: { host: string; fix: string };
  /** `notEnforcingReason()` answered with a cause. */
  notEnforcing: boolean;
}

export interface LaunchScreenOpts {
  color: boolean;
  cols?: number;
  /** Draw the logomark. The caller decides: a terminal only, and not after the setup wizard drew one. */
  logo: boolean;
  version?: string;
}

export function launchScreenLines(facts: LaunchScreenFacts, opts: LaunchScreenOpts): string[] {
  const k = screenKit({ color: opts.color, cols: opts.cols, version: opts.version });
  const art = opts.logo ? k.logo() : [];
  // One attention line at most. The exposed bind is a security warning and
  // outranks the state one; the fix sits on its own line because the sentence
  // carries all three consequences and is too long to share one.
  const attention = facts.exposed
    ? [k.caution(exposedBindWarning(facts.exposed.host)), `  ${k.cmd(facts.exposed.fix)}`]
    : facts.notEnforcing
      ? [k.caution("Policies are not enforcing yet.", "failproofai config")]
      : [];
  return [
    "",
    ...(art.length > 0 ? [...art, ""] : []),
    k.header("End-to-end failure layer for AI agents"),
    "",
    k.head("Dashboard"),
    ...k.kv([
      ["url", `${k.cmd(facts.url)}  ${facts.live ? `${k.on} live` : `${k.off} starting`}`],
      ["policies", facts.policies],
      ["agents", facts.agents],
      ["cloud", facts.cloud],
    ]),
    ...(attention.length > 0 ? ["", ...attention] : []),
    "",
    k.head("Links"),
    ...k.kv(LAUNCH_SCREEN_LINKS.map(([label, href]): [string, string] => [label, href])),
    "",
    k.keys(["ctrl+c stop the dashboard"]),
    "",
  ];
}

/**
 * The address a browser can open for a bind address. Brackets an IPv6 literal,
 * and turns a wildcard bind into this machine's loopback, which it also serves:
 * `0.0.0.0` is not an address anyone can browse to.
 */
export function dashboardBrowseUrl(bindHost: string, port: string | number): string {
  const raw = bindHost.trim();
  const host =
    raw === "" || raw === "0.0.0.0"
      ? "127.0.0.1"
      : raw === "::" || raw === "[::]" || raw === "0:0:0:0:0:0:0:0"
        ? "[::1]"
        : raw.includes(":") && !raw.startsWith("[")
          ? `[${raw}]`
          : raw;
  return `http://${host}:${port}`;
}

/** The security warning for a bind other machines can reach. All three consequences stay. */
export function exposedBindWarning(bindHost: string): string {
  return (
    `The dashboard is bound to ${bindHost}, which is reachable from outside this machine, and has no ` +
    "authentication: anyone who can reach it can read your session transcripts, disable your policies " +
    "and uninstall failproofai's hooks."
  );
}

/** Policies switched on, per source that has any, and whether custom policy files exist. */
export interface LaunchPoliciesSummary {
  /** A pack (`id@version`), the cloud deployment, or the legacy built-ins. */
  sources: Array<{ label: string; count: number; pack: boolean }>;
  /** Configured or convention policy files exist. Never imported to count what they hold. */
  customFiles: boolean;
}

export function describePoliciesOn(summary: LaunchPoliciesSummary): string {
  const total = summary.sources.reduce((n, source) => n + source.count, 0);
  if (total === 0) return summary.customFiles ? "custom policy files only" : "none on";
  const from =
    summary.sources.length === 1
      ? summary.sources[0].label
      : `${summary.sources.length} ${summary.sources.every((source) => source.pack) ? "packs" : "sources"}`;
  return `${total} on from ${from}${summary.customFiles ? ", plus custom policy files" : ""}`;
}

/**
 * `9 traced: Claude Code, OpenAI Codex, GitHub Copilot, Cursor Agent and 5 more`.
 * Four names and a count past five; five or fewer are all named, because
 * "and 1 more" hides a name it had room for.
 */
export function describeTracedAgents(names: readonly string[]): string {
  if (names.length === 0) return "none traced";
  const shown = names.length <= 5 ? names : names.slice(0, 4);
  const rest = names.length - shown.length;
  const list =
    rest > 0
      ? `${shown.join(", ")} and ${rest} more`
      : shown.length === 1
        ? shown[0]
        : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
  return `${names.length} traced: ${list}`;
}

/** The connection, in the precedence `config --status` uses. */
export type LaunchCloudSummary =
  | { kind: "environment"; url: string }
  | { kind: "none" }
  | {
      kind: "connected";
      /** The org recorded at connect time, or null when the server did not name one. */
      org: string | null;
      host: string;
      /** A policy credential: managed policies are pulled. */
      pulling: boolean;
      /** An ingest credential: hook activity is sent. */
      sending: boolean;
      /** The server definitively refused uploads, by status code. Overrides everything else. */
      refused: { codes: number[]; credential: boolean } | null;
    };

export function describeCloudConnection(summary: LaunchCloudSummary): string {
  if (summary.kind === "environment") return `Configured by environment (${summary.url})`;
  if (summary.kind === "none") return "Not connected";
  const lead = summary.org ? `Connected as ${summary.org}` : `Connected to ${summary.host}`;
  if (summary.refused) {
    const what = summary.refused.credential ? "its key is" : "its uploads are";
    return `${lead}, but ${what} refused (${summary.refused.codes.join("/")})`;
  }
  if (!summary.sending) return `${lead}, not sending activity`;
  if (!summary.pulling) return `${lead}, reporting only`;
  return lead;
}

/** Why the dashboard did not start, as the ✕ block launch prints before exiting. */
export function launchFailureLines(
  failure: { portInUse: boolean; cause: string | null; code: number | null },
  opts: { port: string; portFromFlag: boolean; color: boolean },
): string[] {
  const k = screenKit({ color: opts.color });
  if (failure.portInUse) {
    // The shipped CLI always serves on 8020 (the bin refuses --port), so the
    // way out is to free the port. Only the contributor scripts take --port.
    const fix = opts.portFromFlag
      ? `Pass a different ${k.cmd("--port")}, or stop whatever is using ${opts.port}.`
      : `Stop whatever is using it, often another failproofai dashboard, then run ${k.cmd("failproofai")} again.`;
    return ["", k.fail(`Port ${opts.port} is already in use, so the dashboard did not start.`), `  ${fix}`, ""];
  }
  const text = failure.cause
    ? `The dashboard did not start: ${failure.cause}`
    : failure.code === null
      ? "The dashboard stopped before it was ready."
      : `The dashboard stopped before it was ready (exit code ${failure.code}).`;
  return ["", k.fail(text), ""];
}
