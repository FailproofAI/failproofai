// @vitest-environment node
/**
 * Commit versioning for published packs — `a1b2c3d4e5f6`, twelve hex characters
 * of the commit the bytes were built from.
 *
 * This file REPLACES `pack-calendar-version.test.ts`, which asserted the
 * `2026.08.26` / `2026.08.26-2` scheme and the clamp that kept a second
 * publisher from minting a version beneath one already released. That scheme is
 * gone: it answered "when" when the only question a pack version is asked is
 * "which source produced these bytes", and answering it needed a clock and a
 * round trip to the release list. Every expectation in the old file was about
 * values this code no longer computes, so it is deleted rather than adapted —
 * and the last describe block here is what keeps it from coming back.
 *
 * The two version functions are pure: no clock, no network, no filesystem. The
 * provenance `versionForPublish` decides from is an ordinary argument, so the
 * cases it REFUSES — no git checkout, a dirty tree, a sha that is not one — are
 * plain values here rather than a faked repository.
 *
 * The last describe block is the exception, and says why in its own comment: the
 * half that READS provenance out of git has a failure no pure test can reach.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PACK_COMMIT_RE, PACK_VERSION_RE } from "@/src/hooks/pack-manifest";
import * as packCli from "@/src/hooks/pack-cli";
import { VERSION_SHA_LENGTH, versionForPublish, versionFromCommit } from "@/src/hooks/pack-cli";

/** A real-shaped 40-character sha, spelled out so the indexes below are readable. */
const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

/**
 * Deterministic 40-hex shas, for the collision property below.
 *
 * Seeded xorshift rather than `Math.random`, because a property that fails on
 * one run in fifty and passes on the rest reports a flaky test instead of a
 * broken abbreviation. The same seed gives the same corpus on every machine,
 * so a failure here is reproducible from the file alone.
 */
function generatedShas(count: number, seed = 0x9e3779b9): string[] {
  let s = seed >>> 0;
  const next = (): number => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  };
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    let hex = "";
    while (hex.length < 40) hex += next().toString(16).padStart(8, "0");
    out.push(hex.slice(0, 40));
  }
  return out;
}

describe("versionFromCommit", () => {
  it("truncates a 40-character sha to exactly VERSION_SHA_LENGTH", () => {
    const version = versionFromCommit(SHA);
    expect(version).toBe("a1b2c3d4e5f6");
    expect(version).toHaveLength(VERSION_SHA_LENGTH);
    expect(version).toBe(SHA.slice(0, VERSION_SHA_LENGTH));
  });

  it("abbreviates to TWELVE characters, not to git's default seven", () => {
    // The constant is asserted by value, not just read back out of the module,
    // because "12" is the whole claim: seven characters collide in a repository
    // with enough objects — which is why git itself lengthens the abbreviation
    // as a repo grows — and a version that stops being unique means two
    // artifacts claim one name, in an `id|version|sha256` key that assumes they
    // cannot. Twelve is short enough to read in a listing and long enough that
    // no real pack repository reaches it. Bump it deliberately, never by drift.
    expect(VERSION_SHA_LENGTH).toBe(12);
    expect(versionFromCommit(SHA)).toHaveLength(12);
    // Seven would have been a DIFFERENT, shorter answer for this same sha — so
    // if the length is ever quietly reverted to git's default, this fails.
    expect(versionFromCommit(SHA)).not.toBe(SHA.slice(0, 7));
  });

  it("lowercases a sha typed or pasted in upper case", () => {
    // `PACK_COMMIT_RE` accepts lower-case hex only, and the manifest validator
    // is what installs are gated on — so an upper-case version is a pack whose
    // own manifest reads as invalid. Case-folding here is what stops a sha
    // copied out of a UI that renders them upper-case from shipping one.
    expect(versionFromCommit(SHA.toUpperCase())).toBe("a1b2c3d4e5f6");
    expect(versionFromCommit("A1B2C3D4E5F60718293A4B5C6D7E8F9012345678")).toBe("a1b2c3d4e5f6");
    // Mixed case is the realistic form of this, not the fully upper one.
    expect(versionFromCommit("A1b2C3d4E5f60718293a4b5c6d7e8f9012345678")).toBe("a1b2c3d4e5f6");
  });

  it("trims surrounding whitespace BEFORE it truncates", () => {
    // `git rev-parse HEAD` returns a trailing newline, and a caller reading a
    // sha out of a file or a pipe hands over whatever padding came with it.
    // Order is the load-bearing half: slicing first would keep the leading
    // spaces inside the twelve characters, producing a version that is short,
    // contains whitespace, and fails both regexes below.
    expect(versionFromCommit(`  ${SHA}\n`)).toBe("a1b2c3d4e5f6");
    expect(versionFromCommit(`\t${SHA}  `)).toBe("a1b2c3d4e5f6");
    expect(versionFromCommit(`${SHA}\r\n`)).toBe("a1b2c3d4e5f6");
    for (const padded of [`  ${SHA}\n`, `\t${SHA}  `]) {
      expect(versionFromCommit(padded)).toHaveLength(VERSION_SHA_LENGTH);
      expect(versionFromCommit(padded)).not.toMatch(/\s/);
    }
  });

  it("is idempotent — re-abbreviating an abbreviation changes nothing", () => {
    // `versionForPublish` calls this on the way into the dirty-tree message
    // while the caller has already called it for the version, and a manifest
    // round trip re-reads the value it wrote. A second pass that shortened or
    // re-cased the string would make those two disagree about one release.
    const once = versionFromCommit(SHA);
    expect(versionFromCommit(once)).toBe(once);
    expect(versionFromCommit(`  ${once}  `)).toBe(once);
  });
});

