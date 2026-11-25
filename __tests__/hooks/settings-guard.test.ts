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
    ])("allows writing %s", async (file) => {
      expect(await decision("Write", { file_path: file, content: "x" })).toBe("allow");
    });
    // Joined inside the test: `home` exists only once beforeAll has run, and a
    // table built before then wrote `undefined/.claude/…`.
    it.each([".claude/skills/review/SKILL.md", ".claude/CLAUDE.md"])("allows writing ~/%s", async (file) => {
      expect(await decision("Write", { file_path: join(home, file), content: "x" })).toBe("allow");
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
      // A real install, so `.github/hooks/` is protected as a directory here:
      // without the file the test passed whether or not the rule held.
      const project = join(root, "copilot-install");
      mkdirSync(join(project, ".github", "hooks"), { recursive: true });
      writeFileSync(join(project, ".github", "hooks", "failproofai.json"), "{}");
      const session = { cwd: project, agentSettingsPath: join(project, ".github", "hooks", "failproofai.json") };
      expect((await runIn("Bash", { command: "rm -rf .github/hooks" }, session)).decision).toBe("deny");
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

/**
 * hermes's first review and CodeRabbit's: a write through a link, a `..` after
 * one, a quoted word in a hooks-off command, interpreter examples nothing runs,
 * and where the shell stands through pipelines and subshells.
 */
describe("block-failproofai-commands — review round six", () => {
  let h6: string;
  let p6: string;
  let outerHome: string | undefined;
  const settings = () => join(h6, ".claude", "settings.json");
  const program = () => `python3 -c "open('${settings()}','w')"`;

  beforeAll(() => {
    // Its own HOME and project, so the links below reach nothing else in this file.
    h6 = join(root, "home6");
    p6 = join(root, "proj6");
    mkdirSync(join(h6, ".claude", "subdir"), { recursive: true });
    writeFileSync(settings(), "{}");
    mkdirSync(join(p6, ".claude"), { recursive: true });
    mkdirSync(join(p6, "config"), { recursive: true });
    writeFileSync(join(p6, "config", "claude.json"), "{}");
    symlinkSync(join("..", "config", "claude.json"), join(p6, ".claude", "settings.json"));
    symlinkSync(settings(), join(p6, "cfg.json"));
    symlinkSync(join(h6, ".claude"), join(p6, "agent-dir"));
    symlinkSync(join(h6, ".claude", "subdir"), join(p6, "link"));
    symlinkSync(join(h6, ".claude", "settings.local.json"), join(p6, "dangling.json"));
    symlinkSync(join(h6, ".claude", "subdir"), join(h6, "hlink"));
    outerHome = process.env.HOME;
    process.env.HOME = h6;
  });

  afterAll(() => {
    if (outerHome === undefined) delete process.env.HOME;
    else process.env.HOME = outerHome;
  });

  describe("a shell write through a link (hermes F1)", () => {
    it.each([
      `printf '{"disableAllHooks":true}' > cfg.json`,
      `cp /tmp/x cfg.json`,
      `printf '{}' > agent-dir/settings.json`,
      `cd agent-dir && cp /tmp/x settings.json`,
      `printf '{}' > config/claude.json`,
      `printf '{}' > link/../settings.json`,
      `printf '{}' > dangling.json`,
    ])("denies %s", async (command) => {
      expect(await bash(command, p6)).toBe(true);
    });

    it("leaves an ordinary file beside them alone", async () => {
      expect(await bashDecision(`printf '{}' > config/other.json`, p6)).toBe("allow");
      expect(await bashDecision(`cat cfg.json && ls agent-dir/`, p6)).toBe("allow");
    });
  });

  describe("a file tool's path through a link (hermes F2)", () => {
    it("denies a .. that follows a link, relative and absolute", async () => {
      expect(await write("link/../settings.json", p6)).toBe(true);
      expect(await write(`${p6}/link/../settings.json`, p6)).toBe(true);
    });

    it("follows a link that leads nowhere yet: writing it creates the target", async () => {
      expect(await write("dangling.json", p6)).toBe(true);
    });

    it("allows an ordinary .. path", async () => {
      expect(await decision("Write", { file_path: "config/../notes.md", content: "x" }, p6)).toBe("allow");
    });
  });

  describe("a quoted word in an agent CLI's hooks-off command (hermes F3)", () => {
    it.each([
      `codex features disable "hooks"`,
      `codex features disable 'hooks'`,
      `codex features disable ho"oks"`,
      `codex "features" disable hooks`,
      `echo $(codex features disable "hooks")`,
    ])("denies %s", async (command) => {
      const result = await run("Bash", { command });
      expect(result.decision).toBe("deny");
      expect(result.reason).toMatch(/Turning an agent's hooks off/);
    });

    it("still reads a message that quotes one as a message", async () => {
      expect(await bashDecision(`git commit -m "codex features disable hooks is now refused"`)).toBe("allow");
    });
  });

  describe("an interpreter example nothing runs (hermes F4, CodeRabbit)", () => {
    it("allows one in a comment, a stored heredoc or a commit message", async () => {
      expect(await bashDecision(`echo ok # ${program()}`, p6)).toBe("allow");
      expect(await bashDecision(`cat > docs/x.md <<'EOF'\n${program()}\nEOF`, p6)).toBe("allow");
      expect(await bashDecision(`git commit -F - <<'EOF'\nRefuse ${program()} from agents\nEOF`, p6)).toBe("allow");
      const quoted = `python3 -c "open(\\"${settings()}\\",\\"w\\")"`;
      expect(await bashDecision(`git commit -m 'Refuse ${quoted} from agents'`, p6)).toBe("allow");
    });

    it("denies one that runs", async () => {
      expect(await bash(program(), p6)).toBe(true);
      expect(await bash(`echo ok; ${program()}`, p6)).toBe(true);
      expect(await bash(`env -i ${program()}`, p6)).toBe(true);
      expect(await bash(`sh -c "python3 -c \\"open('${settings()}','w')\\""`, p6)).toBe(true);
    });
  });

  describe("a redirect after a copy's destination (reported by the #1795 session)", () => {
    it.each([
      `cp /dev/null ~/.claude/settings.json 2>/dev/null`,
      `cp /tmp/x ~/.claude/settings.json > /tmp/log`,
      `cp /tmp/x ~/.claude/settings.json < /dev/null`,
      `cp /tmp/x ~/.claude/settings.json 2>&1`,
      `install -m 644 /tmp/x ~/.claude/settings.json 2>/dev/null`,
    ])("denies %s", async (command) => {
      expect(await bash(command)).toBe(true);
    });

    it("reads a glob over the home directory spelled out (the #1795 session's other case)", async () => {
      expect(await bash(`rm -rf ${h6}/.clau*`)).toBe(true);
    });

    it("closes it for the state too, and leaves a copy out of the settings alone", async () => {
      expect((await run("Bash", { command: "cp /dev/null ~/.failproofai/policies-config.json 2>/dev/null" })).decision).toBe("deny");
      expect(await bashDecision("cp ~/.claude/settings.json /tmp/backup.json 2>/dev/null")).toBe("allow");
      expect(await bashDecision("cp /tmp/a /tmp/b 2>/dev/null")).toBe("allow");
    });
  });

  describe("CodeRabbit's later reviews", () => {
    it("follows a link before a .. in a home path, from the shell and from a file tool", async () => {
      expect(await bash(`printf '{}' > ~/hlink/../settings.json`)).toBe(true);
      expect(await write("~/hlink/../settings.json")).toBe(true);
    });

    it.each([
      `cp /dev/null ~/.claude/settings.json 2> '/tmp/build log'`,
      `cp /dev/null ~/.claude/settings.json > "/tmp/a b"`,
      `cp /dev/null ~/.claude/settings.json 2>/tmp/a\\ b`,
      `cp /dev/null ~/.claude/settings.json 2>'/tmp/a b'`,
    ])("takes a redirect's whole target out of the copy's operands: %s", async (command) => {
      expect(await bash(command)).toBe(true);
    });

    it("reads through a filter that writes no file of its own", async () => {
      expect(await bashDecision(`cat ~/.claude/settings.json | tr a-z A-Z`)).toBe("allow");
      expect(await bashDecision(`cat ~/.claude/settings.json | tac | rev`)).toBe("allow");
      expect(await bash(`cat /tmp/x | tr a-z A-Z > ~/.claude/settings.json`)).toBe(true);
    });

    it("leaves a quoted > inside an argument where it is", async () => {
      expect(await bashDecision(`cp "/tmp/a > b" /tmp/out`)).toBe("allow");
    });

    it("ends a heredoc only at a line that is its delimiter", async () => {
      expect(await bashDecision(`cat > notes.md <<'EOF'\nEOF \nrm -rf ~/.claude\nEOF\n`)).toBe("allow");
      expect(await bashDecision(`cat > notes.md <<'EOF'\n  EOF\nrm -rf ~/.claude\nEOF\n`)).toBe("allow");
      expect(await bashDecision(`cat > notes.md <<-'EOF'\n\trm -rf ~/.claude\n\tEOF\n`)).toBe("allow");
      expect(await bash(`cat <<EOF | sh\nrm -rf ~/.claude\nEOF\n`)).toBe(true);
      expect(await bash(`cat > notes.md <<'EOF'\nhello\nEOF\nrm -rf ~/.claude\n`)).toBe(true);
    });

    it("stays linear on long runs of parentheses, pipes and variables", async () => {
      for (const command of [
        "echo " + "(".repeat(40000) + " $A".repeat(40000),
        "echo x " + "|".repeat(40000) + " sh",
      ]) {
        const started = performance.now();
        await bashDecision(command);
        expect(performance.now() - started).toBeLessThan(3000);
      }
    }, 60_000);
  });

  describe("where the shell stands (CodeRabbit)", () => {
    it("lets a cd before a | move nothing", async () => {
      expect(await bashDecision(`cd ~/.claude | cat; cp /tmp/example.json settings.json`)).toBe("allow");
      expect(await bash(`cd /tmp | cat; cp /tmp/example.json settings.json`, join(h6, ".claude"))).toBe(true);
    });

    it("counts a cd that ends a pipeline both ways: zsh runs it, bash does not", async () => {
      expect(await bash(`true | cd /tmp; cp /tmp/example.json settings.json`, join(h6, ".claude"))).toBe(true);
      expect(await bash(`true | cd ~/.claude; cp /tmp/example.json settings.json`)).toBe(true);
    });

    it("gives the parent back its directory stack when a subshell closes", async () => {
      expect(await bash(`cd ~/.claude; (cd /tmp; pushd /tmp); popd; cp /tmp/x settings.json`)).toBe(true);
      expect(await bashDecision(`cd ~/.claude; pushd /tmp; (popd); cp /tmp/x settings.json`)).toBe("allow");
      expect(await bash(`cd ~/.claude && (cd /tmp && ls) && cp /tmp/x settings.json`)).toBe(true);
    });

    it("stays where it is on a popd with nothing pushed", async () => {
      expect(await bash(`cd ~/.claude; popd; cp /tmp/x settings.json`)).toBe(true);
    });
  });

  describe("a relocated settings path inside a longer one (CodeRabbit)", () => {
    const session = { cwd: PROJ, agentSettingsPath: "/srv/profile/settings.json" };
    const decide = async (command: string) => (await policy.fn({ eventType: "PreToolUse", payload: {}, toolName: "Bash", toolInput: { command }, session })).decision;

    it("is not the relocated file", async () => {
      expect(await decide(`cp /tmp/x /backup/srv/profile/settings.json`)).toBe("allow");
    });

    it("still reads the file itself, its directory after a glued option, and an --output= value", async () => {
      expect(await decide(`cp /tmp/x /srv/profile/settings.json`)).toBe("deny");
      expect(await decide(`tar -xf /tmp/a.tar -C/srv/profile`)).toBe("deny");
      expect(await decide(`sort --output=/srv/profile/settings.json /tmp/x`)).toBe("deny");
    });
  });

  it("stays linear in a script of file-writing heredocs on separate lines (CodeRabbit)", async () => {
    const script = Array.from({ length: 4000 }, (_, i) => `cat > /tmp/out/f${i}.txt <<EOF\nline ${i}\nEOF`).join("\n");
    const started = performance.now();
    expect(await bashDecision(script)).toBe("allow");
    expect(performance.now() - started).toBeLessThan(3000);
  }, 60_000);
});

/**
 * hermes's second review: a link name with a space, a root settings link's
 * target from a subdirectory, the real files behind an installed plugin link,
 * escaped and variable CLI words, a glued copy target, a relative `git -C`,
 * and where the shell stands after `cd -`, a failing `cd` or `cd -P`.
 */
describe("block-failproofai-commands — review round seven", () => {
  let h7: string;
  let p7: string;
  let pkg7: string;
  let outerHome: string | undefined;
  let outerPackageRoot: string | undefined;
  const settings = () => join(h7, ".claude", "settings.json");

  beforeAll(() => {
    h7 = join(root, "home7");
    p7 = join(root, "proj7");
    pkg7 = join(root, "pkg7");
    mkdirSync(join(h7, ".claude", "subdir"), { recursive: true });
    mkdirSync(join(h7, ".hermes", "plugins"), { recursive: true });
    writeFileSync(settings(), "{}");
    mkdirSync(join(p7, ".git"), { recursive: true });
    mkdirSync(join(p7, ".claude"), { recursive: true });
    mkdirSync(join(p7, "config"), { recursive: true });
    mkdirSync(join(p7, "src"), { recursive: true });
    writeFileSync(join(p7, "config", "claude.json"), "{}");
    mkdirSync(join(pkg7, "hermes-plugin"), { recursive: true });
    mkdirSync(join(pkg7, "openclaw-plugin"), { recursive: true });
    writeFileSync(join(pkg7, "hermes-plugin", "__init__.py"), "");
    symlinkSync(join("..", "config", "claude.json"), join(p7, ".claude", "settings.local.json"));
    symlinkSync(settings(), join(p7, "my cfg.json"));
    symlinkSync(join(h7, ".claude", "subdir"), join(p7, "clink"));
    symlinkSync(join(pkg7, "hermes-plugin"), join(h7, ".hermes", "plugins", "failproofai"));
    mkdirSync(join(h7, ".claude", "x"), { recursive: true });
    symlinkSync(join(h7, ".claude", "x"), join(p7, "physical-link"));
    mkdirSync(join(p7, "external", ".git"), { recursive: true });
    symlinkSync(join(h7, ".claude", "x"), join(p7, "external", "link"));
    mkdirSync(join(p7, "archive"), { recursive: true });
    symlinkSync(join(h7, ".claude", "x"), join(p7, "archive", "link"));
    symlinkSync(settings(), join(p7, "cfg.json"));
    mkdirSync(join(p7, "sub"), { recursive: true });
    symlinkSync(settings(), join(p7, "sub", "cfg.json"));
    mkdirSync(join(p7, "external", "archive"), { recursive: true });
    symlinkSync(join(h7, ".claude", "x"), join(p7, "external", "archive", "link"));
    outerHome = process.env.HOME;
    outerPackageRoot = process.env.FAILPROOFAI_PACKAGE_ROOT;
    process.env.HOME = h7;
  });

  afterAll(() => {
    if (outerHome === undefined) delete process.env.HOME;
    else process.env.HOME = outerHome;
    if (outerPackageRoot === undefined) delete process.env.FAILPROOFAI_PACKAGE_ROOT;
    else process.env.FAILPROOFAI_PACKAGE_ROOT = outerPackageRoot;
  });

  it.each([
    `printf '{}' > "my cfg.json"`,
    `printf '{}' > my\\ cfg.json`,
    `cp /tmp/x "my cfg.json"`,
  ])("follows a link whose name has a space in it: %s", async (command) => {
    expect(await bash(command, p7)).toBe(true);
  });

  it("protects a root settings link's target from a subdirectory session", async () => {
    expect(await bash(`printf '{}' > ../config/claude.json`, join(p7, "src"))).toBe(true);
    expect(await write(join(p7, "config", "claude.json"), join(p7, "src"))).toBe(true);
    expect(await bashDecision(`printf '{}' > ../config/other.json`, join(p7, "src"))).toBe("allow");
  });

  it("protects every file behind an installed plugin link, and the package's plugin directories", async () => {
    expect(await write(join(pkg7, "hermes-plugin", "__init__.py"), p7)).toBe(true);
    expect(await bash(`printf x > ${join(pkg7, "hermes-plugin", "evil.py")}`, p7)).toBe(true);
    process.env.FAILPROOFAI_PACKAGE_ROOT = pkg7;
    expect(await write(join(pkg7, "openclaw-plugin", "index.js"), p7)).toBe(true);
    expect(await decision("Write", { file_path: join(pkg7, "README.md"), content: "x" }, p7)).toBe("allow");
  });

  it.each([
    `codex features disable $'\\x68ooks'`,
    `F=hooks; codex features disable $F`,
    `F=hooks; codex features disable "$F"`,
  ])("reads an escaped or variable word in a hooks-off command: %s", async (command) => {
    const result = await run("Bash", { command });
    expect(result.decision).toBe("deny");
    expect(result.reason).toMatch(/Turning an agent's hooks off/);
  });

  it.each([
    `cp -t"$HOME/.claude" /tmp/settings.json`,
    `cp -vt ~/.claude /tmp/settings.json`,
    `cp --target-directory=$HOME/.claude /tmp/settings.json`,
    `install -m 644 -t ~/.claude /tmp/settings.json`,
  ])("judges each source where a target directory puts it: %s", async (command) => {
    expect(await bash(command, p7)).toBe(true);
  });

  it("leaves other files copied into or out of an agent directory alone", async () => {
    expect(await bashDecision(`cp -t ~/.claude /tmp/notes.md`, p7)).toBe("allow");
    expect(await bashDecision(`cp -t /tmp/backup ~/.claude/settings.json`, p7)).toBe("allow");
  });

  it("resolves git's relative -C chain before its output path", async () => {
    expect(await bash(`git -C .claude log -1 --format='format:{"disableAllHooks":true}' --output=settings.json`, p7)).toBe(true);
    expect(await bash(`git -C . -C .claude log -1 --output=settings.json`, p7)).toBe(true);
    expect(await bashDecision(`git -C .claude log -1 --output=/tmp/log.txt`, p7)).toBe("allow");
  });

  it("knows where the shell may stand after cd -, a failing cd and cd -P", async () => {
    expect(await bash(`cd ~/.claude && cd /tmp && cd - && cp /tmp/x settings.json`, p7)).toBe(true);
    // An OLDPWD from before the command could be any directory, so the state
    // guard refuses this first, with its own reason.
    expect(await bashDecision(`cd - && cp /tmp/x settings.json`, p7)).toBe("deny");
    expect(await bash(`cd /nonexistent-r7; cp /tmp/x settings.json`, join(h7, ".claude"))).toBe(true);
    expect(await bash(`cd -P clink/.. && cp /tmp/x settings.json`, p7)).toBe(true);
    expect(await bashDecision(`cd clink/.. && cp /tmp/x settings.json`, p7)).toBe("allow");
    expect(await bashDecision(`mkdir -p build && cd build && cp /tmp/x settings.json`, p7)).toBe("allow");
  });

  // hermes round 3.
  it.each([
    `codex features disable "\${UNSET:-hooks}"`,
    `codex features disable \${UNSET:-ho}oks`,
    `F=1; codex features disable \${F:+hooks}`,
  ])("reads a parameter default in a hooks-off command: %s", async (command) => {
    const result = await run("Bash", { command });
    expect(result.decision).toBe("deny");
    expect(result.reason).toMatch(/Turning an agent's hooks off/);
  });

  it("keeps a message that quotes a parameter default a message", async () => {
    expect(await bashDecision(`git commit -m "codex features disable \${X:-hooks} is refused"`)).toBe("allow");
  });

  it.each([
    `cd ~/.claude; pushd -n /tmp; cp /tmp/settings.json settings.json`,
    `pushd ~/.claude; popd -n; cp /tmp/settings.json settings.json`,
    `cd ~/.claude; cd /tmp; cd /missing-r8; cd -; cp /tmp/settings.json settings.json`,
    `pushd ~/.claude; pushd /tmp; pushd; cp /tmp/settings.json settings.json`,
    `pushd ~/.claude; pushd /tmp; pushd +1; cp /tmp/settings.json settings.json`,
  ])("knows a directory command that leaves the shell, or OLDPWD, in place: %s", async (command) => {
    expect(await bash(command, p7)).toBe(true);
  });

  it("still follows an ordinary pushd and popd", async () => {
    expect(await bashDecision(`pushd /tmp && ls && popd && cp /tmp/x settings.json`, p7)).toBe("allow");
  });

  it("matches a glob whatever the case of its literal parts (macOS resolves them so)", async () => {
    expect(await bash(`rm -rf ~/.CLAUDE/settings.js*`, p7)).toBe(true);
    expect(await bashDecision(`rm -rf ~/.CACHE/*`, p7)).toBe("allow");
  });

  it("resolves git -C the way chdir walks it", async () => {
    expect(await bash(`git -C physical-link/.. log -1 --format='format:{"disableAllHooks":true}' --output=settings.json`, p7)).toBe(true);
    expect(await bashDecision(`git -C physical-link log -1 --output=/tmp/out.txt`, p7)).toBe("allow");
  });

  // hermes round 4.
  it("reads every value a variable is given on the line, not only the last", async () => {
    const result = await run("Bash", { command: `F=hooks; codex features disable "$F"; F=web_search` });
    expect(result.decision).toBe("deny");
    expect(result.reason).toMatch(/Turning an agent's hooks off/);
    expect(await bashDecision(`F=web_search; codex features disable "$F"`)).toBe("allow");
  });

  it("does not trust the stack's order after a rotation", async () => {
    expect(await bash(`pushd ~/.claude; pushd /tmp; pushd +2; cd /tmp; popd; popd; cp /tmp/settings.json settings.json`, p7)).toBe(true);
    expect(await bashDecision(`pushd /tmp; pushd /var; popd; popd; cp /tmp/x settings.json`, p7)).toBe("allow");
  });

  it("follows git's -C directories and output through links before the text gate", async () => {
    expect(await bash(`git -C external -C link/.. log -1 --format='format:{"disableAllHooks":true}' --output=settings.json`, p7)).toBe(true);
    expect(await bash(`git -C external log -1 --output=link/../settings.json`, p7)).toBe(true);
    expect(await bashDecision(`git -C external log -1 --output=out.txt`, p7)).toBe("allow");
  });

  it("reads a quoted heredoc output filename, and a quoted -F -, as written", async () => {
    const program = `python3 -c "open('${settings()}','w')"`;
    expect(await bashDecision(`cat > '/tmp/example.md' <<'EOF'\n${program}\nEOF\n`, p7)).toBe("allow");
    expect(await bashDecision(`cat > "/tmp/my example.md" <<'EOF'\n${program}\nEOF\n`, p7)).toBe("allow");
    expect(await bashDecision(`git commit -F "-" <<'EOF'\nKeep rm -rf ~/.claude out of agents\nEOF\n`, p7)).toBe("allow");
    // A file named by an expansion is still unknown, so a body run from it is read.
    expect(await bash(`cat > "$F" <<'EOF'\nrm -rf ~/.claude\nEOF\nbash "$F"\n`, p7)).toBe(true);
  });

  // hermes round 5.
  it.each([
    `F=ho; F=\${F}oks; codex features disable "$F"`,
    `F=hooks; X=$F; codex features disable "$X"`,
    `codex $(echo features) disable hooks`,
  ])("refuses a hooks-off command whose words an expansion could make: %s", async (command) => {
    const result = await run("Bash", { command });
    expect(result.decision).toBe("deny");
    expect(result.reason).toMatch(/Turning an agent's hooks off/);
  });

  it("is not hidden by many earlier assignments, and reads a known other feature as itself", async () => {
    const decoys = Array.from({ length: 70 }, (_, i) => `F=decoy${i}`).join("; ");
    expect((await run("Bash", { command: `${decoys}; F=hooks; codex features disable "$F"` })).decision).toBe("deny");
    expect(await bashDecision(`F=web_search; codex features disable "$F"`)).toBe("allow");
  });

  it("reads a value glued to git archive's -o through a link", async () => {
    expect(await bash(`git archive -oarchive/link/../settings.json HEAD`, p7)).toBe(true);
    expect(await bashDecision(`git archive -o/tmp/out.tar HEAD`, p7)).toBe("allow");
  });

  it("follows a variable that holds a link to the settings", async () => {
    expect(await bash(`D=cfg.json; cp /tmp/evil.json "$D"`, p7)).toBe(true);
    expect(await bash(`D=physical-link/..; cd -P "$D"; cp /tmp/evil.json settings.json`, p7)).toBe(true);
    expect(await bashDecision(`D=notes.md; cp /tmp/evil.json "$D"`, p7)).toBe("allow");
  });

  it("finds a stored script run later under a quoted, escaped or built name", async () => {
    const store = `cat > '/tmp/example.md' <<'EOF'\ncp /tmp/evil ${settings()}\nEOF\n`;
    expect(await bash(`${store}bash /tmp/exam'ple.md'\n`, p7)).toBe(true);
    expect(await bash(`${store}bash /tmp/exam\\ple.md\n`, p7)).toBe(true);
    expect(await bash(`${store}bash /tmp/exam$X\n`, p7)).toBe(true);
    expect(await bashDecision(`${store}echo done\n`, p7)).toBe("allow");
  });

  it("copies into an existing directory under each source's own name", async () => {
    expect(await bashDecision(`cp README.md ~/.claude`, p7)).toBe("allow");
    expect(await bash(`cp /tmp/settings.json ~/.claude`, p7)).toBe(true);
    expect(await bash(`cp -rT /tmp/evil ~/.claude`, p7)).toBe(true);
    expect(await bash(`cp -r /tmp/evil/. ~/.claude`, p7)).toBe(true);
  });

  // hermes round 6.
  it("keeps --parents' own path under the directory it copies into", async () => {
    expect(await bash(`cp --parents .claude/settings.json ~`, p7)).toBe(true);
    expect(await bash(`cp --parents -t ~ .claude/settings.json`, p7)).toBe(true);
    expect(await bashDecision(`cp --parents src/a.ts /tmp/backup`, p7)).toBe("allow");
  });

  it("stays linear on a name built from many expansions that does not match", async () => {
    const command = `cat > /tmp/${"a".repeat(100)}.md <<'EOF'\nhello\nEOF\nbash /tmp/${"a\${X}".repeat(8)}z.md\n`;
    const started = performance.now();
    await bashDecision(command, p7);
    expect(performance.now() - started).toBeLessThan(3000);
  }, 60_000);

  it("finds a stored script run later under a glob or brace name", async () => {
    const store = `cat > /tmp/example.md <<'EOF'\ncp /tmp/evil ${settings()}\nEOF\n`;
    expect(await bash(`${store}bash /tmp/exa*\n`, p7)).toBe(true);
    expect(await bash(`${store}bash /tmp/{example,x}.md\n`, p7)).toBe(true);
  });

  it("judges a variable's link from where the shell stands when it is used", async () => {
    expect(await bash(`cd sub; D=cfg.json; cp /tmp/evil.json "$D"`, p7)).toBe(true);
  });

  it("reads a copy destination held in a variable as the directories it holds", async () => {
    expect(await bashDecision(`D=~/.claude; cp README.md "$D"`, p7)).toBe("allow");
    expect(await bash(`D=~/.claude; cp /tmp/settings.json "$D"`, p7)).toBe(true);
  });

  it("joins a value glued to git's -o to the -C repository", async () => {
    expect(await bash(`git -C external archive -oarchive/link/../settings.json HEAD`, p7)).toBe(true);
  });

  // hermes round 7.
  it("resolves a link passed through a second variable", async () => {
    expect(await bash(`cd sub; A=cfg.json; D=$A; cp /tmp/evil.json "$D"`, p7)).toBe(true);
  });

  it("reads a -t directory and copy sources held in variables as their values", async () => {
    expect(await bashDecision(`D=~/.claude; cp -t "$D" README.md`, p7)).toBe("allow");
    expect(await bashDecision(`S=README.md; cp "$S" ~/.claude`, p7)).toBe("allow");
    expect(await bash(`S=/tmp/settings.json; cp "$S" ~/.claude`, p7)).toBe(true);
    expect(await bash(`cp "$S" ~/.claude`, p7)).toBe(true);
  });

  it("does not trust a variable given more values than are kept", async () => {
    const backup = join(root, "backup7");
    mkdirSync(backup, { recursive: true });
    const decoys = Array.from({ length: 64 }, () => `D=${backup}`).join("; ");
    // A crafted variable counts as naming every protected path, so the state
    // guard, which runs first, refuses this with its own reason.
    expect(await bashDecision(`${decoys}; D=~/.claude; cp /tmp/settings.json "$D"`, p7)).toBe("deny");
  });

  it("protects the target of a settings link that does not exist yet", async () => {
    const fresh = join(root, "proj7-dangling");
    mkdirSync(join(fresh, ".claude"), { recursive: true });
    mkdirSync(join(fresh, "config"), { recursive: true });
    symlinkSync(join("..", "config", "new.json"), join(fresh, ".claude", "settings.local.json"));
    expect(await write(join(fresh, "config", "new.json"), fresh)).toBe(true);
    expect(await bash(`printf '{}' > config/new.json`, fresh)).toBe(true);
    expect(await bashDecision(`printf '{}' > config/other.json`, fresh)).toBe("allow");
  });

  // hermes round 8.
  it("resolves a variable chain of any length, and refuses a cycle", async () => {
    const chain = (n: number) => ["A0=cfg.json", ...Array.from({ length: n }, (_, i) => `A${i + 1}=$A${i}`)].join("; ");
    expect(await bash(`cd sub; ${chain(5)}; cp /tmp/evil.json "$A5"`, p7)).toBe(true);
    expect(await bash(`cd sub; ${chain(300)}; cp /tmp/evil.json "$A300"`, p7)).toBe(true);
    expect(await bashDecision(`cd sub; A=$B; B=$A; cp /tmp/evil.json "$A"`, p7)).toBe("deny");
  });

  it("leaves ordinary variables, environment variables, appends and substitutions alone", async () => {
    expect(await bashDecision(`export PATH="$PATH:$HOME/bin"; npm test`, p7)).toBe("allow");
    expect(await bashDecision(`PATH=$PATH:/opt/x npm run build`, p7)).toBe("allow");
    expect(await bashDecision(`FLAGS="$FLAGS -v"; make $FLAGS`, p7)).toBe("allow");
    expect(await bashDecision(`DIR=$(mktemp -d); cp a "$DIR/x"; rm -rf "$DIR"`, p7)).toBe("allow");
    expect(await bashDecision(`A=x; B=$A; C=$B; rm -rf "$C"`, p7)).toBe("allow");
    expect(await bashDecision(`cp /tmp/x "$OUTDIR/report.txt"`, p7)).toBe("allow");
  });

  it("protects a relocated settings file's link target from the shell, existing or not yet", async () => {
    const profile = join(root, "profile8");
    const actual = join(root, "actual8");
    mkdirSync(profile, { recursive: true });
    mkdirSync(actual, { recursive: true });
    writeFileSync(join(actual, "primary.json"), "{}");
    symlinkSync(join(actual, "primary.json"), join(profile, "settings.json"));
    symlinkSync(join(actual, "local.json"), join(profile, "settings.local.json"));
    const session = { cwd: p7, agentSettingsPath: join(profile, "settings.json") };
    const decide = async (command: string) =>
      (await policy.fn({ eventType: "PreToolUse", payload: {}, toolName: "Bash", toolInput: { command }, session })).decision;
    expect(await decide(`cp /tmp/disable.json ${join(actual, "primary.json")}`)).toBe("deny");
    expect(await decide(`printf '{}' > ${join(actual, "local.json")}`)).toBe("deny");
    expect(await decide(`printf '{}' > ${join(actual, "notes.json")}`)).toBe("allow");
  });

  // hermes round 9.
  it("bounds the values self-appends and doubling references can build, in time too", async () => {
    const appends = (n: number) => ["A=x", ...Array.from({ length: n }, (_, i) => `A=\${A}x${i}`)].join("; ") + `; cp a "$A"`;
    const doubling = (n: number) => ["A=x", ...Array.from({ length: n }, () => "A=${A}${A}")].join("; ") + `; cp a "$A"`;
    const chained = (n: number) =>
      ["B0=x", ...Array.from({ length: n }, (_, i) => `B${i + 1}=\${B${i}}\${B${i}}`)].join("; ") + `; cp a "$B${n}"`;
    const started = performance.now();
    // More values, or a longer one, than any real command builds count as
    // naming the target; building them stops at the limit.
    expect(await bashDecision(appends(24), p7)).toBe("deny");
    expect(await bashDecision(appends(63), p7)).toBe("deny");
    expect(await bashDecision(doubling(40), p7)).toBe("deny");
    expect(await bashDecision(chained(40), p7)).toBe("deny");
    expect(performance.now() - started).toBeLessThan(2000);
    // Appends still resolve, and a long value as written is not one that grew.
    expect(await bash(`cd sub; A=cf; A=\${A}g.json; cp /tmp/evil.json "$A"`, p7)).toBe(true);
    expect(await bashDecision(`X=${"y".repeat(5000)}; cp a "$X"`, p7)).toBe("allow");
  });

  it("keeps a variable's known values beside one that cannot be known", async () => {
    // A name that is a settings link only where the shell has moved to.
    mkdirSync(join(p7, "sub9"), { recursive: true });
    symlinkSync(settings(), join(p7, "sub9", "cfg9.json"));
    expect(await bash(`cd sub9; A=cfg9.json; A=$(true); cp /tmp/evil.json "$A"`, p7)).toBe(true);
    expect(await bash("cd sub9; A=cfg9.json; A=`true`; cp /tmp/evil.json \"$A\"", p7)).toBe(true);
    expect(await bashDecision(`D=$(mktemp -d); D=$D/out; cp a "$D/x"`, p7)).toBe("allow");
    expect(await bashDecision(`OUT=build/report.txt; OUT=$(mktemp); cp a "$OUT"`, p7)).toBe("allow");
  });

  it.skipIf(process.platform === "win32")(
    "protects the link target of a worktree's local settings at the main checkout",
    async () => {
      // A linked worktree as git lays it out: Claude Code reads its local
      // settings at the main checkout's root, which links them elsewhere.
      const main = join(root, "main9");
      const worktree = join(root, "wt9");
      const outside = join(root, "outside9");
      mkdirSync(join(main, ".git", "worktrees", "wt9"), { recursive: true });
      writeFileSync(join(main, ".git", "worktrees", "wt9", "commondir"), "../..\n");
      mkdirSync(join(worktree, "src"), { recursive: true });
      writeFileSync(join(worktree, ".git"), `gitdir: ${join(main, ".git", "worktrees", "wt9")}\n`);
      mkdirSync(join(main, ".claude"), { recursive: true });
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, "local-config.json"), "{}");
      symlinkSync(join(outside, "local-config.json"), join(main, ".claude", "settings.local.json"));
      const target = join(outside, "local-config.json");
      expect(await write(target, join(worktree, "src"))).toBe(true);
      expect(await bash(`printf '{}' > ${target}`, join(worktree, "src"))).toBe(true);
      expect(await bash(`cp /tmp/disable.json ${target}`, worktree)).toBe(true);
      expect(await bashDecision(`printf '{}' > ${join(outside, "notes.json")}`, worktree)).toBe("allow");
    },
  );

  it("follows a destination built by parameter expansion, arrays and appends", async () => {
    // A name that is a settings link only where the shell has moved to.
    mkdirSync(join(p7, "sub10"), { recursive: true });
    symlinkSync(settings(), join(p7, "sub10", "cfg10.json"));
    for (const command of [
      `cd sub10; cp /tmp/evil.json "\${A:-cfg10.json}"`,
      `cd sub10; cp /tmp/evil.json "\${A=cfg10.json}"`,
      `cd sub10; A=cfg10.json.bak; cp /tmp/evil.json "\${A%.bak}"`,
      `cd sub10; A=cfg10.json.bak; cp /tmp/evil.json "\${A%.*}"`,
      `cd sub10; A=/x/y/cfg10.json; cp /tmp/evil.json "\${A##*/}"`,
      `cd sub10; A=xcfg10.json; tee "\${A#x}" < /dev/null`,
      `cd sub10; A=cfg10Xjson; cp /tmp/evil.json "\${A/X/.}"`,
      `cd sub10; A=CFG10.JSON; cp /tmp/evil.json "\${A,,}"`,
      `cd sub10; A=zzcfg10.json; cp /tmp/evil.json "\${A:2}"`,
      `cd sub10; A=cfg10.json; R=A; cp /tmp/evil.json "\${!R}"`,
      `cd sub10; A=(x cfg10.json); cp /tmp/evil.json "\${A[1]}"`,
      `cd sub10; A=cf; A+=g10.json; cp /tmp/evil.json "$A"`,
      `cd sub10; printf '{}' > "\${A:-cfg10.json}"`,
      `cd sub10; A=cfg10.json.bak; cp /tmp/evil.json "\${A%$SUFFIX}"`,
      `cd sub10; A=(x cfg10.json); cp /tmp/evil.json "\${A[@]:1}"`,
    ]) {
      expect(await bash(command, p7), command).toBe(true);
    }
    // An operator this does not follow, over a known value, counts as naming it.
    expect(await bashDecision(`cd sub10; A=cfg10.json; cp /tmp/evil.json "\${A:0:$((10))}"`, p7)).toBe("deny");
  });

  it("leaves ordinary parameter expansions alone", async () => {
    for (const command of [
      `cp a "\${OUT:-build}/x.txt"`,
      `f=report.txt; mv "$f" "\${f%.txt}.md"`,
      `for f in *.txt; do mv "$f" "\${f%.txt}.md"; done`,
      `cp a "\${1:-out}/x"`,
      `A=(a b c); for x in "\${A[@]}"; do cp "$x" /tmp/; done`,
      `NAME=report; cp a "\${NAME^^}.txt"`,
      `PATH+=:/opt/bin; npm test`,
      `A=a/b/c; cp x "/tmp/\${A//\\//_}.txt"`,
      `x=${"ab-".repeat(100)}; cp a "/tmp/\${x//[^a-z]/}"`,
      `A=${"a".repeat(1000)}; cp a "/tmp/\${A//*b*/x}"`,
      `f=report.txt; cp a "/tmp/\${f%$EXT}.bak"`,
    ]) {
      expect(await bashDecision(command, p7), command).toBe("allow");
    }
  });

  it("bounds the pattern matching an expansion can ask for", async () => {
    // A match that starts early and ends early makes every longer end a try.
    const long = "ab" + "c".repeat(4000);
    const started = performance.now();
    // Past the budget the word reads as built to evade.
    expect(await bashDecision(`A=${long}; cp x "\${A//a*b/x}"`, p7)).toBe("deny");
    expect(await bashDecision(`A=${long}; cp x "\${A##a*b}"`, p7)).toBe("deny");
    // A pattern that matches nowhere costs one walk, and changes nothing.
    expect(await bashDecision(`A=${"a".repeat(4000)}; cp x "\${A//*a*a*a*a*b/x}"`, p7)).toBe("allow");
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("matches a glob against the files behind settings links", async () => {
    const profile = join(root, "profile10");
    const actual = join(root, "actual10");
    mkdirSync(profile, { recursive: true });
    mkdirSync(actual, { recursive: true });
    writeFileSync(join(actual, "primary.json"), "{}");
    symlinkSync(join(actual, "primary.json"), join(profile, "settings.json"));
    const session = { cwd: p7, agentSettingsPath: join(profile, "settings.json") };
    const decide = async (command: string) =>
      (await policy.fn({ eventType: "PreToolUse", payload: {}, toolName: "Bash", toolInput: { command }, session })).decision;
    expect(await decide(`cp /tmp/disable.json ${join(actual, "prim*.json")}`)).toBe("deny");
    expect(await decide(`printf '{}' > ${join(actual, "prim?ry.json")}`)).toBe("deny");
    expect(await decide(`cd ${actual} && cp /tmp/disable.json prim*.json`)).toBe("deny");
    expect(await decide(`cp /tmp/x ${join(actual, "notes*.json")}`)).toBe("allow");
    // A project's settings link target too: `.claude/settings.local.json -> ../config/claude.json`.
    expect(await bash(`cp /tmp/x config/cl*.json`, p7)).toBe(true);
  });

  it("follows values a line assigns other ways: for, read, printf -v, a nameref, a substitution", async () => {
    mkdirSync(join(p7, "sub11"), { recursive: true });
    symlinkSync(settings(), join(p7, "sub11", "cfg11.json"));
    for (const command of [
      `cd sub11; for A in cfg11.json; do cp /tmp/evil.json "$A"; done`,
      `cd sub11; for A in *.json; do cp /tmp/evil.json "$A"; done`,
      `cd sub11; read -r A <<< "cfg11.json"; cp /tmp/evil.json "$A"`,
      `cd sub11; read <<< cfg11.json; cp /tmp/evil.json "$REPLY"`,
      `cd sub11; printf -v A '%s.%s' cfg11 json; cp /tmp/evil.json "$A"`,
      `cd sub11; A=$(echo cfg11.json); cp /tmp/evil.json "$A"`,
      "cd sub11; A=`printf %s cfg11.json`; cp /tmp/evil.json \"$A\"",
      `cd sub11; A=$(basename /x/cfg11.json); cp /tmp/evil.json "$A"`,
      `cd sub11; A=$(readlink -f cfg11.json); cp /tmp/evil.json "$A"`,
      `A=cfg11.json; declare -n R=A; cd sub11; cp /tmp/evil.json "$R"`,
    ]) {
      expect(await bash(command, p7), command).toBe(true);
    }
    for (const command of [
      `read A <<< hello; echo "$A" > /tmp/out.txt`,
      `A=$(date +%s); cp a "/tmp/$A.txt"`,
      `A=$(echo build); cp a "$A/x"`,
      `printf -v n '%05d' 7; cp a "/tmp/$n.txt"`,
      `for f in src/*.ts; do cp "$f" /tmp/; done`,
    ]) {
      expect(await bashDecision(command, p7), command).toBe("allow");
    }
  });

  it("expands a glob on disk to the links it reaches", async () => {
    mkdirSync(join(p7, "sub12"), { recursive: true });
    symlinkSync(settings(), join(p7, "sub12", "cfg12.json"));
    writeFileSync(join(p7, "sub12", "notes.txt"), "x");
    expect(await bash(`cd sub12; cp /tmp/evil.json *.json`, p7)).toBe(true);
    expect(await bash(`cp /tmp/evil.json sub12/c?g12.json`, p7)).toBe(true);
    expect(await bash(`cp /tmp/evil.json sub12/{cfg12,x}.json`, p7)).toBe(true);
    expect(await bashDecision(`cd sub12; cp /tmp/x *.txt`, p7)).toBe("allow");
    expect(await bashDecision(`ls sub12/*.json; cat sub12/*.json; cp sub12/*.json /tmp/backup/`, p7)).toBe("allow");
  });

  it("reads each directory once for a command's globs", async () => {
    const many = join(root, "many12");
    mkdirSync(many, { recursive: true });
    for (let i = 0; i < 1000; i++) writeFileSync(join(many, `f${i}.json`), "");
    const command = "cp a " + Array.from({ length: 4000 }, (_, i) => `x${i}*.json`).join(" ") + " /tmp/out/";
    const started = performance.now();
    expect(await bashDecision(command, many)).toBe("allow");
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it("reads an appended variable in an agent CLI's hooks-off command", async () => {
    expect(await bashDecision(`F=ho; F+=oks; codex features disable "$F"`, p7)).toBe("deny");
    expect(await bashDecision(`F+=hooks; codex features disable $F`, p7)).toBe("deny");
  });

  it("reads an empty heredoc delimiter the way bash does", async () => {
    expect(await bash(`cat > /tmp/notes <<''\ncat > /tmp/y <<EOF\n\ncp /tmp/evil ${settings()}\nEOF\n`, p7)).toBe(true);
    expect(await bashDecision(`cat > /tmp/notes <<''\nrm -rf ~/.claude\n\necho done\n`, p7)).toBe("allow");
  });
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
