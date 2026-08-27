// @vitest-environment node
//
// The top-level help used to be the reference manual: 152 lines, six screens at
// 80x24, every flag of every command inlined. It is now ONE screen of what
// exists, plus a `failproofai help <command>` router that dispatches straight to
// `<command> --help`, so each command's documentation has exactly one copy.
//
// The thing that will regress is not the wording — it is the SIZE and the
// LAYOUT. Both are properties nobody re-measures: the first person to add a
// command adds a row, the screen quietly becomes two, and nothing anywhere
// notices. So these drive the real binary and measure the rendered bytes.
//
// A note on the measurement, because getting it wrong makes the test lie: the
// section rules are U+2501, three bytes each, so a line's UTF-8 byte length is
// far larger than the width it occupies on screen. Terminal columns are what
// matters, so every width here is `String.length` on the DECODED string, and
// the premise that those two agree — no emoji, no wide characters — is itself
// asserted below rather than assumed.
import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BINARY = resolve(__dirname, "..", "..", "bin", "failproofai.mjs");

/** The contract: one screen, in a terminal nobody has resized. */
const MAX_LINES = 30;
const MAX_COLUMNS = 80;

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

/** The index, as lines, with the trailing blank `console.log` adds removed. */
function indexLines(): string[] {
  const run = cli("--help");
  expect(run.exitCode).toBe(0);
  return run.stdout.replace(/\n+$/, "").split("\n");
}

/**
 * The command words the index advertises.
 *
 * The rows sit between the first section rule and the footer, which opens with
 * the `failproofai help <command>` pointer; each is `<command spec>  <desc>`,
 * separated by a run of two or more spaces. A spec may name alternatives
 * (`harness, flush, backfill`) or a command plus its flags (`policies add`,
 * `config --status`) — the command word is the first token of each
 * alternative, and `(no args)` names no command at all.
 *
 * Blank lines are SKIPPED, not a terminator. They used to be one, because the
 * sections were flush against each other and the only blank on the screen was
 * the one before the footer. The sections breathe now, so stopping at the first
 * blank would have read section one and reported the other three as commands
 * the index does not advertise.
 */
function indexCommands(lines: string[]): string[] {
  const firstRule = lines.findIndex((l) => l.includes("━"));
  expect(firstRule).toBeGreaterThan(-1);

  const rows: string[] = [];
  for (const line of lines.slice(firstRule)) {
    if (line.includes("failproofai help")) break;
    if (line.trim() === "") continue;
    if (line.includes("━")) continue;
    rows.push(line);
  }
  // Not vacuous: the loop above must actually have found the body, not stopped
  // on the first line it saw.
  expect(rows.length).toBeGreaterThan(5);

  const commands = new Set<string>();
  for (const row of rows) {
    const spec = row.trim().split(/\s{2,}/)[0];
    for (const alternative of spec.split(",")) {
      const word = alternative.trim().split(/\s+/)[0];
      if (!word || word.startsWith("(") || word.startsWith("-")) continue;
      commands.add(word);
    }
  }
  return [...commands];
}

const INDEX = indexLines();
const INDEXED_COMMANDS = indexCommands(INDEX);

describe("failproofai --help — the screen that replaced the manual", () => {
  it(`stays inside one screen — at most ${MAX_LINES} lines`, () => {
    // The number this replaced was 152. The slack above the current height is
    // deliberate: a few more rows are fine, a second screen is not.
    expect(INDEX.length).toBeLessThanOrEqual(MAX_LINES);
    // Not vacuous — an empty or truncated help must not read as "small enough".
    expect(INDEX.length).toBeGreaterThan(10);
  });

  it("wraps to no terminal — every line fits 80 display columns", () => {
    const tooWide = INDEX.filter((line) => line.length > MAX_COLUMNS).map(
      (line) => `${line.length} cols: ${line}`,
    );
    expect(tooWide).toEqual([]);
  });

  it("measures those columns in characters, because the rules are multibyte", () => {
    // The premise the width check rests on, asserted rather than trusted: the
    // only non-ASCII character on the screen is the box rule, which is one
    // column wide, so `String.length` IS the display width. An emoji or a
    // full-width character here would make the check above silently wrong.
    const exotic = [...INDEX.join("\n")].filter(
      (ch) => ch.codePointAt(0)! > 126 && ch !== "━",
    );
    expect(exotic).toEqual([]);

    // And the distinction is live, not theoretical: a rule line really does
    // carry more bytes than columns, so measuring a Buffer would have failed
    // the 80-column check on a screen that fits perfectly.
    const rule = INDEX.find((line) => line.includes("━"));
    expect(rule).toBeDefined();
    expect(Buffer.byteLength(rule!, "utf8")).toBeGreaterThan(rule!.length);
  });

  it("keeps the four sections it groups the commands into", () => {
    const rules = INDEX.filter((line) => line.includes("━"));
    expect(rules).toHaveLength(4);
  });

  it("is the same screen from `help`, `--help` and `-h`", () => {
    const long = cli("--help");
    const short = cli("-h");
    const bare = cli("help");

    expect(long.exitCode).toBe(0);
    expect(short.exitCode).toBe(0);
    expect(bare.exitCode).toBe(0);
    expect(long.stdout).toContain("failproofai help <command>");

    expect(short.stdout).toBe(long.stdout);
    expect(bare.stdout).toBe(long.stdout);
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
  it("names the commands this parse is about to check", () => {
    // The guard against the whole suite below passing on an empty list: if the
    // index layout changes shape, this fails loudly instead of checking nothing.
    expect(INDEXED_COMMANDS.length).toBeGreaterThanOrEqual(10);
    expect(INDEXED_COMMANDS).toEqual(
      expect.arrayContaining(["config", "policies", "audit", "uninstall"]),
    );
  });

  it.each(INDEXED_COMMANDS)("`help %s` reaches real help", (command) => {
    const run = cli("help", command);

    expect(run.exitCode).toBe(0);
    expect(run.stdout.trim().length).toBeGreaterThan(0);
    expect(run.stderr).not.toContain("No help for");
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
      expect(out).not.toMatch(/two commands, from nothing/i);
      expect(out).not.toMatch(/what --init does/i);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("publish --help still prints it", () => {
    const run = cli("publish", "--help");
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toMatch(/two commands, from nothing/i);
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
    expect(run.stdout).toMatch(/--allow-private/);
    expect(run.stdout).toMatch(/REFUSED/);
    // The stale promise, in the words it was written in.
    expect(run.stdout).not.toMatch(/still publishes/);
  });
});