describe("the version a commit produces is one the manifest accepts", () => {
  /**
   * Asserted against the REAL exports from `pack-manifest.ts`, never a copy of
   * the patterns. A version this file blesses and the manifest validator
   * rejects is a pack that publishes and then nobody can install, and a
   * hand-copied regex here would keep passing through exactly the edit that
   * caused it.
   */
  it("satisfies PACK_VERSION_RE and PACK_COMMIT_RE for every generated sha", () => {
    for (const sha of [SHA, SHA.toUpperCase(), `  ${SHA}\n`, ...generatedShas(200)]) {
      const version = versionFromCommit(sha);
      expect(PACK_VERSION_RE.test(version), `${version} must pass PACK_VERSION_RE`).toBe(true);
      // The version doubles as an abbreviated commit, so it has to read as one:
      // `commit` in the manifest is validated by this pattern, which accepts
      // lower-case hex from 7 characters up.
      expect(PACK_COMMIT_RE.test(version), `${version} must pass PACK_COMMIT_RE`).toBe(true);
    }
  });

  it("also satisfies both when it comes back out of versionForPublish", () => {
    // The publish path never calls `versionFromCommit` directly for the happy
    // case; it takes whatever `versionForPublish` returns and writes it into
    // the manifest. Pin the value at the boundary that actually ships.
    for (const sha of generatedShas(50, 0x1234_5678)) {
      const resolved = versionForPublish({ sha, dirty: false });
      expect("version" in resolved).toBe(true);
      if (!("version" in resolved)) continue;
      expect(PACK_VERSION_RE.test(resolved.version)).toBe(true);
      expect(PACK_COMMIT_RE.test(resolved.version)).toBe(true);
    }
  });
});

