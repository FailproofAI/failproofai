// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { BUILTIN_POLICIES } from "../../src/hooks/builtin-policies";
import { POLICY_CATALOG } from "../../src/hooks/policy-catalog";
import type { PolicyContext } from "../../src/hooks/policy-types";

// Same mocks as builtin-policies.test.ts. Nothing under test reads a file or
// spawns a process, and these keep it that way: a state guard whose test suite
// could touch the real ~/.failproofai would be a poor way to learn that.
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

function makeCtx(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return { eventType: "PreToolUse", payload: {}, toolName: undefined, toolInput: undefined, ...overrides };
}

const policy = BUILTIN_POLICIES.find((p) => p.name === "block-failproofai-commands")!;

const decide = async (command: string) =>
  (await policy.fn(makeCtx({ toolName: "Bash", toolInput: { command } }))).decision;

const reason = async (command: string) =>
  (await policy.fn(makeCtx({ toolName: "Bash", toolInput: { command } }))).reason ?? "";

/** Deny AND for the state reason, not the CLI/uninstall reason next to it. */
const denialIsAboutState = async (command: string) => {
  const result = await policy.fn(makeCtx({ toolName: "Bash", toolInput: { command } }));
  return result.decision === "deny" && /failproofai's own state/.test(result.reason ?? "");
};

/**
 * `block-failproofai-commands` is the one policy that cannot be switched off:
 * it ships compiled in, no pack can carry it, and no config can disable it. Its
 * whole job is to stop an agent turning failproofai off — so a hole in it is not
 * one policy failing, it is every policy on the machine failing at once.
 *
 * This file covers the half that never names the binary: destroying the STATE.
 * That half shipped with no test of its own, which is why the first two shapes
 * of the check were both wrong in production before anybody noticed.
 */
