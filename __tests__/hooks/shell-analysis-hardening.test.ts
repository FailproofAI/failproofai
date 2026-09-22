// @vitest-environment node
/**
 * Review round 1 of the shell analyser (src/hooks/shell-analysis.ts): the
 * properties the hard floor leans on that the first version lacked — bounded
 * cost, prototype-safe lookups, wrappers beyond sudo/env, directory changes,
 * and resolution that says when it gave up instead of answering "unknown".
 */
import { describe, it, expect } from "vitest";
import {
  analyzeShell,
  basenameGlob,
  lexShell,
  literalText,
  resolveWord,
  type ShellAnalysis,
} from "../../src/hooks/shell-analysis";

const programs = (a: ShellAnalysis) => a.invocations.flatMap((inv) => inv.names);
const run = (command: string) => programs(analyzeShell(command));

describe("runners", () => {
  it.each([
    ["pkexec mkfs /dev/sda", "mkfs"],
    ["pkexec --user root mkfs /dev/sda", "mkfs"],
    ["run0 -u root mkfs /dev/sda", "mkfs"],
    ["su -c 'mkfs /dev/sda'", "mkfs"],
    ["su root -c 'mkfs /dev/sda'", "mkfs"],
    ["su -lc 'mkfs /dev/sda'", "mkfs"],
    ["su --command='mkfs /dev/sda' root", "mkfs"],
    ["runuser -u root -- mkfs /dev/sda", "mkfs"],
    ["runuser - root -c 'mkfs /dev/sda'", "mkfs"],
    ["sg disk -c 'mkfs /dev/sda'", "mkfs"],
    ["sg disk 'mkfs /dev/sda'", "mkfs"],
    ["setpriv --reuid=0 --regid 0 --clear-groups mkfs /dev/sda", "mkfs"],
    ["strace -f -e trace=all mkfs /dev/sda", "mkfs"],
    ["ltrace -o log mkfs /dev/sda", "mkfs"],
    ["flock /tmp/l mkfs /dev/sda", "mkfs"],
    ["flock -w 5 /tmp/l -c 'mkfs /dev/sda'", "mkfs"],
    ["taskset 0x1 mkfs /dev/sda", "mkfs"],
    ["chrt -r 5 mkfs /dev/sda", "mkfs"],
    ["script -qc 'mkfs /dev/sda' /dev/null", "mkfs"],
    ["script -q /dev/null mkfs /dev/sda", "mkfs"],
    ["watch -n1 'mkfs /dev/sda'", "mkfs"],
    ["systemd-run --wait -p X=y mkfs /dev/sda", "mkfs"],
    ["unshare -rm mkfs /dev/sda", "mkfs"],
    ["nsenter -t 1 -a mkfs /dev/sda", "mkfs"],
    ["firejail --private mkfs /dev/sda", "mkfs"],
    ["parallel -j4 mkfs ::: /dev/sda", "mkfs"],
    ["sudo -iu root mkfs /dev/sda", "mkfs"],
    ["sudo -Hu root mkfs /dev/sda", "mkfs"],
    ["timeout $T mkfs /dev/sda", "mkfs"],
    ["env -iS 'mkfs /dev/sda'", "mkfs"],
    ["env --split-string='mkfs' /dev/sda", "mkfs"],
  ])("%s runs %s", (command, name) => {
    expect(run(command)).toContain(name);
  });

  it.each([
    ["taskset -p 1234", "1234"],
    ["taskset -pc 0 1234", "0"],
    ["chrt -p 1234", "1234"],
    ["su root", "root"],
    ["script out.log", "out.log"],
    ["command -pv mkfs", "mkfs"],
  ])("%s does not run %s", (command, name) => {
    expect(run(command)).not.toContain(name);
  });

  // getopt reads a value bundled into its flag's word: `-c'cmd'` is `-ccmd`.
  it.each([
    ["su -c'mkfs /dev/sda'", "mkfs"],
    ["su -lc'mkfs /dev/sda' root", "mkfs"],
    ["script -qc'mkfs /dev/sda' /dev/null", "mkfs"],
    ["flock -c'mkfs /dev/sda' /tmp/l", "mkfs"],
    ["sg disk -c'mkfs /dev/sda'", "mkfs"],
  ])("%s runs %s from the value bundled with its flag", (command, name) => {
    expect(run(command)).toContain(name);
  });

  it.each([
    ["script -qc'mkfs /dev/sda' /dev/null", "null"],
    ["flock -c'mkfs /dev/sda' /tmp/l", "l"],
  ])("%s does not run its operand %s as the command", (command, name) => {
    expect(run(command)).not.toContain(name);
  });

  it("runs a GNU parallel template once per argument", () => {
    const a = analyzeShell("parallel 'wipefs -a {}' ::: /dev/sdb /dev/sdc");
    const wipes = a.invocations.filter((i) => i.names.includes("wipefs")).map((i) => i.args.map((w) => w.text).join(" "));
    expect(wipes).toEqual(expect.arrayContaining(["-a /dev/sdb", "-a /dev/sdc"]));
  });

  it("looks runner names up as own properties only", () => {
    for (const name of ["constructor", "__proto__", "hasOwnProperty", "toString"]) {
      let a: ShellAnalysis | undefined;
      expect(() => { a = analyzeShell(`${name} -x -y; mkfs /dev/sda`); }).not.toThrow();
      expect(programs(a!)).toEqual([name.toLowerCase(), "mkfs"]);
    }
  });
});