describe("versionFromCommit collision behaviour", () => {
  it("is a function of the sha alone — the same sha always gives the same version", () => {
    // Nothing here may depend on a clock, a counter or a release list. Two
    // publishers on the same commit, a rebuild a year later, and a fresh clone
    // on an air-gapped machine all have to name the artifact identically, or
    // "which source produced these bytes" stops being answerable from the
    // version at all.
    for (const sha of generatedShas(100, 0xdead_beef)) {
      const first = versionFromCommit(sha);
      expect(versionFromCommit(sha)).toBe(first);
      expect(versionFromCommit(sha.toUpperCase())).toBe(first);
      expect(versionFromCommit(`\n ${sha} \n`)).toBe(first);
    }
  });

  it("collides across a generated corpus only where the 12-char prefixes match", () => {
    // The property the abbreviation rests on, driven over a corpus rather than
    // two hand-picked examples: distinct shas must produce distinct versions,
    // and the ONLY licensed exception is two shas that agree for all twelve
    // characters. State it as an equivalence in both directions — a truncation
    // that dropped case-folding would satisfy "different in, different out"
    // while breaking "same prefix, same version".
    //
    // Random shas alone never exercise that second direction: `samePrefix` is
    // false for every pair a generator produces, so the equivalence degenerates
    // into "no collisions" and half the sentence above goes unasserted. These
    // three are constructed to make it true — an upper-case twin, a whitespace
    // twin, and one that agrees for twelve and diverges at the thirteenth.
    const base = generatedShas(397, 0xc0ffee);
    expect(new Set(base).size).toBe(base.length);
    const twins = [
      base[0].toUpperCase(),
      `  ${base[1]}\n`,
      // Agrees for twelve, diverges at the thirteenth.
      base[2].slice(0, VERSION_SHA_LENGTH) +
        (base[2][VERSION_SHA_LENGTH] === "a" ? "b" : "a") +
        base[2].slice(VERSION_SHA_LENGTH + 1),
    ];
    // Each twin really is the pair it claims to be, or the loop below proves
    // nothing about the direction they were added for.
    expect(twins[2]).not.toBe(base[2]);
    expect(twins[2].slice(0, VERSION_SHA_LENGTH)).toBe(base[2].slice(0, VERSION_SHA_LENGTH));
    expect(twins[0]).not.toBe(base[0]);
    const corpus = [...base, ...twins];

    // The prefix is normalised the way a READER would state the rule — trim the
    // padding, fold the case, take twelve — rather than by calling the function
    // under test, which would make the comparison agree with itself.
    const prefix = (sha: string): string =>
      sha.trim().toLowerCase().slice(0, VERSION_SHA_LENGTH);
    let licensedCollisions = 0;
    for (let i = 0; i < corpus.length; i += 1) {
      for (let j = i + 1; j < corpus.length; j += 1) {
        const samePrefix = prefix(corpus[i]) === prefix(corpus[j]);
        if (samePrefix) licensedCollisions += 1;
        const sameVersion = versionFromCommit(corpus[i]) === versionFromCommit(corpus[j]);
        expect(sameVersion, `${corpus[i]} vs ${corpus[j]}`).toBe(samePrefix);
      }
    }
    // Without this the assertion above is one-directional: if the twins ever
    // stop being twins, every pair is `false === false` and the test passes by
    // never having been asked the question it exists to ask.
    expect(licensedCollisions).toBe(3);
  });

  it("separates two shas that a SEVEN-character abbreviation would merge", () => {
    // The corpus above is random, so it is unlikely ever to contain a 7-prefix
    // collision on its own — and an abbreviation reverted to git's default
    // would sail straight through it. These are constructed to be exactly that
    // case: identical for the first seven characters, different inside twelve.
    // Two commits, two sets of bytes, and at seven characters one version name
    // for both.
    const near = SHA.slice(0, 7) + "9" + SHA.slice(8);
    expect(near).not.toBe(SHA);
    expect(near.slice(0, 7)).toBe(SHA.slice(0, 7));
    expect(versionFromCommit(near)).not.toBe(versionFromCommit(SHA));

    // And the exception holds from the other side: agreeing for twelve and
    // diverging at the thirteenth IS one version, which is the residual risk
    // the length is chosen to make negligible rather than to eliminate.
    const twin = SHA.slice(0, 12) + "f" + SHA.slice(13);
    expect(twin).not.toBe(SHA);
    expect(versionFromCommit(twin)).toBe(versionFromCommit(SHA));
  });
});

