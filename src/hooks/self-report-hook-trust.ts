/**
 * Self Reports for the agents whose HOOK records the report (Claude Code and
 * Codex, contract §8): will that hook actually run?
 *
 * Both can skip failproofai's hooks while still loading its MCP server:
 *
 * - Codex ≥0.129 runs a `hooks.json` hook only once a person trusted it at its
 *   current hash (`codexHookTrust`). An untrusted hook never runs, so a report
 *   would be lost. Hooks in Codex's system config run without trust.
 * - Claude Code runs no hooks with `disableAllHooks: true`, and only managed
 *   ones with a managed `allowManagedHooksOnly: true`.
 *
 * Two uses, and only the second decides whether a report is recorded:
 *
 * - `self-report sync` registers such an agent on the daemon's HTTP endpoint
 *   (which records nothing for it) only when its user-scope hook will run, and
 *   over stdio otherwise. `status` shows the state and how to fix it.
 * - The stdio server records a Claude Code or Codex report itself unless the
 *   hook already did (`selfReportHookRecordedRecently`). The agent runs its
 *   PreToolUse hook before it sends the MCP call, so the hook's row is on disk
 *   first. Asking what happened, rather than predicting it from trust state,
 *   is what keeps a report from being lost or counted twice when the
 *   prediction is wrong (a Codex whose hash scheme changed, say) or the state
 *   changes while the agent runs (a person trusts the hooks mid-session).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  CODEX_UNTRUSTED_NOTICE,
  codexGatesHookTrust,
  codexHome,
  codexSystemHooksPresent,
  detectCodexVersion,
  failproofaiCodexHookIdentities,
  parseCodexTrustedHashes,
} from "./codex-system-hooks";
import { claudeConfigDir, getIntegration } from "./integrations";
import { getHookActivityEntriesSince } from "./hook-activity-store";
import { selfReportArgs } from "./self-report";
import { selfReportClip } from "./self-report-names";

/** The agents whose hook, when it runs, is the recorder. */
export const SELF_REPORT_HOOK_RECORDED_AGENTS: readonly string[] = ["claude", "codex"];

export type SelfReportHookState =
  | { recorder: "hook" }
  | { recorder: "server"; reason: string; fix: string };

export interface SelfReportHookTrustDeps {
  /** Codex: the trust check (default `codexHookTrust`'s pieces, at user scope). */
  codexVersion?: () => string | null;
  codexSystemPresent?: () => boolean;
  /** Claude Code: managed settings file (default per platform). */
  claudeManagedSettingsPath?: string | null;
  /** Hooks installed at user scope (default: the integration's own check). */
  userHooksInstalled?: (agent: string) => boolean;
}

// ── Codex ───────────────────────────────────────────────────────────────────

