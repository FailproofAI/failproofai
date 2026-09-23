// @vitest-environment node
/**
 * Review round 1 of the hard-floor builtins: each block pins a bypass or a
 * fail-open that a reviewer demonstrated, next to the near miss that must keep
 * passing. A hard floor that can be walked around, or that lets a command
 * through because it could not read it, is not a floor.
 */
import { describe, it, expect } from "vitest";
import { BUILTIN_POLICIES } from "../../src/hooks/builtin-policies";
import { worldWritableMode } from "../../src/hooks/floor-policies";
import type { PolicyContext } from "../../src/hooks/policy-types";

const FLOOR = [
  "block-disk-destruction",
  "block-gh-destructive",
  "block-mass-kill",
  "block-no-verify",
  "block-indirect-exec",
  "block-chmod-777",
] as const;
type Floor = (typeof FLOOR)[number];

const policy = (name: Floor) => BUILTIN_POLICIES.find((p) => p.name === name)!;

function bash(command: unknown, cwd?: string): PolicyContext {
  return {
    eventType: "PreToolUse",
    payload: {},
    toolName: "Bash",
    toolInput: { command },
    session: cwd ? { cwd } : undefined,
  } as PolicyContext;
}

async function decide(name: Floor, command: string, cwd?: string) {
  return (await policy(name).fn(bash(command, cwd))).decision;
}

/** Wrap a command in `levels` nested `bash -c '…'`. */
function nestBashC(levels: number, inner: string): string {
  let s = inner;
  for (let i = 0; i < levels; i++) s = `bash -c '${s.replace(/'/g, `'\\''`)}'`;
  return s;
}

/** Wrap a command in `levels` nested `eval '…'`. */
function nestEval(levels: number, inner: string): string {
  let s = inner;
  for (let i = 0; i < levels; i++) s = `eval '${s.replace(/'/g, `'\\''`)}'`;
  return s;
}

/** One positive per policy, and a harmless command. */
const POSITIVE: Record<Floor, string> = {
  "block-disk-destruction": "dd if=/dev/zero of=/dev/sda",
  "block-gh-destructive": "gh release delete v1 --yes",
  "block-mass-kill": "killall node",
  "block-no-verify": "git commit --no-verify -m x",
  "block-indirect-exec": "R=/bin/rm; $R -rf /tmp/x",
  "block-chmod-777": "chmod 777 /etc/passwd",
};
const HARMLESS = "echo hi";

describe("a command the analyser cannot read to the end is denied by EVERY floor policy", () => {
  it.each(FLOOR)("%s denies 7 nested `bash -c` around a harmless command, and allows 6", async (name) => {
    expect(await decide(name, nestBashC(6, HARMLESS))).toBe("allow");
    const r = await policy(name).fn(bash(nestBashC(7, HARMLESS)));
    expect(r.decision).toBe("deny");
    expect(r.reason).toMatch(/too deeply/);
  });

  it.each(FLOOR)("%s denies 8 nested `eval`", async (name) => {
    expect(await decide(name, nestEval(8, HARMLESS))).toBe("deny");
  });

  it.each(FLOOR)("%s denies seven nested `$( … )`", async (name) => {
    let s = "echo x";
    for (let i = 0; i < 7; i++) s = `echo $(${s})`;
    expect(await decide(name, s)).toBe("deny");
  });

  it("still names the real hit when one is visible inside the nesting it can read", async () => {
    const r = await policy("block-disk-destruction").fn(bash(nestBashC(6, POSITIVE["block-disk-destruction"])));
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("dd of=/dev/sda");
  });

  it("the 7-deep `bash -c` disk wipe is denied by block-disk-destruction alone", async () => {
    expect(await decide("block-disk-destruction", nestBashC(7, "mkfs.ext4 /dev/sda"))).toBe("deny");
  });
});

describe("a floor policy that throws denies instead of failing open", () => {
  it.each(FLOOR)("%s", async (name) => {
    const input = Object.defineProperty({}, "command", { get() { throw new Error("boom"); }, enumerable: true });
    const ctx = { eventType: "PreToolUse", payload: {}, toolName: "Bash", toolInput: input } as PolicyContext;
    const r = await policy(name).fn(ctx);
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain(name);
  });
});

describe("prototype-chain program names", () => {
  it.each(["constructor", "__proto__", "hasOwnProperty", "toString", "valueOf", "isPrototypeOf"])(
    "`%s -x; …` does not blind the policies",
    async (proto) => {
      for (const name of FLOOR) {
        expect(await decide(name, `${proto} -x; ${POSITIVE[name]}`)).toBe("deny");
        expect(await decide(name, `${proto} -x; ${HARMLESS}`)).toBe("allow");
      }
    },
  );

  it("a gh noun named after an Object property is not an alias", async () => {
    expect(await decide("block-gh-destructive", "gh constructor delete x")).toBe("allow");
    expect(await decide("block-gh-destructive", "gh constructor delete x; gh release delete v1")).toBe("deny");
  });
});

describe("block-disk-destruction: bare diskutil", () => {
  it.each(["diskutil; dd if=/dev/zero of=/dev/sda", "diskutil -q; dd if=/dev/zero of=/dev/disk0"])("denies %s", async (c) => {
    expect(await decide("block-disk-destruction", c)).toBe("deny");
  });

  it.each(["diskutil", "diskutil -q", "diskutil list", "diskutil apfs list"])("allows %s", async (c) => {
    expect(await decide("block-disk-destruction", c)).toBe("allow");
  });

  it.each([
    "diskutil apfs deleteContainer disk3",
    "diskutil apfs deleteVolume disk3s2",
    "diskutil deleteVolume disk3s1",
    "diskutil eraseVolume APFS x disk4",
  ])("denies %s", async (c) => {
    expect(await decide("block-disk-destruction", c)).toBe("deny");
  });
});

describe("exec and privilege wrappers are followed", () => {
  it.each([
    ["block-disk-destruction", "pkexec dd if=/dev/zero of=/dev/sda"],
    ["block-disk-destruction", "pkexec --user root dd if=/dev/zero of=/dev/sda"],
    ["block-disk-destruction", "run0 mkfs.ext4 /dev/sdb1"],
    ["block-disk-destruction", "run0 -u root --setenv X=1 mkfs.ext4 /dev/sdb1"],
    ["block-disk-destruction", "su -c 'mkfs.ext4 /dev/sdb1'"],
    ["block-disk-destruction", "su root -c 'wipefs -a /dev/sdb'"],
    ["block-disk-destruction", "su - root -s /bin/bash --command='wipefs -a /dev/sdb'"],
    ["block-disk-destruction", "su -lc 'wipefs -a /dev/sdb' root"],
    ["block-disk-destruction", "runuser -u root -- dd if=/dev/zero of=/dev/sda"],
    ["block-disk-destruction", "runuser -u root dd if=/dev/zero of=/dev/sda"],
    ["block-disk-destruction", "runuser - root -c 'mkfs.ext4 /dev/sdb1'"],
    ["block-disk-destruction", "sg disk -c 'mkfs.ext4 /dev/sdb1'"],
    ["block-disk-destruction", "sg disk 'mkfs.ext4 /dev/sdb1'"],
    ["block-disk-destruction", "setpriv --reuid=0 --regid=0 --init-groups dd if=/dev/zero of=/dev/sda"],
    ["block-disk-destruction", "strace -f dd if=/dev/zero of=/dev/sda"],
    ["block-disk-destruction", "strace -fo trace.txt dd if=/dev/zero of=/dev/sda"],
    ["block-disk-destruction", "ltrace -o out.txt dd if=/dev/zero of=/dev/sda"],
    ["block-disk-destruction", "script -qc 'dd if=/dev/zero of=/dev/sda' /dev/null"],
    ["block-disk-destruction", "script -q -c 'dd if=/dev/zero of=/dev/sda' out.log"],
    // BSD/macOS: script [-q] FILE command …
    ["block-disk-destruction", "script -q /dev/null dd if=/dev/zero of=/dev/sda"],
    ["block-disk-destruction", "flock /tmp/lock dd if=/dev/zero of=/dev/sda"],
    ["block-disk-destruction", "flock -w 5 /tmp/lock -c 'dd if=/dev/zero of=/dev/sda'"],
    ["block-disk-destruction", "taskset 1 dd if=/dev/zero of=/dev/sda"],
    ["block-disk-destruction", "taskset -c 0-3 dd if=/dev/zero of=/dev/sda"],
    ["block-disk-destruction", "chrt -f 10 dd if=/dev/zero of=/dev/sda"],
    ["block-disk-destruction", "watch -n1 'dd if=/dev/zero of=/dev/sda'"],
    ["block-disk-destruction", "watch -n 1 dd if=/dev/zero of=/dev/sda"],
    ["block-disk-destruction", "systemd-run --wait mkfs.ext4 /dev/sdb1"],
    ["block-disk-destruction", "systemd-run -p User=root --uid 0 mkfs.ext4 /dev/sdb1"],
    ["block-disk-destruction", "unshare -r mkfs.ext4 /dev/sdb1"],
    ["block-disk-destruction", "nsenter -t 1 -m -u -i -n dd if=/dev/zero of=/dev/sda"],
    ["block-disk-destruction", "firejail --noprofile dd if=/dev/zero of=/dev/sda"],
    ["block-disk-destruction", "parallel mkfs.ext4 ::: /dev/sdb1 /dev/sdc1"],
    ["block-disk-destruction", "parallel -j2 'wipefs -a {}' ::: /dev/sdb"],
    ["block-disk-destruction", "sudo -iu root dd if=/dev/zero of=/dev/sda"],
    ["block-disk-destruction", "sudo -uroot dd if=/dev/zero of=/dev/sda"],
    ["block-disk-destruction", "timeout $T mkfs.ext4 /dev/sdb1"],
    ["block-disk-destruction", "env -S 'mkfs.ext4' /dev/sdb1"],
    ["block-disk-destruction", "env -iS 'mkfs.ext4 /dev/sdb1'"],
    ["block-no-verify", "strace -o /dev/null git commit --no-verify"],
    ["block-mass-kill", "pkexec killall node"],
    ["block-chmod-777", "su -c 'chmod -R 777 /srv'"],
    ["block-gh-destructive", "flock /tmp/l gh release delete v1 -y"],
  ] as Array<[Floor, string]>)("%s denies %s", async (name, command) => {
    expect(await decide(name, command)).toBe("deny");
  });

  // getopt reads a value bundled into its flag's word: `-c'cmd'` is `-ccmd`,
  // `-D/dev` is `-D /dev`. The session cwd keeps a bare `sda1` from counting
  // on its own, so the `-D/dev` row stands on the chdir being read.
  it.each([
    ["block-disk-destruction", "su -c'mkfs.ext4 /dev/sdb1'"],
    ["block-disk-destruction", "su -lc'wipefs -a /dev/sdb' root"],
    ["block-disk-destruction", "script -qc'dd if=/dev/zero of=/dev/sda' /dev/null"],
    ["block-disk-destruction", "flock -c'dd if=/dev/zero of=/dev/sda' /tmp/lock"],
    ["block-disk-destruction", "sg disk -c'mkfs.ext4 /dev/sdb1'"],
    ["block-disk-destruction", "sudo -D/dev mkfs.ext4 sda1"],
    ["block-disk-destruction", "env -C/dev dd if=/dev/zero of=sda"],
    ["block-chmod-777", "su -c'chmod -R 777 /srv'"],
    ["block-no-verify", "su -c'git commit --no-verify -m x'"],
  ] as Array<[Floor, string]>)("%s denies %s (a value attached to its flag)", async (name, command) => {
    expect(await decide(name, command, "/home/u/proj")).toBe("deny");
  });

  it.each(["sudo -D/srv mkfs.ext4 sda1", "su -c'mkfs.ext4 -F rootfs.img'"])(
    "block-disk-destruction allows %s (cwd /home/u/proj)",
    async (command) => {
      expect(await decide("block-disk-destruction", command, "/home/u/proj")).toBe("allow");
    },
  );

  it.each([
    "sudo -l dd",
    "taskset -p 1234",
    "taskset -pc 0 1234",
    "chrt -p 1234",
    "su root",
    "su - root",
    "script out.log",
    "flock /tmp/lock true",
    "watch -n 5 df -h",
    "strace -p 1234",
    "pkexec --version",
    "parallel echo ::: a b c",
    "systemd-run --user --wait make test",
  ])("allows %s", async (command) => {
    expect(await decide("block-disk-destruction", command)).toBe("allow");
  });
});

