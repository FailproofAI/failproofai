/**
 * Hermes profile discovery — shared by BOTH pillars.
 *
 * A Hermes "profile" is not a column or a flag: it is a whole separate Hermes
 * home directory, each with its own `config.yaml`, `.env`, `SOUL.md`, and
 * `state.db`. The default profile lives at `~/.hermes`; upstream named profiles
 * live at `~/.hermes/profiles/<name>/`, while older/custom multi-install setups
 * may use sibling homes such as `~/.hermes-work`. Selection is `hermes -p
 * <name>`, a generated `~/.local/bin/<name>` alias that exports `HERMES_HOME`,
 * or a sticky default recorded in `<root>/active_profile`.
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
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/** Directory under the Hermes root that holds non-default profiles. */
const PROFILES_DIR = "profiles";
const STANDARD_HOME = ".hermes";
const SIBLING_HOME_PREFIX = ".hermes-";

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
 * `HERMES_HOME` may point AT an upstream profile (`<root>/profiles/<name>`) or
 * at a sibling installation (`~/.hermes-<name>`). We normalize either standard
 * layout back to `~/.hermes` so discovery covers every installation. A custom
 * non-standard path remains authoritative; scanning arbitrary sibling paths
 * would risk treating backups and unrelated directories as live agents.
 */
export function hermesRoot(): string {
  const env = (process.env.HERMES_HOME || "").trim();
  if (env) {
    let home = resolve(env);
    const parent = dirname(home);
    if (basename(parent) === PROFILES_DIR) home = dirname(parent);
    const base = basename(home);
    if (base === STANDARD_HOME || base.startsWith(SIBLING_HOME_PREFIX)) {
      return join(dirname(home), STANDARD_HOME);
    }
    return home;
  }
  return join(homedir(), STANDARD_HOME);
}

function uniqueProfileName(preferred: string, seen: Set<string>): string {
  if (!seen.has(preferred)) return preferred;
  const base = `${preferred}-home`;
  if (!seen.has(base)) return base;
  let suffix = 2;
  while (seen.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

/**
 * Every Hermes profile on disk: the root home first (as `"default"`), then each
 * `<root>/profiles/<name>/`, then valid `~/.hermes-<name>` sibling homes, in
 * name order within each layout.
 *
 * A sibling home counts only when it contains `config.yaml`, matching OpenClaw
 * discovery and avoiding arbitrary `.hermes-*` backup directories. Upstream
 * `profiles/` directories are authoritative and remain discoverable before
 * their config is first written.
 *
 * A profile directory literally named `default` would collide with the root's
 * reserved name; the root wins and the directory is skipped (dedup by name keeps
 * grouping keys unique and the outcome deterministic).
 */
export function listHermesProfiles(): HermesProfile[] {
  const root = hermesRoot();
  const out: HermesProfile[] = [{ name: HERMES_DEFAULT_PROFILE, home: root }];
  const seen = new Set<string>([HERMES_DEFAULT_PROFILE]);

  let names: string[] = [];
  try {
    names = readdirSync(join(root, PROFILES_DIR), { withFileTypes: true })
      // Symlinked profile dirs are legitimate, and `isDirectory()` is false for them.
      .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  } catch {}

  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, home: join(root, PROFILES_DIR, name) });
  }

  // Only the standard ~/.hermes layout defines `.hermes-*` sibling homes.
  // A custom HERMES_HOME is intentionally not used as a prefix convention.
  if (basename(root) !== STANDARD_HOME) return out;

  let siblings: HermesProfile[] = [];
  const parent = dirname(root);
  try {
    siblings = readdirSync(parent, { withFileTypes: true })
      .filter(
        (entry) =>
          (entry.isDirectory() || entry.isSymbolicLink()) &&
          entry.name.startsWith(SIBLING_HOME_PREFIX) &&
          entry.name.length > SIBLING_HOME_PREFIX.length &&
          existsSync(join(parent, entry.name, "config.yaml")),
      )
      .map((entry) => ({
        name: entry.name.slice(SIBLING_HOME_PREFIX.length),
        home: join(parent, entry.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return out;
  }

  for (const sibling of siblings) {
    const name = uniqueProfileName(sibling.name, seen);
    seen.add(name);
    out.push({ name, home: sibling.home });
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
