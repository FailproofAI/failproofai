// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  AGENT_SKILL_MARKER,
  AGENT_SKILL_MD,
  AGENT_SKILL_NAME,
  agentSkillRoots,
  installAgentSkill,
  installedAgentSkillDirs,
  removeAgentSkill,
} from "../../src/hooks/agent-skill";
import { INTEGRATION_TYPES } from "../../src/hooks/types";

// Every variable that moves an agent's folder, so a developer's own exports
// can never point a test at their real agents.
const ENV = [
  "HOME", "FAILPROOFAI_HOME", "XDG_CONFIG_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "COPILOT_HOME",
  "PI_CODING_AGENT_DIR", "HERMES_HOME", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH",
  "FACTORY_HOME_OVERRIDE", "GOOSE_PATH_ROOT",
];
let saved: Record<string, string | undefined>;
let home: string;
beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  home = mkdtempSync(join(tmpdir(), "fpai-skill-"));
  process.env.HOME = home;
  process.env.FAILPROOFAI_HOME = join(home, ".failproofai");
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(home, { recursive: true, force: true });
});

const rel = (paths: string[]) => paths.map((p) => relative(home, p));
const skillFile = (root: string) => join(root, AGENT_SKILL_NAME, "SKILL.md");

describe("agentSkillRoots", () => {
  it("is each agent's own user folder, as verified against each CLI", () => {
    expect(Object.fromEntries(INTEGRATION_TYPES.map((id) => [id, rel(agentSkillRoots(id))]))).toEqual({
      claude: [".claude/skills"],
      codex: [".codex/skills"],
      copilot: [".copilot/skills"],
      cursor: [".cursor/skills"],
      opencode: [".config/opencode/skills"],
      pi: [".pi/agent/skills"],
      hermes: [".hermes/skills"],
      openclaw: [".openclaw/skills"],
      factory: [".factory/skills"],
      devin: [".config/devin/skills"],
      antigravity: [".gemini/config/skills"],
      goose: [".config/goose/skills"],
    });
  });

  it("follows each agent's own override", () => {
    const at = (name: string) => join(home, "moved", name);
    Object.assign(process.env, {
      CLAUDE_CONFIG_DIR: at("claude"), CODEX_HOME: at("codex"), COPILOT_HOME: at("copilot"),
      XDG_CONFIG_HOME: at("xdg"), PI_CODING_AGENT_DIR: at("pi"), FACTORY_HOME_OVERRIDE: at("factory"),
    });
    expect(rel(["claude", "codex", "copilot", "opencode", "pi", "factory", "devin", "goose"].flatMap((id) =>
      agentSkillRoots(id as never)))).toEqual([
      "moved/claude/skills", "moved/codex/skills", "moved/copilot/skills", "moved/xdg/opencode/skills",
      "moved/pi/skills", "moved/factory/.factory/skills", "moved/xdg/devin/skills", "moved/xdg/goose/skills",
    ]);
    process.env.GOOSE_PATH_ROOT = at("goose");
    expect(rel(agentSkillRoots("goose"))).toEqual(["moved/goose/config/skills"]);
  });

  it("covers every Hermes and OpenClaw profile, since each reads only its own", () => {
    mkdirSync(join(home, ".hermes", "profiles", "work"), { recursive: true });
    mkdirSync(join(home, ".openclaw-work"), { recursive: true });
    writeFileSync(join(home, ".openclaw-work", "openclaw.json"), "{}");
    expect(rel(agentSkillRoots("hermes"))).toEqual([".hermes/skills", ".hermes/profiles/work/skills"]);
    expect(rel(agentSkillRoots("openclaw"))).toEqual([".openclaw/skills", ".openclaw-work/skills"]);
  });

  it("never uses the shared ~/.agents/skills", () => {
    const all = INTEGRATION_TYPES.flatMap((id) => rel(agentSkillRoots(id)));
    expect(all.filter((p) => p.startsWith(".agents"))).toEqual([]);
  });
});

describe("the skill file", () => {
  const front = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(AGENT_SKILL_MD);

  it("names the folder it sits in, with a description every agent shows enough of", () => {
    expect(front?.[1]).toBe(AGENT_SKILL_NAME);
    const description = front![2]!;
    // Copilot drops a skill over 1024; droid shows the model 200, Hermes 57.
    expect(description.length).toBeLessThanOrEqual(200);
    expect(description.slice(0, 57)).toMatch(/^FailproofAI hooks, policies/);
  });

  it("points at the umbrella skill and its siblings online", () => {
    const base = "https://raw.githubusercontent.com/FailproofAI/skills/main/skills";
    for (const name of ["failproofai", "failproofai-policy-author", "failproofai-policy-publish", "fp-cloud-cli", "failproofai-sdk", "failproofai-eval-brainstorm", "failproofai-eval-author", "failproofai-alert-author", "failproofai-audit-author"]) {
      expect(AGENT_SKILL_MD).toContain(`${base}/${name}/SKILL.md`);
    }
  });
});