describe("variable resolution does not give up silently", () => {
  it.each([
    "A=rm; B=$A; A=$B; $B important.txt",
    'A=rm; B=$A; A=$B; cd "$A" 2>/dev/null; $B important.txt',
    "V1=rm; V2=$V1; V3=$V2; V4=$V3; V5=$V4; V6=$V5; V7=$V6; V8=$V7; $V8 important.txt",
    "V1=rm; V2=$V1; V3=$V2; V4=$V3; V5=$V4; V6=$V5; V7=$V6; V8=$V7; $V7 -r dir",
    // A binding added by a nested source after X was already resolved.
    "X=ls; cd $X; bash -c 'X=rm; $X important.txt'",
    // A head resolved before an `eval` binds what it reads.
    "f() { $X important.txt; }; eval X=rm; f",
  ])("block-indirect-exec denies %s", async (command) => {
    expect(await decide("block-indirect-exec", command)).toBe("deny");
  });

  it("names rm for a chain it follows, and calls one it cannot follow too deep", async () => {
    const chain = (n: number) =>
      Array.from({ length: n }, (_, i) => (i === 0 ? "V0=rm" : `V${i}=$V${i - 1}`)).join("; ") + `; $V${n - 1} important.txt`;
    const followed = await policy("block-indirect-exec").fn(bash(chain(8)));
    expect(followed.reason).toContain("runs rm");
    const deep = await policy("block-indirect-exec").fn(bash(chain(20)));
    expect(deep.decision).toBe("deny");
    expect(deep.reason).toMatch(/too deeply/);
  });

  it("a variable given more values than are kept cannot hide a later one in command position", async () => {
    const items = Array.from({ length: 300 }, (_, i) => `f${i}`).join(" ");
    expect(await decide("block-indirect-exec", `for c in ${items} rm; do $c x; done`)).toBe("deny");
    // …and as an ordinary argument it is not a command, so no deny.
    expect(await decide("block-indirect-exec", `for f in ${items}; do cat $f; done`)).toBe("allow");
    expect(await decide("block-disk-destruction", `for f in ${items}; do cat $f > out/$f; done`)).toBe("allow");
  });

  it.each(["P=R; R=ls; ${!P} x", "A=ls; B=$A; $B x", "for t in build test; do npm run $t; done"])(
    "still allows %s",
    async (command) => {
      expect(await decide("block-indirect-exec", command)).toBe("allow");
    },
  );
});

describe("block-disk-destruction: relative device paths", () => {
  const cwd = "/home/u/proj";
  it.each([
    "dd if=/dev/zero of=../../../../dev/sda bs=1M",
    "cd / && dd if=/dev/zero of=dev/sda bs=1M",
    "cat image.iso > ../../../../dev/sdb",
    "mkfs.ext4 ../../../../dev/sdb1",
    "cd ..; cd ..; cd ..; dd if=/dev/zero of=dev/sda",
    "pushd / && wipefs -a dev/sdb",
    "env -C / dd if=/dev/zero of=dev/sda",
    "sudo -D / dd if=/dev/zero of=dev/sda",
    "D=/; cd $D && mkfs.ext4 dev/sdb1",
    "cd /dev/disk/by-id && mkfs.ext4 ata-SAMSUNG_X",
    // An unresolvable `cd`: a disk tool's bare device name is not given the benefit of the doubt.
    'cd "$(some-cmd)" && mkfs.ext4 sda1',
    'cd "$TARGET" && dd if=/dev/zero of=nvme0n1',
  ])("denies %s (cwd /home/u/proj)", async (command) => {
    expect(await decide("block-disk-destruction", command, cwd)).toBe("deny");
  });

  it.each([
    "dd if=/dev/zero of=dev/sda",
    "dd if=/dev/zero of=../disk.img",
    "cd build && dd if=/dev/zero of=disk.img",
    'cd "$X" && mkfs.ext4 -F rootfs.img',
    'cd "$X" && dd if=/dev/zero of=disk.img bs=1M count=1',
    "cd / && ls dev/sda",
    "cd / && cat dev/null > /dev/null",
    "echo x > ../../dev/null",
  ])("allows %s (cwd /home/u/proj)", async (command) => {
    expect(await decide("block-disk-destruction", command, cwd)).toBe("allow");
  });

  // A `cd` the policy cannot place makes the cwd unknown: `~` (whose home?), or
  // a set of candidate directories grown past the 64 it tracks. In bash the
  // failed cds below leave the shell at /, so `cd dev` lands in /dev.
  it.each([
    "cd ~ && dd if=/dev/zero of=../../dev/sda",
    "cd ~/src && mkfs.ext4 sda1",
    "cd /; cd a; cd b; cd c; cd d; cd e; cd f; cd dev; mkfs.ext4 sda1",
    "cd /; cd a; cd b; cd c; cd d; cd e; cd f; cd dev; dd if=/dev/zero of=sda",
  ])("denies %s (cwd /home/u/proj): the directory it reaches is unknown", async (command) => {
    expect(await decide("block-disk-destruction", command, cwd)).toBe("deny");
  });

  it.each([
    "cd ~ && dd if=/dev/zero of=disk.img",
    "cd ~/build && mkfs.ext4 -F rootfs.img",
    "cd /; cd a; cd b; cd c; cd d; cd e; cd f; cd g; dd if=/dev/zero of=disk.img",
  ])("allows %s (cwd /home/u/proj)", async (command) => {
    expect(await decide("block-disk-destruction", command, cwd)).toBe("allow");
  });

  it("with no session cwd, a path that can reach /dev from anywhere counts", async () => {
    expect(await decide("block-disk-destruction", "dd if=/dev/zero of=../../dev/sda")).toBe("deny");
    expect(await decide("block-disk-destruction", "dd if=/dev/zero of=dev/sda")).toBe("deny");
    expect(await decide("block-disk-destruction", "mkfs.ext4 sdb1")).toBe("deny");
    expect(await decide("block-disk-destruction", "mkfs.ext4 -F rootfs.img")).toBe("allow");
  });

  it("stays fast on thousands of relative cds", async () => {
    const cds = Array.from({ length: 2000 }, (_, i) => `cd d${i}`).join("; ");
    const t = performance.now();
    expect(await decide("block-disk-destruction", `${cds}; dd if=/dev/zero of=disk.img`, cwd)).toBe("allow");
    expect(performance.now() - t).toBeLessThan(1500);
  });
});

describe("block-gh-destructive: gh api flags as pflag parses them", () => {
  it.each([
    "gh api -X=DELETE repos/o/r/releases/1",
    "gh api -iX DELETE repos/o/r/releases/1",
    "gh api -iXDELETE repos/o/r/releases/1",
    "gh api -iX=DELETE repos/o/r/releases/1",
    "gh api --method DELETE repos/o/r/releases/1",
    "gh api -if query='mutation { deleteRef(input:{refId:\"x\"}) { clientMutationId } }' graphql",
    "gh api graphql --raw-field=query='mutation { deleteIssue(input:{}) { x } }'",
    "gh --hostname ghe.example.com release delete v1",
    "gh project field-delete --id x",
  ])("denies %s", async (command) => {
    expect(await decide("block-gh-destructive", command)).toBe("deny");
  });

  it.each([
    "gh api -X=GET repos/o/r",
    "gh api -iX GET repos/o/r",
    "gh api -iXPOST repos/o/r/issues -f title=delete",
    "gh api --jq '.[] | select(.m == \"-X DELETE\")' repos/o/r",
    "gh api -H 'X-Delete: 1' repos/o/r",
    "gh api graphql -f query='query { deleteMe: viewer { login } }'",
  ])("allows %s", async (command) => {
    expect(await decide("block-gh-destructive", command)).toBe("allow");
  });
});

