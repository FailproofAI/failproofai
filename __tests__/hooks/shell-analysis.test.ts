// @vitest-environment node
/**
 * The shell analyser behind the hard-floor builtins (src/hooks/shell-analysis.ts).
 *
 * The floor policies are only as good as its answer to "which program runs with
 * which words", so this pins the lexing (quotes, comments, operators,
 * substitutions, heredocs, case patterns), the runner walk (sudo, env, xargs,
 * bash -c, find -exec, eval, ssh, a shell reading stdin), variable resolution,
 * and the robustness properties a hook on the critical path needs: it never
 * throws, it stays fast on large input, and it marks what it could not follow.
 */
import { describe, it, expect } from "vitest";
import {
  analyzeShell,
  basenameGlob,
  decodeAnsiC,
  firstBraceExpansion,
  lexShell,
  literalText,
  normalizeName,
  resolveWord,
  type ShellAnalysis,
} from "../../src/hooks/shell-analysis";

/** Every program name the analysis found, in order. */
const programs = (a: ShellAnalysis) => a.invocations.flatMap((inv) => inv.names);
const run = (command: string) => programs(analyzeShell(command));
/** The literal argument texts of the first invocation named `name`. */
const argsOf = (command: string, name: string) =>
  analyzeShell(command).invocations.find((inv) => inv.names.includes(name))?.args.map((w) => w.text);

describe("lexShell", () => {
  it("splits simple commands on ; && || | & and newlines", () => {
    const cmds = lexShell("a 1; b 2 && c 3 || d 4 | e 5 & f 6\ng 7");
    expect(cmds.map((c) => c.words.map((w) => w.text).join(" "))).toEqual([
      "a 1", "b 2", "c 3", "d 4", "e 5", "f 6", "g 7",
    ]);
  });

  it("links a pipeline's commands, but not across || or ;", () => {
    const [a, b, c, d] = lexShell("a | b; c || d");
    expect(b.pipedFrom).toBe(a);
    expect(c.pipedFrom).toBeUndefined();
    expect(d.pipedFrom).toBeUndefined();
  });

  it("carries a pipe across a boundary that ends no command of its own", () => {
    // The `|` arrives with no words of its own when a `)` or a newline already
    // ended the command, and the relation used to be dropped there \u2014 which is
    // how the program a piped-into shell runs reached the analysis at all.
    const [a, b] = lexShell("echo 'mkfs /dev/sda' |\n bash");
    expect(b.pipedFrom).toBe(a);
    const [c, d] = lexShell("(echo 'mkfs /dev/sda') | bash");
    expect(d.pipedFrom).toBe(c);
    const [e, f] = lexShell("echo 'mkfs /dev/sda' | ( bash )");
    expect(f.pipedFrom).toBe(e);
    expect(run("echo 'mkfs /dev/sda' | ( bash )")).toContain("mkfs");
    // A `;` still ends the pipeline.
    const [, , h] = lexShell("echo x | cat; ls");
    expect(h.pipedFrom).toBeUndefined();
  });

  it("keeps quoted text as one word and removes the quotes", () => {
    const [cmd] = lexShell(`echo "a b" 'c;d' e\\ f`);
    expect(cmd.words.map((w) => w.text)).toEqual(["echo", "a b", "c;d", "e f"]);
  });

  it("drops comments but not a # inside a word or quotes", () => {
    const cmds = lexShell("echo a#b '#c' # rm -rf /\nls");
    expect(cmds.map((c) => c.words.map((w) => w.text))).toEqual([["echo", "a#b", "#c"], ["ls"]]);
  });

  it("joins a backslash-newline continuation", () => {
    expect(lexShell("mk\\\nfs /dev/sda")[0].words[0].text).toBe("mkfs");
  });

  it("lexes the bodies of $( ), backticks and process substitutions as commands", () => {
    expect(run("echo $(mkfs /dev/sda) `wipefs -a /dev/sdb` <(dd if=x)")).toEqual(
      expect.arrayContaining(["echo", "mkfs", "wipefs", "dd"]),
    );
  });

  it("keeps an expansion's source in the word text", () => {
    const [cmd] = lexShell(`x "$HOME/a" \${R:-rm} $(echo hi)`);
    expect(cmd.words.map((w) => w.text)).toEqual(["x", "$HOME/a", "${R:-rm}", "$(echo hi)"]);
  });

  it("separates redirection operators and their targets", () => {
    const [cmd] = lexShell("cmd 2>/dev/null >>log &>all >&2 <in");
    expect(cmd.words.filter((w) => w.redirect).map((w) => w.redirect)).toEqual(["2>", ">>", "&>", ">&", "<"]);
  });

  it("treats a quoted heredoc body as data", () => {
    const text = "cat > notes.md <<'EOF'\nrm -rf /\ngit commit --no-verify\nEOF\nls";
    expect(run(text)).toEqual(["cat", "ls"]);
  });

  it("runs only the substitutions of an unquoted heredoc body", () => {
    const text = "cat <<EOF\nplain rm -rf / text\n$(mkfs /dev/sda)\nEOF\n";
    expect(run(text)).toEqual(["cat", "mkfs"]);
  });

  it("finds the end of $( ) past a heredoc with an apostrophe — the commit-message idiom", () => {
    const text = `git commit -m "$(cat <<'EOF'\nDon't (really) break it\nEOF\n)" && git push --no-verify`;
    const a = analyzeShell(text);
    expect(programs(a)).toEqual(["git", "git", "cat"]);
    expect(a.invocations[1].args.map((w) => w.text)).toEqual(["push", "--no-verify"]);
  });

  it("does not read case patterns as commands", () => {
    const text = `for f in *; do case "$f" in ./a/*|./b/*|r?) continue;; *.py) python3 "$f";; esac; done`;
    expect(run(text)).toEqual(["continue", "python3"]);
  });

  it("never throws on malformed input", () => {
    for (const bad of ["echo 'unterminated", 'echo "x', "echo $(", "echo ${", "cat <<EOF\nno end", "a | | b", ")))", "`", "$'\\x"]) {
      expect(() => analyzeShell(bad)).not.toThrow();
    }
  });
});