describe("versionForPublish", () => {
  it("returns the commit's version, and nothing else, for a clean checkout", () => {
    const resolved = versionForPublish({ sha: SHA, dirty: false });
    // `toEqual` on the whole object, not a property read: an `error` key
    // returned ALONGSIDE a version would be a publish that both succeeds and
    // reports a failure, and the caller branches on `"error" in resolved`.
    expect(resolved).toEqual({ version: "a1b2c3d4e5f6" });
    expect(Object.keys(resolved)).toEqual(["version"]);
    expect("error" in resolved).toBe(false);
  });

  it("refuses a directory that is not a git checkout, naming git init and --version", () => {
    // There is no commit to name, so a version minted here would claim a
    // provenance that does not exist. Publishing from a non-checkout used to
    // work, so the message has to carry BOTH ways forward — start a repo, or
    // name the version by hand — or somebody who deliberately publishes from a
    // scratch directory reads this as a dead end.
    const resolved = versionForPublish(null);
    expect("error" in resolved).toBe(true);
    if (!("error" in resolved)) return;
    const text = resolved.error.join("\n");
    expect(text).toContain("git init");
    expect(text).toContain("not a git checkout");
    // The flag WITH its argument, not the bare word: `--version` alone is also
    // contained in a sentence that names the flag and never says it takes one,
    // and somebody who types it bare gets the next token swallowed as the value.
    expect(text).toContain("--version <version>");
    // The dirty tree's remedy must not leak into this one. `git add -A && git
    // commit` is useless advice to somebody with no repository, and the two
    // messages collapsed into one generic paragraph would satisfy this test and
    // the next one at the same time while helping neither reader.
    expect(text).not.toContain("uncommitted changes");
    // No version is smuggled back beside the refusal.
    expect(resolved).not.toHaveProperty("version");
  });

  it("refuses a dirty tree, naming the commit, the mismatch, and --version", () => {
    // The bytes about to be published are not the bytes in that commit, so the
    // version — and `commit` in the manifest beside it — would both point at
    // source that does not contain them. The message names the commit it WOULD
    // have used, because that is what makes the sentence checkable by the
    // person reading it.
    const resolved = versionForPublish({ sha: SHA, dirty: true });
    expect("error" in resolved).toBe(true);
    if (!("error" in resolved)) return;
    const text = resolved.error.join("\n");
    expect(text).toContain("uncommitted changes");
    expect(text).toContain("not the bytes in that commit");
    expect(text).toContain("--version <version>");
    expect(text).not.toContain("git init");
    // The ABBREVIATION, and not the forty characters it came from. `toContain`
    // on the twelve alone cannot tell the two apart — the version is a prefix of
    // the sha, so a message that dumped the whole thing would pass it — and the
    // number quoted here is the one the publisher then compares against a
    // release listing, so printing a longer string than any version anywhere is
    // a message that reads as a different identifier.
    expect(text).toContain(versionFromCommit(SHA));
    expect(text).not.toContain(SHA);
    expect(text).toMatch(new RegExp(`${versionFromCommit(SHA)}(?![0-9a-f])`));
    expect(resolved).not.toHaveProperty("version");
  });

  it("refuses a dirty tree whatever the sha, rather than only the sample one", () => {
    // Guards against a refusal keyed on anything but `dirty`. Every one of
    // these has a perfectly good commit; the tree is what disqualifies it.
    for (const sha of generatedShas(25, 0xfeed_face)) {
      const resolved = versionForPublish({ sha, dirty: true });
      expect("error" in resolved, sha).toBe(true);
      if (!("error" in resolved)) continue;
      const text = resolved.error.join("\n");
      expect(text, sha).toContain(versionFromCommit(sha));
      expect(text, sha).not.toContain(sha);
    }
  });

  it("refuses a sha that is not one, instead of truncating it into a version", () => {
    // The "somebody else's data" case: the provenance has the right SHAPE and a
    // `sha` field that is not a sha. `inferCommit` guarantees forty lower-case
    // hex, so nothing in the publish path gets here — but the guarantee lives in
    // a different function, and a truncation is silent. The empty string is the
    // one that bites: it yields an EMPTY version, which the manifest validator
    // rejects hundreds of lines later with a message about the manifest.
    for (const sha of ["", "   ", "\n", "not-a-sha-at-all", "z1b2c3d4e5f6", "a1b2c3"]) {
      const resolved = versionForPublish({ sha, dirty: false });
      expect("error" in resolved, JSON.stringify(sha)).toBe(true);
      if (!("error" in resolved)) continue;
      expect(resolved.error.join("\n")).toContain("--version <version>");
    }
    // Stated the other way round, because that is the property that matters:
    // whatever version this hands back, the manifest accepts it. A truncation
    // that let any of the above through would break exactly this.
    for (const sha of [SHA, SHA.toUpperCase(), `  ${SHA}\n`, SHA.slice(0, 7), SHA.slice(0, 12)]) {
      const resolved = versionForPublish({ sha, dirty: false });
      expect("version" in resolved, sha).toBe(true);
      if (!("version" in resolved)) continue;
      expect(PACK_VERSION_RE.test(resolved.version), resolved.version).toBe(true);
      expect(PACK_COMMIT_RE.test(resolved.version), resolved.version).toBe(true);
    }
  });

  it("prints its refusals as non-empty lines, because they go straight to a terminal", () => {
    // These arrays are written to stdout verbatim by the publish command. A
    // non-string element renders as `undefined` or `[object Object]`, and an
    // empty FIRST line pushes the sentence that explains the failure below the
    // fold of whatever the caller printed before it — so the reader sees a
    // blank line where the reason should be.
    for (const provenance of [null, { sha: SHA, dirty: true }]) {
      const resolved = versionForPublish(provenance);
      expect("error" in resolved).toBe(true);
      if (!("error" in resolved)) continue;
      expect(Array.isArray(resolved.error)).toBe(true);
      expect(resolved.error.length).toBeGreaterThan(0);
      for (const line of resolved.error) expect(typeof line).toBe("string");
      expect(resolved.error[0]).not.toBe("");
      expect(resolved.error[0].trim()).not.toBe("");
    }
  });
});