describe("block-chmod-777: world-writable in every spelling", () => {
  it.each([
    "chmod 00777 secrets.txt",
    "chmod 000777 secrets.txt",
    "chmod 1777 secrets.txt",
    "chmod 1777 deploy.sh",
    "chmod -R 1777 /var/www",
    "chmod o+wt secrets.txt",
    "chmod a+rwxt file",
    "chmod ugo+rwxt -R /srv/app",
    "install -m 1777 a /usr/local/bin/a",
    "icacls C:\\data /grant *S-1-1-0:F",
    "icacls C:\\data /grant '*S-1-1-0:(OI)(CI)(M)'",
  ])("denies %s", async (command) => {
    expect(await decide("block-chmod-777", command)).toBe("deny");
  });

  it.each([
    "mkdir -m 1777 /tmp/shared",
    "mkdir -pm 1777 /srv/drop",
    "install -d -m 1777 /srv/drop",
    "chmod +t dir",
    "chmod 00644 file",
    "chmod 0755 file",
    "icacls C:\\data /grant *S-1-1-0:R",
  ])("allows %s", async (command) => {
    expect(await decide("block-chmod-777", command)).toBe("allow");
  });

  it.each([
    ["00777", false, true], ["1777", false, true], ["1777", true, false], ["o+wt", false, true],
    ["o+wt", true, false], ["a+rwxt", true, false], ["o+w", true, true], ["0644", false, false],
  ] as const)("worldWritableMode(%s, directory=%s) is %s", (mode, directory, expected) => {
    expect(worldWritableMode(mode, directory)).toBe(expected);
  });
});

describe("block-no-verify: a core.hooksPath a commit brings with it", () => {
  it.each([
    "git -c core.hooksPath=/dev/null commit -m x",
    "git -c core.hooksPath= commit -m x",
    "git -c core.hooksPath=NUL push origin x",
    "git --config-env=core.hooksPath=EMPTY commit -m x",
    "git config core.hooksPath NUL",
    "GIT_CONFIG_PARAMETERS=\"'core.hooksPath'='/dev/null'\" git commit -m x",
    "declare -x HUSKY=0; git commit -m x",
    "git pull --no-verify",
    "git am --no-verify fix.patch",
    "git cherry-pick --no-verify abc123",
    "git revert --no-verify abc123",
    // ROUND 7 REVERSAL: the VALUE of a `core.hooksPath` a commit or a push
    // brings with it is no longer read. Pointing it at ANY directory that does
    // not hold the repo's hooks is the standard one-command skip — checked
    // against git 2.43 in a throwaway HOME: a repo whose `pre-commit` rejected
    // `git commit -m x` committed under `-c core.hooksPath=<empty dir>`. A
    // static read cannot tell an empty hooks directory from a populated one,
    // and the one spelling that was both readable and effective was the one
    // that passed. These four were pinned as allows.
    "git -c core.hooksPath=.husky commit -m x",
    "git -c core.hooksPath=.githooks push origin x",
    "git -c core.hooksPath=/tmp/nohooks commit -m x",
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=.husky git commit -m x",
  ])("denies %s", async (command) => {
    expect(await decide("block-no-verify", command)).toBe("deny");
  });

  it.each([
    // A PERSISTENT write is not a commit, and `git config core.hooksPath
    // .husky` is how hook managers install themselves.
    "git config core.hooksPath .husky",
    "git config --global core.hooksPath .githooks",
    "GIT_CONFIG_PARAMETERS=\"'user.name'='x'\" git commit -m x",
    "declare HUSKY=0; git commit -m x",
    "git show --no-verify",
  ])("allows %s", async (command) => {
    expect(await decide("block-no-verify", command)).toBe("allow");
  });
});

describe("block-no-verify: an inline alias it cannot read to the end", () => {
  /** Single-quote a string for the shell. */
  const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  /** `git -c alias.x='!<body>' x`: the alias runs its body in a shell. */
  const bangAlias = (body: string) => `git -c alias.x=${shq("!" + body)} x`;
  /** `inner` wrapped in `levels` inline `!` aliases, each defined on the git that runs the next. */
  const nestAlias = (levels: number, inner: string) => {
    let s = inner;
    for (let i = 0; i < levels; i++) s = `git -c alias.a${i}=${shq("!" + s)} a${i}`;
    return s;
  };

  // The alias body gets an analysis of its own; the command around it is
  // shallow, so only that inner analysis knows it gave up.
  it("denies an alias whose body nests `bash -c` too deeply to check", async () => {
    const r = await policy("block-no-verify").fn(bash(bangAlias(nestBashC(7, "git commit --no-verify -m x"))));
    expect(r.decision).toBe("deny");
    expect(r.reason).toMatch(/too deeply nested/);
  });

  it("denies inline aliases nested deeper than it expands", async () => {
    const r = await policy("block-no-verify").fn(bash(nestAlias(3, "git commit --no-verify -m x")));
    expect(r.decision).toBe("deny");
    expect(r.reason).toMatch(/too deeply nested/);
    expect(await decide("block-no-verify", nestAlias(2, "git commit --no-verify -m x"))).toBe("deny");
  });

  it.each([
    ["an alias body nesting `bash -c` six deep", bangAlias(nestBashC(6, "git commit -m x"))],
    ["two nested aliases around a plain commit", nestAlias(2, "git commit -m x")],
  ])("allows %s", async (_, command) => {
    expect(await decide("block-no-verify", command)).toBe("allow");
  });
});

describe("one policy's resolution does not decide another's verdict", () => {
  /** `A1=<first>; A2=$A1; …; A14=$A13`: two hops more than resolution follows. */
  const chain14 = (first: string) =>
    Array.from({ length: 14 }, (_, i) => (i === 0 ? `A1=${first}` : `A${i + 1}=$A${i}`)).join("; ");

  it("a chain too deep for block-disk-destruction to resolve leaves the other policies' verdicts alone", async () => {
    const cmd = `${chain14("notes.txt")}; echo hi > $A14`;
    for (const name of ["block-chmod-777", "block-gh-destructive"] as const) {
      expect(await decide(name, cmd + ` # ${name} alone`)).toBe("allow");
    }
    // Disk resolves the redirect target, cannot, and says so.
    const disk = await policy("block-disk-destruction").fn(bash(cmd));
    expect(disk.decision).toBe("deny");
    expect(disk.reason).toMatch(/too deeply/);
    // Every other policy reading the same cached analysis afterwards.
    for (const name of FLOOR) {
      if (name !== "block-disk-destruction") expect(await decide(name, cmd)).toBe("allow");
    }
    // And the next hook event carrying the same command gets the same verdicts.
    expect(await decide("block-disk-destruction", cmd)).toBe("deny");
    expect(await decide("block-chmod-777", cmd)).toBe("allow");
  });

  it("the policy that cannot resolve a word still denies after another policy gave up on the same word", async () => {
    // chmod reads $A14 as its mode and gives up; disk then reads the same
    // variable as a redirect target and must not be served chmod's give-up
    // as an ordinary unknown.
    const cmd = `${chain14("/dev/sda")}; chmod $A14 f > $A14`;
    expect(await decide("block-chmod-777", cmd)).toBe("deny");
    const disk = await policy("block-disk-destruction").fn(bash(cmd));
    expect(disk.decision).toBe("deny");
    expect(disk.reason).toMatch(/too deeply/);
  });

  it("a command the analysis itself could not finish stays denied by every policy, however often it is read", async () => {
    const cmd = nestBashC(7, HARMLESS);
    for (let round = 0; round < 2; round++) {
      for (const name of FLOOR) expect(await decide(name, cmd)).toBe("deny");
    }
  });
});

describe("branches with no other test", () => {
  it("block-mass-kill: a short unanchored pattern is broad, an exact one is not", async () => {
    expect(await decide("block-mass-kill", "pkill -f ab")).toBe("deny");
    expect(await decide("block-mass-kill", "pkill -x ab")).toBe("allow");
  });

  it("block-mass-kill: a kill fed by `ps -C <generic>`", async () => {
    expect(await decide("block-mass-kill", "kill $(ps -C node -o pid=)")).toBe("deny");
    expect(await decide("block-mass-kill", "kill $(ps -C myserver -o pid=)")).toBe("allow");
  });

  it("block-indirect-exec: a substitution that names rm without printing it statically", async () => {
    expect(await decide("block-indirect-exec", "$(cd /bin && echo rm) important.txt")).toBe("deny");
    expect(await decide("block-indirect-exec", "$(cd /bin && echo ls) important.txt")).toBe("allow");
  });

  it("block-disk-destruction: the command in a `${X:-$(…)}` default runs", async () => {
    expect(await decide("block-disk-destruction", "echo ${X:-$(mkfs.ext4 /dev/sda)}")).toBe("deny");
    expect(await decide("block-disk-destruction", "echo ${X:-$(echo /dev/sda)}")).toBe("allow");
  });
});

