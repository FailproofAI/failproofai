/**
 * Differential test: `src/policy-runtime/pure-path.ts` vs `node:path.posix`.
 *
 * The sealed tier has no `node:path`, so three sealed-eligible builtins do
 * their path arithmetic through a reimplementation. A reimplementation that is
 * *nearly* right is the worst possible outcome here: `block-read-outside-cwd`
 * uses `resolve()` to decide whether a path is inside the project, and
 * `isAgentInternalPath` uses `join()` to build the `~/.claude` prefix it
 * whitelists. An off-by-one in `..` handling or a mishandled trailing slash
 * does not throw — it silently whitelists a directory, or silently stops
 * whitelisting one, and the policy keeps returning confident verdicts.
 *
 * So this asserts equivalence against the real thing over a generated corpus
 * rather than checking a handful of examples. Every input below is run through
 * both implementations and compared exactly. If Node ever changes its
 * normalisation, this fails and tells us, which is the correct outcome — the
 * sealed and legacy tiers must agree, whichever way they move.
 */
import { describe, it, expect } from "vitest";
import { posix } from "node:path";
import { resolve, join, normalize } from "../../src/policy-runtime/pure-path";

/**
 * Segments chosen for the ways they break naive implementations: relative
 * markers, empty strings, redundant and trailing separators, dotfiles, names
 * that merely start with a dot, and a name containing a space.
 */
const SEGMENTS = [
  "/",
  "//",
  "",
  ".",
  "..",
  "...",
  "a",
  "a/",
  "/a",
  "/a/",
  "a//b",
  "a/./b",
  "a/../b",
  "../a",
  "./a",
  ".claude",
  ".config/opencode",
  "home/u",
  "/home/u",
  "/home/u/",
  "tmp",
  "/tmp/../etc/passwd",
  "/../..",
  "../../..",
  "my dir",
  ".env",
  "x/y/z",
  "/a/b/../../c",
];

/** Every ordered pair and triple, plus each segment alone. */
function corpus(): string[][] {
  const cases: string[][] = [];
  for (const a of SEGMENTS) {
    cases.push([a]);
    for (const b of SEGMENTS) {
      cases.push([a, b]);
      // Triples over a smaller slice keeps the corpus meaningful without
      // making the suite slow; the interesting interactions are pairwise.
      for (const c of SEGMENTS.slice(0, 8)) cases.push([a, b, c]);
    }
  }
  return cases;
}

const CASES = corpus();

describe("pure-path matches node:path.posix", () => {
  it(`resolve() agrees on all ${CASES.length} generated cases`, () => {
    const mismatches: Array<{ args: string[]; ours: string; node: string }> = [];
    for (const args of CASES) {
      // `posix.resolve` falls back to process.cwd(); ours falls back to "/".
      // Only compare cases where the fallback cannot be reached, i.e. at least
      // one argument is absolute — which is the contract every call site in the
      // builtins satisfies. The fallback itself is asserted separately below.
      if (!args.some((a) => a.startsWith("/"))) continue;
      const ours = resolve(...args);
      const theirs = posix.resolve(...args);
      if (ours !== theirs) mismatches.push({ args, ours, node: theirs });
    }
    expect(mismatches).toEqual([]);
  });

  it(`join() agrees on all ${CASES.length} generated cases`, () => {
    const mismatches: Array<{ args: string[]; ours: string; node: string }> = [];
    for (const args of CASES) {
      const ours = join(...args);
      const theirs = posix.join(...args);
      if (ours !== theirs) mismatches.push({ args, ours, node: theirs });
    }
    expect(mismatches).toEqual([]);
  });

  it("normalize() agrees on every single segment", () => {
    const mismatches: Array<{ arg: string; ours: string; node: string }> = [];
    for (const arg of SEGMENTS) {
      if (arg === "") continue; // posix.normalize("") is "." — asserted below.
      const ours = normalize(arg);
      const theirs = posix.normalize(arg);
      if (ours !== theirs) mismatches.push({ arg, ours, node: theirs });
    }
    expect(mismatches).toEqual([]);
    expect(normalize("")).toBe(posix.normalize(""));
  });

  it("the corpus is large enough to be meaningful", () => {
    // Anti-vacuity: if `corpus()` ever returns [] the three tests above pass
    // while asserting nothing.
    expect(CASES.length).toBeGreaterThan(5000);
  });
});

describe("the sealed cwd fallback", () => {
  it("resolves a wholly relative path against / rather than a real cwd", () => {
    // Node would use process.cwd() here. The sealed context has no process,
    // and the daemon's own cwd is wherever it was launched — wrong for the
    // session being enforced, and wrong the same way for all of them. "/" is
    // chosen so the result is still a well-formed absolute path.
    expect(resolve("a", "b")).toBe("/a/b");
    expect(resolve(".")).toBe("/");
    expect(resolve("")).toBe("/");
  });

  it("never returns a relative path", () => {
    for (const args of CASES) {
      expect(resolve(...args).startsWith("/")).toBe(true);
    }
  });
});

describe("the cases the builtins actually depend on", () => {
  // Spelled out separately from the generated corpus because these are the
  // exact shapes `block-read-outside-cwd` and `isAgentInternalPath` construct,
  // and a reader should be able to see them without running the generator.
  const cwd = "/home/u/project";

  it("keeps an in-project file inside the project", () => {
    expect(resolve(cwd, "src/index.ts")).toBe("/home/u/project/src/index.ts");
    expect(resolve(cwd, "src/index.ts").startsWith(`${cwd}/`)).toBe(true);
  });

  it("escapes the project when the path climbs out of it", () => {
    expect(resolve(cwd, "../../../etc/passwd")).toBe("/etc/passwd");
    expect(resolve(cwd, "../../../etc/passwd").startsWith(`${cwd}/`)).toBe(false);
  });

  it("cannot be tricked past the project boundary by a redundant prefix", () => {
    // `/home/u/project-other` must NOT count as inside `/home/u/project`.
    // The policy's own `cwd + "/"` comparison is what enforces that; this
    // asserts resolve() does not normalise the two together.
    expect(resolve(cwd, "/home/u/project-other/x")).toBe("/home/u/project-other/x");
    expect(resolve(cwd, "/home/u/project-other/x").startsWith(`${cwd}/`)).toBe(false);
  });

  it("builds the agent-internal prefixes the whitelist compares against", () => {
    expect(join("/home/u", ".claude")).toBe("/home/u/.claude");
    expect(join(".config", "opencode")).toBe(".config/opencode");
    expect(join("/home/u", join(".local", "share", "opencode"))).toBe(
      "/home/u/.local/share/opencode",
    );
  });

  it("collapses a traversal that lands exactly on the whitelisted root", () => {
    expect(resolve(cwd, "/home/u/.claude/../.claude/settings.json")).toBe(
      "/home/u/.claude/settings.json",
    );
  });
});