/**
 * The half that READS provenance, rather than the half that decides from it.
 *
 * This block is the one impure thing in the file, and it earns a real checkout
 * because nothing pure can reach the bug it pins. `inferCommit` asks git two
 * questions and its helper answers `""` for a clean tree and `null` for "could
 * not run the command at all" — and the `Boolean()` it used to call read BOTH
 * as clean. That was harmless while `dirty` was only a label in the release
 * body. Making it decide the version turned it into a silent fail-OPEN: a tree
 * whose state could not be read published at its commit exactly as if it had
 * been checked against it, which is the single claim this scheme exists to
 * refuse.
 *
 * Reached by turning `.git/index` into a directory. `rev-parse HEAD` never
 * touches the index, so the sha still resolves and provenance is non-null;
 * `status` fails outright. That is the shape of the realistic cases too — an
 * index that cannot be read, or a `status` that outruns the 5s timeout because
 * it is the one command that walks the whole worktree — and it needs no stubbed
 * git, which would only assert my idea of what git prints.
 *
 * `--dry-run` with no `--repo` reaches none of the network: the version is
 * settled before the credential and the repository, which is the whole point of
 * deciding it from the tree.
 */
describe("provenance git could not be read", () => {
  const ENTRY = `
    import { customPolicies, deny } from "failproofai";
    customPolicies.add({
      name: "block-big-refund",
      description: "Block refunds above the approved limit",
      category: "Finance",
      defaultEnabled: true,
      match: { events: ["PreToolUse"] },
      fn: async () => deny("no"),
    });
  `;

  let work: string;
  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), "fp-commit-version-"));
  });
  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });

  const gitIn = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    }).trim();

  /**
   * A checkout with the entry committed in it.
   *
   * The out directory every caller passes is a SIBLING of the checkout, never
   * inside it: `dist-pack` written into the tree would leave it dirty, and
   * dirtiness is the thing being measured — a refusal caused by the harness's
   * own output would look exactly like the one this file is about.
   */
  function checkout(name: string): { dir: string; entry: string } {
    const dir = join(work, name);
    mkdirSync(dir, { recursive: true });
    const entry = join(dir, "policies.mjs");
    writeFileSync(entry, ENTRY, "utf8");
    gitIn(dir, "init", "-q", "-b", "main");
    gitIn(dir, "add", "-A");
    gitIn(dir, "commit", "-qm", "policies");
    return { dir, entry };
  }

  it("publishes a checkout whose status git CAN read, at that commit", async () => {
    // The control. Without it the refusal below passes for any reason at all —
    // a broken harness, a git that is not installed, an entry the builder
    // rejects — and a test that refuses everything proves nothing.
    const { dir, entry } = checkout("readable");
    const r = await packCli.runPublishCommand([entry, "--dry-run", "--out", join(work, "out-readable")]);

    expect(r.exitCode).toBe(0);
    expect(r.lines.join("\n")).toContain(versionFromCommit(gitIn(dir, "rev-parse", "HEAD")));
  });

  it("refuses a checkout whose status git CANNOT read, instead of calling it clean", async () => {
    const { dir, entry } = checkout("unreadable");
    // A genuinely uncommitted change, so the tree this refuses is one the old
    // code would have published while it was dirty — not merely unknown.
    writeFileSync(join(dir, "uncommitted.txt"), "not in that commit\n", "utf8");
    rmSync(join(dir, ".git", "index"));
    mkdirSync(join(dir, ".git", "index"));
    // The premise, asserted rather than assumed: one question still answers and
    // the other does not. If a future git answered both, this test would go
    // quietly green while testing nothing.
    expect(gitIn(dir, "rev-parse", "HEAD")).toMatch(/^[0-9a-f]{40}$/);
    expect(() => gitIn(dir, "status", "--porcelain")).toThrow();

    const r = await packCli.runPublishCommand([entry, "--dry-run", "--out", join(work, "out-unreadable")]);

    expect(r.exitCode).toBe(1);
    const text = r.lines.join("\n");
    expect(text).toContain("uncommitted changes");
    expect(text).toContain("--version <version>");
    // It refuses under the DIRTY message rather than the not-a-checkout one.
    // Both fail closed, so exit 1 alone cannot tell them apart — and sending
    // somebody with a perfectly good repository off to `git init` is a remedy
    // that does not apply to what happened.
    expect(text).not.toContain("git init");
  });
});

