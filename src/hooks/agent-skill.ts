/**
 * The `failproofai` skill: one small SKILL.md that `failproofai config` puts in
 * every agent this machine has, in that agent's own user-scope skills folder.
 *
 * It carries no instructions of its own. It points the agent at the umbrella
 * skill in the public FailproofAI/skills repository, which the agent reads when
 * a FailproofAI task comes up, along with whichever focused sibling skill and
 * `references/*.md` file the task needs. So the content is never stale on
 * disk: changing that repository changes what every machine reads next, with
 * no release and no re-run of setup.
 *
 * Every folder below was verified on 2026-10-23 against the real CLI (versions
 * in each comment), by planting a probe skill in each candidate folder and
 * reading what the CLI listed, or what it sent to a mock model server.
 *
 * Never `~/.agents/skills`, although many agents read it: Claude Code does not
 * read it at all, Codex lists a skill found there and in `~/.codex/skills`
 * twice, Copilot stops reading it once `COPILOT_HOME` is set, and in OpenClaw it
 * outranks OpenClaw's own folder. Each agent's own folder works on its own.
 *
 * The frontmatter is shaped by the strictest of them: `name` equals the folder
 * name (Claude Code, Cursor and Devin go by the folder, the rest by `name`, and
 * Antigravity shows a skill without one as "SKILL"); Copilot drops a skill whose
 * description is over 1024 characters, droid shows the model the first 200, and
 * Hermes the first 57 — so the description is short and leads with what it is
 * for.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { listHermesProfiles } from "../../lib/hermes-profiles";
import { listOpenClawProfiles } from "../../lib/openclaw-profiles";
import { hookLogWarn } from "./hook-logger";
import { writeConfigFileAtomic } from "./safe-config-write";
import { INTEGRATION_TYPES, type IntegrationType } from "./types";

export const AGENT_SKILL_NAME = "failproofai";

/**
 * Sits beside SKILL.md in a folder failproofai wrote. A `failproofai` folder
 * without it belongs to someone else — most often the full skill installed with
 * `npx skills add FailproofAI/skills` — and is never overwritten or removed.
 */
export const AGENT_SKILL_MARKER = ".failproofai-managed";

const SKILLS_RAW = "https://raw.githubusercontent.com/FailproofAI/skills/main/skills";

export const AGENT_SKILL_MD = `---
name: ${AGENT_SKILL_NAME}
description: FailproofAI hooks, policies, daemon, Cloud, the fp CLI and the SDK. Use for any question about setting up, running or fixing FailproofAI.
---

# FailproofAI

This skill is a pointer. Before acting on anything FailproofAI, read the full skill, which is kept current online (use your web fetch tool, or \`curl -fsSL <url>\`):

${SKILLS_RAW}/${AGENT_SKILL_NAME}/SKILL.md

Files it names by a relative path, such as \`references/cli.md\`, are in that same folder: ${SKILLS_RAW}/${AGENT_SKILL_NAME}/<path>

For focused work, read the matching skill too. Each has the same layout, with its own \`references/\` beside it.

- Writing or testing a policy: ${SKILLS_RAW}/failproofai-policy-author/SKILL.md
- Publishing a policy pack: ${SKILLS_RAW}/failproofai-policy-publish/SKILL.md
- FailproofAI Cloud and the \`fp\` CLI: ${SKILLS_RAW}/fp-cloud-cli/SKILL.md
- Adding the SDK to an agent, or running an evaluator: ${SKILLS_RAW}/failproofai-sdk/SKILL.md
- Planning evaluations: ${SKILLS_RAW}/failproofai-eval-brainstorm/SKILL.md
`;

/** An agent's own override for where it keeps its files, else the default. */
function envDir(name: string, fallback: string): string {
  const value = (process.env[name] ?? "").trim();
  return value ? resolve(value) : fallback;
}

/**
 * The skills folders `id` reads at user scope — one, except for Hermes and
 * OpenClaw, where every profile reads only its own.
 */
