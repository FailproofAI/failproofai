// @vitest-environment node
/**
 * The four hard-floor builtins (src/hooks/floor-policies.ts): deterministic
 * guards for the commands the Jev semantic evaluator is measured to miss.
 *
 * Each table pairs positives with NEAR MISSES — the same words in a position
 * that does not run them (a commit message, a grep pattern, a quoted heredoc),
 * or the harmless form of the same tool (`dd` into a file, `chmod 755`,
 * `gh release view`). The near misses are what keep a hard policy,
 * which no reviewer can clear, from blocking real work. Several come straight
 * from the false-positive sweep over real transcripts.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { BUILTIN_POLICIES, registerBuiltinPolicies } from "../../src/hooks/builtin-policies";
import { POLICY_CATALOG } from "../../src/hooks/policy-catalog";
import { clearPolicies, getAllPolicies } from "../../src/hooks/policy-registry";
import { effectiveAuthority, type PolicyContext } from "../../src/hooks/policy-types";
import { worldWritableMode } from "../../src/hooks/floor-policies";

const FLOOR = [
  "block-disk-destruction",
  "block-gh-destructive",
  "block-indirect-exec",
  "block-chmod-777",
] as const;

const policy = (name: (typeof FLOOR)[number]) => BUILTIN_POLICIES.find((p) => p.name === name)!;

function bash(command: unknown, cwd?: string): PolicyContext {
  return {
    eventType: "PreToolUse",
    payload: {},
    toolName: "Bash",
    toolInput: { command },
    session: cwd ? { cwd } : undefined,
  } as PolicyContext;
}

async function decide(name: (typeof FLOOR)[number], command: unknown, cwd?: string) {
  return (await policy(name).fn(bash(command, cwd))).decision;
}

describe("catalog entries", () => {
  it.each(FLOOR)("%s is a hard, opt-in PreToolUse Bash guard", (name) => {
    const entry = POLICY_CATALOG.find((e) => e.name === name)!;
    expect(entry).toBeDefined();
    expect(entry.defaultEnabled).toBe(false);
    expect(entry.authority).toBe("hard");
    expect(entry.reviewedBy).toBeUndefined();
    expect(effectiveAuthority(entry)).toBe("hard");
    expect(entry.match).toEqual({ events: ["PreToolUse"], toolNames: ["Bash"] });
    expect("alwaysOn" in entry).toBe(false);
    expect("params" in entry).toBe(false);
    expect(entry.displayTitle).toMatch(/^Tried to /);
    expect(entry.impact?.length).toBeGreaterThan(10);
    expect(entry.description.length).toBeGreaterThan(10);
  });

  it("files every floor policy under an existing category", () => {
    const existing = new Set(
      POLICY_CATALOG.filter((e) => !(FLOOR as readonly string[]).includes(e.name)).map((e) => e.category),
    );
    for (const name of FLOOR) expect(existing.has(POLICY_CATALOG.find((e) => e.name === name)!.category)).toBe(true);
  });

  it("appends the floor after every existing policy, so first-deny attribution is unchanged", () => {
    const names = POLICY_CATALOG.map((e) => e.name);
    expect(names.slice(-FLOOR.length)).toEqual([...FLOOR]);
  });

  it("gives each one its own implementation", () => {
    const fns = FLOOR.map((n) => policy(n).fn);
    expect(new Set(fns).size).toBe(FLOOR.length);
    for (const fn of fns) expect(typeof fn).toBe("function");
  });

  describe("registration", () => {
    beforeEach(() => clearPolicies());

    it("registers only when enabled", () => {
      registerBuiltinPolicies([]);
      expect(getAllPolicies().map((p) => p.name)).toEqual(["failproofai/block-failproofai-commands"]);
      clearPolicies();
      registerBuiltinPolicies([...FLOOR]);
      expect(getAllPolicies().map((p) => p.name)).toEqual([
        "failproofai/block-failproofai-commands",
        ...FLOOR.map((n) => `failproofai/${n}`),
      ]);
      clearPolicies();
    });
  });
});

describe("common behaviour", () => {
  it.each(FLOOR)("%s allows other tools and empty commands", async (name) => {
    expect((await policy(name).fn({ eventType: "PreToolUse", payload: {}, toolName: "Write", toolInput: { file_path: "x", content: "chmod 777 /" } } as PolicyContext)).decision).toBe("allow");
    expect(await decide(name, "")).toBe("allow");
    expect(await decide(name, undefined)).toBe("allow");
    expect(await decide(name, { not: "a string" })).toBe("allow");
  });

  it("reads an argv array (Codex exec) as the command it runs", async () => {
    expect(await decide("block-disk-destruction", ["bash", "-lc", "mkfs.ext4 /dev/sdb1"])).toBe("deny");
    expect(await decide("block-disk-destruction", ["ls", "-la"])).toBe("allow");
  });

  it("does not serve a cached analysis for a different command", async () => {
    expect(await decide("block-chmod-777", "chmod 777 a")).toBe("deny");
    expect(await decide("block-chmod-777", "chmod 755 a")).toBe("allow");
    expect(await decide("block-chmod-777", "chmod 777 a")).toBe("deny");
  });
});

describe("block-disk-destruction", () => {
  it.each([
    "dd if=/dev/zero of=/dev/sda bs=1M",
    "sudo dd if=image.iso of=/dev/disk4 bs=4m status=progress",
    "dd if=/dev/urandom of=/dev/nvme0n1",
    "dd if=/dev/zero of=//dev/../dev/sdb",
    "dd of=$DISK if=/dev/zero",
    "D=/dev/sda; dd if=/dev/zero of=$D",
    "mkfs.ext4 /dev/sdb1",
    "mkfs -t ext4 /dev/nvme0n1p1",
    "mkfs.ext4 -F -L data $DEV",
    "mke2fs /dev/sdc",
    "mkswap /dev/sdd2",
    "wipefs -a /dev/sdc",
    "blkdiscard -f /dev/nvme0n1p3",
    "shred -n 3 /dev/sde",
    "cat /dev/urandom > /dev/sdb",
    ": > /dev/sdb1",
    "echo x | sudo tee /dev/sda",
    "cp disk.img /dev/sdf",
    "bash -c 'mkfs.xfs /dev/sdd'",
    "cd /dev && mkfs.ext4 sda1",
    "diskutil eraseDisk JHFS+ Untitled disk2",
    "diskutil zeroDisk disk3",
    "pwsh -Command Clear-Disk -Number 1 -RemoveData",
    "cmd /c format D: /q",
    "echo x > /dev/sd$N",
  ])("denies %s", async (command) => {
    expect(await decide("block-disk-destruction", command)).toBe("deny");
  });

  it.each([
    "dd if=/dev/zero of=./disk.img bs=1M count=10",
    "dd if=/dev/sda of=backup.img",
    "dd if=x of=/dev/null",
    "dd if=/dev/zero of=\"$HOME/swap.img\" bs=1M count=64",
    "mkfs.ext4 -F rootfs.img",
    "mkswap /swapfile",
    "wipefs --help",
    "shred -u secrets.txt",
    "echo hi > /dev/null 2>&1",
    "cmd >/dev/stderr; cmd 2>/dev/tty",
    "echo x | tee /dev/stderr",
    "exec 3<>/dev/tcp/$HOST/5432",
    "cat < /dev/tcp/$PG_IP/5432",
    "grep mkfs notes.md",
    "echo 'dd of=/dev/sda'",
    "man mkfs.ext4",
    "cp /dev/sda.backup ./restore",
    "diskutil list",
    "lsblk -f /dev/sda",
    "cat > notes.md <<'EOF'\nnever run dd of=/dev/sda or wipefs -a /dev/sdb\nEOF",
    "git commit -m 'document: mkfs.ext4 /dev/sdb1 is forbidden'",
  ])("allows %s", async (command) => {
    expect(await decide("block-disk-destruction", command)).toBe("allow");
  });

  it("treats a relative operand as a device when the session cwd is /dev", async () => {
    expect(await decide("block-disk-destruction", "mkfs.ext4 sda1", "/dev")).toBe("deny");
    expect(await decide("block-disk-destruction", "mkfs.ext4 sda1", "/home/u/project")).toBe("allow");
  });

  it("names what it blocked", async () => {
    const r = await policy("block-disk-destruction").fn(bash("sudo dd if=x of=/dev/sdb"));
    expect(r.reason).toContain("dd of=/dev/sdb");
  });
});

describe("block-gh-destructive", () => {
  it.each([
    "gh release delete v1.2.3 --yes",
    "gh release delete v1.0.0 --repo o/r --cleanup-tag --yes 2>&1 | tail -3",
    "gh release delete-asset v1 app.zip",
    "gh repo delete o/r --yes",
    "gh issue delete 42 --yes",
    "gh run delete 123",
    "gh secret delete TOKEN",
    "gh variable remove FOO",
    "gh cache delete --all",
    "gh label delete bug --yes",
    "gh gist delete abc",
    "gh ssh-key delete 1",
    "gh cs delete -c name",
    "gh project item-delete 1 --id x",
    "gh repo deploy-key delete 7",
    "gh -R o/r release delete v2",
    "gh api -X DELETE repos/o/r/git/refs/heads/x",
    "gh api --method DELETE /repos/o/r/branches/main/protection",
    "gh api --method=delete /repos/o/r",
    "gh api -XDELETE /repos/o/r/releases/1",
    "gh api -X $METHOD /repos/o/r",
    "gh api graphql -f query='mutation { deleteRef(input:{refId:\"x\"}) { clientMutationId } }'",
    "echo cleanup && gh release delete old --yes",
  ])("denies %s", async (command) => {
    expect(await decide("block-gh-destructive", command)).toBe("deny");
  });

  it.each([
    "gh release view v1",
    "gh release list --repo o/r",
    "gh release create v1 --notes x",
    "gh api repos/o/r/pulls",
    "gh api -X POST repos/o/r/issues -f title=delete",
    "gh api -X PATCH repos/o/r -f name=delete-me",
    "gh api graphql -f query='query { viewer { login } }'",
    "gh pr close 12 --comment 'please delete the branch'",
    "gh issue close 3",
    "gh extension remove owner/gh-ext",
    "gh alias delete co",
    "gh release delete --help",
    "echo gh release delete v1",
    "git commit -m 'gh repo delete is blocked now'",
  ])("allows %s", async (command) => {
    expect(await decide("block-gh-destructive", command)).toBe("allow");
  });
});

describe("block-indirect-exec", () => {
  it.each([
    "R=/bin/rm; $R -rf /tmp/x",
    "R=/usr/bin/rm; O='-r'; F='-f'; $R $O $F /home/u/.state",
    "X=/sbin/mkfs.ext4; ${X} /dev/sda",
    "export D=dd; $D if=/dev/zero of=x",
    "$(which rm) -rf build",
    "`which rm` -rf build",
    "$(find /bin -name rm) -rf /",
    "/bin/r? -rf /",
    "/???/r[m] -rf /",
    "{rm,-rf,/tmp/x}",
    "$'\\x72\\x6d' -rf /",
    "for c in rm; do $c -rf /; done",
    "eval \"$R -rf /\"; R=rm",
    "${X:-rm} -rf /",
    "a=r; b=m; $a$b -rf /",
    "sudo $(which dd) if=/dev/zero of=/dev/sda",
    "find . -exec $R {} + ; R=rm",
    "$UNKNOWN -rf /",
    "\"$CMD\" --no-preserve-root /",
    "$TOOL if=/dev/zero of=/dev/sda",
    "$(printf '\\x72\\x6d') -rf x",
    "$(echo -e '\\x72\\x6d') x",
    "$(printf %b '\\x64\\x64') if=x",
  ])("denies %s", async (command) => {
    expect(await decide("block-indirect-exec", command)).toBe("deny");
  });

  it.each([
    "rm -rf build",
    "\\rm -f file",
    "command rm -rf build",
    "$PYTHON -m pytest",
    "\"$(npm bin)/eslint\" .",
    "${CC:-gcc} -o x x.c",
    "$KUBECTL apply -R -f manifests/",
    "$EDITOR notes.md",
    "\"$VIRTUAL_ENV/bin/python\" -m pip install -r requirements.txt",
    "$(which python3) script.py",
    "for t in build test; do npm run $t; done",
    "./scripts/run-*.sh",
    "[ -f x ] && echo ok",
    // From the real-transcript sweep: case patterns are not commands.
    "for f in $(find . -name '*.py'); do case \"$f\" in ./a/*|./b/*) continue;; esac; cat \"$f\"; done",
    "echo 'R=/bin/rm; $R -rf /'",
  ])("allows %s", async (command) => {
    expect(await decide("block-indirect-exec", command)).toBe("allow");
  });

  it("denies a command nested past what it can check", async () => {
    const deep = "echo " + "$(echo ".repeat(12) + "x" + ")".repeat(12);
    const r = await policy("block-indirect-exec").fn(bash(deep));
    expect(r.decision).toBe("deny");
    expect(r.reason).toMatch(/too deeply/);
  });
});

describe("block-chmod-777", () => {
  it.each([
    "chmod 777 script.sh",
    "chmod -R 777 /var/www",
    "chmod --recursive 0777 dir",
    "chmod 666 file",
    "chmod 2777 shared",
    "chmod 1777 /tmp/shared",
    "chmod a+rwx file",
    "chmod ugo+rwx file",
    "chmod o+w file",
    "chmod go+w file",
    "chmod u+x,o+w file",
    "chmod a=rwx file",
    "chmod o=u file",
    "sudo chmod 777 /etc/x",
    "find . -type d -exec chmod 777 {} +",
    "xargs chmod 777 < files.txt",
    "M=777; chmod $M dir",
    "mkdir -m 777 shared",
    "mkdir -pm 777 shared",
    "mkdir --mode=0777 shared",
    "install -m 666 a /usr/local/share/a",
    "icacls C:\\data /grant Everyone:F",
    // Unquoted parens are bash syntax, so a Bash tool call quotes the grant.
    "icacls 'C:\\data' /grant 'Everyone:(OI)(CI)(M)'",
  ])("denies %s", async (command) => {
    expect(await decide("block-chmod-777", command)).toBe("deny");
  });

  it.each([
    "chmod 755 script.sh",
    "chmod 775 dir",
    "chmod 644 file",
    "chmod +x script.sh",
    "chmod u+w file",
    "chmod -w file",
    "chmod a-w file",
    "chmod o-rwx file",
    "chmod +t dir",
    "chmod --reference=a b",
    "chmod -R 644 /tmp/share",
    "mkdir -p -m 755 out",
    "echo chmod 777",
    "grep -rn 'chmod 777' docs/",
    "git commit -m 'never chmod 777'",
    "icacls C:\\data /grant Everyone:R",
    "icacls C:\\data /grant Admins:F",
  ])("allows %s", async (command) => {
    expect(await decide("block-chmod-777", command)).toBe("allow");
  });

  it.each([
    ["777", true], ["0777", true], ["666", true], ["7", true], ["2777", true],
    ["1777", true], ["755", false], ["775", false], ["0644", false],
    ["a+w", true], ["o+rw", true], ["+w", false], ["u+rwx", false], ["o+wt", true],
  ] as const)("worldWritableMode(%s) is %s", (mode, expected) => {
    expect(worldWritableMode(mode)).toBe(expected);
  });
});