describe("the runner walk", () => {
  it.each([
    ["sudo -u root nice -n 5 timeout 10 mkfs /dev/sda", "mkfs"],
    ["env -i FOO=1 mkfs /dev/sda", "mkfs"],
    ["xargs -n1 -P4 wipefs -a", "wipefs"],
    ["bash -lc 'mkfs /dev/sda'", "mkfs"],
    ["bash -euo pipefail -c 'mkfs /dev/sda'", "mkfs"],
    ["find . -name x -exec shred {} \\;", "shred"],
    ["eval 'mkfs /dev/sda'", "mkfs"],
    ["env -S 'mkfs /dev/sda'", "mkfs"],
    ["ssh -p 22 host 'mkfs /dev/sda'", "mkfs"],
    ["echo 'mkfs /dev/sda' | bash", "mkfs"],
    ["bash <<< 'mkfs /dev/sda'", "mkfs"],
    ["sh <<'EOF'\nmkfs /dev/sda\nEOF", "mkfs"],
    ["busybox mkfs /dev/sda", "mkfs"],
    ["if mkfs /dev/sda; then :; fi", "mkfs"],
    ["{ mkfs /dev/sda; }", "mkfs"],
    ["(cd / && mkfs /dev/sda)", "mkfs"],
    ["pwsh -Command Clear-Disk -Number 1", "clear-disk"],
    ["cmd /c format C:", "format"],
  ])("%s runs %s", (command, name) => {
    expect(run(command)).toContain(name);
  });

  it("does not treat `command -v` or `sudo -l` as running their operand", () => {
    expect(run("command -v mkfs")).not.toContain("mkfs");
    expect(run("sudo -l mkfs")).not.toContain("mkfs");
  });

  it("does not treat a script operand as a -c string", () => {
    expect(run("bash script.sh mkfs")).toEqual(["bash"]);
  });

  it("normalizes program names: basename, lower case, .exe dropped", () => {
    expect(normalizeName("/usr/sbin/MKFS.ext4")).toBe("mkfs.ext4");
    expect(normalizeName("C:\\Windows\\taskkill.exe")).toBe("taskkill");
    expect(run("/sbin/wipefs -a /dev/sdb")).toEqual(["wipefs"]);
  });

  it("walks thousands of stacked runners without recursing, and says it stopped", () => {
    const a = analyzeShell("sudo ".repeat(5000) + "mkfs /dev/sda");
    expect(a.truncated).toBe(true);
  });
});