export function agentSkillRoots(id: IntegrationType): string[] {
  const home = homedir();
  const config = envDir("XDG_CONFIG_HOME", join(home, ".config"));
  switch (id) {
    // 2.1.309. CLAUDE_CONFIG_DIR replaces ~/.claude rather than adding to it.
    case "claude":
      return [join(envDir("CLAUDE_CONFIG_DIR", join(home, ".claude")), "skills")];
    // 0.164.0. Its own skill installer writes here too.
    case "codex":
      return [join(envDir("CODEX_HOME", join(home, ".codex")), "skills")];
    // 1.0.103.
    case "copilot":
      return [join(envDir("COPILOT_HOME", join(home, ".copilot")), "skills")];
    // 2026.10.22. Always under HOME: CURSOR_CONFIG_DIR does not move it.
    case "cursor":
      return [join(home, ".cursor", "skills")];
    // 1.19.4.
    case "opencode":
      return [join(config, "opencode", "skills")];
    // 1.4.0 and 0.73.1. Not the pi-extension package: a `skills/` folder there
    // makes Pi stop loading the package's index.ts, and with it enforcement.
    case "pi":
      return [join(envDir("PI_CODING_AGENT_DIR", join(home, ".pi", "agent")), "skills")];
    // 0.21.3. A profile reads its own skills/ and no other profile's.
    case "hermes":
      return listHermesProfiles().map((p) => join(p.home, "skills"));
    // 2026.9.2. The same profile homes its hooks are installed into.
    case "openclaw":
      return listOpenClawProfiles().map((p) => join(p.home, "skills"));
    // 0.248.0. FACTORY_HOME_OVERRIDE stands in for HOME.
    case "factory":
      return [join(envDir("FACTORY_HOME_OVERRIDE", home), ".factory", "skills")];
    // 3000.11.205.
    case "devin":
      return [join(config, "devin", "skills")];
    // 1.4.6. The documented user folder, beside the hooks.json we write; not
    // ~/.gemini/antigravity/skills, which it does not read.
    case "antigravity":
      return [join(home, ".gemini", "config", "skills")];
    // 1.55.0. GOOSE_PATH_ROOT moves Goose's whole config tree.
    case "goose": {
      const root = (process.env.GOOSE_PATH_ROOT ?? "").trim();
      return [root ? join(resolve(root), "config", "skills") : join(config, "goose", "skills")];
    }
  }
}

/**
 * Whether `id` already has a `failproofai` skill from a folder it also reads,
 * and would list ours beside it rather than pick one. Only Codex: it reads
 * `~/.agents/skills` (always under HOME, whatever CODEX_HOME says) as well as
 * its own folder and lists a name found in both twice (0.164.0) — and that is
 * where `npx skills add FailproofAI/skills -g` puts the full skill for it.
 */
function listedTwice(id: IntegrationType): boolean {
  return id === "codex" && existsSync(join(homedir(), ".agents", "skills", AGENT_SKILL_NAME));
}

/**
 * Write the skill for each agent in `ids`. Never fails setup: an agent whose
 * folder cannot be written is logged and skipped. Returns the agents it was
 * written for.
 */
export function installAgentSkill(ids: readonly IntegrationType[]): IntegrationType[] {
  const installed: IntegrationType[] = [];
  for (const id of ids) {
    let wrote = false;
    const covered = listedTwice(id);
    for (const root of agentSkillRoots(id)) {
      const dir = join(root, AGENT_SKILL_NAME);
      const ours = existsSync(join(dir, AGENT_SKILL_MARKER));
      // Covered already: a copy of ours from an earlier run is now the duplicate.
      if (covered) {
        if (ours) removeSkillDir(dir);
        continue;
      }
      if (existsSync(dir) && !ours) continue;
      try {
        // Marker first: a run interrupted before it would leave a folder every
        // later run takes for someone else's and skips.
        mkdirSync(dir, { recursive: true });
        writeConfigFileAtomic(join(dir, AGENT_SKILL_MARKER), "", { backup: false, symlinks: "replace" });
        writeConfigFileAtomic(join(dir, "SKILL.md"), AGENT_SKILL_MD, { backup: false, symlinks: "replace" });
        wrote = true;
      } catch (err) {
        hookLogWarn(`the failproofai skill was not written to ${dir}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (wrote) installed.push(id);
  }
  return installed;
}

/** Every skill folder failproofai wrote, for any agent. */
export function installedAgentSkillDirs(): string[] {
  const dirs = INTEGRATION_TYPES.flatMap((id) => agentSkillRoots(id).map((root) => join(root, AGENT_SKILL_NAME)));
  return [...new Set(dirs)].filter((dir) => existsSync(join(dir, AGENT_SKILL_MARKER)));
}

/** Remove one skill folder; never throws, so neither setup nor uninstall stops on it. */
function removeSkillDir(dir: string): boolean {
  try {
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch (err) {
    hookLogWarn(`the failproofai skill was not removed from ${dir}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** Remove every skill folder failproofai wrote. Returns the folders removed. */
export function removeAgentSkill(): string[] {
  return installedAgentSkillDirs().filter(removeSkillDir);
}