describe("directory changes", () => {
  it.each([
    ["cd /dev", [["/dev"]]],
    ["pushd /srv", [["/srv"]]],
    ["cd", [["~"]]],
    ["cd -", []],
    ["cd -P /dev", [["/dev"]]],
    ["D=/opt; cd $D", [["/opt"]]],
    ['cd "$UNSET"', [null]],
    ["env -C /tmp ls", [["/tmp"]]],
    ["env --chdir=/tmp ls", [["/tmp"]]],
    ["sudo -D /var ls", [["/var"]]],
    ["run0 --chdir /var ls", [["/var"]]],
    ["systemd-run --working-directory=/var ls", [["/var"]]],
    ["unshare -w /var ls", [["/var"]]],
  ] as Array<[string, Array<string[] | null>]>)("%s", (command, chdirs) => {
    expect(analyzeShell(command).chdirs).toEqual(chdirs);
  });

  it.each([
    ["sudo -D/var ls", [["/var"]]],
    ["env -C/tmp ls", [["/tmp"]]],
  ] as Array<[string, Array<string[] | null>]>)("%s: a directory bundled with its flag", (command, chdirs) => {
    const a = analyzeShell(command);
    expect(a.chdirs).toEqual(chdirs);
    expect(programs(a)).toContain("ls");
  });

  it("still flags a cd into /dev", () => {
    expect(analyzeShell("cd /dev && ls").cdIntoDev).toBe(true);
    expect(analyzeShell("cd /srv && ls").cdIntoDev).toBe(false);
  });
});

describe("resolution", () => {
  it("does not let a resolution made mid-cycle poison a later one", () => {
    const a = analyzeShell('A=rm; B=$A; A=$B; cd "$A"; $B x');
    expect(a.invocations.find((i) => i.word.text === "$B")?.names).toEqual(["rm"]);
  });

  it("re-reads a name after a nested source binds it again", () => {
    const a = analyzeShell("X=ls; cd $X; bash -c 'X=rm; $X y'");
    expect(a.invocations.find((i) => i.word.text === "$X")?.names).toEqual(expect.arrayContaining(["rm"]));
  });

  it("resolves a head again when a later eval binds what it reads", () => {
    const a = analyzeShell("f() { $X y; }; eval X=rm; f");
    expect(a.invocations.find((i) => i.word.text === "$X")?.names).toEqual(["rm"]);
  });

  it("follows a 12-hop chain and marks a deeper one truncated", () => {
    const chain = (n: number) =>
      Array.from({ length: n }, (_, i) => (i === 0 ? "V0=rm" : `V${i}=$V${i - 1}`)).join("; ") + `; $V${n - 1} x`;
    const ok = analyzeShell(chain(12));
    expect(ok.truncated).toBe(false);
    expect(ok.invocations.at(-1)?.names).toEqual(["rm"]);
    expect(analyzeShell(chain(20)).truncated).toBe(true);
  });

  it("marks a command word read from an over-full variable truncated, not an argument", () => {
    const items = Array.from({ length: 300 }, (_, i) => `v${i}`).join(" ");
    expect(analyzeShell(`for c in ${items}; do $c x; done`).truncated).toBe(true);
    expect(analyzeShell(`for f in ${items}; do cat $f; done`).truncated).toBe(false);
  });

  it("gives each resolveWord call its own budget, so repeated calls never add up", () => {
    const a = analyzeShell("X=$(echo /dev/sda); dd of=$X");
    const dd = a.invocations.find((i) => i.names.includes("dd"))!;
    for (let k = 0; k < 20_000; k++) resolveWord(a, dd.args[0]);
    expect(a.truncated).toBe(false);
    expect(resolveWord(a, dd.args[0])).toEqual(["of=/dev/sda"]);
  });
});

