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

describe("block-no-verify: a core.hooksPath override is judged by its value", () => {
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
  ])("denies %s", async (command) => {
    expect(await decide("block-no-verify", command)).toBe("deny");
  });

  it.each([
    "git -c core.hooksPath=.husky commit -m x",
    "git -c core.hooksPath=.githooks push origin x",
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
  ])("denies %s", async (command) => {
    expect(await decide("block-no-verify", command)).toBe("deny");
  });

  it.each([
    // Unresolvable: the command string does not say it skips hooks.
    "git commit $F -m x",
    "git commit -m x $FLAGS",
    "git $S -m x",
    "git -c core.hooksPath=$H commit -m x",
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

describe("block-mass-kill: a conditional that decides nothing is not a per-process filter", () => {
  it.each([
    "P=$(pgrep node); if true; then kill $P; fi",
    // The assignment sits in a command prefix the analysis does not carry.
    "if true; then P=$(pgrep node); kill $P; fi",
    "[ 1 = 1 ]; P=$(pgrep node); kill $P",
    "case x in y) ;; esac; P=$(pgrep node); kill $P",
    "for p in $(pgrep node); do if true; then kill $p; fi; done",
    // A test and a grep that read something other than the PID.
    'for p in $(pgrep node); do [ -n "$x" ] && kill $p; done',
    "grep -q x file; P=$(pgrep node); kill $P",
  ])("denies %s", async (command) => {
    expect(await decide("block-mass-kill", command)).toBe("deny");
  });

  it.each([
    'for p in $(pgrep node); do if [ -n "$p" ]; then kill $p; fi; done',
    "for p in $(pgrep -f node); do if grep -q myapp /proc/$p/cmdline; then kill $p; fi; done",
    // The filter reads a variable derived from the PID, not the PID itself.
    'for p in $(pgrep -f node); do c=$(ps -o args= -p $p); case "$c" in *myapp*) kill $p;; esac; done',
    // An argument that looks like an assignment does not assign.
    "echo P=$(pgrep node); kill $P",
    "P=$(cat server.pid); if true; then kill $P; fi",
  ])("allows %s", async (command) => {
    expect(await decide("block-mass-kill", command)).toBe("allow");
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

describe("block-mass-kill: the filter check stays linear", () => {
  // Reading the filter off the PID variable's data dependencies replaced a scan
  // of the whole analysis per variable. With one filtered variable per kill,
  // recomputing that scan per variable is quadratic in the command's length.
  it("handles a command with a filtered PID variable per kill", async () => {
    const cmd = Array.from(
      { length: 2000 },
      (_, i) => `P${i}=$(pgrep node); [ -n "$P${i}" ] && kill $P${i}`,
    ).join("; ");
    const t = performance.now();
    expect(await decide("block-mass-kill", cmd)).toBe("allow");
    expect(performance.now() - t).toBeLessThan(1500);
  });
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
    "git -c core.hooksPath=.githooks -c alias.a=commit a -m x",
    "HUSKY=1 git -c alias.a=commit a -m x",
  ])("allows %s", async (command) => {
    expect(await decide("block-no-verify", command)).toBe("allow");
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

describe("block-mass-kill: a filter on a `ps` chain is not only grep", () => {
  it.each([
    // The canonical awk spelling of the grep row the policy already denied.
    `ps aux | awk '/node/ {print $2}' | xargs kill -9`,
    `ps -e | awk '/node/{print $1}' | xargs kill`,
    `ps aux | awk '$11 ~ /node/ {print $2}' | xargs kill`,
    `ps -eo pid,comm | awk '{if ($2 == "node") print $1}' | xargs kill`,
    `ps aux | sed -n '/node/p' | awk '{print $2}' | xargs kill`,
    `ps aux | perl -ne 'print if /node/' | awk '{print $2}' | xargs kill`,
    `kill $(ps aux | awk '/python/ {print $2}')`,
    // The pattern is assembled in a variable.
    `N=node; ps aux | awk "/$N/ {print \\$2}" | xargs kill`,
    // Nothing on the chain narrows a listing of every process at all.
    `ps aux | awk '{print $2}' | xargs kill -9`,
    // `-aux`'s `u` is BSD output format, not the `-u <user>` selector.
    `ps -aux | awk '{print $2}' | xargs kill`,
    `ps -ef | awk '{print $2}' | xargs kill`,
    `ps -eo pid= | xargs kill -9`,
    `ps aux | cut -c10-15 | xargs kill`,
  ])("denies %s", async (command) => {
    expect(await decide("block-mass-kill", command)).toBe("deny");
  });

  it.each([
    // A narrow pattern in every one of those tools.
    `ps aux | awk '/my-special-worker/ {print $2}' | xargs kill`,
    `ps aux | sed -n '/my-special-worker/p' | awk '{print $2}' | xargs kill`,
    `ps -eo pid,comm | awk '{if ($2 == "my-daemon") print $1}' | xargs kill`,
    // A `s///` or a division is not a selection: reading every literal as a
    // pattern would deny these.
    `ps aux | grep my-worker | sed 's/ +/ /g' | awk '{print $2}' | xargs kill`,
    `ps aux | grep my-worker | awk '{print $1/$2}' | xargs kill`,
    // Something on the chain does narrow, so the every-process rule stays quiet.
    `ps aux --sort=-%mem | head -2 | awk '{print $2}' | xargs kill`,
    `ps aux | awk 'NR>1 {print $2}' | grep -f wanted.txt | xargs kill`,
    // A `ps` that selects a subset is not a listing of every process.
    `ps -o ppid= -p 4242 | xargs kill`,
    `ps -C my-daemon -o pid= | xargs kill`,
    `ps 4242 -o pid= | xargs kill`,
    // No `ps` in front of it: these are not process listings.
    `cat pids.txt | awk '/node/ {print $2}' | xargs kill`,
  ])("allows %s", async (command) => {
    expect(await decide("block-mass-kill", command)).toBe("allow");
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
    "pkill -f 'node.*worker'",
    "pkill -f /opt/app/bin/serve",
    "killall myapp",
    "killall -r 'myapp-worker.*'",
    // `nod$` does not match `node`, and pkill would not kill it.
    "pkill 'nod$'",
    // `-x` compares the whole name.
    "pkill -x nod",
  ])("allows %s", async (command) => {
    expect(await decide("block-mass-kill", command)).toBe("allow");
  });

  it("stays fast on a pathological pattern", async () => {
    const t = performance.now();
    expect(await decide("block-mass-kill", `pkill '${"(a+)+".repeat(40)}$'`)).toBe("allow");
    expect(await decide("block-mass-kill", "pkill '(([a-z]*)*)*node'")).toBe("deny");
    expect(performance.now() - t).toBeLessThan(1500);
  });
});
