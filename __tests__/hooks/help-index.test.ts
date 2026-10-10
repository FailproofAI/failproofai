// @vitest-environment node
//
// The top-level help used to be the reference manual: 152 lines, six screens at
// 80x24, every flag of every command inlined. It is now the 2026-10 redesign's
// index: what to do first (GET STARTED), every command by what it is for, three
// examples — plus a `failproofai help <command>` router that dispatches straight
// to `<command> --help`, so each command's documentation has exactly one copy.
//
// The redesign is taller than the old one-screen index (decision D10 allows it),
// but it still fits 80 columns: nothing on it is cut or wrapped in a default
// terminal. What will regress is the SIZE, the LAYOUT and the COMPLETENESS —
// a command added to the CLI and never to the index is invisible. So these
// drive the real binary and measure the rendered text.
//
// Widths are `String.length` on the decoded string, because a terminal column
// is a character, not a byte; the premise that the two agree here (no emoji, no
// wide characters) is itself asserted below rather than assumed.
import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BINARY = resolve(__dirname, "..", "..", "bin", "failproofai.mjs");

/** The redesign's index, with room for a row or two more — not a second screen's worth. */
const MAX_LINES = 36;
const MAX_COLUMNS = 80;
const HEADINGS = ["GET STARTED", "SET UP", "ENFORCE", "OBSERVE", "LESS OFTEN", "EXAMPLES"];

// An isolated HOME so a first-run gate, an onboarding lock, or a migration
// resolves `~/.failproofai` under a throwaway dir rather than the developer's
// real one. Created at module scope because the index is rendered once, at
// collection time, to generate the per-command cases below.
const HOME = mkdtempSync(join(tmpdir(), "fpai-help-index-"));

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function cli(...args: string[]): Run {
  const result = spawnSync("bun", [BINARY, ...args], {
    env: {
      ...process.env,
      HOME,
      USERPROFILE: HOME,
      FAILPROOFAI_TELEMETRY_DISABLED: "1",
    },
    encoding: "utf8",
    timeout: 15_000,
  });
  if (result.error) throw result.error;
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

// Rendered once, and asserted inside the tests below rather than here: an
// expect at module scope makes a layout change fail the whole FILE at
// collection, taking every unrelated routing test down with it.
const INDEX_RUN = cli("--help");
const INDEX = INDEX_RUN.stdout.replace(/\n+$/, "").split("\n");

/** The flush-left UPPERCASE headings, in order. */
const headings = (lines: string[]) => lines.filter((l) => /^[A-Z][A-Z ]+$/.test(l));

/** The indented rows under one heading, up to the next blank line. */
function rowsUnder(lines: string[], heading: string): string[] {
  const at = lines.indexOf(heading);
  if (at === -1) return [];
  const out: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === "") break;
    out.push(line);
  }
  return out;
}

/** The command words the index advertises: the first token of every row in the four command sections. */
function indexCommands(lines: string[]): string[] {
  const words = new Set<string>();
  for (const heading of ["SET UP", "ENFORCE", "OBSERVE", "LESS OFTEN"]) {
    for (const row of rowsUnder(lines, heading)) {
      const word = row.trim().split(/\s+/)[0];
      if (word && !word.startsWith("(")) words.add(word);
    }
  }
  return [...words];
}

/** The commands bin dispatches, read from its own SUBCOMMANDS list. */
function dispatchedCommands(): string[] {
  const source = readFileSync(BINARY, "utf8");
  const match = source.match(/const SUBCOMMANDS = \[([^\]]+)\]/);
  if (!match) return [];
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter((c) => c !== "help");
}

const INDEXED_COMMANDS = indexCommands(INDEX);

