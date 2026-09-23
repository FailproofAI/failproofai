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
    ["block-chmod-777", "strace -o /dev/null chmod -R 777 /srv"],
    ["block-disk-destruction", "pkexec wipefs -a /dev/sdb"],
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
    ["block-gh-destructive", "su -c'gh repo delete o/r --yes'"],
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
    ["thousands of `x | chmod`", "ls | chmod 777 a; ".repeat(20_000)],
    ["thousands of `dd of=$T`", "T=/dev/sda; " + "dd if=/dev/zero of=$T; ".repeat(5_000)],
    ["a chmod mode of repeated clauses", "chmod '" + "u+r,".repeat(100_000) + "o+w' a"],
  ])("stays linear on %s", async (_, command) => {
    const t = performance.now();
    for (const name of FLOOR) await decide(name, command);
    expect(performance.now() - t).toBeLessThan(1500);
  });
});

/**
 * Review round 2: the same failure in several policies — a word read with
 * `literalText` alone, so a value the analyser CAN resolve walks past a floor
 * no reviewer can clear. Each block pins the bypass, the near miss that must
 * stay allowed, and the unresolvable form that stays lenient.
 */
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
 * ROUND 8 (the scope cut): `block-mass-kill` and `block-no-verify` were removed
 * from this branch. Both needed to decide what a shell would DO with the text
 * between two programs — which listing reached which kill, what an alias or a
 * `core.hooksPath` a later command reads would mean — and every closure that
 * needed no such model denied ordinary work (`ps aux > log; kill $SERVER_PID`,
 * `git -c core.hooksPath=.husky commit`) or cost seconds on one hook call.
 * What is left reads a program's OWN arguments, which is why the table below
 * can state a bound at all.
 */
