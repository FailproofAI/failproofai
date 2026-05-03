/**
 * Single source of truth for agent-CLI metadata used by the dashboard, the
 * `bin/failproofai.mjs` argv parser, the install prompt, and the badge UI.
 *
 * This module is **client-safe** — it only exports plain string metadata. The
 * server-side project / session providers live in their own files
 * (`lib/codex-projects.ts`, `lib/codex-sessions.ts`, `lib/copilot-projects.ts`,
 * `lib/copilot-sessions.ts`, `lib/cursor-projects.ts`, `lib/cursor-sessions.ts`,
 * `lib/opencode-projects.ts`, `lib/opencode-sessions.ts`,
 * `lib/pi-projects.ts`, `lib/pi-sessions.ts`)
 * and are imported lazily by `lib/projects.ts` and the session viewer page so
 * Turbopack doesn't drag Node-only deps (`fs/promises`, `os`) into client
 * bundles.
 *
 * Adding a new agent CLI = three steps:
 *   1. Extend `INTEGRATION_TYPES` in `src/hooks/types.ts` (server-side hook contract).
 *   2. Add an `Integration` impl in `src/hooks/integrations.ts` (install/uninstall plumbing).
 *   3. Add an entry to `CLI_REGISTRY` below — display label and badge classes.
 *      Optionally add a project provider (`lib/<cli>-projects.ts`) and a
 *      session loader (`lib/<cli>-sessions.ts`); wire them into
 *      `lib/projects.ts#getProjectFolders` and the session viewer page's
 *      fallback chain (both already iterate over per-CLI providers).
 *
 * Filter dropdown, badge component, and project-list filter all read from
 * this registry and pick up new CLIs without further code changes.
 */
import type { IntegrationType } from "@/src/hooks/types";

/** Canonical CLI ids the registry knows about. Mirrors `INTEGRATION_TYPES`. */
export const KNOWN_CLI_IDS = ["claude", "codex", "copilot", "cursor", "opencode", "pi"] as const satisfies readonly IntegrationType[];
export type CliId = (typeof KNOWN_CLI_IDS)[number];

/** Per-CLI metadata consumed by the dashboard. */
export interface CliEntry {
  id: CliId;
  label: string;
  /** Tailwind utility classes for the small CLI badge (background + text + border). */
  badgeClasses: string;
}

const CLI_ENTRIES: Record<CliId, CliEntry> = {
  claude: {
    id: "claude",
    label: "Claude Code",
    badgeClasses: "bg-orange-500/10 text-orange-400 border-orange-500/20",
  },
  codex: {
    id: "codex",
    label: "OpenAI Codex",
    badgeClasses: "bg-purple-500/10 text-purple-400 border-purple-500/20",
  },
  copilot: {
    id: "copilot",
    label: "GitHub Copilot",
    badgeClasses: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  },
  cursor: {
    id: "cursor",
    label: "Cursor Agent",
    badgeClasses: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  },
  opencode: {
    id: "opencode",
    label: "OpenCode",
    badgeClasses: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  },
  pi: {
    id: "pi",
    label: "Pi",
    badgeClasses: "bg-pink-500/10 text-pink-400 border-pink-500/20",
  },
};

export function getCliEntry(id: string): CliEntry | undefined {
  return CLI_ENTRIES[id as CliId];
}

export function listCliEntries(): CliEntry[] {
  return KNOWN_CLI_IDS.map((id) => CLI_ENTRIES[id]);
}

/** External CLIs (everything except Claude) that contribute project listings. */
export function listExternalCliEntries(): CliEntry[] {
  return listCliEntries().filter((c) => c.id !== "claude");
}

/** Display label for a CLI id. Returns the id itself if unknown. */
export function getCliLabel(id: string): string {
  return getCliEntry(id)?.label ?? id;
}

/** Badge classes for a CLI id. Falls back to Claude's classes if unknown. */
export function getCliBadgeClasses(id: string): string {
  return getCliEntry(id)?.badgeClasses ?? CLI_ENTRIES.claude.badgeClasses;
}

/** Predicate: is this id a known CLI? Useful when validating user input. */
export function isKnownCli(id: string | null | undefined): id is CliId {
  // hasOwnProperty.call (not `id in CLI_ENTRIES`) so inherited Object.prototype
  // keys like "toString" / "constructor" / "hasOwnProperty" don't pass.
  return typeof id === "string" && Object.prototype.hasOwnProperty.call(CLI_ENTRIES, id);
}
