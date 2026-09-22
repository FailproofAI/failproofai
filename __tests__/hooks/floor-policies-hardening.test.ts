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

  it("a command built to exhaust the analysis budget is denied, quickly", async () => {
    const runners = "su sg script flock watch parallel env eval ssh sudo nice timeout xargs strace " + shells;
    const cmd = Array(16).fill(nestVar(6, HARMLESS, runners)).join("; ");
    const t = performance.now();
    for (const name of FLOOR) expect(await decide(name, cmd)).toBe("deny");
    expect(performance.now() - t).toBeLessThan(1500);
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