describe("the floor's cost stays bounded on a command built to be expensive", () => {
  // A hook that times out lets the call through, so every shape below has to
  // stay in milliseconds. Run under node, whose regex engine is the one the
  // shipped CLI uses.
  const big = (unit: string) => unit.repeat(Math.ceil(500_000 / unit.length));
  it.each([
    ["a GraphQL query built to backtrack", "gh api graphql -f query='mutation " + "a ".repeat(100_000) + "'"],
    // The one place a regex is BUILT from the command: a glob in command
    // position, every metacharacter escaped, adjacent `*` coalesced, capped at
    // 1 KB of source and matched only against 22 fixed program names.
    ["a command-position glob built to backtrack", "/bin/" + "*m".repeat(400) + " -rf /tmp/x"],
    ["a command-position glob of 100k stars", "/bin/" + "*".repeat(100_000) + "m -rf /tmp/x"],
    ["a command-position glob of 50k unterminated classes", "/bin/" + "[".repeat(50_000) + "m* -rf /tmp/x"],
    ["500 KB of gh deletions", big("gh release view v1; ")],
    ["500 KB of chmod", big("chmod 755 a; ")],
    ["500 KB of dd", big("dd if=/dev/zero of=out.img; ")],
    ["500 KB of assignments before one dd", "dd if=/dev/zero of=out.img; " + big("A=1; ")],
    ["many relative cds before one mkfs", Array.from({ length: 2_000 }, () => "cd ..").join("; ") + "; mkfs.ext4 img"],
    ["a very long argument", "chmod 755 " + "a".repeat(200_000)],
  ])("%s", async (_label, command) => {
    const started = Date.now();
    for (const name of FLOOR) await decide(name, command);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
  // The number the scope cut was made for. Measured under node at 500 KB:
  // 5–22 ms for all four together, worst single policy 21 ms. The bound here is
  // an order of magnitude looser so a loaded CI box cannot flake it, and it
  // still fails an O(n²) reading of the same command — which is what the two
  // removed policies had (4.1 s on 540 KB).
  it("evaluates a 500 KB command through all four in well under 100 ms", async () => {
    const command = "git status; npm run build; ".repeat(Math.ceil(500_000 / 27));
    expect(command.length).toBeGreaterThan(500_000);
    for (const name of FLOOR) await decide(name, command); // warm
    const started = performance.now();
    for (const name of FLOOR) expect(await decide(name, command)).toBe("allow");
    expect(performance.now() - started).toBeLessThan(300);
  });
});

/**
 * What the two removed policies used to decide, and no longer does.
 *
 * The first table is the regression: ordinary commands a developer writes in a
 * normal day, each of them a DENY at the parent commit (9bcb992e, verified by
 * running this list against that tree). The second is what they were aimed at
 * — real hook bypasses and real mass kills, which now reach Jev as a warning
 * instead of the hard floor. Both tables assert the same thing, because the
 * floor no longer reads either: what makes them different belongs in the PR
 * description, not in a verdict.
 */
describe("what the scope cut gave up, in both directions", () => {
  it.each([
    // FALSE POSITIVES. block-mass-kill's co-occurrence rule: a broad listing
    // and a kill that named no PID, in one command, denied each other however
    // unrelated to each other they were.
    "ps aux > log; kill $SERVER_PID",
    "ps aux | grep node; kill $(cat server.pid)",
    "echo P=$(pgrep node); kill $P",
    "ps -e -o pid= | xargs kill",
    "for p in $(pgrep bash); do kill $p; done",
    // block-no-verify: `.husky` is the directory husky itself installs, and the
    // value-blind rule could not tell it from an empty one; `git $OPTS commit`
    // is an unreadable word where a `-c` could live.
    "git -c core.hooksPath=.husky commit -m x",
    "git -c core.hooksPath=.githooks push origin main",
    "git config core.hooksPath .husky && git commit -m x",
    "git $OPTS commit -m x",
    "MSG='do not use --no-verify'; git commit -m $MSG",
  ])("no shipped floor policy denies %s (a deny at the parent commit)", async (command) => {
    for (const name of FLOOR) expect(await decide(name, command)).toBe("allow");
  });

  it.each([
    // THE REAL TARGETS, now Jev's to warn on rather than the floor's to block.
    "git commit --no-verify -m x",
    "git push --no-verify origin main",
    "HUSKY=0 git commit -m x",
    "killall node",
    "pkill -f node",
    "kill -9 -1",
  ])("the floor no longer reads %s either", async (command) => {
    for (const name of FLOOR) expect(await decide(name, command)).toBe("allow");
  });
});

/**
 * A deny reason is written into the transcript and the hook log, so it must not
 * carry a value the user only bound to a variable. The four read their own
 * arguments, so what they name is either fixed text, the word AS WRITTEN (which
 * is already in the command), or a value that matched a device path, a gh
 * noun/verb or a permission mode — never an arbitrary resolved string.
 */
describe("a deny reason never carries a value the command only bound to a variable", () => {
  // Built at runtime: a literal key-shaped string in the source is what the
  // repo's own secret scanners exist to stop.
  const SECRET = ["sk", "live", "9f2b7c41d8e6a0b3c5d7e9f1a2b4c6d8"].join("-");
  it.each([
    ["block-disk-destruction", `K=${SECRET}; export K; dd if=/dev/zero of=/dev/sda`],
    ["block-disk-destruction", `dd if=/dev/zero of=/dev/sda # token ${SECRET}`],
    ["block-gh-destructive", `GH_TOKEN=${SECRET} gh release delete v1 --yes`],
    ["block-chmod-777", `K=${SECRET}; M=777; chmod $M creds.json`],
    ["block-indirect-exec", `K=${SECRET}; R=/bin/rm; $R -rf /tmp/x`],
  ] as Array<[Floor, string]>)("%s", async (name, command) => {
    const r = await policy(name).fn(bash(command));
    expect(r.decision).toBe("deny");
    expect(r.reason).not.toContain(SECRET);
  });
});