describe("failproofai --help — the index", () => {
  it("prints, and exits 0", () => {
    expect(INDEX_RUN.exitCode).toBe(0);
    expect(INDEX_RUN.stdout.trim().length).toBeGreaterThan(0);
  });

  it(`stays at most ${MAX_LINES} lines`, () => {
    // The number this replaced was 152.
    expect(INDEX.length).toBeLessThanOrEqual(MAX_LINES);
    // Not vacuous — an empty or truncated help must not read as "small enough".
    expect(INDEX.length).toBeGreaterThan(25);
  });

  it("wraps to no terminal — every line fits 80 display columns", () => {
    const tooWide = INDEX.filter((line) => line.length > MAX_COLUMNS).map(
      (line) => `${line.length} cols: ${line}`,
    );
    expect(tooWide).toEqual([]);
  });

  it("measures those columns in characters, and the only wide-byte character is the separator dot", () => {
    // `·` is one column and two bytes, so `String.length` IS the display width.
    // An emoji or a full-width character here would make the check above
    // silently wrong; so would an escape code, which a pipe must never carry.
    const text = INDEX.join("\n");
    expect(text).not.toContain("\x1b");
    const exotic = [...text].filter((ch) => ch.codePointAt(0)! > 126 && ch !== "·");
    expect(exotic).toEqual([]);
    const header = INDEX.find((line) => line.includes("·") && line.startsWith("failproof ai"));
    expect(header).toBeDefined();
    expect(Buffer.byteLength(header!, "utf8")).toBeGreaterThan(header!.length);
  });

  it("opens with the wordmark and the version", () => {
    const version = (JSON.parse(readFileSync(resolve(__dirname, "..", "..", "package.json"), "utf8")) as { version: string }).version;
    expect(INDEX.find((l) => l.trim() !== "")).toContain(`failproof ai  v${version}`);
  });

  it("keeps its six sections, in order", () => {
    expect(headings(INDEX)).toEqual(HEADINGS);
  });

  it("gets a newcomer started in three numbered steps, each ending in a command they can run", () => {
    const steps = rowsUnder(INDEX, "GET STARTED");
    expect(steps).toHaveLength(3);
    steps.forEach((row, i) => {
      expect(row).toMatch(new RegExp(`^\\s+${i + 1}\\s+\\S.*\\s{2,}failproofai\\b`));
    });
  });

  it("says where per-command help lives, and how to print the version", () => {
    expect(INDEX_RUN.stdout).toContain("failproofai help <command>");
    expect(INDEX_RUN.stdout).toContain("failproofai -v");
  });

  it("is the same screen from `help`, `--help`, `-h` and `help help`", () => {
    const short = cli("-h");
    const bare = cli("help");
    const twice = cli("help", "help");

    expect(short.exitCode).toBe(0);
    expect(bare.exitCode).toBe(0);
    expect(twice.exitCode).toBe(0);
    expect(short.stdout).toBe(INDEX_RUN.stdout);
    expect(bare.stdout).toBe(INDEX_RUN.stdout);
    expect(twice.stdout).toBe(INDEX_RUN.stdout);
  });
});

describe("failproofai help <command> — one copy of each command's help", () => {
  // `help <command>` is literally `<command> --help`. Assert the two spellings
  // are byte-identical, so a future rewrite cannot give one of them its own copy
  // and let the two drift.
  it.each(["policies", "config", "audit", "publish", "harness"])(
    "`help %s` is exactly what the same command's own --help prints",
    (command) => {
      const routed = cli("help", command);
      const direct = cli(command, "--help");

      expect(routed.exitCode).toBe(0);
      expect(direct.exitCode).toBe(0);
      // Not vacuous — two silent commands would otherwise compare equal.
      expect(routed.stdout.trim().length).toBeGreaterThan(0);
      expect(routed.stdout).toBe(direct.stdout);
    },
  );

  // `update` and `migrate` were missing from SUBCOMMANDS, so `--help` fell
  // through to the top-level argument check and both exited 1 with "Unexpected
  // argument" — neither command had reachable help at all.
  it.each(["update", "migrate"])(
    "reaches %s, whose --help used to exit 1 with Unexpected argument",
    (command) => {
      const routed = cli("help", command);
      const direct = cli(command, "--help");

      expect(routed.exitCode).toBe(0);
      expect(direct.exitCode).toBe(0);
      expect(direct.stderr).not.toContain("Unexpected argument");
      expect(routed.stdout.trim().length).toBeGreaterThan(0);
      expect(routed.stdout).toBe(direct.stdout);
    },
  );

  it.each(["pack", "policy", "p"])(
    "canonicalizes `help %s` to the policies help, like a typed command",
    (alias) => {
      const aliased = cli("help", alias);
      const canonical = cli("help", "policies");

      expect(aliased.exitCode).toBe(0);
      expect(aliased.stdout).toContain("failproofai policies");
      expect(aliased.stdout).toBe(canonical.stdout);
    },
  );

  it("documents --hook, which appeared in no help output before", () => {
    const run = cli("help", "hook");

    expect(run.exitCode).toBe(0);
    // It is the entry point an agent CLI spawns per tool call, and it is
    // useless without the flag that selects the payload shape — so both names
    // have to be on the page, not just the one in the topic.
    expect(run.stdout).toContain("--hook");
    expect(run.stdout).toContain("--cli");
    // And both are enumerations: neither flag can be used from its name alone.
    expect(run.stdout).toContain("PreToolUse");
    expect(run.stdout).toContain("claude");
  });

  it("sends an unknown topic back to the index rather than guessing", () => {
    const run = cli("help", "nonsense");

    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("nonsense");
    expect(run.stderr).toContain("failproofai help");
    // A clean CliError, not a stack trace.
    expect(run.stderr).not.toContain("node:internal");
  });
});