describe("resolution", () => {
  const firstIndirect = (command: string) => analyzeShell(command).invocations.find((i) => i.indirect);

  it.each([
    ["R=/bin/rm; $R -rf x", "rm"],
    ["X=/sbin/mkfs.ext4; ${X} /dev/sda", "mkfs.ext4"],
    ["export D=dd; $D if=a", "dd"],
    ["for c in shred wipefs; do $c x; done", "shred"],
    ["read -r R <<< rm; $R x", "rm"],
    ["set -- rm -rf x; \"$@\"", "rm"],
    ["A=(rm -rf x); \"${A[@]}\"", "rm"],
    ["printf -v R rm; $R x", "rm"],
    ["${UNSET:-rm} -rf x", "rm"],
    ["P=R; R=rm; ${!P} x", "rm"],
    ["$(echo rm) x", "rm"],
    ["$(which rm) x", "rm"],
    ["$(command -v dd) if=a", "dd"],
    ["`printf rm` x", "rm"],
    ["$'\\x72\\x6d' x", "rm"],
    ["{rm,-rf,x}", "rm"],
    ["a=r; b=m; $a$b x", "rm"],
  ])("%s resolves to %s", (command, name) => {
    expect(firstIndirect(command)?.names).toContain(name);
  });

  it("leaves a variable the command never assigns unresolved", () => {
    const inv = firstIndirect("$EDITOR file");
    expect(inv?.indirect).toBe(true);
    expect(inv?.names).toEqual([]);
  });

  it("resolves an argument word too", () => {
    const a = analyzeShell("DEV=/dev/sda; dd of=$DEV");
    const dd = a.invocations.find((i) => i.names.includes("dd"))!;
    expect(resolveWord(a, dd.args[0])).toEqual(["of=/dev/sda"]);
  });

  it("stays polynomial on self-referencing and wide bindings", () => {
    const wide = Array.from({ length: 30 }, (_, i) => `V${i}=$V${i + 1}$V${i + 1}$V${i + 1}`).join("; ");
    const t = performance.now();
    analyzeShell(`${wide}; V30=x; A=$B; B=$A; $V0 -rf /; $A`).invocations.forEach(() => {});
    const a = analyzeShell(`${wide}; V30=x; $V0 x`);
    resolveWord(a, a.invocations[a.invocations.length - 1].word);
    expect(performance.now() - t).toBeLessThan(2000);
  });
});

describe("word helpers", () => {
  it("literalText is null for expansions, unquoted globs, braces and $'\\x..'", () => {
    const words = lexShell(`a "b*" c* {x,y} $'\\x41' $V [ [[`)[0].words;
    expect(words.map(literalText)).toEqual(["a", "b*", null, null, null, null, "[", "[["]);
  });

  it("basenameGlob matches only unquoted glob characters, on the basename", () => {
    const [w1, w2, w3] = lexShell(`/???/r? "r?" ./dir*/run`)[0].words;
    expect(basenameGlob(w1)?.test("rm")).toBe(true);
    expect(basenameGlob(w2)).toBeNull();
    expect(basenameGlob(w3)?.test("rm")).toBe(false);
  });

  it("firstBraceExpansion expands the first alternative", () => {
    expect(firstBraceExpansion(lexShell("{rm,-rf,/}")[0].words[0])).toBe("rm");
    expect(firstBraceExpansion(lexShell("'{rm,x}'")[0].words[0])).toBeNull();
  });

  it("decodeAnsiC handles hex, octal, unicode and named escapes", () => {
    expect(decodeAnsiC("\\x72\\155\\u0066s\\n")).toBe("rmfs\n");
  });
});

describe("robustness on the hook path", () => {
  it("analyses a 200 KB command quickly and without truncating it", () => {
    const filler = "echo " + "x".repeat(200_000);
    const t = performance.now();
    const names = run(`${filler}; mkfs /dev/sda`);
    expect(performance.now() - t).toBeLessThan(2000);
    // A floor with a blind spot after byte 8,192 is not a floor.
    expect(names).toContain("mkfs");
  });

  it("marks, rather than blows the stack on, absurd substitution nesting", () => {
    const deep = '"$('.repeat(3000) + "mkfs /dev/sda" + ')"'.repeat(3000);
    let a: ShellAnalysis | undefined;
    expect(() => { a = analyzeShell(`echo ${deep}`); }).not.toThrow();
    expect(a!.truncated).toBe(true);
  });

  it("marks nesting deeper than it follows", () => {
    expect(analyzeShell("echo " + "$(echo ".repeat(12) + "x" + ")".repeat(12)).truncated).toBe(true);
    expect(analyzeShell("echo $(echo $(echo x))").truncated).toBe(false);
  });

  it("reports the arguments after redirections are removed", () => {
    expect(argsOf("tee -a 2>/dev/null /dev/sda", "tee")).toEqual(["-a", "/dev/sda"]);
  });
});
