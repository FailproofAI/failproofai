// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_POLICIES } from "../../src/hooks/builtin-policies";
import { POLICY_CATALOG } from "../../src/hooks/policy-catalog";
import type { PolicyContext } from "../../src/hooks/policy-types";
import {
  agentPatchTargetPaths,
  agentToolWritePaths,
  isAgentConfigDirPath,
  isAgentSettingsPath,
} from "../../src/hooks/agent-settings-guard";

// Same mocks as state-guard.test.ts: no policy under test may spawn anything.
// The filesystem IS read here — the guard follows symlinks — but only under
// a throwaway HOME and work directory created below.
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  stat: vi.fn().mockResolvedValue({ size: 0 }),
  open: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}));

const policy = BUILTIN_POLICIES.find((p) => p.name === "block-failproofai-commands")!;
const PROJ = "/work/proj";

let root: string;
let home: string;
let savedHome: string | undefined;

beforeAll(() => {
  // os.homedir() reads HOME on every call on POSIX, so the guard's `~` and its
  // home-directory symlink check both land in this directory, never the real one.
  root = mkdtempSync(join(tmpdir(), "fpai-settings-guard-"));
  home = join(root, "home");
  mkdirSync(home, { recursive: true });
  savedHome = process.env.HOME;
  process.env.HOME = home;
});

afterAll(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
});

function run(toolName: string, toolInput: Record<string, unknown>, cwd: string = PROJ) {
  const ctx: PolicyContext = { eventType: "PreToolUse", payload: {}, toolName, toolInput, session: { cwd } };
  return policy.fn(ctx);
}

const decision = async (toolName: string, toolInput: Record<string, unknown>, cwd?: string) =>
  (await run(toolName, toolInput, cwd)).decision;

/** Denied, and for the settings reason rather than the state or CLI reason next to it. */
const deniedAsSettings = async (toolName: string, toolInput: Record<string, unknown>, cwd?: string) => {
  const result = await run(toolName, toolInput, cwd);
  return result.decision === "deny" && /settings or hook file/.test(result.reason ?? "");
};

const write = (filePath: string, cwd?: string) => deniedAsSettings("Write", { file_path: filePath, content: "{}" }, cwd);
const bash = (command: string, cwd?: string) => deniedAsSettings("Bash", { command }, cwd);
const bashDecision = (command: string, cwd?: string) => decision("Bash", { command }, cwd);

/**
 * #1794: the always-on guard refused writes to `~/.failproofai` only. An agent
 * could set `"disableAllHooks": true` in any Claude Code settings layer, or take
 * failproofai's entries out of any CLI's hook file, and from then on no policy
 * ran — this guard included — with nothing anywhere saying so.
 */
