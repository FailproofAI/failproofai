/**
 * Hermes profile discovery — shared by BOTH pillars.
 *
 * A Hermes "profile" is not a column or a flag: it is a whole separate Hermes
 * home directory, each with its own `config.yaml`, `.env`, `SOUL.md`, and
 * `state.db`. The default profile lives at `~/.hermes`; every other profile at
 * `~/.hermes/profiles/<name>/`. Selection is `hermes -p <name>`, a generated
 * `~/.local/bin/<name>` alias that exports `HERMES_HOME`, or a sticky default
 * recorded in `<root>/active_profile`.
 *
 * Upstream's own contributor guide warns that hardcoding `~/.hermes` breaks
 * profiles — which is exactly what both pillars used to do:
 *   • audit      → read one state.db, so non-default profiles were INVISIBLE;
 *   • enforcement→ wrote one config.yaml, so non-default profiles ran UNHOOKED.
 * Both now enumerate through here.
 *
 * Kept deliberately dependency-light (node:fs / node:os / node:path only) so
 * `src/hooks/integrations.ts` can import it without pulling the sql.js reader
 * into the hook hot path.
 *
 * Home override: set `HERMES_HOME` (Hermes's own env var — respected here so a
 * profile-scoped shell and failproofai agree on what "all profiles" means).
 */
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/** Directory under the Hermes root that holds non-default profiles. */
const PROFILES_DIR = "profiles";

/** Name we give the root home (`~/.hermes`), which Hermes itself leaves unnamed. */
export const HERMES_DEFAULT_PROFILE = "default";

export interface HermesProfile {
  /** Profile name — `"default"` for the root home, else the directory name. */
  name: string;
  /** Absolute HERMES_HOME for this profile (holds config.yaml + state.db). */
  home: string;
}

/**
 * The Hermes ROOT home — the directory that owns `profiles/`.
 *
 * `HERMES_HOME` may point AT a profile (`<root>/profiles/<name>`), because
 * that's what the per-profile alias wrapper exports. We climb back to `<root>`
 * in that case so discovery still sees every sibling profile — mirroring what
 * upstream does so `profile list` can see them all.
 */
export function hermesRoot(): string {
  const env = (process.env.HERMES_HOME || "").trim();
  if (env) {
    const home = resolve(env);
    const parent = dirname(home);
    if (basename(parent) === PROFILES_DIR) return dirname(parent);
    return home;
  }
  return join(homedir(), ".hermes");
}

/**
 * Every Hermes profile on disk: the root home first (as `"default"`), then each
 * `<root>/profiles/<name>/` in name order.
 *
 * Fail-open — a missing or unreadable `profiles/` dir just means "default only",
 * which is the single-profile install everyone starts with.
 *
 * A profile directory literally named `default` would collide with the root's
 * reserved name; the root wins and the directory is skipped (dedup by name keeps
 * grouping keys unique and the outcome deterministic).
 */
export function listHermesProfiles(): HermesProfile[] {
  const root = hermesRoot();
  const out: HermesProfile[] = [{ name: HERMES_DEFAULT_PROFILE, home: root }];
  const seen = new Set<string>([HERMES_DEFAULT_PROFILE]);

  let names: string[];
  try {
    names = readdirSync(join(root, PROFILES_DIR), { withFileTypes: true })
      // Symlinked profile dirs are legitimate, and `isDirectory()` is false for them.
      .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  } catch {
    return out;
  }

  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, home: join(root, PROFILES_DIR, name) });
  }
  return out;
}

// ── (profile, source) naming ────────────────────────────────────────────────
//
// Gateway sessions have no cwd to group by, so the dashboard and the audit
// synthesize a project per (profile, source). Lives here — next to the profile
// list the parser needs — so lib/hermes-sessions.ts and lib/hermes-projects.ts
// can both use it without importing each other.

/**
 * Encoded project name for a (profile, source) pair.
 *
 * `decodeFolderName()` renders every `-` as `/`, so `hermes-work-slack` shows up
 * as `hermes/work/slack` in the projects panel with no UI change.
 */
export function hermesProjectName(profile: string, source: string): string {
  return `hermes-${profile}-${source}`;
}

/** Machine-readable grouping key, shown under the project name. */
export function hermesProjectPath(profile: string, source: string): string {
  return `hermes:${profile}:${source}`;
}

export interface HermesNameSplit {
  profile: string;
  source: string;
}

/**
 * Every way `hermes-<profile>-<source>` could split, best guess first.
 *
 * Profile names may contain `-`, so the slug is never split blindly: each
 * candidate is a profile that actually exists on disk, tried longest-first.
 * Length alone is not decisive though — with profiles `work` and `work-slack`,
 * `hermes-work-slack-dev` could be `work-slack`+`dev` or `work`+`slack-dev` —
 * so callers walk the candidates and take the first that owns real sessions.
 *
 * The last candidate is always the legacy `hermes-<source>` form attributed to
 * the default profile, keeping links made before profile support alive.
 */
export function hermesProjectNameCandidates(name: string): HermesNameSplit[] {
  if (!name.startsWith("hermes-")) return [];
  const rest = name.slice("hermes-".length);
  if (!rest) return [];

  const out: HermesNameSplit[] = [];
  const profiles = listHermesProfiles()
    .map((p) => p.name)
    .sort((a, b) => b.length - a.length);
  for (const profile of profiles) {
    const prefix = `${profile}-`;
    if (rest.startsWith(prefix) && rest.length > prefix.length) {
      out.push({ profile, source: rest.slice(prefix.length) });
    }
  }
  out.push({ profile: HERMES_DEFAULT_PROFILE, source: rest });
  return out;
}

/** The best-guess split for a project name — `null` if it isn't a Hermes one. */
export function parseHermesProjectName(name: string): HermesNameSplit | null {
  return hermesProjectNameCandidates(name)[0] ?? null;
}