describe("installAgentSkill", () => {
  it("writes the skill and its marker into each agent's folder", () => {
    expect(installAgentSkill(["claude", "goose"])).toEqual(["claude", "goose"]);
    for (const id of ["claude", "goose"] as const) {
      const [root] = agentSkillRoots(id);
      expect(readFileSync(skillFile(root!), "utf8")).toBe(AGENT_SKILL_MD);
      expect(existsSync(join(root!, AGENT_SKILL_NAME, AGENT_SKILL_MARKER))).toBe(true);
    }
    expect(existsSync(join(home, ".codex"))).toBe(false);
  });

  it("rewrites its own folder, and never touches a failproofai skill someone else put there", () => {
    const [claude] = agentSkillRoots("claude");
    const [codex] = agentSkillRoots("codex");
    installAgentSkill(["claude"]);
    writeFileSync(skillFile(claude!), "old");
    mkdirSync(join(codex!, AGENT_SKILL_NAME), { recursive: true });
    writeFileSync(skillFile(codex!), "the full skill, from npx skills");

    expect(installAgentSkill(["claude", "codex"])).toEqual(["claude"]);
    expect(readFileSync(skillFile(claude!), "utf8")).toBe(AGENT_SKILL_MD);
    expect(readFileSync(skillFile(codex!), "utf8")).toBe("the full skill, from npx skills");
  });

  it("leaves Codex to a failproofai skill in ~/.agents/skills, which Codex would list beside ours", () => {
    const npx = join(home, ".agents", "skills", AGENT_SKILL_NAME);
    mkdirSync(npx, { recursive: true });
    writeFileSync(join(npx, "SKILL.md"), "the full skill, from npx skills -g");
    process.env.CODEX_HOME = join(home, "moved-codex"); // ~/.agents stays under HOME regardless

    expect(installAgentSkill(["codex", "claude"])).toEqual(["claude"]);
    expect(existsSync(join(home, "moved-codex", "skills", AGENT_SKILL_NAME))).toBe(false);
    expect(readFileSync(join(npx, "SKILL.md"), "utf8")).toBe("the full skill, from npx skills -g");
  });

  it("takes back its own Codex copy once ~/.agents/skills has one", () => {
    const [codex] = agentSkillRoots("codex");
    installAgentSkill(["codex"]);
    expect(existsSync(skillFile(codex!))).toBe(true);
    const npx = join(home, ".agents", "skills", AGENT_SKILL_NAME);
    mkdirSync(npx, { recursive: true });
    writeFileSync(join(npx, "SKILL.md"), "the full skill");

    expect(installAgentSkill(["codex"])).toEqual([]);
    expect(existsSync(join(codex!, AGENT_SKILL_NAME))).toBe(false);
  });

  it("carries on when its old Codex copy can't be taken back", () => {
    const [codex] = agentSkillRoots("codex");
    installAgentSkill(["codex"]);
    const npx = join(home, ".agents", "skills", AGENT_SKILL_NAME);
    mkdirSync(npx, { recursive: true });
    writeFileSync(join(npx, "SKILL.md"), "the full skill");
    chmodSync(codex!, 0o555); // the copy inside can't be deleted (except by root)
    try {
      expect(() => installAgentSkill(["codex", "claude"])).not.toThrow();
      expect(existsSync(skillFile(agentSkillRoots("claude")[0]!))).toBe(true);
    } finally {
      chmodSync(codex!, 0o755);
    }
  });

  it("skips a folder it cannot write without failing the rest", () => {
    writeFileSync(join(home, ".codex"), "a file where the folder would go");
    expect(installAgentSkill(["codex", "claude"])).toEqual(["claude"]);
  });

  it("keeps the Codex copy when the shared skill folder has no SKILL.md", () => {
    const [codex] = agentSkillRoots("codex");
    installAgentSkill(["codex"]);
    mkdirSync(join(home, ".agents", "skills", AGENT_SKILL_NAME), { recursive: true });

    expect(installAgentSkill(["codex"])).toEqual(["codex"]);
    expect(readFileSync(skillFile(codex!), "utf8")).toBe(AGENT_SKILL_MD);
  });

  it("writes every Hermes profile", () => {
    mkdirSync(join(home, ".hermes", "profiles", "work"), { recursive: true });
    installAgentSkill(["hermes"]);
    for (const root of agentSkillRoots("hermes")) expect(existsSync(skillFile(root))).toBe(true);
  });
});

describe("removeAgentSkill", () => {
  it("removes only the folders failproofai wrote", () => {
    installAgentSkill(["claude", "cursor"]);
    const [codex] = agentSkillRoots("codex");
    mkdirSync(join(codex!, AGENT_SKILL_NAME), { recursive: true });
    writeFileSync(skillFile(codex!), "someone else's");

    expect(rel(installedAgentSkillDirs())).toEqual([".claude/skills/failproofai", ".cursor/skills/failproofai"]);
    expect(rel(removeAgentSkill())).toEqual([".claude/skills/failproofai", ".cursor/skills/failproofai"]);
    expect(installedAgentSkillDirs()).toEqual([]);
    expect(existsSync(join(home, ".claude", "skills"))).toBe(true);
    expect(readFileSync(skillFile(codex!), "utf8")).toBe("someone else's");
  });
});