/**
 * A dead export that nothing calls is how a replaced scheme comes back: the
 * next person to need "a version" finds `nextCalendarVersion` still sitting in
 * the module, still passing its own tests, and wires it back in beside the sha.
 * These four are the calendar scheme's entire surface, and this block is the
 * only thing asserting that removing them was part of the change rather than a
 * rename that left the originals behind.
 */
describe("the calendar scheme is gone from the module", () => {
  const mod = packCli as unknown as Record<string, unknown>;

  it("exports none of parseCalendarVersion, nextCalendarVersion, utcToday, formatCalendarVersion", () => {
    for (const name of [
      "parseCalendarVersion",
      "nextCalendarVersion",
      "utcToday",
      "formatCalendarVersion",
    ]) {
      expect(mod[name], `${name} must not be exported`).toBeUndefined();
      expect(Object.keys(mod), `${name} must not be exported`).not.toContain(name);
    }
  });

  it("does export the commit scheme that replaced them", () => {
    // Without this, the assertions above pass for the wrong reason: a broken
    // import path or a renamed module makes every name undefined, and a file
    // proving nothing looks exactly like a file proving everything.
    expect(typeof mod.versionFromCommit).toBe("function");
    expect(typeof mod.versionForPublish).toBe("function");
    expect(typeof mod.VERSION_SHA_LENGTH).toBe("number");
  });
});