describe("cost stays bounded (a hook that times out lets the call through)", () => {
  const shells = "sh bash zsh dash ksh mksh ash fish yash pwsh powershell";
  const nestVar = (levels: number, inner: string, values: string) => {
    let s = inner;
    for (let i = 0; i < levels; i++) s = `$S -c '${s.replace(/'/g, `'\\''`)}'`;
    return `for S in ${values}; do :; done; ${s}`;
  };

  it("follows a variable bound to every shell once per level, not once per shell", async () => {
    // Every candidate shell reads the same -c string. Following each one
    // separately was 11^depth analyses: 1.2 KB held the hook 6-17 s and 4 GB.
    const { analyzeShell } = await import("../../src/hooks/shell-analysis");
    expect(analyzeShell(nestVar(4, HARMLESS, shells)).invocations.length).toBeLessThan(50);
    const four = Array(4).fill(nestVar(6, "dd if=/dev/zero of=/dev/sda", shells)).join("; ");
    const t = performance.now();
    expect(await decide("block-disk-destruction", four)).toBe("deny");
    expect(await decide("block-chmod-777", Array(4).fill(nestVar(6, HARMLESS, shells)).join("; "))).toBe("allow");
    expect(performance.now() - t).toBeLessThan(1500);
  });

  // 16 copies bind 400 runners to S, past the 256 values kept: the binding
  // overflow, not the budget, is what marks this one truncated.
  it("a command word read from a variable bound to 400 runners is denied, quickly (binding overflow)", async () => {
    const runners = "su sg script flock watch parallel env eval ssh sudo nice timeout xargs strace " + shells;
    const cmd = Array(16).fill(nestVar(6, HARMLESS, runners)).join("; ");
    const t = performance.now();
    for (const name of FLOOR) expect(await decide(name, cmd)).toBe("deny");
    expect(performance.now() - t).toBeLessThan(1500);
  });

  // GNU parallel analyses its template once, then once per argument. No
  // variable, one level of nesting, one runner hop: only the budget stops it.
  const parallelRuns = (invocations: number) =>
    `parallel '${"a; ".repeat(invocations)}' ::: ${Array.from({ length: 16 }, (_, i) => `x${i}`).join(" ")}`;

  it("a command that runs the analysis out of budget is denied by every floor policy, quickly", async () => {
    const cmd = parallelRuns(10_000);
    const t = performance.now();
    for (const name of FLOOR) {
      const r = await policy(name).fn(bash(cmd));
      expect(r.decision).toBe("deny");
      expect(r.reason).toMatch(/too deeply/);
    }
    expect(performance.now() - t).toBeLessThan(1500);
    // Half the work fits in the budget: the deny above is the budget's.
    for (const name of FLOOR) expect(await decide(name, parallelRuns(5_000))).toBe("allow");
  });

  it.each([
    ["a run of reserved words", "! ".repeat(20_000) + "true"],
    ["a run of `{`", "echo " + "{".repeat(60_000)],
    ["a command word of `[`", "/" + "[".repeat(50_000) + " x"],
    ["a GraphQL query of repeated `mutation`", "gh api graphql -f query='" + "mutation ".repeat(30_000) + "'"],
    ["thousands of `x | kill`", "ls | kill; ".repeat(20_000)],
    ["thousands of `kill $P`", "P=$(pgrep -f " + "x".repeat(500) + "); " + "kill $P; ".repeat(5_000)],
    ["a pkill pattern of repeated `.*`", "pkill -f '" + ".*".repeat(100_000) + "x'"],
  ])("stays linear on %s", async (_, command) => {
    const t = performance.now();
    for (const name of FLOOR) await decide(name, command);
    expect(performance.now() - t).toBeLessThan(1500);
  });
});

/**
 * Review round 2: the same failure in three policies — a word read with
 * `literalText` alone, so a value the analyser CAN resolve walks past a floor
 * no reviewer can clear. Each block pins the bypass, the near miss that must
 * stay allowed, and the unresolvable form that stays lenient.
 */
describe("block-no-verify: a flag or subcommand carried in a variable", () => {
  it.each([
    "F=--no-verify; git commit $F -m x",
    'F="--no-verify"; git commit -m x "$F"',
    "F=-n; git commit $F -m x",
    "C=commit; git $C --no-verify -m x",
    "P=push; git $P --no-verify",
    "git commit ${F:---no-verify} -m x",
    "git commit $(echo --no-verify) -m x",
    "P=/dev/null; git -c core.hooksPath=$P commit -m x",
    "H=core.hooksPath=/dev/null; git -c $H commit -m x",
    // A non-literal global option used to abandon the whole invocation.
    'git -c user.name="$NAME" commit --no-verify -m x',
    // ROUND 6 REVERSAL: a setting that could be `core.hooksPath=/dev/null`
    // fails CLOSED in front of a commit. The key is readable and it is the one
    // that turns hooks off; only its value is missing.
    "git -c core.hooksPath=$H commit -m x",
  ])("denies %s", async (command) => {
    expect(await decide("block-no-verify", command)).toBe("deny");
  });

  it.each([
    // Unresolvable: the command string does not say it skips hooks.
    "git commit $F -m x",
    "git commit -m x $FLAGS",
    "git $S -m x",
    // Resolvable, and not a skip: `-m` takes the next word, whichever way round.
    'M=--no-verify; git commit -m "$M"',
    "F=-m; git commit $F --no-verify",
    "D=--dry-run; git push $D origin main",
    "S=status; git $S",
    'git -c user.name="$NAME" commit -m x',
  ])("allows %s", async (command) => {
    expect(await decide("block-no-verify", command)).toBe("allow");
  });
});

describe("block-gh-destructive: a noun or verb carried in a variable", () => {
  it.each([
    "N=release; gh $N delete v1 -y",
    "A=delete; gh release $A v1",
    "N=cs; gh $N delete -c name",
    "V=item-delete; gh project $V 1 --id x",
    // Fail closed on an unresolved verb, the rule `gh api -X $METHOD` follows.
    "gh release $V v1",
    "gh $N delete v1",
  ])("denies %s", async (command) => {
    expect(await decide("block-gh-destructive", command)).toBe("deny");
  });

  it.each(["V=view; gh release $V v1", "gh release view $V", "gh $N view v1", "gh pr merge $N --squash", "gh $CMD"])(
    "allows %s",
    async (command) => {
      expect(await decide("block-gh-destructive", command)).toBe("allow");
    },
  );

  it("says which word it could not read", async () => {
    const r = await policy("block-gh-destructive").fn(bash("gh release $V v1"));
    expect(r.reason).toContain("<unresolved verb>");
  });
});

describe("block-mass-kill: a loop body is not a per-process filter", () => {
  // Round 6 deleted the per-process-filter exemption. It could not tell a real
  // filter from a no-op one — `[ -n "$p" ]` counted — so
  // `for p in $(pgrep node); do [ -n "$p" ] && kill $p; done` was a one-line
  // bypass, pinned as an allow. A kill fed by a process listing is now denied
  // whatever the loop around it does.
  it.each([
    "P=$(pgrep node); if true; then kill $P; fi",
    // The assignment sits in a command prefix the analysis does not carry.
    "if true; then P=$(pgrep node); kill $P; fi",
    "[ 1 = 1 ]; P=$(pgrep node); kill $P",
    "case x in y) ;; esac; P=$(pgrep node); kill $P",
    "for p in $(pgrep node); do if true; then kill $p; fi; done",
    'for p in $(pgrep node); do [ -n "$x" ] && kill $p; done',
    "grep -q x file; P=$(pgrep node); kill $P",
    // ROUND 6 REVERSALS: the loop body is no longer read, so the form that
    // really checks each process and the form that only looks as if it does
    // are both denied.
    'for p in $(pgrep node); do if [ -n "$p" ]; then kill $p; fi; done',
    "for p in $(pgrep -f node); do if grep -q myapp /proc/$p/cmdline; then kill $p; fi; done",
    'for p in $(pgrep -f node); do c=$(ps -o args= -p $p); case "$c" in *myapp*) kill $p;; esac; done',
  ])("denies %s", async (command) => {
    expect(await decide("block-mass-kill", command)).toBe("deny");
  });

  it.each([
    "P=$(cat server.pid); if true; then kill $P; fi",
    // The lister named one thing, which is the only exemption left.
    "for p in $(pgrep -f my-worker); do kill $p; done",
    "for p in $(ps -C my-daemon -o pid=); do kill $p; done",
  ])("allows %s", async (command) => {
    expect(await decide("block-mass-kill", command)).toBe("allow");
  });

  // ROUND 7 REVERSAL: which words the kill's PIDs travelled through is no
  // longer read at all, so a broad listing and a kill that names no target in
  // ONE command deny each other whether or not one feeds the other. The
  // `pgrep node` here really runs. This was pinned as an allow.
  it("denies a broad listing beside a kill that names no target", async () => {
    expect(await decide("block-mass-kill", "echo P=$(pgrep node); kill $P")).toBe("deny");
  });

  // Reading the source off the PID variable is per kill, so it must not rescan
  // the command each time.
  it("stays linear on a PID variable per kill", async () => {
    const cmd = Array.from(
      { length: 2000 },
      (_, i) => `P${i}=$(pgrep -f my-worker); [ -n "$P${i}" ] && kill $P${i}`,
    ).join("; ");
    const t = performance.now();
    expect(await decide("block-mass-kill", cmd)).toBe("allow");
    expect(performance.now() - t).toBeLessThan(1500);
  });
});

describe("block-disk-destruction: a dd operand assembled in a variable", () => {
  it.each(["T=of=/dev/sda; dd if=/dev/zero $T", "O=of=; dd if=/dev/zero ${O}/dev/sdb"])(
    "denies %s",
    async (command) => {
      expect(await decide("block-disk-destruction", command)).toBe("deny");
    },
  );

  it.each(["T=of=./disk.img; dd if=/dev/zero $T", "T=of=/dev/null; dd if=/dev/zero $T", "dd if=/dev/zero $T"])(
    "allows %s",
    async (command) => {
      expect(await decide("block-disk-destruction", command)).toBe("allow");
    },
  );
});

/**
 * Review round 3: three bypasses that are one rewrite away from a command the
 * floor already denies. Each block pins every spelling the reviewers found,
 * plus the whole class behind it, next to the ordinary commands that must keep
 * running.
 */
describe("block-no-verify: an inline alias runs under what the invocation around it set", () => {
  // Expanding an alias used to re-read the body on its own, so every setting on
  // the outer `git` was dropped — including the `-c alias.*` that names the next
  // alias, which is why the chain below ran a real `--no-verify` commit and why
  // the `depth` guard could never fire. Checked against git 2.43: each of these
  // really does reach the commit.
  it.each([
    // The chain itself, for both commit and push, at two and three levels.
    "git -c alias.b=a -c alias.a='commit --no-verify' b -m x",
    "git -c alias.b=a -c alias.a='commit -n' b -m x",
    "git -c alias.q=p -c alias.p='push --no-verify' q",
    "git -c alias.c=b -c alias.b=a -c alias.a='commit --no-verify' c -m x",
    // A `!` body shells out to git, which inherits the settings via GIT_CONFIG_PARAMETERS.
    "git -c alias.b=a -c alias.a='!git commit --no-verify' b -m x",
    // The rest of the same class: the other things the outer invocation imposes.
    "git -c core.hooksPath=/dev/null -c alias.a=commit a -m x",
    "git --config-env=core.hooksPath=H -c alias.a=commit a -m x",
    "HUSKY=0 git -c alias.a=commit a -m x",
    "export HUSKY=0; git -c alias.a=commit a -m x",
    // git takes the LAST definition of a name; reading only the first hid this one.
    "git -c alias.a=status -c alias.a='commit --no-verify' a -m x",
  ])("denies %s", async (command) => {
    expect(await decide("block-no-verify", command)).toBe("deny");
  });

  it.each([
    "git -c alias.st=status st",
    "git -c alias.lg='log --oneline -20' lg",
    "git -c alias.b=st -c alias.st=status b",
    "git -c alias.ci='commit -s' ci -m x",
    "git -c alias.p='!git push origin HEAD' p",
    "HUSKY=1 git -c alias.a=commit a -m x",
  ])("allows %s", async (command) => {
    expect(await decide("block-no-verify", command)).toBe("allow");
  });

  // ROUND 7 REVERSAL: the enclosing `core.hooksPath` reaches the alias, and its
  // value is no longer read (see "a core.hooksPath a commit brings with it").
  it("denies an alias that commits under a hooksPath the command sets", async () => {
    expect(await decide("block-no-verify", "git -c core.hooksPath=.githooks -c alias.a=commit a -m x")).toBe("deny");
  });

  it("names every level it walked through", async () => {
    const r = await policy("block-no-verify").fn(bash("git -c alias.b=a -c alias.a='commit --no-verify' b -m x"));
    expect(r.reason).toContain("alias.b=… → git -c alias.a=… → git commit --no-verify");
  });

  // Each definition is analysed and recursed into, so N of one name at each of
  // two levels is N² analyses. Repeats collapse; distinct ones past the cap stop.
  it("stays bounded on a command that defines one alias hundreds of times", async () => {
    const dup = `git ${Array(400).fill("-c alias.a=status").join(" ")} a`;
    const distinct = (n: number, name: string, body: (i: number) => string) =>
      Array.from({ length: n }, (_, i) => `-c alias.${name}='${body(i)}'`).join(" ");
    const fanOut = `git ${distinct(150, "a", (i) => `status -x${i}`)} ${distinct(150, "b", (i) => `a -y${i}`)} b`;
    const t = performance.now();
    expect(await decide("block-no-verify", dup)).toBe("allow");
    const r = await policy("block-no-verify").fn(bash(fanOut));
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("too many definitions");
    expect(performance.now() - t).toBeLessThan(1500);
  });
});

describe("block-mass-kill: nothing between the listing and the kill is read", () => {
  // Round 6 deleted the chain reading outright. Five rounds tried to decide
  // whether a stage can take a process OUT of a `ps` listing — a grep pattern,
  // an awk test, a sed address, `tail -n +2`, `cat`, `tac`, `shuf`, `column`,
  // a header comparison — and every round the next reviewer found three more
  // spellings of the same thing, twice with a new defect in the patch (a ReDoS
  // from compiling the caller's own selector, and nine false denies). It cannot
  // be decided from the command text, so it is no longer attempted: only the
  // LISTER'S OWN options narrow a listing, and every row below is decided by
  // the command at the head of its pipeline.
  it.each([
    // The canonical filter spellings, with a generic name in them.
    `ps aux | awk '/node/ {print $2}' | xargs kill -9`,
    `ps -e | awk '/node/{print $1}' | xargs kill`,
    `ps aux | awk '$11 ~ /node/ {print $2}' | xargs kill`,
    `ps -eo pid,comm | awk '{if ($2 == "node") print $1}' | xargs kill`,
    `ps aux | sed -n '/node/p' | awk '{print $2}' | xargs kill`,
    `ps aux | perl -ne 'print if /node/' | awk '{print $2}' | xargs kill`,
    `kill $(ps aux | awk '/python/ {print $2}')`,
    `N=node; ps aux | awk "/$N/ {print \\$2}" | xargs kill`,
    `ps aux | awk 'index($0, "node") {print $2}' | xargs kill`,
    `ps aux | awk 'match($0, /python3/) {print $2}' | xargs kill`,
    `ps aux | sed '/node/!d' | awk '{print $2}' | xargs kill`,
    `ps aux | grep node | grep -v grep | awk '{print $2}' | xargs kill -9`,
    // Nothing on the chain narrows at all.
    `ps aux | awk '{print $2}' | xargs kill -9`,
    `ps -aux | awk '{print $2}' | xargs kill`,
    `ps -ef | awk '{print $2}' | xargs kill`,
    `ps -eo pid= | xargs kill -9`,
    `ps aux | cut -c10-15 | xargs kill`,
    `ps aux | awk '//{print $2}' | xargs kill`,
    `ps aux | grep myapp | awk '/.*/{print $2}' | xargs kill`,
    // Round 5 report: a selector that matches every `ps` row. The parent denied
    // these through a rule the round-5 patch removed, and the patch that put a
    // reading back compiled the caller's pattern to decide them.
    `ps aux | awk '/:/{print $2}' | xargs kill -9`,
    `ps aux | awk '/0/{print $2}' | xargs kill -9`,
    `ps aux | sed -n '/:/p' | awk '{print $2}' | xargs kill`,
    `ps -ef | awk '/:/{print $2}' | xargs kill -9`,
    `ps aux | awk '$0 ~ /:/{print $2}' | xargs kill -9`,
    `ps aux | perl -ne 'print if /:/' | awk '{print $2}' | xargs kill`,
    // Round 5 report: one unmodelled reorder/reshape stage turned the deny off.
    `ps -e | tac | awk '{print $1}' | xargs kill`,
    `ps -eo pid= | shuf | xargs kill`,
    `ps -e | column -t | awk '{print $1}' | xargs kill`,
    `ps -e | expand | awk '{print $1}' | xargs kill`,
    `ps aux | cat | awk '{print $2}' | xargs kill`,
    `ps aux | awk '{print $2}' | sort | xargs kill`,
    `ps aux | awk '{print $2}' | sort -u | xargs kill`,
    `ps -e -o pid= | tee /tmp/p | xargs kill`,
    `ps -e -o pid= | nl | xargs kill`,
    // Round 5 report: another spelling of "drop the `ps` header".
    `ps -e | awk '$1 != "PID" {print $1}' | xargs kill`,
    `ps -e | awk '$1 ~ /^[0-9]+$/{print $1}' | xargs kill`,
    `ps -e | awk 'NF>1{print $1}' | xargs kill`,
    `ps aux | awk '$1 != "USER" {print $2}' | xargs kill`,
    `ps -ef | awk '$2 != "PID" {print $2}' | xargs kill`,
    `ps aux | awk 'NF {print $2}' | xargs kill`,
    `ps aux | awk 'NF > 0 {print $2}' | xargs kill`,
    `ps aux | awk 'NR>1 {print $2}' | xargs kill`,
    `ps aux | awk 'NR!=1{print $2}' | xargs kill`,
    `ps aux | awk '{if (NR!=1) print $2}' | xargs kill`,
    `ps aux | awk '/^USER/{next} {print $2}' | xargs kill`,
    `ps aux | tail -n +2 | awk '{print $2}' | xargs kill`,
    `ps -ef | sed 1d | awk '{print $2}' | xargs kill`,
    `ps -ef | sed '1,2d' | awk '{print $2}' | xargs kill`,
    `ps aux | sed '/^$/d' | awk '{print $2}' | xargs kill`,
    `kill $(ps aux | awk 'NR>1{print $2}')`,
    // Round 5 report: a positive grep silenced the rule unconditionally.
    `ps -e | awk '{print $1}' | grep -E '^[0-9]+$' | xargs kill -9`,
    `ps aux | grep -v grep | awk '{print $2}' | xargs kill`,
    `ps aux | grep -v myapp | awk '{print $2}' | xargs kill`,
    // ROUND 6 REVERSALS. Every one of these was pinned as an allow because
    // something on the chain looked narrowing. None of them is read any more:
    // the listing at the head is every process on the box.
    `ps aux | awk '/my-special-worker/ {print $2}' | xargs kill`,
    `ps aux | sed -n '/my-special-worker/p' | awk '{print $2}' | xargs kill`,
    `ps -eo pid,comm | awk '{if ($2 == "my-daemon") print $1}' | xargs kill`,
    `ps aux | grep my-worker | sed 's/ +/ /g' | awk '{print $2}' | xargs kill`,
    `ps aux | grep my-worker | awk '{print $1/$2}' | xargs kill`,
    `ps aux --sort=-%mem | head -2 | awk '{print $2}' | xargs kill`,
    `ps aux | awk 'NR>1 {print $2}' | grep -f wanted.txt | xargs kill`,
    `ps -eo pid,stat,comm | grep myapp | awk '$2 ~ /^Z/ {print $1}' | xargs kill`,
    `ps aux | grep my-worker | awk '$8 ~ /Z/ {print $2}' | xargs kill`,
    `ps -eo pid,etime,comm | grep myapp | awk '$2 ~ /:/ {print $1}' | xargs kill`,
    `ps aux | grep myapp | sed '/^$/d' | awk '{print $2}' | xargs kill`,
    `ps aux | grep myapp | awk '/^$/{next} {print $2}' | xargs kill`,
    `ps -ef | grep myapp | awk '{if ($1 ~ /db/) print $2}' | xargs kill`,
    `ps aux | grep myapp | sed 's/python3 //' | awk '{print $2}' | xargs kill`,
    `ps aux | grep myapp | sed 's/node/N/' | awk '{print $2}' | xargs kill`,
    `ps aux | grep myapp | awk '{sub(/python3 /,""); print $2}' | xargs kill`,
    `ps aux | awk '{print $2}' | head -3 | xargs kill`,
    `ps aux | tail -5 | awk '{print $2}' | xargs kill`,
    `ps aux | sed -n '2p' | awk '{print $2}' | xargs kill`,
    `ps aux | grep myapp | tail -n +2 | awk '{print $2}' | xargs kill`,
    `ps aux | grep myapp | awk '{print $2}' | xargs kill`,
    `ps -e | awk 'index($0,"myapp"){print $2}' | xargs kill`,
    // Listers other than `ps`.
    `top -b -n1 | awk 'NR>7{print $1}' | xargs kill`,
    `ls /proc | grep -E '^[0-9]+$' | xargs kill`,
    "for p in /proc/[0-9]*; do kill ${p##*/}; done",
    "for p in /proc/[0-9]*; do kill $(basename $p); done",
    "Get-Process | Stop-Process",
  ])("denies %s", async (command) => {
    expect(await decide("block-mass-kill", command)).toBe("deny");
  });

  it.each([
    // A `ps` that selects a subset is not a listing of every process, and that
    // is now the ONLY thing that keeps this quiet on a `ps` chain.
    `ps -o ppid= -p 4242 | xargs kill`,
    `ps -C my-daemon -o pid= | xargs kill`,
    `ps 4242 -o pid= | xargs kill`,
    `ps -u alice -o pid= | awk '{print $1}' | xargs kill`,
    `kill $(ps -C myserver -o pid=)`,
    // The narrow spellings that sit right beside every denied row above.
    `pgrep -f my-worker | xargs kill`,
    `pkill -f 'node server.js'`,
    `kill 4242`,
    `Get-Process -Id 12 | Stop-Process`,
    // No process listing in front of it: these are not process listings.
    `cat pids.txt | awk '/node/ {print $2}' | xargs kill`,
    `lsof -ti:3000 | xargs kill -9`,
    `kill $(cat server.pid)`,
  ])("allows %s", async (command) => {
    expect(await decide("block-mass-kill", command)).toBe("allow");
  });

  // The rule is blunt enough that the deny has to carry the way out of it.
  it("names the spellings that still run", async () => {
    const r = await policy("block-mass-kill").fn(bash(`ps aux | grep myapp | awk '{print $2}' | xargs kill`));
    expect(r.reason).toContain("kill 4242");
    expect(r.reason).toContain("pkill -f my-worker");
    expect(r.reason).toContain("pgrep -f my-worker | xargs kill");
  });

  // The reading this replaced compiled the caller's own selector against a
  // 44-character probe line. `((.)*)*X` took 102 seconds in Node there, and a
  // hook that times out lets the call through. Nothing is compiled now.
  it("costs nothing on a pattern that is a bomb for a regex engine", async () => {
    const bomb = "((.)*)*X";
    const t = performance.now();
    expect(await decide("block-mass-kill", `ps aux | awk '/myapp|${bomb}/{print $2}' | xargs kill`)).toBe("deny");
    expect(await decide("block-mass-kill", `ps aux | sed -n '/myapp|${bomb}/p' | awk '{print $2}' | xargs kill`)).toBe("deny");
    expect(await decide("block-mass-kill", `pkill -f 'myapp|${bomb}'`)).toBe("deny");
    expect(await decide("block-mass-kill", `pkill -f '${"(a+)+".repeat(40)}$'`)).toBe("deny");
    expect(await decide("block-mass-kill", `ps aux | awk '${"{print $2} ".repeat(400)}' | xargs kill`)).toBe("deny");
    expect(await decide("block-mass-kill", `ps aux | sed '${"s/a/b/;".repeat(400)}' | awk '{print $2}' | xargs kill`)).toBe("deny");
    expect(await decide("block-mass-kill", `ps aux ${"| cat ".repeat(200)}| xargs kill`)).toBe("deny");
    expect(performance.now() - t).toBeLessThan(1500);
  });
});

describe("block-mass-kill: an unanchored pattern is a substring regex", () => {
  // pkill/pgrep match the pattern as a regex SEARCH over the process name, so
  // each of these reaches exactly what the literal name beside it reaches.
  // Comparing normalised strings drew the line one character wide: `pkill node`
  // denied, `pkill nod` did not.
  it.each([
    "pkill nod",
    "pkill ode",
    "pkill -f nod",
    "pkill n.de",
    "pkill ytho",
    "pkill '^nod'",
    "pkill '.*nod.*'",
    "killall -r 'nod.*'",
    "pgrep nod | xargs kill",
    "pgrep -f ytho | xargs kill",
    `ps aux | grep nod | awk '{print $2}' | xargs kill`,
    // ROUND 6 REVERSALS: the pattern is no longer compiled, so anything
    // written with regex syntax other than `.` is a pattern this cannot read,
    // and an unreadable pattern is treated as reaching everything.
    "pkill -f 'node.*worker'",
    "killall -r 'myapp-worker.*'",
    "pkill 'nod$'",
  ])("denies %s", async (command) => {
    expect(await decide("block-mass-kill", command)).toBe("deny");
  });

  it.each([
    // The pattern is matched against the generic name, never the other way
    // round, so a longer or more specific pattern reaches none of them.
    "pkill vite",
    "pkill esbuild",
    "pkill nginx",
    "pkill webpack",
    "pkill my-worker",
    "pkill -f /opt/app/bin/serve",
    "killall myapp",
    // `-x` compares the whole name.
    "pkill -x nod",
    // A `.` is the one piece of regex syntax still read, so a name with a dot
    // in it is still read as a name.
    "pkill -f 'node server.js'",
    "pkill -x 'my.app'",
  ])("allows %s", async (command) => {
    expect(await decide("block-mass-kill", command)).toBe("allow");
  });

  it("stays fast on a pathological pattern", async () => {
    const t = performance.now();
    // Both deny, and neither is compiled: a pattern holding a group or a
    // repetition is one this does not read.
    expect(await decide("block-mass-kill", `pkill '${"(a+)+".repeat(40)}$'`)).toBe("deny");
    expect(await decide("block-mass-kill", "pkill '(([a-z]*)*)*node'")).toBe("deny");
    expect(performance.now() - t).toBeLessThan(1500);
  });
});

describe("block-no-verify: an alias cannot stand for a command git ships", () => {
  // git.c tries handle_builtin(), then the dashed externals, and only then
  // handle_alias() — so an alias NAMED after a git command is never expanded.
  // Checked against git 2.43 in a throwaway HOME: `git -c alias.version=status
  // version` prints the version, while a name git does not ship DOES expand.
  // Reading the alias as the expansion and stopping there let one extra
  // `-c alias.commit=…` remove the deny from every spelling below.
  it.each([
    "git -c alias.commit=status commit --no-verify -m x",
    "git -c alias.commit=version commit -n -m x",
    "git -c alias.push=noop push --no-verify",
    "git -c alias.merge=status merge --no-verify topic",
    "git -c alias.commit=st -c core.hooksPath=/dev/null commit -m x",
    "HUSKY=0 git -c alias.commit=status commit -m x",
  ])("denies %s", async (command) => {
    expect(await decide("block-no-verify", command)).toBe("deny");
  });

  it.each([
    // The other direction of the same rule: the alias is dead text, so what it
    // would have expanded to says nothing about the command that runs.
    "git -c alias.commit=status commit -m x",
    "git -c alias.status='commit --no-verify' status",
    "git -c alias.log='commit -n' log --oneline",
    "git -c alias.stash='commit --no-verify' stash list",
  ])("allows %s", async (command) => {
    expect(await decide("block-no-verify", command)).toBe("allow");
  });

  it("names the real subcommand, not the alias it ignored", async () => {
    const r = await policy("block-no-verify").fn(bash("git -c alias.commit=status commit --no-verify -m x"));
    expect(r.reason).toContain("git commit --no-verify");
    expect(r.reason).not.toContain("alias");
  });
});

describe("block-no-verify: an alias body the command string does not state", () => {
  // `--config-env core.hooksPath` already denied because the value lives in an
  // environment variable. An alias defined the same way decides far more — it
  // IS the command that runs — and used to fail OPEN. `--config-env=alias.ci=E`
  // really does define an alias (checked against git 2.43:
  // `E=version git --config-env=alias.zz=E zz` prints the version).
  it.each([
    "E='commit --no-verify' git --config-env=alias.ci=E ci -m x",
    "git --config-env alias.ci=E ci -m x",
    'git -c alias.ci="$UNSET" ci -m x',
    "git -c alias.ci=$(cat body.txt) ci -m x",
    'read B; git -c alias.ci="$B" ci -m x',
    // A body the resolver reads only PART of is worse than one it cannot read:
    // it takes the first word of a `${X:-…}` default, so this read back as a
    // plain `commit` and the `--no-verify` disappeared.
    'git -c alias.ci="${B:-commit --no-verify}" ci -m x',
  ])("denies %s", async (command) => {
    expect(await decide("block-no-verify", command)).toBe("deny");
  });

  it.each([
    // Only the alias the command actually INVOKES has to be readable.
    "git --config-env=alias.zz=E st",
    "git --config-env=core.author=A commit -m x",
    'git -c user.name="$NAME" commit -m x',
    "git -c alias.ci=commit ci -m x",
  ])("allows %s", async (command) => {
    expect(await decide("block-no-verify", command)).toBe("allow");
  });

  it("says the body is what it could not read", async () => {
    const r = await policy("block-no-verify").fn(bash("git --config-env=alias.ci=E ci -m x"));
    expect(r.reason).toContain("alias.ci=… (body not in the command)");
  });
});

describe("block-no-verify: expanding an alias keeps the tail's quoting", () => {
  // `ShellWord.text` has the quotes REMOVED, so rebuilding the alias tail with
  // it and re-lexing turned a commit MESSAGE into flags — a false deny on a
  // hard policy, and the exact opposite of what the note at the top of
  // floor-policies.ts promises about `git commit -m "never use --no-verify"`.
  it.each([
    "git -c alias.ci=commit ci -m 'do not use --no-verify here'",
    'git -c alias.ci=commit ci -m "never pass -n"',
    "git -c alias.ci=commit ci -m 'a; git commit --no-verify'",
    "git -c alias.ci='commit -s' ci -m 'skip with --no-verify? no'",
    "git -c alias.b=a -c alias.a=commit b -m 'mentions --no-verify twice: --no-verify'",
  ])("allows %s", async (command) => {
    expect(await decide("block-no-verify", command)).toBe("allow");
  });

  it.each([
    // The flag still counts when it is a flag.
    "git -c alias.ci=commit ci --no-verify -m 'a message'",
    "git -c alias.ci=commit ci -m 'a message' -n",
  ])("denies %s", async (command) => {
    expect(await decide("block-no-verify", command)).toBe("deny");
  });
});

describe("block-mass-kill: a `ps` option's argument is consumed, not scanned", () => {
  // `ps -eopid=` and `ps -eo pid=` are the same listing — 424 lines each on
  // this box — but reading the flag bundle as a bag of letters found the `p`
  // of the output FORMAT and called it the `-p <pid>` selector. One space was
  // the whole difference between a pinned deny row and an allow.
  it.each([
    "ps -eopid= | xargs kill",
    "ps -e -opid= | xargs kill",
    "ps -eo pid= | xargs kill",
    "ps -Ao pid= | xargs kill",
    "ps axo pid= | xargs kill",
    "ps --format pid= -e | xargs kill",
    "ps -e --format=pid= | xargs kill",
  ])("denies %s", async (command) => {
    expect(await decide("block-mass-kill", command)).toBe("deny");
  });

  it.each([
    // A real selector, with its own operand, still stops the rule.
    "ps -p 1 -o pid= | xargs kill",
    "ps -o pid= -p 4242 | xargs kill",
    "ps -U root -o pid= | xargs kill",
    "ps --user root -o pid= | xargs kill",
    "ps --pid 4242 -o pid= | xargs kill",
    "ps -C my-daemon -o pid= | xargs kill",
  ])("allows %s", async (command) => {
    expect(await decide("block-mass-kill", command)).toBe("allow");
  });
});

describe("block-mass-kill: a pattern is read the way pgrep compiles it", () => {
  // Splitting on `|` before compiling shredded `n(o|0)de` into two invalid
  // fragments that match nothing, and a POSIX class or an `-i` was read as
  // plain JavaScript. Checked against procps-ng 4.0.4: `pgrep 'n(o|0)de'`,
  // `pgrep '[[:alpha:]]ode'` and `pgrep -i NOD` all list the same pids as
  // `pgrep node`, and `-x` is a fully ANCHORED regex — `pgrep -x 'b.sh'` and
  // `pgrep -x 'b(a|0)sh'` both match bash, `pgrep -x bas` matches nothing.
  it.each([
    "pkill 'n(o|0)de'",
    "pkill '(no|na)de'",
    "pkill 'nod(e|3)'",
    "killall -r 'n(o|0)de'",
    "pgrep 'n(o|0)de' | xargs kill",
    "pkill '[[:alpha:]]ode'",
    "pkill -f '[[:alpha:]]ode'",
    "pkill -i NOD",
    "pkill --ignore-case NOD",
    "killall -I NODE",
    // `-x` anchors the pattern; it is still a regex.
    "pkill -x 'n(o|0)de'",
    "pkill -x 'n.de'",
    "pkill -x 'node|myapp'",
    `ps aux | grep -i NOD | awk '{print $2}' | xargs kill`,
    // ROUND 6 REVERSALS: a group, an alternation or a character class is regex
    // syntax this no longer reads, whatever it spells.
    "pkill 'my(a|b)pp'",
    "pkill '(vite|esbuild)'",
    "pkill '[[:alpha:]]yapp'",
    "killall -r 'my(a|b)pp'",
  ])("denies %s", async (command) => {
    expect(await decide("block-mass-kill", command)).toBe("deny");
  });

  it.each([
    // The pattern is matched against the generic names, never the other way
    // round, so a longer or more specific pattern reaches none of them.
    "pkill -i MYAPP",
    "pkill my-worker",
    // `-x` still compares the whole name.
    "pkill -x nod",
    "pkill -x 'my.app'",
  ])("allows %s", async (command) => {
    expect(await decide("block-mass-kill", command)).toBe("allow");
  });
});

/**
 * Review round 6: the two policies that kept producing "three more spellings"
 * were rebuilt around one rule each instead of a list of spellings.
 * block-mass-kill reads only the LISTER; block-no-verify decides on the command
 * git will really run, and fails CLOSED where it cannot work that out.
 */
describe("block-no-verify: git's own case rules decide what an alias can shadow", () => {
  // git.c dispatches its builtins case-SENSITIVELY, while config lookup — and
  // therefore `alias.<name>` — is case-INSENSITIVE. Checked against git 2.43 in
  // a throwaway HOME with GIT_CONFIG_NOSYSTEM=1: `git VERSION` is "not a git
  // command", `git -c alias.COMMIT=version COMMIT` prints the version, and
  // `git -c alias.commit=version COMMIT` prints it too. Lower-casing the
  // subcommand before the builtin test read `COMMIT` as the builtin and skipped
  // every alias check, which was a working one-command bypass.
  it.each([
    "git -c alias.COMMIT='commit --no-verify' COMMIT -m x",
    "git -c alias.commit='commit --no-verify' COMMIT -m x",
    "git -c alias.Commit='commit --no-verify' Commit -m x",
    "git -c alias.PUSH='push --no-verify' PUSH",
    "git -c alias.COMMIT='!git commit --no-verify' COMMIT -m x",
    "git -c alias.COMMIT='commit -n' COMMIT -m x",
    "git -c alias.Push='push --no-verify' Push",
    "git -C repo -c alias.CI='commit --no-verify' CI -m x",
    "git -c alias.b=A -c alias.A='commit --no-verify' b -m x",
    "git --config-env=alias.CI=E CI -m x",
  ])("denies %s", async (command) => {
    expect(await decide("block-no-verify", command)).toBe("deny");
  });

  it.each([
    // The other direction: a builtin is a builtin however the alias is spelled.
    "git -c alias.COMMIT=status commit -m x",
    "git -c alias.commit='commit --no-verify' status",
    // git would answer "'COMMIT' is not a git command", and nothing here defines it.
    "git COMMIT -m x",
  ])("allows %s", async (command) => {
    expect(await decide("block-no-verify", command)).toBe("allow");
  });
});

describe("block-no-verify: a setting the command does not state fails closed", () => {
  // Every way a command brings configuration with it can redefine a subcommand
  // or turn hooks off, and they are all read as one kind of thing now. A source
  // whose KEY the command does not state could be any setting at all; a source
  // whose VALUE it does not state could hold anything.
  it.each([
    // `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n` really do define an alias (checked
    // against git 2.43: `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.ci
    // GIT_CONFIG_VALUE_0=version git ci` prints the version).
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.ci GIT_CONFIG_VALUE_0='commit --no-verify' git ci -m x",
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.ci git ci -m x",
    // A slot the command counts but does not fill.
    "GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=user.name GIT_CONFIG_VALUE_0=x git commit -m y",
    'GIT_CONFIG_PARAMETERS="$P" git commit -m x',
    // A `-c` whose whole key is unreadable: it could be `alias.ci=…` in front
    // of a subcommand git does not ship, or `core.hooksPath=` in front of one it does.
    'git -c "$C" ci -m x',
    'git -c "$C" commit -m x',
    // A config FILE the command names holds settings this cannot read.
    "GIT_CONFIG_GLOBAL=/tmp/evil.cfg git commit -m x",
    "GIT_CONFIG=/tmp/evil.cfg git ci -m x",
    "git -c include.path=/tmp/evil.cfg commit -m x",
    "git -c includeIf.gitdir:/x/.path=/tmp/evil.cfg commit -m x",
    // A hook skip with no subcommand to pin it on.
    "git $S --no-verify",
  ])("denies %s", async (command) => {
    expect(await decide("block-no-verify", command)).toBe("deny");
  });

  it.each([
    // A setting whose key IS readable and is not one that changes what runs or
    // whether hooks run is harmless whatever its value.
    'git -c user.name="$NAME" commit -m x',
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.name GIT_CONFIG_VALUE_0=x git commit -m y",
    "GIT_CONFIG_PARAMETERS=\"'user.name'='x'\" git commit -m x",
    // Only the alias the command actually INVOKES has to be readable.
    'git -c alias.zz="$B" st',
    // An alias whose definition is not in this command at all — every user has
    // these, and nothing here says it is a commit.
    "git st",
    "git ci -m x",
  ])("allows %s", async (command) => {
    expect(await decide("block-no-verify", command)).toBe("allow");
  });

  it.each([
    // An EXPORT of the same variables reaches the commit the same way, and is
    // judged by the same rule.
    "export GIT_CONFIG_PARAMETERS=\"'core.hooksPath'='/dev/null'\"; git commit -m x",
    "export GIT_CONFIG_COUNT=1; export GIT_CONFIG_KEY_0=core.hooksPath; export GIT_CONFIG_VALUE_0=/dev/null; git commit -m x",
    "export GIT_CONFIG_GLOBAL=/tmp/evil.cfg; git commit -m x",
  ])("denies %s", async (command) => {
    expect(await decide("block-no-verify", command)).toBe("deny");
  });

  it.each([
    "export GIT_CONFIG_PARAMETERS=\"'user.name'='x'\"; git commit -m x",
    // `GIT_CONFIG_COUNT=0` states that there are no settings; a count the
    // command cannot state is the one that fails closed.
    "GIT_CONFIG_COUNT=0 git commit -m x",
    "export GIT_CONFIG_COUNT=0; git commit -m x",
  ])("allows %s", async (command) => {
    expect(await decide("block-no-verify", command)).toBe("allow");
  });

  it("says what it could not read", async () => {
    const r = await policy("block-no-verify").fn(bash('git -c "$C" ci -m x'));
    expect(r.reason).toContain("alias.ci=… (body not in the command)");
    const h = await policy("block-no-verify").fn(bash("git -c core.hooksPath=$H commit -m x"));
    expect(h.reason).toContain("value not in the command");
  });
});

// ── ROUND 7: the two ends, and nothing in between ───────────────────────────
//
// Round 6 stopped reading what a pipeline DOES to a listing, and the next
// review found the same class one rewrite wide in what it still read: the
// ROUTE from the listing to the kill, and the WORD a program's argument
// travelled in. Both are gone. `block-mass-kill` now reads the lister and the
// kill's own operands, and `block-no-verify` reads the argv git is really
// handed, with a `-c`, an alias or a `core.hooksPath` it cannot state failing
// closed.

describe("block-mass-kill: the route from the listing to the kill is not read", () => {
  it.each([
    // A group around either end used to drop the pipe relation entirely.
    "(ps -e -o pid=) | xargs kill",
    "ps -e -o pid= | ( xargs kill )",
    "{ ps -e -o pid=; } | xargs kill",
    // A loop body, which is how this is actually written.
    "ps aux | while read u p rest; do kill -9 $p; done",
    "ps -e -o pid= | while read p; do kill $p; done",
    'ps -e -o pid= | while IFS= read -r p; do kill "$p"; done',
    "ps aux | awk '{print $2}' | while read p; do kill $p; done",
    "ps -e -o pid= | { read p; kill $p; }",
    "ps -e -o pid= | if true; then xargs kill; fi",
    // A downstream stage that re-sources its own command template.
    "ps -eo pid= | parallel kill",
    "ps -eo pid= | parallel -j4 kill",
    "ps -eo pid= | parallel 'kill {}'",
    'ps aux | xargs sh -c \'kill "$@"\' _',
    // A redirect, a process substitution, or a file written and read back.
    "xargs kill < <(ps -e -o pid=)",
    'mapfile -t pids < <(ps -e -o pid=); kill "${pids[@]}"',
    'readarray -t pids < <(ps -e -o pid=); kill "${pids[@]}"',
    "ps -e -o pid= > /tmp/p; xargs kill < /tmp/p",
    "ps -e -o pid= > /tmp/p && kill $(cat /tmp/p)",
    // A lister this knows, however the listing is then carried.
    "pstree -p | grep -o '[0-9]*' | xargs kill",
    "ls /proc | grep -E '^[0-9]+$' | xargs kill",
    "awk '{print}' /proc/*/cmdline | xargs kill",
    "for p in /proc/[0-9]*; do kill $(basename $p); done",
    // One more assignment between the listing and the kill.
    "P=$(ps -e -o pid=); Q=$P; kill $Q",
    "P=$(pgrep node); Q=$P; kill $Q",
    "pids=$(pgrep node); for p in $pids; do kill $p; done",
    "pids=$(ps -e -o pid=); for p in $pids; do kill $p; done",
  ])("denies %s", async (command) => {
    expect(await decide("block-mass-kill", command)).toBe("deny");
  });

  it.each([
    // The same routes, out of a lister that NAMED what it wanted.
    "(pgrep -f my-worker) | xargs kill",
    "pgrep -f my-worker | while read p; do kill $p; done",
    "ps -C my-daemon -o pid= | parallel kill",
    "xargs kill < <(pgrep -f my-worker)",
    "P=$(pgrep -f my-worker); Q=$P; kill $Q",
    // A kill that names the PIDs the user typed runs whatever else is around it.
    "ps aux | head -20; kill 4242",
    "ps aux; kill -9 4242 4243",
    "ps aux | grep node; kill %1",
    "top -b -n1 | head; kill -s TERM 4242",
    "ps aux | grep node; kill -l",
    // A `/proc` path the command spells out names ONE thing, and is not a listing.
    "cat /proc/1234/status; kill $PID",
    "cat /proc/self/status; kill $PID",
    "cat /proc/meminfo; kill $PID",
    "pstree -p 4242 | xargs kill",
  ])("allows %s", async (command) => {
    expect(await decide("block-mass-kill", command)).toBe("allow");
  });

  it("names the listing and the kill it paired", async () => {
    const r = await policy("block-mass-kill").fn(bash("ps aux | while read u p; do kill $p; done"));
    expect(r.reason).toContain("kill naming no PID beside ps listing every process");
  });
});

describe("block-mass-kill: an option carried in a variable is still an option", () => {
  it.each([
    "X=aux; ps $X | xargs kill",
    "X='-e -o pid='; ps $X | xargs kill",
    "X=e; ps -$X | xargs kill",
    "X=ax; ps $X | xargs kill",
    "A='-f node'; pkill $A",
    "A='-9 node'; killall $A",
    "N='-1'; kill -9 $N",
    "A='-u root'; pkill $A",
    // `ps x` and `ps a` each drop one of the two restrictions on a bare `ps`.
    "ps x | xargs kill",
    "ps a | xargs kill",
    // An option the command cannot read could be `aux`; the narrow one can say so.
    "ps $OPTS | xargs kill",
  ])("denies %s", async (command) => {
    expect(await decide("block-mass-kill", command)).toBe("deny");
  });

  it.each([
    "X='-p 4242'; ps $X | xargs kill",
    "P=my-worker; pkill -f $P",
    "S=my-daemon; ps -C $S -o pid= | xargs kill",
    "ps -p $$ -o ppid= | xargs kill",
    "ps -u alice -o pid= | xargs kill",
  ])("allows %s", async (command) => {
    expect(await decide("block-mass-kill", command)).toBe("allow");
  });
});

describe("block-no-verify: the argv git is really handed", () => {
  it.each([
    // bash splits an unquoted expansion, so all three hand git a real skip.
    "A='commit --no-verify'; git $A -m x",
    "F='-m x --no-verify'; git commit $F",
    "F='--no-verify -m x'; git commit $F",
    "O='-c core.hooksPath=/dev/null'; git $O commit -m x",
    'O="-c core.hooksPath=/dev/null"; git $O push',
    "O='-c alias.ci=commit --no-verify'; git $O ci -m x",
    // The resolver reads the FIRST word of a `${X:-default}` and no more, so a
    // default of several words states nothing about this position.
    "git ${O:--c core.hooksPath=/dev/null} commit -m x",
    // An unreadable word where a `-c` lives, in front of a subcommand git ships.
    "git $OPTS commit -m x",
    "git $OPTS push",
    "export HUSKY=0; git $OPTS commit -m x",
    'git "$OPTS" commit -m x',
  ])("denies %s", async (command) => {
    expect(await decide("block-no-verify", command)).toBe("deny");
  });

  it.each([
    // A quoted expansion is ONE argument however many spaces it holds.
    'MSG="fix: stop passing --no-verify"; git commit -m "$MSG"',
    'git commit -m "$MSG"',
    'M="--no-verify is banned"; git commit -m "$M" --author="a <a@b>"',
    // A long option that states its own name carries no setting.
    "git --git-dir=$D commit -m x",
    "git --work-tree=$W commit -m x",
    "git --no-pager commit -m x",
    // The unreadable word could BE the subcommand, so a name git does not ship
    // after it is not read as an alias.
    "git $S -m x",
    "git $S st",
    // Still unresolvable, still left alone.
    "git commit $F -m x",
    "git commit -m x $FLAGS",
  ])("allows %s", async (command) => {
    expect(await decide("block-no-verify", command)).toBe("allow");
  });
});

describe("block-no-verify: a definition the command writes or pads out of reach", () => {
  it.each([
    // `git config` NAMES and writes the file the next git reads (checked
    // against git 2.43 in a throwaway HOME: the plain commit was rejected by a
    // failing pre-commit, and `git nv` committed).
    "git config alias.nv 'commit --no-verify' && git nv -m x",
    "git config --global alias.nv 'commit --no-verify'; git nv -m x",
    "git config alias.nv '!git commit --no-verify'; git nv -m x",
    "git config --add alias.nv 'commit --no-verify'",
    "git config --replace-all alias.nv 'commit -n'",
    "git config alias.nv 'commit --no-verify'",
    // A definition the command writes but does not state.
    'git config alias.nv "$BODY"; git nv -m x',
  ])("denies %s", async (command) => {
    expect(await decide("block-no-verify", command)).toBe("deny");
  });

  it.each([
    "git config alias.st status; git st",
    "git config alias.lg 'log --oneline -20' && git lg",
    "git config --get alias.nv",
    "git config --unset alias.nv",
    "git config --list",
    "git config user.email a@b.com && git commit -m x",
  ])("allows %s", async (command) => {
    expect(await decide("block-no-verify", command)).toBe("allow");
  });

  it("reads every GIT_CONFIG_COUNT slot or none", async () => {
    const pad = (n: number) =>
      Array.from({ length: n }, (_, i) => `GIT_CONFIG_KEY_${i}=user.name GIT_CONFIG_VALUE_${i}=A`).join(" ");
    // Sixteen junk slots in front of the payload used to hide it: git honours
    // every slot it counts (checked against git 2.43), and the policy read 16.
    for (const [total, key, value] of [
      [17, "alias.ci", "commit --no-verify"],
      [17, "core.hooksPath", "/dev/null"],
      [20, "alias.ci", "commit --no-verify"],
      [40, "core.hooksPath", "/dev/null"],
    ] as const) {
      const cmd = `GIT_CONFIG_COUNT=${total} ${pad(total - 1)} GIT_CONFIG_KEY_${total - 1}=${key} ` +
        `GIT_CONFIG_VALUE_${total - 1}='${value}' git commit -m x`;
      expect(await decide("block-no-verify", cmd)).toBe("deny");
    }
    expect(await decide("block-no-verify", `GIT_CONFIG_COUNT=16 ${pad(16)} git commit -m x`)).toBe("allow");
  });
});

describe("the floor's cost stays bounded on a command built to be expensive", () => {
  // A hook that times out lets the call through, so every shape below has to
  // stay in milliseconds. Run under node, whose regex engine is the one the
  // shipped CLI uses.
  it.each([
    ["a selector built to backtrack", "ps aux | awk '/myapp|((.)*)*X/{print $2}' | xargs kill"],
    ["a pattern built to backtrack", "pkill -f '((a+)+)+$'"],
    ["many kill stages in one pipeline", "ps aux | " + Array.from({ length: 400 }, () => "xargs kill").join(" | ")],
    ["many kills in one command", "ps aux; " + Array.from({ length: 2000 }, (_, i) => `kill $P${i}`).join("; ")],
    ["many settings on one git", Array.from({ length: 500 }, (_, i) => `git -c a${i}.b=c commit -m x`).join("; ")],
    ["a very long argument", "ps aux | xargs kill " + "a".repeat(200_000)],
  ])("%s", async (_label, command) => {
    const started = Date.now();
    for (const name of FLOOR) await decide(name, command);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