describe("block-failproofai-commands — the state guard", () => {
  describe("the reported hole, and the rest of its family", () => {
    // The reviewer's finding. The check was one regex,
    // `\b(?:rm|unlink|shred|mv|truncate)\b[^;&|]*\.failproofai` — a fixed verb
    // list, and `find … -delete` names none of those words. It walked through
    // the always-on guard and nothing anywhere reported it.
    it("denies find -delete over the state directory", async () => {
      expect(await denialIsAboutState("find ~/.failproofai -delete")).toBe(true);
    });

    // Deleting this one file is the whole attack: every pack policy stops
    // running, and a MISSING store reads as a FRESH machine rather than a
    // broken one, so fail-closed never fires. The machine looks healthy and
    // enforces nothing.
    it("denies the single-file kill that leaves the machine reading as fresh", async () => {
      expect(await denialIsAboutState("rm ~/.failproofai/policies/packs/installed.json")).toBe(true);
      expect(await denialIsAboutState("find ~/.failproofai/policies/packs -name installed.json -delete")).toBe(true);
      expect(await denialIsAboutState("mv ~/.failproofai/policies/packs/installed.json /tmp/")).toBe(true);
    });

    // `-exec` runs anything at all, which makes find a deleter without ever
    // using the word. `-execdir` and `-ok` are the same primitive with a
    // different cwd and a prompt, so leaving either out reopens the hole.
    it("denies every find action that hands paths to another command", async () => {
      expect(await decide("find ~/.failproofai -type f -exec rm -f {} +")).toBe("deny");
      expect(await decide("find ~/.failproofai -execdir rm -f {} \\;")).toBe("deny");
      expect(await decide("find ~/.failproofai -type f -ok rm {} \\;")).toBe("deny");
      expect(await decide("find ~/.failproofai -type f -exec sh -c 'rm \"$1\"' _ {} \\;")).toBe("deny");
    });

    // A read `-exec` in front of a destructive one defeated a findIndex that
    // only looked at the first match — the read answered for the whole command
    // while the second `-exec` did the deleting. Every action has to be judged.
    it("denies a destructive -exec hidden behind a harmless one", async () => {
      expect(await decide("find ~/.failproofai -name '*.json' -exec cat {} + -o -exec rm -f {} +")).toBe("deny");
      expect(await decide("find ~/.failproofai -print -delete")).toBe("deny");
    });
  });

  describe("the path and the verb in different commands", () => {
    // The per-segment version asked each segment for BOTH a path and a verb, so
    // splitting them across `&&` made each half look innocent. `cd` carries the
    // directory into a command whose only argument is `.`, and the shell does
    // the rest. This is the single cheapest bypass of the old check.
    it("denies cd into the state followed by a relative delete", async () => {
      expect(await denialIsAboutState("cd ~/.failproofai && rm -rf .")).toBe(true);
      expect(await decide("cd ~/.failproofai; rm -rf *")).toBe("deny");
      expect(await decide("cd ~/.failproofai && find . -delete")).toBe("deny");
      expect(await decide("pushd ~/.failproofai && rm -rf ./policies")).toBe("deny");
    });

    // Grouping is not protection: a subshell and an interpreter both reduce to
    // the same two commands, and the guard reads the string either way.
    it("denies the same trick inside a subshell or behind sh -c", async () => {
      expect(await decide("(cd ~/.failproofai && rm -rf ./*)")).toBe("deny");
      expect(await decide("bash -c 'cd ~/.failproofai && rm -rf .'")).toBe("deny");
    });

    // The other carrier: a variable holds the path and the destroying command
    // names only `$D`. `classifySelfInvocation` already had to learn this for
    // the binary half (`x=failproofai; $x config --pause` was a live bypass);
    // the state half had never learned it.
    it("denies a delete whose target arrives through a variable", async () => {
      expect(await denialIsAboutState("D=~/.failproofai; rm -rf $D")).toBe(true);
      expect(await decide('export FP=$HOME/.failproofai && rm -rf "$FP"')).toBe("deny");
      expect(await decide("T=~/.failproofai; find $T -delete")).toBe("deny");
      expect(await decide("D=~/.failproofai/policies-config.json; : > $D")).toBe("deny");
    });

    // A pipeline is one unit of work, not two commands. Splitting on `|` let
    // `find` name the path on the left and `rm` do the deleting on the right,
    // with neither half matching on its own.
    it("denies a pipeline that feeds the state into a deleter", async () => {
      expect(await denialIsAboutState("find ~/.failproofai -type f -print0 | xargs -0 rm -f")).toBe(true);
      expect(await decide("echo ~/.failproofai | xargs rm -rf")).toBe("deny");
      expect(await decide("find ~/.failproofai -type f | xargs -I{} sh -c 'rm {}'")).toBe("deny");
      expect(await decide('find ~/.failproofai -type f | while read f; do rm "$f"; done')).toBe("deny");
    });
  });

  describe("tools that delete without owning a delete verb", () => {
    // Every interpreter on the machine is one more verb a blocklist would have
    // to know. None of these four contains `rm` as a word, and all four empty
    // the directory. This is the class that made the blocklist shape unfixable.
    it("denies an interpreter deleting the state", async () => {
      expect(await decide("python3 -c 'import shutil; shutil.rmtree(\"/home/u/.failproofai\")'")).toBe("deny");
      expect(await decide("perl -MFile::Path -e 'rmtree(\"$ENV{HOME}/.failproofai\")'")).toBe("deny");
      expect(await decide("node -e \"require('fs').rmSync(process.env.HOME + '/.failproofai', {recursive:true})\"")).toBe("deny");
      expect(await decide("python3 - <<'EOF'\nimport shutil\nshutil.rmtree('/home/u/.failproofai')\nEOF")).toBe("deny");
    });

    // An interpreter does not have to delete: opening the config for writing
    // empties it, and the result is the same disabled machine.
    it("denies an interpreter truncating the config", async () => {
      expect(await decide("node -e \"require('fs').writeFileSync(process.env.HOME+'/.failproofai/policies-config.json','')\"")).toBe("deny");
      expect(await decide("python3 -c \"open('/home/u/.failproofai/policies-config.json','w').close()\"")).toBe("deny");
    });

    // Ordinary tools with the same effect. `git clean -xdff` deletes a tree as
    // thoroughly as `rm -rf`, `sed -i` empties a file in place, and a trash
    // command moves it somewhere the daemon will never look.
    it("denies the ordinary tools a verb list keeps missing", async () => {
      expect(await decide("cd ~ && git clean -xdff .failproofai")).toBe("deny");
      expect(await decide("sed -i '1,$d' ~/.failproofai/policies-config.json")).toBe("deny");
      expect(await decide("sed -i.bak 'd' ~/.failproofai/policies-config.json")).toBe("deny");
      expect(await decide("gio trash ~/.failproofai")).toBe("deny");
      expect(await decide("trash-put ~/.failproofai")).toBe("deny");
      expect(await decide("tar -xf /tmp/empty.tar -C ~/.failproofai --overwrite")).toBe("deny");
    });

    // Not deleting, still disabling. `chmod 000` makes the state unreadable and
    // `chattr +i` makes it unwritable; a tmpfs mount hides the real directory
    // entirely. Each leaves the daemon reading something other than the truth.
    it("denies making the state unusable without removing it", async () => {
      expect(await decide("chmod 000 ~/.failproofai")).toBe("deny");
      expect(await decide("chattr +i ~/.failproofai/policies-config.json")).toBe("deny");
      expect(await decide("sudo mount -t tmpfs none ~/.failproofai")).toBe("deny");
    });

    // The doc comment on the old regex listed `cp /dev/null path` as covered
    // and the regex never mentioned `cp` at all — the comment described a check
    // that did not exist. `install` is the same move with a mode flag.
    it("denies copying over the state, which the old comment claimed was covered", async () => {
      expect(await denialIsAboutState("cp /dev/null ~/.failproofai/policies-config.json")).toBe(true);
      expect(await decide("install -m 600 /dev/null ~/.failproofai/policies-config.json")).toBe("deny");
    });

    // `-t` puts the DESTINATION first, so the last operand — which is what
    // decides whether a copy is a backup or an overwrite — is the innocent one.
    it("denies a copy whose destination is named by -t rather than by position", async () => {
      expect(await decide("cp -t ~/.failproofai /dev/null")).toBe("deny");
      expect(await decide("cp --target-directory=$HOME/.failproofai /dev/null")).toBe("deny");
      expect(await decide("install -t ~/.failproofai/policies /dev/null")).toBe("deny");
    });

    // rsync empties a destination through a flag, not a verb, and `--del` is a
    // real alias for it that a `--delete`-only pattern misses.
    it("denies rsync emptying the state directory", async () => {
      expect(await decide("rsync -a --delete /tmp/empty/ ~/.failproofai/")).toBe("deny");
      expect(await decide("rsync -a --del /tmp/empty/ ~/.failproofai/")).toBe("deny");
    });

    // A symlink turns any later relative command into a state command, and the
    // later command cannot be caught by reading its string. Denying the ALIAS
    // is what is actually reachable here, so it is what gets denied.
    it("denies creating a symlink to the state", async () => {
      expect(await decide("ln -s ~/.failproofai /tmp/fp")).toBe("deny");
      expect(await decide("ln -s ~/.failproofai /tmp/fp && rm -rf /tmp/fp/")).toBe("deny");
    });
  });

  describe("writes with no command in front of them", () => {
    // A redirect needs no verb at all. `> file` truncates on open, so the
    // shortest disable on the machine is four characters and a path.
    it("denies a truncating redirect into the state", async () => {
      expect(await decide("> ~/.failproofai/policies-config.json")).toBe("deny");
      expect(await decide(": > ~/.failproofai/policies-config.json")).toBe("deny");
      expect(await decide(">'/home/u/.failproofai/policies-config.json'")).toBe("deny");
      expect(await decide("cat > ~/.failproofai/policies-config.json <<'EOF'\n{}\nEOF")).toBe("deny");
    });

    // The same write reached through a tool that takes the path as an argument
    // instead of after an operator. `awk` is on the read allowlist, so its
    // redirect has to be caught by the redirect scan rather than by its head.
    it("denies writes that reach the state through dd, tee or awk", async () => {
      expect(await decide("dd if=/dev/null of=$HOME/.failproofai/policies-config.json")).toBe("deny");
      expect(await decide("echo '{}' | tee ~/.failproofai/policies-config.json")).toBe("deny");
      expect(await decide("truncate -s 0 ~/.failproofai/policies-config.json")).toBe("deny");
      expect(await decide("awk 'BEGIN{printf \"\" > \"/home/u/.failproofai/policies-config.json\"}'")).toBe("deny");
    });
  });

  describe("quoting, escaping and prefixes", () => {
    // A shell strips these before it execs, so each one presents a broken
    // literal to a matcher and a real path to the kernel. The binary half of
    // this policy was hardened against exactly this class; the state half gets
    // it by re-running the check on the unescaped form.
    it("denies the shell-escape spellings of the path", async () => {
      expect(await decide("rm -rf ~/.fail\\proofai")).toBe("deny");
      expect(await decide('rm -rf ~/.failproof"ai"')).toBe("deny");
      expect(await decide("rm -rf ~/.failproof'ai'")).toBe("deny");
      expect(await decide("rm -rf $'\\x2efailproofai'")).toBe("deny");
      expect(await decide("rm -rf ~/.fail\\\nproofai")).toBe("deny");
    });

    // A runner in front of the deleter is the same trick that hid `npx
    // failproofai config --pause` from the binary half. The walk has to strip
    // prefixes here too, or `xargs`, `env` and `nohup` each hide an `rm`.
    it("denies a delete standing behind a runner or a wrapper", async () => {
      expect(await decide("nohup rm -rf ~/.failproofai")).toBe("deny");
      expect(await decide("env -i rm -rf ~/.failproofai")).toBe("deny");
      expect(await decide("command rm -rf ~/.failproofai")).toBe("deny");
      expect(await decide('eval "rm -rf ~/.failproofai"')).toBe("deny");
      expect(await decide("sh -c 'rm -rf ~/.failproofai'")).toBe("deny");
    });

    // Renaming the deleter does not hide it, because the allowlist decides by
    // what a command IS rather than by what it is called: an unknown head over
    // the state is destructive by default, so an alias gains nothing.
    it("denies a delete reached through an alias or a function", async () => {
      expect(await decide("alias x=rm; x -rf ~/.failproofai")).toBe("deny");
      expect(await decide("f(){ rm -rf ~/.failproofai; }; f")).toBe("deny");
      expect(await decide("\\rm -rf ~/.failproofai")).toBe("deny");
      expect(await decide('"rm" -rf ~/.failproofai')).toBe("deny");
    });

    // Spelling the path a different way is not a different path. Absolute,
    // `$HOME`, `${HOME}`, relative-from-home and a traversal all land on the
    // same directory.
    it("denies every spelling of the same directory", async () => {
      expect(await decide('rm -rf "$HOME/.failproofai"')).toBe("deny");
      expect(await decide("rm -rf ${HOME}/.failproofai")).toBe("deny");
      expect(await decide("cd ~ && rm -rf .failproofai")).toBe("deny");
      expect(await decide("cd $HOME && rm -rf ./.failproofai")).toBe("deny");
      expect(await decide("rm -rf /home/u/projects/../../u/.failproofai")).toBe("deny");
      expect(await decide("rm -rf $(ls -d ~/.failproofai)")).toBe("deny");
    });
  });

  describe("the file-tool surface, which needs no shell at all", () => {
    // The guard was `toolNames: ["Bash"]`, so it never ran for Write or Edit —
    // and the shortest disable never needed a shell: write
    // `{"enabledPolicies":[]}` over the config, or an empty installed.json, and
    // every policy stops with the machine still reading as fresh.
    it("denies writing to the state through Write, Edit and NotebookEdit", async () => {
      const write = await policy.fn(
        makeCtx({ toolName: "Write", toolInput: { file_path: "/home/u/.failproofai/policies-config.json", content: '{"enabledPolicies":[]}' } }),
      );
      expect(write.decision).toBe("deny");
      const edit = await policy.fn(
        makeCtx({ toolName: "Edit", toolInput: { file_path: "/home/u/.failproofai/policies/packs/installed.json", old_string: "a", new_string: "" } }),
      );
      expect(edit.decision).toBe("deny");
      const notebook = await policy.fn(
        makeCtx({ toolName: "NotebookEdit", toolInput: { notebook_path: "/home/u/.failproofai/x.ipynb" } }),
      );
      expect(notebook.decision).toBe("deny");
    });

    // The catalog entry is what actually routes the event. A correct policy
    // function behind `toolNames: ["Bash"]` is never called for a Write, so the
    // fix is only real if the match declaration carries it.
    it("declares the file tools in the catalog, not just in the function", async () => {
      const entry = POLICY_CATALOG.find((p) => p.name === "block-failproofai-commands")!;
      expect(entry.match.toolNames).toEqual(expect.arrayContaining(["Bash", "Write", "Edit", "NotebookEdit"]));
    });

    // Widening the tool surface must not turn the guard into a general
    // file-write blocker: it fires on the state path and nothing else.
    it("leaves writes outside the state directory alone", async () => {
      const result = await policy.fn(
        makeCtx({ toolName: "Write", toolInput: { file_path: "/home/u/project/src/index.ts", content: "x" } }),
      );
      expect(result.decision).toBe("allow");
    });

    // The consequence of the branch above that nobody wrote down, pinned so it
    // is a decision rather than a surprise: `.failproofai/policies/*.mjs` is the
    // DOCUMENTED home for a user's own policies, in the project as well as
    // under home, and the branch denies every write to it. So an agent cannot
    // author a custom policy through a file tool, and cannot edit the two that
    // this repo has committed at `.failproofai/policies/`.
    //
    // There is a real security argument for the deny — convention files are
    // auto-loaded and run as code inside the evaluator, so a write there is a
    // write to the thing doing the enforcing — and it is consistent with the
    // CLI branch, which already blocks `failproofai policies --install
    // --custom`. It is still the always-on guard standing in front of the
    // product's own authoring path, which is the shape of guard that gets
    // worked around. Whichever way it is settled, it should be settled on
    // purpose.
    it("denies authoring a custom policy file, which is the documented workflow", async () => {
      const projectPolicy = await policy.fn(
        makeCtx({
          toolName: "Write",
          toolInput: { file_path: "/home/u/project/.failproofai/policies/checkout-policies.ts", content: "export {}" },
        }),
      );
      expect(projectPolicy.decision).toBe("deny");
      const userPolicy = await policy.fn(
        makeCtx({
          toolName: "Edit",
          toolInput: { file_path: "/home/u/.failproofai/policies/personal-policies.mjs", old_string: "a", new_string: "b" },
        }),
      );
      expect(userPolicy.decision).toBe("deny");
    });
  });

  describe("reads stay allowed, because a guard that blocks diagnosis gets worked around", () => {
    // These are how somebody works out what failproofai is doing. An always-on
    // policy that denied them would be argued around rather than respected, and
    // the argument would end with the whole guard being questioned.
    it("allows reading the state directory", async () => {
      expect(await decide("cat ~/.failproofai/policies-config.json")).toBe("allow");
      expect(await decide("ls -la ~/.failproofai")).toBe("allow");
      expect(await decide("grep -r block-sudo ~/.failproofai")).toBe("allow");
      expect(await decide("find ~/.failproofai -type f -print")).toBe("allow");
      expect(await decide("du -sh ~/.failproofai")).toBe("allow");
      expect(await decide("stat ~/.failproofai/policies-config.json")).toBe("allow");
    });

    // The second command is a separate command: nothing in it reaches the
    // state. Treating a whole command line as destructive because one half
    // names the path and the other half deletes something is how a guard starts
    // denying `cat && rm /tmp/x`.
    it("allows a destructive command in a genuinely separate segment", async () => {
      expect(await decide("cat ~/.failproofai/config.json && rm /tmp/scratch")).toBe("allow");
      expect(await decide("rm -rf /tmp/scratch")).toBe("allow");
      expect(await decide("find /tmp/build -delete")).toBe("allow");
    });

    // The previous check matched ANY `>` anywhere in the segment, so silencing
    // stderr or saving a listing denied. Both are reads, and both are what
    // somebody does while diagnosing — only a redirect whose TARGET is the
    // state is a write to the state.
    it("allows a redirect that points away from the state", async () => {
      expect(await decide("grep -r sudo ~/.failproofai 2>/dev/null")).toBe("allow");
      expect(await decide("cat ~/.failproofai/policies-config.json > /tmp/backup.json")).toBe("allow");
      expect(await decide("ls ~/.failproofai >> /tmp/audit.log")).toBe("allow");
    });

    // Same reason on the other side: `-exec` is judged by what it runs, so a
    // `find` that prints file contents stays a read. The previous check denied
    // on the flag alone.
    it("allows find -exec when the command it runs only reads", async () => {
      expect(await decide("find ~/.failproofai -name '*.json' -exec cat {} +")).toBe("allow");
      expect(await decide("find ~/.failproofai -type f -execdir stat {} +")).toBe("allow");
      expect(await decide("find ~/.failproofai -type f -print0 | xargs -0 grep -l sudo")).toBe("allow");
    });

    // Copying the state OUT is what somebody does BEFORE changing it, and
    // denying a backup pushes them toward changing it without one. Only the
    // destination separates this from `cp /dev/null <state>`.
    it("allows copying the state out as a backup", async () => {
      expect(await decide("cp -r ~/.failproofai /tmp/fp-backup")).toBe("allow");
      expect(await decide("rsync -a ~/.failproofai/ /tmp/fp-backup/")).toBe("allow");
    });

    // `cd` into the directory is not itself an act. Denying it would block the
    // ordinary way of looking around, and the destructive case is the command
    // that FOLLOWS the cd, which is covered above.
    it("allows cd into the state followed by a read", async () => {
      expect(await decide("cd ~/.failproofai && cat policies-config.json")).toBe("allow");
      expect(await decide("cd ~/.failproofai; ls -la")).toBe("allow");
      expect(await decide("sed -n '1,20p' ~/.failproofai/policies-config.json")).toBe("allow");
    });

    // A `cd` back out ends the window. Without this the guard would treat every
    // command after any `cd ~/.failproofai` as a state command for the rest of
    // the line, and deny an unrelated cleanup in /tmp.
    it("stops treating relative paths as state paths after cd back out", async () => {
      expect(await decide("cd ~/.failproofai && cat config.json && cd /tmp && rm -rf junk")).toBe("allow");
    });

    // The binary half of this policy had to be anchored to command position
    // because this repo's own CHANGELOG and docs contain the literal
    // invocation. The state half has the same exposure: an agent writing a
    // commit message or a PR body that names the path is not touching it.
    it("allows the path appearing as prose in an argument", async () => {
      expect(await decide("git commit -m 'document ~/.failproofai layout'")).toBe("allow");
      expect(await decide("gh pr create --body 'moves state to ~/.failproofai/policies'")).toBe("allow");
      expect(await decide('echo "state lives in ~/.failproofai"')).toBe("allow");
      expect(await decide("grep -rl '.failproofai' /tmp/scan")).toBe("allow");
    });

    // Reading through a pipe is still reading. Denying here would rule out the
    // single most common way of inspecting a JSON config.
    it("allows a read piped into another read", async () => {
      expect(await decide("cat ~/.failproofai/policies-config.json | grep block-sudo")).toBe("allow");
      expect(await decide("jq '.enabledPolicies' ~/.failproofai/policies-config.json")).toBe("allow");
      expect(await decide("wc -l ~/.failproofai/policies-config.json")).toBe("allow");
      expect(await decide("diff ~/.failproofai/policies-config.json /tmp/other.json")).toBe("allow");
    });

    // This asserted only that `policy.fn` returns allow for a Read — which it
    // would have done just as happily with "Read" added to the catalog, because
    // calling `fn` directly bypasses `match.toolNames` entirely. The comment
    // claimed the routing was pinned and nothing checked the routing. The
    // catalog assertion is the one that would actually fail if widening
    // `toolNames` for Write swept the read tools in, so it is here now.
    it("never fires on the read-only file tools, in the catalog or in the function", async () => {
      const entry = POLICY_CATALOG.find((p) => p.name === "block-failproofai-commands")!;
      for (const readOnlyTool of ["Read", "Glob", "Grep", "LS", "WebFetch"]) {
        expect(entry.match.toolNames).not.toContain(readOnlyTool);
      }
      const result = await policy.fn(
        makeCtx({ toolName: "Read", toolInput: { file_path: "/home/u/.failproofai/policies-config.json" } }),
      );
      expect(result.decision).toBe("allow");
    });
  });

  /**
   * A second adversarial pass over the allowlist, after the first one shipped.
   *
   * Every case below was a live bypass of the version that landed with this
   * file: 25 of 35 tried went through. They fall into two shapes, and both are
   * the allowlist's own failure mode rather than the blocklist's — a name on
   * the read list that turns out to have a write in it, and a path that reaches
   * a command without the command naming it.
   */
  describe("readers that turn out to write", () => {
    // `sort -o FILE` and `curl -o FILE` take their destination as an OPTION, so
    // neither the head nor the operand order says they are writing — and both
    // heads were on a list that said they only read. `curl` was the worse of
    // the two: it replaces the config with whatever a server returns.
    it("denies a reader whose destination arrives as a flag", async () => {
      expect(await denialIsAboutState("sort -o ~/.failproofai/policies-config.json /dev/null")).toBe(true);
      expect(await decide("sort --output=/home/u/.failproofai/policies-config.json /dev/null")).toBe("deny");
      expect(await decide("curl -sfo ~/.failproofai/policies-config.json https://x.test/e")).toBe("deny");
      expect(await decide("curl --output ~/.failproofai/policies-config.json https://x.test/e")).toBe("deny");
      expect(await decide("curl --output-dir ~/.failproofai -O https://x.test/policies-config.json")).toBe("deny");
      expect(await decide("tree -o ~/.failproofai/policies-config.json /etc")).toBe("deny");
    });

    // `uniq IN OUT` and `xxd IN OUT` write their LAST operand. One operand is
    // still a read, which is why the count has to decide rather than the name.
    it("denies a reader whose last operand is an output file", async () => {
      expect(await denialIsAboutState("uniq /dev/null ~/.failproofai/policies-config.json")).toBe(true);
      expect(await decide("xxd -r -p /tmp/hex ~/.failproofai/policies-config.json")).toBe("deny");
    });

    // `sed` was judged on `-i` alone, and `w` inside the script needs no flag:
    // `sed 's/a/b/w <state>' /etc/hosts` writes the state while reading
    // /etc/hosts. A quoted script containing a space is two tokens by the time
    // the walk sees it, so both spellings have to be caught.
    it("denies sed writing through its w command, with no -i anywhere", async () => {
      expect(await denialIsAboutState("sed 's/a/b/w /home/u/.failproofai/policies-config.json' /etc/hosts")).toBe(true);
      expect(await decide("sed -n 'w /home/u/.failproofai/policies-config.json' /dev/null")).toBe("deny");
    });

    // `find` was judged on `-delete` and `-exec`, and `-fprint` is neither: it
    // truncates the file it reports INTO, so the state is the report target and
    // the search never descends into it at all.
    it("denies find reporting into the state", async () => {
      expect(await denialIsAboutState("find /etc -maxdepth 1 -fprint ~/.failproofai/policies-config.json")).toBe(true);
      expect(await decide("find /etc -fprintf ~/.failproofai/policies-config.json '%p'")).toBe("deny");
      expect(await decide("find /etc -fls ~/.failproofai/policies-config.json")).toBe("deny");
    });

    // `awk` runs a shell. The redirect scan already caught `print > "file"`,
    // which left the two channels that are not redirects at all.
    it("denies awk shelling out", async () => {
      expect(await decide("awk 'BEGIN{system(\"rm -rf ~/.failproofai\")}'")).toBe("deny");
      expect(await decide("awk 'BEGIN{print \"\" | \"cat > /home/u/.failproofai/policies-config.json\"}'")).toBe("deny");
    });

    // The `-exec` check reused the READ allowlist, and half that list is only a
    // read because of where its operands sit — which `-exec` decides for it.
    // `-exec cp /dev/null {}` empties every file in the state through two names
    // that were both allowlisted.
    it("denies find -exec handing paths to a conditional reader", async () => {
      expect(await decide("find ~/.failproofai -type f -exec cp /dev/null {} \\;")).toBe("deny");
      expect(await decide("find ~/.failproofai -name '*.json' -exec sed -i 's/.*/x/' {} \\;")).toBe("deny");
      expect(await decide("find ~/.failproofai -type f -exec install -m 600 /dev/null {} \\;")).toBe("deny");
      expect(await decide("find ~/.failproofai -maxdepth 0 -exec find {} -delete \\;")).toBe("deny");
    });

    // `--remove-source-files` makes a copy a move, so the state being the
    // SOURCE — the shape that makes every other rsync a backup — is what makes
    // this one destructive.
    it("denies rsync deleting what it copied", async () => {
      expect(await denialIsAboutState("rsync -a --remove-source-files ~/.failproofai/ /tmp/x/")).toBe(true);
    });

    // `git` carries the path as prose, so the verdict rests entirely on finding
    // the subcommand — and `-C` and `-c` swallow the token after them, so the
    // walk settled on `core.x=1`, found no destructive subcommand, and let a
    // `git clean -xdff` of the state directory through.
    it("denies git clean when a global flag hides the subcommand", async () => {
      expect(await denialIsAboutState("git -c core.x=1 -C ~/.failproofai clean -xdff")).toBe(true);
      expect(await decide("git -C ~/.failproofai clean -xdff")).toBe("deny");
      expect(await decide("git --git-dir=/tmp/g clean -xdff ~/.failproofai")).toBe("deny");
    });
  });

  describe("the path reaching a command that never names it", () => {
    // A substitution runs its body as a command of its own, so the head the
    // walk settled on — `echo`, a mention command — was not the head that ran.
    // Splitting on parentheses instead would have cost the opposite case, which
    // is why the bodies are judged AS WELL AS the whole string.
    it("denies a destructive command inside a substitution", async () => {
      expect(await denialIsAboutState("echo $(rm -rf ~/.failproofai)")).toBe(true);
      expect(await decide("echo `rm -rf ~/.failproofai`")).toBe("deny");
      expect(await decide("cat $(find ~/.failproofai -delete)")).toBe("deny");
      // And the case that must not be lost to the fix: the OUTER command is the
      // destructive one and the substitution only reads.
      expect(await decide("rm -rf $(ls -d ~/.failproofai)")).toBe("deny");
    });

    // A depth-limited recursion answers this with whatever the OUTER head is,
    // and the outer head is always `echo`. Nesting thirty deep is one line to
    // write, so the walk is bounded by a work budget rather than by depth.
    it("denies a destructive command nested deep inside substitutions", async () => {
      const nested = "echo $(".repeat(30) + "rm -rf ~/.failproofai" + ")".repeat(30);
      expect(await decide(nested)).toBe("deny");
    });

    // The variable walk ran one pass, so the second hop — which names no path
    // at all, only the first variable — carried the state past it.
    it("denies a delete whose target arrives through a chain of variables", async () => {
      expect(await denialIsAboutState("A=$HOME/.failproofai; B=$A; rm -rf $B")).toBe(true);
      expect(await decide("A=~/.failproofai; B=$A; C=$B; rm -rf $C")).toBe("deny");
    });

    // A loop header names the state and the body is a separate pipeline that
    // names nothing, so the body was judged against a path it never mentions.
    // The header's reach has to carry into the body and stop at `done`.
    it("denies a loop body deleting what its header expanded", async () => {
      expect(await denialIsAboutState("for f in ~/.failproofai/*; do rm -rf $f; done")).toBe(true);
      expect(await decide("find ~/.failproofai -type f | while read f; do rm \"$f\"; done")).toBe("deny");
    });

    // `tee` writes every operand it is given, and the state as an operand is
    // the only thing that makes it a write.
    it("denies tee writing into the state", async () => {
      expect(await decide("cat /dev/null | tee ~/.failproofai/policies-config.json")).toBe("deny");
    });
  });

  describe("reads that the allowlist was denying anyway", () => {
    // The head was taken with its quote still attached, so `'cat` matched no
    // allowlist entry and the guard denied a plain read of the config through
    // the most ordinary wrapper there is. Stripping the quote cannot let a
    // deleter past: `"rm"` unquotes to `rm`, which is still not a reader.
    it("allows a read whose head is quoted", async () => {
      expect(await decide("bash -c 'cat ~/.failproofai/policies-config.json'")).toBe("allow");
      expect(await decide('sh -c "ls -la ~/.failproofai"')).toBe("allow");
      expect(await decide("bash -c 'grep -c sudo ~/.failproofai/policies-config.json'")).toBe("allow");
      // The same strip, on the destructive side.
      expect(await decide("bash -c 'rm -rf ~/.failproofai'")).toBe("deny");
    });

    // Shell grammar was reaching the unknown-head branch: `[` is a command, and
    // a loop header only expands words. Checking whether the state exists is
    // the first thing anybody does when a policy misfires.
    it("allows shell grammar around a read", async () => {
      expect(await decide("[ -f ~/.failproofai/policies-config.json ] && echo present")).toBe("allow");
      expect(await decide("[[ -d ~/.failproofai ]] && echo yes")).toBe("allow");
      expect(await decide("for f in ~/.failproofai/policies/*.mjs; do cat $f; done")).toBe("allow");
      expect(await decide("find ~/.failproofai -type f | while read f; do head -1 \"$f\"; done")).toBe("allow");
    });

    // `popd` returns the shell to where `pushd` found it, and a `cd` inside
    // `( … )` moves only the subshell. Without either, every command for the
    // rest of the line was judged as if it stood in the state directory — so an
    // unrelated cleanup in the project denied.
    it("allows an unrelated delete after the cd window has closed", async () => {
      expect(await decide("pushd ~/.failproofai; cat policies-config.json; popd; rm -rf node_modules")).toBe("allow");
      expect(await decide("(cd ~/.failproofai && cat policies-config.json); rm -rf node_modules")).toBe("allow");
      // The window still holds while it is genuinely open.
      expect(await decide("(cd ~/.failproofai && rm -rf ./*)")).toBe("deny");
      expect(await decide("pushd ~/.failproofai && rm -rf ./policies")).toBe("deny");
    });

    // Piping a read into a transcript is a read. `tee` was an unknown head, so
    // it denied wherever it appeared, including on the side of the pipe that
    // writes to /tmp.
    it("allows a read piped into tee", async () => {
      expect(await decide("cat ~/.failproofai/policies-config.json | tee /tmp/out.json")).toBe("allow");
    });

    // The conditional readers, in their reading direction. Each of these is the
    // same binary as a case above and differs only in where the state sits.
    it("allows the conditional readers when the state is the input", async () => {
      expect(await decide("sort ~/.failproofai/policies-config.json")).toBe("allow");
      expect(await decide("uniq ~/.failproofai/policies-config.json")).toBe("allow");
      expect(await decide("xxd ~/.failproofai/policies-config.json | head")).toBe("allow");
      expect(await decide("awk '{print $1}' /home/u/.failproofai/policies-config.json")).toBe("allow");
      expect(await decide("sed 's/a/b/' ~/.failproofai/policies-config.json")).toBe("allow");
      expect(await decide("git -C ~/.failproofai status")).toBe("allow");
      expect(await decide("curl -X POST -d 'path=~/.failproofai' https://x.test/report")).toBe("allow");
      expect(await decide("cat $(ls -d ~/.failproofai)/policies-config.json")).toBe("allow");
    });
  });

  describe("what this guard does NOT catch — stated, not hidden", () => {
    // This block used to assert `allow` for all three, on the reasoning that a
    // glob is only the state AFTER the shell expands it. That reasoning was
    // wrong, and it left the cheapest bypass on the list standing: `rm -rf
    // ~/.failproof*` is four keystrokes short of the literal and wipes the
    // machine's enforcement. What a check over the pre-exec string CAN decide
    // is whether the pattern could land on the state, so now it compiles the
    // glob and tries it.
    it("denies a glob that could expand onto the state", async () => {
      expect(await denialIsAboutState("rm -rf ~/.fail*")).toBe(true);
      expect(await decide("rm -rf ~/.failproof*")).toBe("deny");
      expect(await decide("rm -rf ~/.failproofa[i]")).toBe("deny");
      expect(await decide("rm -rf $HOME/.fail?roofai")).toBe("deny");
      expect(await decide("find ~ -maxdepth 1 -name '*failproof*' -exec rm -rf {} +")).toBe("deny");
    });

    // The other half of that change, and the reason it does not over-deny. A
    // pattern has to carry the literal `fail` before it is compiled at all:
    // without that floor a bare `*` matches every candidate and `rm -rf *` in
    // an unrelated directory denies, which is the exact failure that gets a
    // guard worked around.
    it("leaves a glob alone when it could not reach the state", async () => {
      expect(await decide("cd /tmp/build && rm -rf *")).toBe("allow");
      expect(await decide("rm -rf /tmp/test-failures*")).toBe("allow");
      expect(await decide("rm -rf ~/.cache/*")).toBe("allow");
    });

    // Same class as the indirection limit the binary half already documents:
    // when the path is BUILT at run time the literal never appears, so there is
    // nothing to match. The real fix is action-gating on the resolved path,
    // which is not something a string check can do.
    it("does not catch a path assembled at run time", async () => {
      expect(await decide("X=ai; rm -rf ~/.failproof$X")).toBe("allow");
      expect(await decide('echo ~/.failproofai > /tmp/t; rm -rf "$(cat /tmp/t)"')).toBe("allow");
      expect(await decide("find ~ -inum 12345 -delete")).toBe("allow");
    });

    // Creating the symlink denies (covered above), but a symlink that already
    // exists — made in an earlier turn, or by something other than the agent —
    // makes `rm -rf /tmp/fp/` a state delete with nothing in the string to say
    // so. Only resolving the path on disk would catch this.
    it("does not catch a delete through a symlink made earlier", async () => {
      expect(await decide("rm -rf /tmp/fp/")).toBe("allow");
    });

    // The cost of an allowlist, paid on purpose. A blocklist miss disables
    // enforcement silently; an allowlist miss denies a command the operator can
    // see and report. These two are misses of the second kind — a backup and a
    // read — and they are pinned so the next person knows they are a decision
    // rather than an accident.
    it("over-denies a tar backup and an interpreter read, which is the chosen failure", async () => {
      expect(await decide("tar -cf /tmp/backup.tar ~/.failproofai")).toBe("deny");
      expect(await decide("python3 -c \"print(open('/home/u/.failproofai/policies-config.json').read())\"")).toBe("deny");
    });
  });

  // A glob is the cheapest bypass there is, and the floor that was supposed to
  // stop a bare `*` from denying every build directory was a literal `fail`
  // substring test — which is precisely the letter a metacharacter stands in
  // for. Every spelling here reached the state with no `fail` in it.
  describe("a glob that spells the state without spelling it", () => {
    it.each([
      ["a star inside the name", "rm -rf ~/.f*ailproofai"],
      ["a star mid-word", "rm -rf ~/.fa*lproofai"],
      ["a one-letter class", "rm -rf ~/.[f]ailproofai"],
      ["a class mid-word", "rm -rf ~/.fa[i]lproofai"],
      ["a brace alternation", "rm -rf ~/.f{a,b}ilproofai"],
      ["a brace naming it outright", "rm -rf ~/.{failproofai,other}"],
      ["a question mark", "rm -rf ~/.f?ilproofai"],
      ["an unexpanded $HOME", "rm -rf $HOME/.f*ailproofai"],
      ["find, which deletes without a verb", "find ~/.f*ailproofai -delete"],
      ["a glob in a segment that is not the last", "shred ~/.f*ailproofai/policies-config.json"],
      // A glob INSIDE a brace. The shell expands braces first and globs second,
      // so `{a*,x}` becomes `~/.fa*ilproofai` and then the directory itself —
      // while compiling the alternation put a literal `*` in the pattern.
      ["a star inside a brace alternative", "rm -rf ~/.f{a*,x}ilproofai"],
      ["a class inside a brace alternative", "rm -rf ~/.f{[a],x}ilproofai"],
      ["a question mark inside a brace", "rm -rf ~/.f{a?,x}lproofai"],
      ["nested braces around a glob", "rm -rf ~/.f{{a,b}*,x}ilproofai"],
      ["two brace groups multiplying", "rm -rf ~/.f{a,x}{i,y}lproofai"],
      // The token ends with the brace, and the leading/trailing strip that
      // exists for shell groups (`{ rm -rf x; }`) used to eat it.
      ["a brace that closes the token", "rm -rf ~/.{fail*,zz}"],
      ["a brace glob above the state", "shred ~/.f{a*,x}ilproofai/policies-config.json"],
      // Deeper than any expansion budget. Running out of budget must collapse
      // what is left to `*` — a superset — rather than hand a still-braced word
      // to a compiler that escapes braces as literals.
      ["17 levels, one round past the old cap", `rm -rf ~/.f${"{x,".repeat(17)}a*${"}".repeat(17)}ilproofai`],
      ["200 levels", `rm -rf ~/.f${"{x,".repeat(200)}a*${"}".repeat(200)}ilproofai`],
      ["200 levels, beneath the directory", `rm -rf ~/.f${"{x,".repeat(200)}a*${"}".repeat(200)}ilproofai/policies`],
      ["200 levels, no glob in the branch", `rm -rf ~/.f${"{x,".repeat(200)}ai${"}".repeat(200)}lproofai`],
      // POSIX negates a bracket expression with `!`; JavaScript spells it `^`,
      // and reads `[!b]` as "either `!` or `b`". Copying the shell's text into
      // a regex read the pattern backwards, one character wide.
      ["POSIX negation", "rm -rf ~/.f[!b]ilproofai"],
      ["caret negation", "rm -rf ~/.f[^b]ilproofai"],
      ["a negated range", "rm -rf ~/.f[!0-9]ilproofai"],
      ["a negated class beneath the directory", "rm -rf ~/.f[!b]ilproofai/policies"],
      ["a negated class above a state file", "shred ~/.f[!b]ilproofai/policies-config.json"],
      ["a POSIX character class", "rm -rf ~/.f[[:alpha:]]ilproofai"],
      // A `]` in the first position is content, not the terminator.
      ["a literal ] leading the class", "rm -rf ~/.f[]a]ilproofai"],
      ["a literal ] after the negation", "rm -rf ~/.f[!]b]ilproofai"],
      ["a negated class inside a brace", "rm -rf ~/.f{[!b],x}ilproofai"],
      ["a negated class 30 braces deep", `rm -rf ~/.f${"{x,".repeat(30)}[!b]${"}".repeat(30)}ilproofai`],
      // An unclosed `[` is a literal `[` to the shell. Bailing out would answer
      // "names nothing" off a malformed pattern.
      ["an unclosed bracket beside the literal", "rm -rf ~/.failproofai[x"],
      // Bash extended globs. Three of the five operators begin with a character
      // that means nothing on its own, so `@(`, `+(` and `!(` were not even
      // recognised as making the token a pattern.
      ["an extglob group", "rm -rf ~/.f@(ailproofai)"],
      ["an extglob through bash -O extglob -c", "bash -O extglob -c 'rm -rf ~/.f@(ailproofai)'"],
      ["an extglob with alternatives", "rm -rf ~/.f@(ailproofai|other)"],
      ["an optional group", "rm -rf ~/.f?(a)ilproofai"],
      ["a starred group", "rm -rf ~/.f*(a)ilproofai"],
      ["a plussed group", "rm -rf ~/.f+(a)ilproofai"],
      ["a nested extglob", "rm -rf ~/.f@(@(a)ilproofai)"],
      ["a star inside an extglob", "rm -rf ~/.f@(a*)ilproofai"],
      ["a negated class inside an extglob", "rm -rf ~/.f@([!b])ilproofai"],
      ["an extglob wrapping the whole name", "rm -rf ~/@(.failproofai)"],
      ["an extglob beneath the directory", "rm -rf ~/.f@(ailproofai)/policies"],
      ["an extglob above a state file", "shred ~/.f@(ailproofai)/policies-config.json"],
      ["an extglob inside a brace", "rm -rf ~/.f{@(a),x}ilproofai"],
    ])("denies %s", async (_label, command) => {
      expect(await decide(command)).toBe("deny");
    });

    // The other half of the same fix, and the reason the floor existed. A
    // pattern that also sweeps up `node_modules` or `~/.config` is not aimed at
    // the state, and an always-on guard that denied `rm -rf *` would be
    // switched off by the first person who met it.
    it.each([
      ["a bare star", "rm -rf *"],
      ["every dotfile in home", "rm -rf ~/.*"],
      ["a directory that merely carries the word", "rm -rf /tmp/test-failures*"],
      ["a build directory", "rm -rf dist/*"],
      ["a search that names no path", "find . -name '*.fail*' -type f"],
      ["a read through a glob", "grep -r x ~/.fail*"],
      ["ordinary brace expansion", "rm -rf {dist,build}/*"],
      ["braces over unrelated dotfiles", "rm -rf ~/.{cache,config}/*"],
      ["braces naming nothing near the state", "rm -rf {a,b}{c,d}"],
      ["deep braces over an unrelated path", `rm -rf /tmp/${"{x,".repeat(40)}a*${"}".repeat(40)}build`],
      ["a negated class over an unrelated dotfile", "rm -rf ~/.[!x]onfig"],
      ["a negated class on an unrelated path", "rm -rf /tmp/[!a]uild"],
      ["a read through a negated class", "cat ~/.f[!b]ilproofai/policies-config.json"],
      ["an extglob elsewhere", "rm -rf /tmp/@(build|dist)"],
      ["a negated extglob sweeping home", "rm -rf ~/.!(config)"],
      ["a read through an extglob", "cat ~/.f@(ailproofai)/policies-config.json"],
      ["an unterminated group", "rm -rf /tmp/@(build"],
    ])("allows %s", async (_label, command) => {
      expect(await decide(command)).not.toBe("deny");
    });
  });

  // Brace expansion multiplies, so it is bounded rather than trusted. Past the
  // bound every group collapses to `*`, which reaches at least as far as the
  // braces could — an oversized token stays decidable instead of becoming a
  // way to stall the hook path.
  it("answers a brace bomb quickly instead of expanding it", async () => {
    const started = Date.now();
    expect(await decide(`rm -rf ${"{a,b}".repeat(20)}`)).toBe("allow");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  describe("the guard's own standing", () => {
    // If this ever stops being alwaysOn, every case above becomes optional and
    // the first thing an agent does is switch it off. The flag is the reason
    // the rest of this file matters.
    it("cannot be switched off", () => {
      expect(policy.alwaysOn).toBe(true);
      expect(policy.defaultEnabled).toBe(true);
    });

    // The state branch and the CLI branch have different remedies, so a denial
    // that names the wrong one sends the operator to the wrong place.
    it("explains that the state is what was protected", async () => {
      expect(await reason("find ~/.failproofai -delete")).toMatch(/switch enforcement off/);
      expect(await reason("failproofai config --pause")).toMatch(/human action/);
    });
  });
});
