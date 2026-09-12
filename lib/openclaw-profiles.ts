/**
 * Lightweight OpenClaw profile discovery shared by hook installation code.
 *
 * The default profile lives at `~/.openclaw`; named profiles selected with
 * `openclaw --profile <name>` live in sibling directories named
 * `~/.openclaw-<name>`. Each profile owns an independent `openclaw.json`, so
 * policy enforcement must be installed into every one of them.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export interface OpenClawProfile {
  name: string;
  home: string;
}

export const OPENCLAW_DEFAULT_PROFILE = "default";

/** Active/default OpenClaw state home, respecting OpenClaw's own overrides. */
export function openclawProfileHome(): string {
  const stateDir = (process.env.OPENCLAW_STATE_DIR || process.env.OPENCLAW_HOME || "").trim();
  if (stateDir) return resolve(stateDir);

  const configPath = (process.env.OPENCLAW_CONFIG_PATH || "").trim();
  if (configPath) return dirname(resolve(configPath));

  return join(homedir(), ".openclaw");
}

/**
 * Every standard OpenClaw profile on disk, default first and named profiles in
 * lexical order. A named directory counts as a profile only when it contains
 * `openclaw.json`; this avoids modifying backup or unrelated `.openclaw-*`
 * directories.
 */
export function listOpenClawProfiles(): OpenClawProfile[] {
  const activeHome = openclawProfileHome();
  const activeBase = basename(activeHome);

  // Non-standard OPENCLAW_STATE_DIR locations do not have a well-defined
  // sibling-profile convention. Keep the explicit location authoritative.
  if (activeBase !== ".openclaw" && !activeBase.startsWith(".openclaw-")) {
    return [{ name: OPENCLAW_DEFAULT_PROFILE, home: activeHome }];
  }

  const parent = dirname(activeHome);
  const defaultHome = join(parent, ".openclaw");
  const out: OpenClawProfile[] = [
    { name: OPENCLAW_DEFAULT_PROFILE, home: defaultHome },
  ];

  let entries;
  try {
    entries = readdirSync(parent, { withFileTypes: true });
  } catch {
    return out;
  }

  const named = entries
    .filter((entry) =>
      (entry.isDirectory() || entry.isSymbolicLink()) &&
      entry.name.startsWith(".openclaw-") &&
      entry.name.length > ".openclaw-".length &&
      existsSync(join(parent, entry.name, "openclaw.json")),
    )
    .map((entry) => ({
      name: entry.name.slice(".openclaw-".length),
      home: join(parent, entry.name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  out.push(...named);
  return out;
}