describe("the analysis budget", () => {
  const shells = "sh bash zsh dash ksh mksh ash fish yash pwsh powershell";
  const nest = (levels: number, values: string) => {
    let s = "echo hi";
    for (let i = 0; i < levels; i++) s = `$S -c '${s.replace(/'/g, `'\\''`)}'`;
    return `for S in ${values}; do :; done; ${s}`;
  };

  it("reads the same -c string once however many shells a variable names", () => {
    const a = analyzeShell(nest(6, shells));
    expect(a.truncated).toBe(false);
    expect(a.invocations.length).toBeLessThan(40);
  });

  // 16 copies bind 400 values to S, past the 256 kept, so this one is marked
  // truncated by the binding overflow before it reaches the budget.
  it("marks a command word read from a variable bound to 400 runners truncated (binding overflow)", () => {
    const runners = "su sg script flock watch parallel env eval ssh sudo nice timeout xargs strace " + shells;
    const a = analyzeShell(Array(16).fill(nest(6, runners)).join("; "));
    expect(a.truncated).toBe(true);
  });

  // A template GNU parallel analyses once, then once per argument: 17 × 10,000
  // invocations. No variable, one level of nesting, one runner hop — nothing
  // but the budget can stop it.
  const parallelRuns = (invocations: number) =>
    `parallel '${"a; ".repeat(invocations)}' ::: ${Array.from({ length: 16 }, (_, i) => `x${i}`).join(" ")}`;

  it("marks a command that exhausts it truncated, with no binding, depth or hop cap involved", () => {
    const a = analyzeShell(parallelRuns(10_000));
    expect(a.bindings.size).toBe(0);
    expect(a.truncated).toBe(true);
    // The same shape at half the size stays inside the budget, so the caps that
    // do not depend on size are not what truncated it.
    expect(analyzeShell(parallelRuns(5_000)).truncated).toBe(false);
  });

  it("gives resolveWord calls a budget of their own: calls costing twice the analysis's in total never truncate it", () => {
    // A substitution is not memoized, so each call lexes its 20 KB body again:
    // 200 calls spend ~4M units against an analysis budget of ~2.3M.
    const a = analyzeShell(`dd of=$(echo${" ".repeat(20_000)} /dev/sda)`);
    expect(a.truncated).toBe(false);
    const dd = a.invocations.find((i) => i.names.includes("dd"))!;
    for (let k = 0; k < 200; k++) expect(resolveWord(a, dd.args[0])).toEqual(["of=/dev/sda"]);
    expect(a.truncated).toBe(false);
  });

  it("marks the analysis truncated when a single resolveWord call runs past its own budget", () => {
    const a = analyzeShell(`dd of=$(echo${" ".repeat(600_000)} /dev/sda)`);
    expect(a.truncated).toBe(false);
    const dd = a.invocations.find((i) => i.names.includes("dd"))!;
    expect(resolveWord(a, dd.args[0])).toBeNull();
    expect(a.truncated).toBe(true);
  });

  it("never meets a large ordinary command", () => {
    expect(analyzeShell("cat > big.txt <<'EOF'\n" + "line of text\n".repeat(80_000) + "EOF").truncated).toBe(false);
    expect(analyzeShell("bash <<'EOF'\n" + "echo line $i\n".repeat(20_000) + "EOF").truncated).toBe(false);
    expect(analyzeShell("echo " + "x ".repeat(300_000)).truncated).toBe(false);
  });
});

describe("linear-time word helpers", () => {
  it("literalText sees exactly the brace expansions the old regex saw", () => {
    const lit = (s: string) => literalText(lexShell(s)[0].words[0]);
    expect(lit("{a,b}")).toBeNull();
    expect(lit("{1..3}")).toBeNull();
    expect(lit("{a{b,c}")).toBeNull();
    expect(lit("{a,{b}")).toBeNull();
    expect(lit("x{a,b}y")).toBeNull();
    expect(lit("{}")).toBe("{}");
    expect(lit("{a}")).toBe("{a}");
    expect(lit("a}b,{c")).toBe("a}b,{c");
    expect(lit("{a.b}")).toBe("{a.b}");
  });

  it("basenameGlob folds a run of `*` into one term, and gives up on an absurd glob", () => {
    const g = basenameGlob(lexShell("/bin/r****m")[0].words[0])!;
    expect(g.source).not.toContain(".*.*");
    expect(g.test("rm")).toBe(true);
    const huge = basenameGlob(lexShell("/" + "?".repeat(5000))[0].words[0])!;
    expect(huge.test("rm")).toBe(true);
  });
});