/** `.codex/hooks.json` files a Codex started in `cwd` reads: the user's, then the project's up the tree. */
function codexHooksFiles(cwd: string | undefined): string[] {
  const files = [resolve(codexHome(), "hooks.json")];
  if (cwd) {
    let dir = resolve(cwd);
    for (;;) {
      const candidate = resolve(dir, ".codex", "hooks.json");
      if (!files.includes(candidate)) files.push(candidate);
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return files;
}

/**
 * Whether Codex will run failproofai's PreToolUse hook (the one that records a
 * report): it is in Codex's system config, or in a hooks.json Codex reads and
 * either trusted at its current hash or on a Codex too old to ask.
 */
export function codexReportHookRuns(cwd?: string, deps: SelfReportHookTrustDeps = {}): boolean {
  try {
    if ((deps.codexSystemPresent ?? codexSystemHooksPresent)()) return true;
  } catch {
    // unreadable system config: fall through to hooks.json
  }
  let trusted: Map<string, string> | undefined;
  let version: string | null | undefined;
  for (const file of codexHooksFiles(cwd)) {
    const pre = failproofaiCodexHookIdentities(file).filter((h) => h.key.includes(":pre_tool_use:"));
    if (pre.length === 0) continue;
    if (version === undefined) version = (deps.codexVersion ?? detectCodexVersion)();
    if (!codexGatesHookTrust(version)) return true;
    if (!trusted) {
      try {
        trusted = parseCodexTrustedHashes(readFileSync(resolve(codexHome(), "config.toml"), "utf8"));
      } catch {
        trusted = new Map();
      }
    }
    if (pre.some((h) => trusted!.get(h.key) === h.hash)) return true;
  }
  return false;
}

// ── Claude Code ─────────────────────────────────────────────────────────────

function claudeManagedSettingsPath(): string | null {
  const override = process.env.FAILPROOFAI_CLAUDE_MANAGED_SETTINGS;
  if (override !== undefined) return override.trim() === "" || override === "off" ? null : override;
  if (process.platform === "darwin") return "/Library/Application Support/ClaudeCode/managed-settings.json";
  if (process.platform === "linux") return "/etc/claude-code/managed-settings.json";
  return null;
}

function readJsonObject(path: string | null): Record<string, unknown> | null {
  if (!path || !existsSync(path)) return null;
  try {
    const v: unknown = JSON.parse(readFileSync(path, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Why Claude Code will not run failproofai's user or project hooks, or null
 * when nothing stops them. `disableAllHooks` is read with Claude Code's
 * precedence (managed, then local, then project, then user: the first layer
 * that sets it wins); a managed `allowManagedHooksOnly` stops every hook that
 * is not managed, which failproofai's never are.
 */
export function claudeHooksBlockedReason(cwd?: string, deps: SelfReportHookTrustDeps = {}): string | null {
  const managed = readJsonObject(deps.claudeManagedSettingsPath !== undefined ? deps.claudeManagedSettingsPath : claudeManagedSettingsPath());
  if (managed?.allowManagedHooksOnly === true) return "managed settings allow only managed hooks (allowManagedHooksOnly)";
  const layers: Array<[string, Record<string, unknown> | null]> = [
    ["managed settings", managed],
    ...(cwd
      ? ([
          [".claude/settings.local.json", readJsonObject(resolve(cwd, ".claude", "settings.local.json"))],
          [".claude/settings.json", readJsonObject(resolve(cwd, ".claude", "settings.json"))],
        ] as Array<[string, Record<string, unknown> | null]>)
      : []),
    [`${claudeConfigDir()}/settings.json`, readJsonObject(resolve(claudeConfigDir(), "settings.json"))],
  ];
  for (const [label, layer] of layers) {
    const v = layer?.disableAllHooks;
    if (typeof v === "boolean") return v ? `disableAllHooks is set in ${label}` : null;
  }
  return null;
}

// ── Both ────────────────────────────────────────────────────────────────────

function defaultUserHooksInstalled(agent: string): boolean {
  try {
    return getIntegration(agent as Parameters<typeof getIntegration>[0]).hooksInstalledInSettings("user");
  } catch {
    return false;
  }
}

/**
 * Who records a report from `agent` registered at user scope: its hook, or (for
 * Claude Code and Codex when their user-scope hook will not run) the MCP
 * server. Every other agent is recorded by the server and is not asked here.
 */
export function selfReportHookState(agent: string, deps: SelfReportHookTrustDeps = {}): SelfReportHookState {
  if (!SELF_REPORT_HOOK_RECORDED_AGENTS.includes(agent)) return { recorder: "hook" };
  const installed = (deps.userHooksInstalled ?? defaultUserHooksInstalled)(agent);
  if (agent === "codex") {
    if (codexReportHookRuns(undefined, deps)) return { recorder: "hook" };
    return installed
      ? { recorder: "server", reason: "Codex has not trusted failproofai's hooks, so it does not run them", fix: CODEX_UNTRUSTED_NOTICE.replace(/\n/g, " ") }
      : { recorder: "server", reason: "failproofai's Codex hooks are not installed at user scope", fix: "Run `failproofai policies --install --cli codex`." };
  }
  const blocked = claudeHooksBlockedReason(undefined, deps);
  if (blocked) {
    return { recorder: "server", reason: `Claude Code runs no failproofai hooks: ${blocked}`, fix: "Remove that setting to let failproofai's hooks run." };
  }
  if (!installed) {
    return { recorder: "server", reason: "failproofai's Claude Code hooks are not installed at user scope", fix: "Run `failproofai policies --install --cli claude`." };
  }
  return { recorder: "hook" };
}

/** How long after its hook row a report can still be the same call. */
export const SELF_REPORT_HOOK_DEDUPE_MS = 2 * 60 * 1000;

/**
 * Whether `agent`'s hook already recorded this report: a PreToolUse row from
 * that integration, written in the last two minutes, carrying a `selfReport`
 * with the same category and detail (as the hook would have clipped them).
 * An unreadable activity store reads as "no", so a report is recorded rather
 * than lost.
 */
export function selfReportHookRecordedRecently(
  agent: string,
  args: unknown,
  now: number = Date.now(),
): boolean {
  const { category, detail } = selfReportArgs(args ?? {});
  const want = { category: selfReportClip(category), detail: selfReportClip(detail) };
  let rows: Array<Record<string, unknown>>;
  try {
    rows = getHookActivityEntriesSince(now - SELF_REPORT_HOOK_DEDUPE_MS) as unknown as Array<Record<string, unknown>>;
  } catch {
    return false;
  }
  return rows.some((row) => {
    if (row.integration !== agent || row.eventType !== "PreToolUse") return false;
    const ts = typeof row.timestamp === "number" ? row.timestamp : NaN;
    if (!Number.isFinite(ts) || now - ts > SELF_REPORT_HOOK_DEDUPE_MS || ts - now > 60_000) return false;
    const sr = row.selfReport as { category?: unknown; detail?: unknown } | undefined;
    return !!sr && sr.category === want.category && sr.detail === want.detail;
  });
}