describe("block-failproofai-commands — agent settings and hook files", () => {
  describe("the reported edits", () => {
    it("denies setting disableAllHooks through Edit on the user settings", async () => {
      expect(
        await deniedAsSettings("Edit", {
          file_path: `${home}/.claude/settings.json`,
          old_string: "{",
          new_string: '{"disableAllHooks": true,',
        }),
      ).toBe(true);
    });

    it("denies writing a project's local settings, which overrides the user's", async () => {
      expect(
        await deniedAsSettings("Write", {
          file_path: `${PROJ}/.claude/settings.local.json`,
          content: '{"disableAllHooks":true}',
        }),
      ).toBe(true);
    });

    it("denies the jq-then-mv rewrite from the shell", async () => {
      expect(await bash(`jq '.disableAllHooks=true' ~/.claude/settings.json > t && mv t ~/.claude/settings.json`)).toBe(true);
    });

    it("denies emptying another CLI's hooks file", async () => {
      expect(await write(`${home}/.codex/hooks.json`)).toBe(true);
    });
  });

  describe("every integration's files", () => {
    // What `failproofai policies --install` writes for each CLI, plus the files
    // that can switch those hooks off without touching them (Codex's trust
    // hashes in config.toml, Goose's plugin registration).
    const homeFiles = [
      ".claude/settings.json",
      ".claude/settings.local.json",
      ".codex/hooks.json",
      ".codex/config.toml",
      ".copilot/hooks/failproofai.json",
      ".cursor/hooks.json",
      ".config/opencode/opencode.json",
      ".config/opencode/plugins/failproofai.mjs",
      ".pi/agent/settings.json",
      ".pi/agent/extensions/failproofai/index.ts",
      ".gemini/settings.json",
      ".gemini/config/hooks.json",
      ".agents/plugins/failproofai/hooks/hooks.json",
      ".config/goose/config.yaml",
      ".factory/hooks.json",
      ".config/devin/config.json",
      ".hermes/config.yaml",
      ".hermes/profiles/work/config.yaml",
      ".hermes-work/config.yaml",
      ".hermes/plugins/failproofai/__init__.py",
      ".openclaw/openclaw.json",
      ".openclaw-work/openclaw.json",
    ];
    it.each(homeFiles)("denies writing ~/%s", async (file) => {
      expect(await write(`${home}/${file}`)).toBe(true);
    });

    const projectFiles = [
      ".claude/settings.json",
      ".codex/hooks.json",
      ".github/hooks/failproofai.json",
      ".cursor/hooks.json",
      ".opencode/opencode.json",
      ".opencode/plugins/failproofai.mjs",
      ".pi/settings.json",
      ".agents/hooks.json",
      ".agents/plugins/failproofai/hooks/hooks.json",
      ".factory/hooks.json",
      ".devin/config.json",
    ];
    it.each(projectFiles)("denies writing <project>/%s", async (file) => {
      expect(await write(`${PROJ}/${file}`)).toBe(true);
    });
  });

  describe("the tools that reach them", () => {
    it("is invoked for MultiEdit, and denies it", async () => {
      const entry = POLICY_CATALOG.find((p) => p.name === "block-failproofai-commands")!;
      expect(entry.match.toolNames).toEqual(expect.arrayContaining(["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"]));
      expect(
        await deniedAsSettings("MultiEdit", {
          file_path: `${home}/.claude/settings.json`,
          edits: [{ old_string: "{", new_string: '{"disableAllHooks": true,' }],
        }),
      ).toBe(true);
    });

    it("reads the paths an apply_patch edit carries inside its patch", async () => {
      // Codex, Copilot and OpenCode canonicalize apply_patch to Edit with no
      // file_path at all, so a guard reading only file_path saw nothing.
      const update = "*** Begin Patch\n*** Update File: .claude/settings.json\n@@\n-{\n+{\"disableAllHooks\": true,\n*** End Patch\n";
      expect(await deniedAsSettings("Edit", { command: ["apply_patch", update] })).toBe(true);
      expect(await deniedAsSettings("Edit", { input: `*** Begin Patch\n*** Add File: ${home}/.codex/hooks.json\n+{}\n*** End Patch` })).toBe(true);
      expect(await deniedAsSettings("Edit", { patchText: "*** Begin Patch\n*** Delete File: .cursor/hooks.json\n*** End Patch" })).toBe(true);
      expect(await deniedAsSettings("Edit", { input: "*** Begin Patch\n*** Update File: notes.md\n*** Move to: .github/hooks/failproofai.json\n*** End Patch" })).toBe(true);
      expect(await deniedAsSettings("Edit", { patch: "--- a/.cursor/hooks.json\n+++ b/.cursor/hooks.json\n@@ -1 +1 @@\n-x\n+y\n" })).toBe(true);
    });

    it("allows an apply_patch edit of ordinary files, and a Write whose content is a diff", async () => {
      expect(await decision("Edit", { command: ["apply_patch", "*** Begin Patch\n*** Update File: src/index.ts\n@@\n-a\n+b\n*** End Patch\n"] })).toBe("allow");
      // The content of a Write is content: its file_path is what it writes.
      expect(
        await decision("Write", { file_path: `${PROJ}/docs/fix.md`, content: "+++ b/.claude/settings.json\n*** Update File: .claude/settings.json" }),
      ).toBe("allow");
    });
  });

  describe("paths as the tool would open them", () => {
    it("resolves a relative path against the session's cwd", async () => {
      expect(await write(".claude/settings.json")).toBe(true);
      expect(await write("../other/.claude/settings.local.json")).toBe(true);
      expect(await write("settings.json", `${home}/.claude`)).toBe(true);
    });

    it("expands ~", async () => {
      expect(await write("~/.claude/settings.json")).toBe(true);
    });

    it("ignores case, as macOS's default filesystem does", async () => {
      expect(await write(`${home}/.Claude/Settings.json`)).toBe(true);
      expect(await write(`${home}/.CODEX/HOOKS.JSON`)).toBe(true);
    });
  });

  describe("symlinks", () => {
    let work: string;
    beforeAll(() => {
      work = join(root, "work");
      mkdirSync(join(work, "real", ".claude"), { recursive: true });
      mkdirSync(join(work, "proj"), { recursive: true });
      writeFileSync(join(work, "real", ".claude", "settings.json"), "{}");
      symlinkSync(join(work, "real", ".claude", "settings.json"), join(work, "proj", "cfg.json"));
      symlinkSync(join(work, "real", ".claude"), join(work, "proj", "link"));
      // The dotfiles layout: the real file names no agent directory at all.
      mkdirSync(join(home, "dotfiles", "claude"), { recursive: true });
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(join(home, "dotfiles", "claude", "settings.json"), "{}");
      writeFileSync(join(home, "dotfiles", "zshrc"), "");
      symlinkSync(join(home, "dotfiles", "claude", "settings.json"), join(home, ".claude", "settings.json"));
    });

    it("denies a write through a link to a settings file", async () => {
      expect(await write(join(work, "proj", "cfg.json"), join(work, "proj"))).toBe(true);
    });

    it("denies creating a settings file through a linked directory", async () => {
      expect(await write(join(work, "proj", "link", "settings.local.json"), join(work, "proj"))).toBe(true);
    });

    it("denies editing the real file behind the home directory's settings link", async () => {
      expect(
        await deniedAsSettings("Edit", {
          file_path: join(home, "dotfiles", "claude", "settings.json"),
          old_string: "{",
          new_string: '{"disableAllHooks": true,',
        }),
      ).toBe(true);
    });

    it("allows the rest of a dotfiles directory", async () => {
      expect(await decision("Write", { file_path: join(home, "dotfiles", "zshrc"), content: "" })).toBe("allow");
    });

    it("denies the dotfiles target from the shell too", async () => {
      expect(await bash(`sed -i '/failproofai/d' ~/dotfiles/claude/settings.json`)).toBe(true);
      expect(await bash(`sed -i '/failproofai/d' ${join(home, "dotfiles", "claude", "settings.json")}`)).toBe(true);
      expect(await bashDecision(`sed -i 's/a/b/' ~/dotfiles/zshrc`)).toBe("allow");
    });

    it("denies the target of a project's settings link", async () => {
      // A committed `.claude/settings.json -> ../config/claude.json`: the file an
      // agent edits names no agent directory.
      const project = join(root, "linkproj");
      mkdirSync(join(project, ".claude"), { recursive: true });
      mkdirSync(join(project, "config"), { recursive: true });
      writeFileSync(join(project, "config", "claude.json"), "{}");
      symlinkSync(join("..", "config", "claude.json"), join(project, ".claude", "settings.json"));
      expect(await write(join(project, "config", "claude.json"), project)).toBe(true);
      expect(await decision("Write", { file_path: join(project, "config", "other.json"), content: "{}" }, project)).toBe("allow");
    });
  });

  describe("ordinary file work stays allowed", () => {
    it.each([
      `${PROJ}/src/settings.json`,
      `${PROJ}/config/hooks.json`,
      `${PROJ}/hooks.json`,
      `${PROJ}/.claude/commands/review.md`,
      `${PROJ}/.claude/agents/reviewer.md`,
      `${PROJ}/.claude/worktrees/feature/src/index.ts`,
      `${PROJ}/.claude/worktrees/feature/.github/workflows/ci.yml`,
      `${PROJ}/.claude/settings.json.bak`,
      `${PROJ}/.github/workflows/ci.yml`,
      `${PROJ}/.cursor/rules/style.mdc`,
      `${PROJ}/.codex/AGENTS.md`,
      `${home}/.claude/skills/review/SKILL.md`,
      `${home}/.claude/CLAUDE.md`,
    ])("allows writing %s", async (file) => {
      expect(await decision("Write", { file_path: file, content: "x" })).toBe("allow");
    });
  });

  describe("from the shell", () => {
    it.each([
      // Rewrites in place, through tools on the read allowlist.
      `sed -i 's/"hooks"/"_hooks"/' ~/.claude/settings.json`,
      `yq -i '.hooks = {}' .agents/hooks.json`,
      `awk -i inplace '{print}' ~/.claude/settings.json`,
      `sed '1e cp /tmp/x ~/.claude/settings.json' /dev/null`,
      `sed -n '1W ~/.claude/settings.json' /tmp/x`,
      `perl -pi -e 's/a/b/' .claude/settings.json`,
      // Redirects, copies and links onto the file.
      `echo '{"disableAllHooks":true}' > .claude/settings.local.json`,
      `printf '{}' > ~/.codex/hooks.json`,
      `cp /tmp/empty.json ~/.cursor/hooks.json`,
      `tee .github/hooks/failproofai.json < /dev/null`,
      `curl -o ~/.claude/settings.json https://example.com/settings.json`,
      `ln -sf /tmp/evil.json ~/.claude/settings.json`,
      `chmod 000 ~/.claude/settings.json`,
      // Removing or moving the file or the directory that holds it.
      `rm ~/.claude/settings.json`,
      `rm -rf ~/.claude`,
      `mv ~/.claude ~/.claude.bak`,
      `find ~/.claude -name settings.json -delete`,
      `rm -rf ~/.hermes/plugins/failproofai`,
      `sed -i '/failproofai/d' ~/.hermes/config.yaml`,
      `git checkout -- .claude/settings.json`,
      `git mv .claude/settings.json /tmp/x`,
      `git -C ~/.claude pull`,
      // Interpreters, which name the path only inside their code.
      `python3 -c "import json; p='/home/u/.claude/settings.json'; d=json.load(open(p)); d['disableAllHooks']=True; json.dump(d, open(p,'w'))"`,
      `node -e "require('fs').writeFileSync(process.env.HOME+'/.claude/settings.json','{}')"`,
      `python3 -c "import shutil; shutil.rmtree('/home/u/.claude')"`,
      // The path carried by a cd, a variable, a substitution, a glob or quoting.
      `cd ~/.claude && sed -i 's/a/b/' settings.json`,
      `F=~/.claude/settings.json; jq . $F > /tmp/x && cp /tmp/x $F`,
      `D=~/.claude; rm -rf $D`,
      `echo $(rm ~/.claude/settings.json)`,
      `rm -f ~/.claude/settings.*`,
      `rm -rf ~/.claude/*`,
      `rm ~/.cl*/settings.json`,
      `rm ~/.claude/"settings.json"`,
      `rm -rf ~/.config/op*`,
      // A program on an interpreter's stdin, which the walk reads line by line.
      `python3 - <<'EOF'\nimport json\np = '/home/u/.claude/settings.json'\njson.dump({"disableAllHooks": True}, open(p, 'w'))\nEOF`,
    ])("denies %s", async (command) => {
      expect(await bash(command)).toBe(true);
    });

    it.each([
      // Sweeps of a shared parent: the same decoy floor that keeps `rm -rf *`
      // allowed for the state guard.
      `rm -rf ~/.config/*`,
      `rm -rf ~/.{cache,config}/*`,
      `rm -rf .github/*`,
    ])("allows the sweep %s", async (command) => {
      expect(await bashDecision(command)).toBe("allow");
    });

    it("resolves relative words against a cwd an earlier call left inside ~/.claude", async () => {
      const inClaude = `${home}/.claude`;
      expect(await bash(`sed -i 's/x/y/' settings.json`, inClaude)).toBe(true);
      expect(await bash(`rm *.json`, inClaude)).toBe(true);
      expect(await bash(`rm -rf .`, inClaude)).toBe(true);
      // The rest of that directory is ordinary files.
      expect(await bashDecision(`rm -rf skills/old`, inClaude)).toBe("allow");
      expect(await bashDecision(`sed -i 's/a/b/' commands/review.md`, inClaude)).toBe("allow");
    });

    it.each([
      `cat ~/.claude/settings.json`,
      `jq '.hooks' ~/.claude/settings.json`,
      `cat ~/.claude/settings.json | jq '.disableAllHooks=true'`,
      `sed -n '1,20p' ~/.claude/settings.json`,
      `sed 's/a/b/' ~/.claude/settings.json`,
      `cp ~/.claude/settings.json /tmp/settings.backup.json`,
      `diff ~/.claude/settings.json /tmp/x.json`,
      `grep -n failproofai ~/.codex/hooks.json`,
      `ls -la ~/.claude`,
      `git add .claude/settings.json && git commit -m "Add project hooks"`,
      `git diff .claude/settings.json`,
      `git log -p -- .claude/settings.json`,
      `mkdir -p .claude/commands`,
      `mkdir -p .claude`,
      `touch .claude/settings.local.json`,
      `rm -rf .claude/worktrees/old`,
      `rm -rf ~/.claude/projects/-home-u-old`,
      `git worktree remove .claude/worktrees/feature`,
      `cd .claude/worktrees/feature && git status`,
      `rm -rf node_modules dist`,
      `rm -rf *`,
      `rm */*.json`,
      `rm -rf ~/.*`,
      `echo "edit ~/.claude/settings.json yourself"`,
      `gh pr create --title x --body "Blocks edits to ~/.claude/settings.json"`,
      `code ~/.claude/settings.json`,
      `bun test __tests__/hooks/settings-guard.test.ts`,
    ])("allows %s", async (command) => {
      expect(await bashDecision(command)).toBe("allow");
    });
  });

  describe("the state guard beside it is unchanged", () => {
    it("still denies the state for the state's own reason", async () => {
      const result = await run("Bash", { command: "rm -rf ~/.failproofai" });
      expect(result.decision).toBe("deny");
      expect(result.reason).toMatch(/failproofai's own state/);
      expect(await decision("Write", { file_path: `${home}/.failproofai/policies-config.json`, content: "{}" })).toBe("deny");
    });

    it("still allows reading the state", async () => {
      expect(await bashDecision("cat ~/.failproofai/policies-config.json")).toBe("allow");
    });

    // The walk is shared, so the writers it learned for settings files reach
    // the state too. Each of these was allowed before.
    it.each([
      `yq -i '.enabledPolicies = []' ~/.failproofai/policies-config.json`,
      `awk -i inplace '{print}' ~/.failproofai/policies-config.json`,
      `sed '1e rm -rf ~/.failproofai' /dev/null`,
      `python3 -c "import os; p='/home/u/.failproofai/policies/packs/installed.json'; os.remove(p)"`,
      `git mv ~/.failproofai/policies-config.json /tmp/x`,
    ])("now denies %s", async (command) => {
      const result = await run("Bash", { command });
      expect(result.decision).toBe("deny");
      expect(result.reason).toMatch(/failproofai's own state/);
    });
  });
});

/**
 * The second review round: one-command writes that still got through, and
 * ordinary work the first round denied.
 */
describe("block-failproofai-commands — agent settings, review round two", () => {
  function runIn(toolName: string, toolInput: Record<string, unknown>, session: PolicyContext["session"]) {
    const ctx: PolicyContext = { eventType: "PreToolUse", payload: {}, toolName, toolInput, session };
    return policy.fn(ctx);
  }

  describe("a destination the shell resolves where a cd left it", () => {
    it.each([
      `cd ~/.claude && echo '{"disableAllHooks":true}' > settings.json`,
      `cd ~/.claude && cp /tmp/evil.json settings.json`,
      `cd ~/.claude && tee settings.json < /tmp/evil.json`,
      `pushd ~/.claude && cp /tmp/evil.json settings.json`,
      `(cd ~/.claude && cp /tmp/evil.json settings.json)`,
      `cd ~/.config && rm -rf opencode`,
      `cd ~ && cd .claude && cp /tmp/evil.json settings.local.json`,
    ])("denies %s", async (command) => {
      expect(await bash(command)).toBe(true);
    });

    it("keeps the cd's reach inside its subshell and stops it at popd", async () => {
      expect(await bashDecision(`(cd ~/.claude && cat settings.json); cp /tmp/x settings.json`)).toBe("allow");
      expect(await bashDecision(`pushd ~/.claude && cat settings.json && popd && cp /tmp/x settings.json`)).toBe("allow");
    });

    it("closes the same hole for the state", async () => {
      const result = await run("Bash", { command: "cd ~/.failproofai && cp /dev/null policies-config.json" });
      expect(result.decision).toBe("deny");
      expect(result.reason).toMatch(/failproofai's own state/);
      expect((await run("Bash", { command: "cd ~/.failproofai && echo {} > policies-config.json" })).decision).toBe("deny");
    });
  });

  describe("writers the first round missed", () => {
    it.each([
      `sed -Ei 's/a/b/' ~/.claude/settings.json`,
      `sed -ni 's/a/b/p' ~/.claude/settings.json`,
      `sed -n 's/^//w/home/u/.claude/settings.json' /tmp/evil.json`,
      `sed -n '1p; w /home/u/.claude/settings.json' /tmp/evil.json`,
      `awk 'BEGIN{printf "{\\"disableAllHooks\\":true}" > ARGV[1]}' ~/.claude/settings.json`,
      `git log -1 --format='format:{"disableAllHooks":true}' --output=$HOME/.claude/settings.json`,
      `git diff --output=.claude/settings.json HEAD~1`,
      `git archive -o ~/.claude/settings.json HEAD`,
      `git -c alias.x='!rm -rf ~/.claude' x`,
      `gh release download v1 -O ~/.claude/settings.json`,
      `sort -o$HOME/.claude/settings.json /tmp/evil.json`,
      `curl -so$HOME/.claude/settings.json https://example.com/x`,
      `echo ~/.claude/settings.json | xargs tee`,
      `echo ~/.claude/settings.json | xargs -n1 cp /tmp/evil.json`,
      `echo x > >(tee ~/.claude/settings.json)`,
      `rg --pre ./x.sh foo ~/.claude`,
    ])("denies %s", async (command) => {
      expect(await bash(command)).toBe(true);
    });

    it("denies an agent CLI's own command that turns its hooks off", async () => {
      expect(await bashDecision("codex features disable hooks")).toBe("deny");
      expect(await bashDecision("npx codex features disable hooks")).toBe("deny");
      expect(await bashDecision("pi remove /usr/lib/node_modules/failproofai/pi-extension")).toBe("deny");
      expect(await bashDecision("codex features list")).toBe("allow");
      expect(await bashDecision("codex features enable web_search")).toBe("allow");
    });
  });

  describe("paths spelled so the text never matches", () => {
    it.each([
      `cp evil ~/.claude/settings$X.json`,
      `cp evil ~/.clau\${X}de/settings.json`,
      `cp evil ~/.claude/settings$(true).json`,
      `cp evil /home/u/.claude/./settings.json`,
      `cp evil /home/u/.claude//settings.json`,
      `cp -l ~/.claude/settings.json /tmp/x`,
      `cp -rs ~/.claude /tmp/c`,
    ])("denies %s", async (command) => {
      expect(await bash(command)).toBe(true);
    });

    it("splices variables into the state's paths too", async () => {
      const result = await run("Bash", { command: "X=ai; rm -rf ~/.failproof$X" });
      expect(result.decision).toBe("deny");
    });
  });

  describe("files this session knows about beyond the shapes", () => {
    it("protects the settings file the hook was loaded from, wherever CLAUDE_CONFIG_DIR put it", async () => {
      const session = { cwd: PROJ, agentSettingsPath: `${home}/.claude-work/settings.json` };
      const write = await runIn("Write", { file_path: `${home}/.claude-work/settings.json`, content: "{}" }, session);
      expect(write.decision).toBe("deny");
      for (const command of [`sed -i 's/a/b/' ~/.claude-work/settings.json`, `rm -rf ~/.claude-work`]) {
        expect((await runIn("Bash", { command }, session)).decision).toBe("deny");
      }
      // The rest of that directory is not settings.
      const other = await runIn("Write", { file_path: `${home}/.claude-work/CLAUDE.md`, content: "x" }, session);
      expect(other.decision).toBe("allow");
    });

    it("reads Antigravity's own cwd for a run_command", async () => {
      expect(await deniedAsSettings("Bash", { command: "printf '{}' > hooks.json", cwd: "~/.gemini/config" })).toBe(true);
      expect(await decision("Bash", { command: "printf '{}' > hooks.json", cwd: "/work/proj/tmp" })).toBe("allow");
    });

    it("reads an indented apply_patch marker, and a patch beside a path key", async () => {
      expect(await deniedAsSettings("Edit", { input: "*** Begin Patch\n *** Update File: .claude/settings.json\n@@\n-a\n+b\n*** End Patch" })).toBe(true);
      expect(await deniedAsSettings("Edit", { input: "*** Begin Patch\n\t*** Update File: .claude/settings.json\n*** End Patch" })).toBe(true);
      expect(
        await deniedAsSettings("Edit", { path: "notes.md", patch: "*** Begin Patch\n*** Update File: ~/.hermes/config.yaml\n*** End Patch" }),
      ).toBe(true);
    });

    it("reads a program that builds the path from its parts", async () => {
      for (const command of [
        `python3 -c "import os; p=os.path.join(os.path.expanduser('~'),'.claude','settings.json'); open(p,'w').write('{}')"`,
        `node -e "const p=require('path').join(require('os').homedir(),'.claude','settings.json'); require('fs').writeFileSync(p,'{}')"`,
        `python3 - <<'EOF'\nimport os\np = os.path.join(os.path.expanduser('~'), '.codex', 'hooks.json')\nopen(p, 'w').write('{}')\nEOF`,
      ]) {
        expect(await bash(command)).toBe(true);
      }
    });

    it("denies a sweep of the agent directory the session stands in", async () => {
      expect(await bash("rm -rf *", `${home}/.claude`)).toBe(true);
      expect(await bashDecision("rm -rf skills/*", `${home}/.claude`)).toBe("allow");
    });
  });

  describe("ordinary work the first round denied", () => {
    it.each([
      // Claude Code's own commit and PR shapes: the message is stored, never run.
      `git commit -m "$(cat <<'EOF'\nRegister failproofai in .claude/settings.json\n\nCo-Authored-By: someone <a@b.c>\nEOF\n)"`,
      `gh pr create --title t --body "$(cat <<'EOF'\n## Summary\nBlocks edits to ~/.claude/settings.json and \`rm -rf ~/.claude\`\nEOF\n)"`,
      `git commit -m "Install\n\nWrites .codex/hooks.json; and rm -rf ~/.claude is refused"`,
      `git commit -m "Protect \\\`~/.claude/settings.json\\\` from agent edits"`,
      `echo "a; rm -rf ~/.claude > ~/.claude/settings.json"`,
      // Git hooks kept in .github/hooks.
      `git config core.hooksPath .github/hooks`,
      `chmod +x .github/hooks/*`,
      `cp scripts/pre-commit .github/hooks/`,
      // Reads that a loose sed or git check read as writes.
      `sed -n '1,20p' /workspaces/p/.claude/settings.json`,
      `git restore --staged .claude/settings.json`,
      `echo ~/.claude/settings.json | xargs cat`,
    ])("allows %s", async (command) => {
      expect(await bashDecision(command)).toBe("allow");
    });

    it("still denies what those shapes really run", async () => {
      expect(await bash(`bash -c 'cat x; rm -rf ~/.claude'`)).toBe(true);
      expect(await bash(`git commit -m "$(rm ~/.claude/settings.json)"`)).toBe(true);
      expect(await bash(`cat <<'EOF' | sh\nrm -rf ~/.claude\nEOF`)).toBe(true);
      expect(await bash(`cat <<EOF\n$(rm -rf ~/.claude)\nEOF`)).toBe(true);
      // A heredoc written to a file is read line by line: the same command could run it next.
      expect(await bash(`cat > /tmp/x.sh <<'EOF'\nrm -rf ~/.claude\nEOF\nbash /tmp/x.sh`)).toBe(true);
    });

    it("no longer denies the state's own false positives from the same causes", async () => {
      expect(await bashDecision(`git merge feature -m "notes about ~/.failproofai"`)).toBe("allow");
      expect(await bashDecision(`sed -n 1p /Users/Wei/.failproofai/policies-config.json`)).toBe("allow");
    });
  });

  it("stays fast on a long line", async () => {
    // A heredoc pattern rescanned the rest of the line for every
    // interpreter-shaped word: 100 KB of prose took 12.6 s on the first
    // version of this guard, against 0.15 s now. The bound is loose enough for
    // a slow CI runner and still far below the old cost.
    const words = "node php lua perl ruby bun deno python3 said ";
    const command = "echo " + words.repeat(Math.ceil((100 * 1024) / words.length));
    const started = performance.now();
    expect(await bashDecision(command)).toBe("allow");
    expect(performance.now() - started).toBeLessThan(5000);
  }, 60_000);
});

/**
 * The third review pass: holes the second round's heredoc and quote handling
 * opened (for the state too), and the gaps it left.
 */
describe("block-failproofai-commands — review round three", () => {
  function runIn(toolName: string, toolInput: Record<string, unknown>, session: PolicyContext["session"]) {
    const ctx: PolicyContext = { eventType: "PreToolUse", payload: {}, toolName, toolInput, session };
    return policy.fn(ctx);
  }
  const stateDenied = async (command: string) => {
    const result = await run("Bash", { command });
    return result.decision === "deny" && /failproofai's own state/.test(result.reason ?? "");
  };

  describe("a `<<` that is not a heredoc does not hide the lines after it", () => {
    it.each([
      `cat <<< x\nrm -rf ~/.failproofai`,
      `echo "<<EOF"\nrm -rf ~/.failproofai\nEOF`,
      `echo ok # don't\nrm -rf ~/.failproofai`,
      `x=$((1<<n))\nrm -rf ~/.failproofai`,
    ])("state: denies %s", async (command) => {
      expect(await stateDenied(command)).toBe(true);
    });

    it.each([
      `echo $((1<<n))\ncp /tmp/evil.json ~/.claude/settings.json`,
      `echo ok # don't\nrm ~/.claude/settings.json`,
    ])("settings: denies %s", async (command) => {
      expect(await bash(command)).toBe(true);
    });
  });

  describe("a heredoc whose body is used is read", () => {
    it.each([
      `git apply <<'EOF'\n--- a/.claude/settings.json\n+++ b/.claude/settings.json\n@@ -1 +1 @@\n-{}\n+{"disableAllHooks":true}\nEOF`,
      `patch -p1 <<'EOF'\n--- a/.claude/settings.json\n+++ b/.claude/settings.json\nEOF`,
      `while read f; do cp /tmp/evil.json "$f"; done <<EOF\n/home/u/.claude/settings.json\nEOF`,
    ])("settings: denies %s", async (command) => {
      expect(await bash(command)).toBe(true);
    });

    it.each([
      `xargs rm -rf <<'EOF'\n/home/u/.failproofai\nEOF`,
      `cat > /tmp/x.sh <<'EOF'\nrm -rf ~/.failproofai\nEOF\nbash /tmp/x.sh`,
    ])("state: denies %s", async (command) => {
      expect(await stateDenied(command)).toBe(true);
    });
  });

  describe("gaps the second round left", () => {
    it.each([
      `cp /tmp/evil.json ~/.claude/settings$( true ).json`,
      "cp /tmp/evil.json ~/.claude/settings` true `.json",
      `cd "$(dirname ~/.claude/settings.json)" && echo '{}' > settings.json`,
      `python3 -c"import os; p=os.path.join(os.path.expanduser('~'),'.claude','settings.json'); open(p,'w')"`,
      `python3 \\\n -c "import os; p=os.path.join(os.path.expanduser('~'),'.claude','settings.json'); open(p,'w')"`,
      `git -C ~/.claude log -1 --output=settings.json`,
      `git bundle create ~/.claude/settings.json HEAD`,
      `sed -n -l 1 "w $HOME/.claude/settings.json" /tmp/evil.json`,
      `git rebase -x 'cp /tmp/evil.json ~/.claude/settings.json' HEAD~1`,
      `git submodule foreach 'cp /tmp/evil.json ~/.claude/settings.json'`,
      `git -C ~/.claude switch evil`,
      `git -C ~/.claude merge FETCH_HEAD`,
      `git -C ~/.claude rebase evil`,
      `git -C ~/.claude am /tmp/evil.mbox`,
    ])("denies %s", async (command) => {
      expect(await bash(command)).toBe(true);
    });

    it("no longer takes a trailing comment for the destination", async () => {
      expect(await stateDenied("cp /dev/null ~/.failproofai/policies-config.json # reset")).toBe(true);
      expect(await bash("cp /dev/null ~/.claude/settings.json # reset")).toBe(true);
    });

    it("protects config.toml beside a relocated Codex hooks file", async () => {
      const session = { cwd: PROJ, agentSettingsPath: `${home}/.codex-work/hooks.json` };
      const result = await runIn("Write", { file_path: `${home}/.codex-work/config.toml`, content: "[features]\nhooks = false\n" }, session);
      expect(result.decision).toBe("deny");
    });

    it("protects .github/hooks as a directory only where failproofai's Copilot hooks live", async () => {
      const withHooks = join(root, "copilot-proj");
      mkdirSync(join(withHooks, ".github", "hooks"), { recursive: true });
      writeFileSync(join(withHooks, ".github", "hooks", "failproofai.json"), "{}");
      expect(await bash("rm -rf .github/hooks", withHooks)).toBe(true);
      const gitHooksOnly = join(root, "githooks-proj");
      mkdirSync(join(gitHooksOnly, ".github", "hooks"), { recursive: true });
      expect(await bashDecision("rm -rf .github/hooks", gitHooksOnly)).toBe("allow");
    });
  });

  describe("false positives the second round added", () => {
    it.each([
      `git commit -m "Deny xargs writes to .claude/settings.json"`,
      `git commit -m "Refuse codex features disable hooks"`,
      `git -c core.pager=cat log -p -- .claude/settings.json`,
      `awk '$2 > 1 {print $1}' ~/.claude/settings.json`,
      `git merge feature -m "notes about ~/.claude/settings.json"`,
      `git stash push -m "before editing .claude/settings.json"`,
    ])("allows %s", async (command) => {
      expect(await bashDecision(command)).toBe("allow");
    });

    it("allows pointing git's hooksPath at a Copilot install's directory", async () => {
      const session = { cwd: PROJ, agentSettingsPath: `${PROJ}/.github/hooks/failproofai.json` };
      expect((await runIn("Bash", { command: "git config core.hooksPath .github/hooks" }, session)).decision).toBe("allow");
    });

    it("still judges the state's merge message as a message", async () => {
      expect(await bashDecision(`git merge feature -m "notes about ~/.failproofai"`)).toBe("allow");
    });
  });

  it("stays linear on many quoted arguments", async () => {
    // Deciding whether a quote's command was a shell copied the command's
    // words at every quote: 20k quoted printf arguments took 1.46 s in the
    // second round. One pass now; the bound leaves room for a slow runner.
    const command = "printf '%s\\n' " + Array.from({ length: 40000 }, (_, i) => `'arg${i}'`).join(" ");
    const started = performance.now();
    expect(await bashDecision(command)).toBe("allow");
    expect(performance.now() - started).toBeLessThan(3000);
  }, 60_000);
});

/**
 * The fourth review pass: what the lexer still read differently from bash,
 * message bodies that something runs after all, and inputs that grew
 * faster than their size.
 */
describe("block-failproofai-commands — review round four", () => {
  const stateDenied = async (command: string) => {
    const result = await run("Bash", { command });
    return result.decision === "deny" && /failproofai's own state/.test(result.reason ?? "");
  };

  describe("what the lexer read differently from bash", () => {
    it("reads ${…} as one word: a # inside it starts no comment", async () => {
      expect(await stateDenied("echo ${X:- #}; rm -rf ~/.failproofai")).toBe(true);
      expect(await bash("echo ${X:- #}; rm ~/.claude/settings.json")).toBe(true);
      expect(await bash(`echo "$(echo \${X:-)}; cp /tmp/evil.json ~/.claude/settings.json)"`)).toBe(true);
    });

    it("reads a heredoc delimiter the way bash does", async () => {
      // `<<E\OF` ends at EOF, so the `cp` after it runs.
      expect(await bash("git commit --allow-empty -F - <<E\\OF\nmsg\nEOF\ncp /tmp/evil.json ~/.claude/settings.json\nE")).toBe(true);
      // `<<"EOF"x` ends at EOFx.
      expect(await bash('git commit --allow-empty -F - <<"EOF"x\nmsg\nEOFx\ncp /tmp/evil.json ~/.claude/settings.json\nEOF')).toBe(true);
    });

    it("splices a parameter expansion's default into the path, however long", async () => {
      expect(await stateDenied("rm -rf ~/.fa${X:-ilproofai}")).toBe(true);
      expect(await stateDenied(`rm -rf ~/.fa\${X:-il\${Z:+${"A".repeat(300)}}proofai}`)).toBe(true);
      expect(await bash("cp /tmp/evil.json ~/.clau${X:-de}/settings.json")).toBe(true);
    });

    it("keeps an unquoted substitution whole as a cd operand", async () => {
      expect(await bash("cd $(echo ~/.claude) && echo '{}' > settings.json")).toBe(true);
    });
  });

  describe("a message body that something runs", () => {
    const body = "$(cat <<'EOF'\ncp /tmp/evil.json ~/.claude/settings.json\nEOF\n)";
    it.each([
      `sudo -u root sh -c "${body}"`,
      `timeout -s KILL 5 sh -c "${body}"`,
      `find /tmp -maxdepth 0 -exec sh -c "${body}" \;`,
      `X="${body}"; eval "$X"`,
      `echo "${body}" | sh`,
    ])("denies %s", async (command) => {
      expect(await bash(command)).toBe(true);
    });
  });

  describe("text piped into a shell", () => {
    it("is judged as a command", async () => {
      expect(await stateDenied("echo 'rm -rf ~/.failproofai' | sh")).toBe(true);
      expect(await bash("printf 'cp /tmp/evil.json %s\\n' ~/.claude/settings.json | sh")).toBe(true);
      expect(await bashDecision("echo 'codex features disable hooks' | sh")).toBe("deny");
      expect(await bashDecision("echo 'codex features disable hooks' | cat")).toBe("allow");
    });
  });

  describe("commands git runs", () => {
    it.each([
      `git difftool -x 'cp /tmp/evil.json ~/.claude/settings.json' HEAD`,
      `git filter-branch --tree-filter 'cp /tmp/evil.json .claude/settings.json' HEAD`,
    ])("denies %s", async (command) => {
      expect(await bash(command)).toBe(true);
    });
  });

  describe("message shapes that are only messages", () => {
    it.each([
      "git commit -m \"$(cat <<EOF\nRegister failproofai in .claude/settings.json\nEOF\n)\"",
      "cat <<'EOF' | git commit -F -\nmsg about .claude/settings.json and rm -rf ~/.claude\nEOF",
      "git commit -F- <<'EOF'\nmsg about .claude/settings.json and rm -rf ~/.claude\nEOF",
      "git commit -F /dev/stdin <<'EOF'\nmsg about .claude/settings.json and rm -rf ~/.claude\nEOF",
      "cat > docs/hooks.md <<'EOF'\nSee .github/hooks/failproofai.json\nrm -rf ~/.claude\nEOF",
      "tee docs/hooks.md <<'EOF' >/dev/null\nrm -rf ~/.claude\nEOF",
    ])("allows %s", async (command) => {
      expect(await bashDecision(command)).toBe("allow");
    });

    it("allows the state's quoted message too, which main denied", async () => {
      expect(await bashDecision("git commit -m \"$(cat <<'EOF'\nKeep ~/.failproofai intact\nEOF\n)\"")).toBe("allow");
    });
  });

  describe("inputs that grew faster than their size", () => {
    const fast = async (command: string, limitMs: number) => {
      const started = performance.now();
      await bashDecision(command);
      return performance.now() - started < limitMs;
    };
    it("handles thousands of heredoc operators on one line", async () => {
      expect(await fast("cat " + "<<EOF ".repeat(5000) + "\nEOF\n", 3000)).toBe(true);
    }, 60_000);
    it("handles an unclosed ${ repeated through a long command", async () => {
      expect(await fast("echo " + "${".repeat(50000), 3000)).toBe(true);
    }, 60_000);
  });
});

/** The last review pass. */
describe("block-failproofai-commands — review round five", () => {
  const stateDenied = async (command: string) => {
    const result = await run("Bash", { command });
    return result.decision === "deny" && /failproofai's own state/.test(result.reason ?? "");
  };

  it("reads an echoed or printed heredoc that a later command runs", async () => {
    expect(await stateDenied(`echo "$(cat <<'EOF'\nrm -rf ~/.failproofai\nEOF\n)" > /tmp/x.sh && sh /tmp/x.sh`)).toBe(true);
    expect(await stateDenied(`printf '%s\\n' "$(cat <<'EOF'\nrm -rf ~/.failproofai\nEOF\n)" > /tmp/x.sh; bash /tmp/x.sh`)).toBe(true);
  });

  it("reads the failproofai CLI in text piped into a shell", async () => {
    const result = await run("Bash", { command: "echo 'failproofai config --pause' | sh" });
    expect(result.decision).toBe("deny");
    expect(result.reason).toMatch(/Pausing failproofai/);
    expect(await bashDecision("echo 'failproofai config --pause' | cat")).toBe("allow");
  });

  it("stays fast on thousands of heredocs on one line", async () => {
    const command = "cat <<A;".repeat(8000) + "\n" + "A\n".repeat(8000);
    const started = performance.now();
    await bashDecision(command);
    expect(performance.now() - started).toBeLessThan(3000);
  }, 60_000);

  it("matches a glob with a run of stars without backtracking through it", async () => {
    const command = "rm ~/.c" + "*".repeat(200) + "laude/settings.json";
    const started = performance.now();
    expect(await bash(command)).toBe(true);
    expect(performance.now() - started).toBeLessThan(3000);
    const spread = "rm ~/.c" + "*l".repeat(60) + "*aude/settings.json";
    const startedSpread = performance.now();
    await bashDecision(spread);
    expect(performance.now() - startedSpread).toBeLessThan(3000);
  }, 60_000);
});

describe("agent-settings-guard helpers", () => {
  it("matches settings files anchored at the end, and config directories exactly", () => {
    expect(isAgentSettingsPath("/h/.claude/settings.json")).toBe(true);
    expect(isAgentSettingsPath(".claude/settings.local.json")).toBe(true);
    expect(isAgentSettingsPath("/h/.claude/settings.json.bak")).toBe(false);
    expect(isAgentSettingsPath("/h/my.claude/settings.json")).toBe(false);
    expect(isAgentSettingsPath("/h/.claude/projects/x/settings.json")).toBe(false);
    expect(isAgentConfigDirPath("/h/.claude")).toBe(true);
    expect(isAgentConfigDirPath("/h/.claude/")).toBe(true);
    expect(isAgentConfigDirPath("/h/.claude/skills")).toBe(false);
    expect(isAgentConfigDirPath("/h/.github")).toBe(false);
    // `.github/hooks/` is also where repositories keep GIT hooks: only its
    // `*.json` files are Copilot's.
    expect(isAgentConfigDirPath("/h/.github/hooks")).toBe(false);
    expect(isAgentSettingsPath("/h/.github/hooks/failproofai.json")).toBe(true);
  });

  it("reads file paths before patch text, and patch text only without them", () => {
    expect(agentToolWritePaths({ file_path: "/a", content: "*** Update File: /b" })).toEqual(["/a"]);
    expect(agentToolWritePaths({ notebook_path: "/n.ipynb" })).toEqual(["/n.ipynb"]);
    expect(agentToolWritePaths({ command: ["apply_patch", "*** Begin Patch\n*** Update File: x/y.ts\n*** End Patch"] })).toEqual(["x/y.ts"]);
    expect(agentToolWritePaths(undefined)).toEqual([]);
  });

  it("finds every file a patch touches", () => {
    expect(
      agentPatchTargetPaths(
        "*** Begin Patch\n*** Add File: a.ts\n*** Update File: b.ts\n*** Move to: c.ts\n*** Delete File: d.ts\n*** End Patch",
      ),
    ).toEqual(["a.ts", "b.ts", "c.ts", "d.ts"]);
    expect(agentPatchTargetPaths("--- a/x.json\n+++ b/x.json\n--- /dev/null\n+++ b/new.json\n")).toEqual([
      "x.json",
      "x.json",
      "new.json",
    ]);
  });
});