describe("the index advertises nothing it cannot explain", () => {
  it("names every command the CLI dispatches, each once — none is undiscoverable", () => {
    // The guard against the whole suite below passing on an empty list, and
    // against a command that exists but is on no screen anyone reads.
    const dispatched = dispatchedCommands();
    expect(dispatched.length).toBeGreaterThanOrEqual(10);
    expect([...INDEXED_COMMANDS].sort()).toEqual([...dispatched].sort());
  });

  it.each(INDEXED_COMMANDS)("`help %s` reaches real help, the same bytes as its own --help", (command) => {
    const run = cli("help", command);
    const direct = cli(command, "--help");

    expect(run.exitCode).toBe(0);
    expect(run.stdout.trim().length).toBeGreaterThan(0);
    expect(run.stderr).not.toContain("No help for");
    expect(run.stdout).toBe(direct.stdout);
  });
});

describe("a bare command runs, it does not describe itself", () => {
  // `failproofai publish` printed its own help and exited — while the first
  // line of that help read "TWO COMMANDS, FROM NOTHING: --init to start,
  // publish to ship it". The one command the documentation headlines was the
  // one command that did nothing, because the dispatch treated "no arguments"
  // as a request for help rather than as the whole point: everything publish
  // needs is worked out from the directory and the git remote.
  it("publish with no arguments does not print the publish help", () => {
    const empty = mkdtempSync(join(tmpdir(), "fpai-bare-publish-"));
    try {
      const run = spawnSync("bun", [BINARY, "publish"], {
        cwd: empty,
        env: { ...process.env, HOME, USERPROFILE: HOME, FAILPROOFAI_TELEMETRY_DISABLED: "1" },
        encoding: "utf8",
        timeout: 20_000,
      });
      const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
      // It has nothing to publish in an empty directory, so it must FAIL —
      // but as the command failing, not as a manual.
      // Anchored on markers the help page really prints today, so this can
      // never pass simply because the help stopped containing them.
      expect(cli("publish", "--help").stdout).toContain("Build and release it on GitHub");
      expect(out).not.toMatch(/^USAGE$/m);
      expect(out).not.toContain("Build and release it on GitHub");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("publish --help still prints it", () => {
    const run = cli("publish", "--help");
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toMatch(/^USAGE$/m);
    expect(run.stdout).toContain("failproofai publish --init [file]");
  });

  // Behaviour changed and the screen describing it did not. `publish` now
  // REFUSES an existing private repository — exit 1, nothing created — but this
  // help still promised "an existing private one still publishes, and warns",
  // and named `--allow-private` nowhere at all. So the only documentation of the
  // command told a publisher the run would go through, and left the one flag
  // that gets past the refusal discoverable only by triggering it.
  it("publish --help describes the private-repo refusal and names the way past it", () => {
    const run = cli("publish", "--help");

    expect(run.exitCode).toBe(0);
    // One line per flag now (decision D11), and no shouting: the row says the
    // default refusal is something you have to override, and what that costs.
    expect(run.stdout).toMatch(/--allow-private\s+Publish to a private repo anyway; installs will fail/);
    // The stale promise, in the words it was written in.
    expect(run.stdout).not.toMatch(/still publishes/);
  });
});
