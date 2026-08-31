// @vitest-environment node
/**
 * The GitHub release body as a WIRE FORMAT, and the commit half of a pack's
 * identity.
 *
 * `releaseBody` and `parseReleaseBody` are one format with two readers: a human
 * on the releases page, and `policies show --releases`, which parses the same
 * lines instead of downloading a manifest per release. That is the whole reason
 * a listing costs ONE request rather than N, so the two functions have to move
 * together — the round-trip test below is what fails when only one of them does.
 *
 * The rest is about what happens when nothing was written in this format at all.
 * Every release published before it exists, plus every hand-typed one, reaches
 * the same parser, and a listing must render those as "says less" rather than
 * as a defect: absent fields, zero throws.
 *
 * `parsePackIdentity`'s commit is tested here rather than beside the manifest
 * refusals because it is the one field that is deliberately NOT a refusal. The
 * digest is what makes a pack safe to run; the commit is a label saying which
 * source produced it, so a publisher who wrote something odd there must still
 * get an installable pack.
 */
import { describe, it, expect } from "vitest";

import { releaseBody, parseReleaseBody } from "@/src/hooks/pack-cli";
import { parsePackIdentity } from "@/src/hooks/pack-manifest";

const COMMIT = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

describe("releaseBody / parseReleaseBody round trip", () => {
  it("carries policies, defaultOn and commit back out unchanged", () => {
    const body = releaseBody("acme/finance", "2026.08.26", {
      policies: 7,
      defaultOn: 3,
      commit: COMMIT,
    });

    expect(parseReleaseBody(body)).toEqual({ policies: 7, defaultOn: 3, commit: COMMIT });
  });

  it("round trips a pack with no policies on by default", () => {
    // Zero is a real answer and has to survive the trip: an observe-only pack
    // ships everything off, and a parser that treated 0 as "absent" would make
    // that listing indistinguishable from a pre-format release.
    const body = releaseBody("acme/finance", "2026.08.26-2", { policies: 4, defaultOn: 0 });

    expect(parseReleaseBody(body)).toEqual({ policies: 4, defaultOn: 0 });
  });

  it("round trips a pack that ships nothing, which is not saying nothing", () => {
    // The other slot at zero. `{}` is what a pre-format release parses to, so a
    // pack that genuinely contains no policies has to come back as a pair of
    // zeros — otherwise the listing prints an em dash for a fact the release
    // did state, which is the same row a release from before this format gets.
    const body = releaseBody("acme/finance", "2026.08.26", { policies: 0, defaultOn: 0 });

    expect(parseReleaseBody(body)).toEqual({ policies: 0, defaultOn: 0 });
  });

  it("round trips a pack published from a directory that is not a checkout", () => {
    const body = releaseBody("acme/finance", "2026.08.26", { policies: 2, defaultOn: 2 });

    // Absent means the LINE IS NOT THERE, not merely that the parser declined
    // to read it. A body carrying `commit undefined` parses back to the same
    // absent field — the reader wants hex — so checking only the parsed value
    // would pass a release page that shows a human a word that is not a commit.
    expect(body).not.toMatch(/commit/);
    expect(parseReleaseBody(body)).toEqual({ policies: 2, defaultOn: 2 });
  });

  it("round trips the shortest commit either side of the format accepts", () => {
    // Seven is one floor written twice: `PACK_COMMIT_RE` accepts from 7 and
    // `parseReleaseBody` reads `{7,40}`. Raise either alone and `publish` emits
    // a provenance line that neither `--releases` nor
    // `policies add <owner>/<repo>@<sha>` can read back, with nothing failing.
    const body = releaseBody("acme/finance", "2026.08.26", {
      policies: 1,
      defaultOn: 1,
      commit: "a1b2c3d",
    });

    expect(parseReleaseBody(body).commit).toBe("a1b2c3d");
  });

  it("puts <id>@<version> on the first line, which is what a human sees", () => {
    const body = releaseBody("acme/finance", "2026.08.26", {
      policies: 7,
      defaultOn: 3,
      commit: COMMIT,
    });

    expect(body.split("\n")[0]).toBe("acme/finance@2026.08.26");
  });

  it("omits the counts entirely when there is no meta, rather than writing zeros", () => {
    // A publish that could not describe what it built must say nothing, not
    // claim a pack with zero policies in it — the listing would then be
    // confidently wrong instead of quiet.
    const body = releaseBody("acme/finance", "2026.08.26");

    expect(body.trim()).toBe("acme/finance@2026.08.26");
    expect(body).not.toMatch(/policies/);
    expect(parseReleaseBody(body)).toEqual({});
  });
});

describe("parseReleaseBody on bodies it did not write", () => {
  it("returns every field absent for an empty body", () => {
    expect(parseReleaseBody("")).toEqual({});
  });

  it("returns every field absent for null and undefined without throwing", () => {
    // The GitHub API returns `body: null` for a release created with no notes,
    // and that is the common case for everything published before this format.
    expect(parseReleaseBody(null)).toEqual({});
    expect(parseReleaseBody(undefined)).toEqual({});
  });

  it("returns every field absent for a hand-written release body", () => {
    // Prose that talks about the same things in the same words, because that is
    // what a publisher writes by hand. Recognising this as counts would be
    // worse than reading nothing: the listing would print numbers the release
    // never claimed.
    const body = [
      "## What's new",
      "",
      "* 3 new policies for refund limits",
      "* 2 of them are off by default until you opt in",
    ].join("\n");

    expect(parseReleaseBody(body)).toEqual({});
  });

  it("reads a body with CRLF line endings, which is what the API returns", () => {
    // Every body this parser sees in production came back from GitHub, and
    // GitHub stores release bodies with `\r\n` — carriage returns the string
    // `publish` handed it never had. This is here for the obvious cleanup:
    // splitting on `\n` and reusing the one anchored `PACK_COMMIT_RE` instead
    // of a second copy of the range leaves a trailing `\r` on every line, and
    // reads every REAL release as a pre-format one with nothing failing.
    const body = `acme/finance@1.0.0\r\n\r\n7 policies, 3 on by default\r\ncommit ${COMMIT}\r\n`;

    expect(parseReleaseBody(body)).toEqual({ policies: 7, defaultOn: 3, commit: COMMIT });
  });

  it("does not read a commit out of the middle of a sentence", () => {
    // "this reverts commit <sha>" is what `git revert` writes and therefore
    // what a publisher pastes into hand-written notes. Only a line that BEGINS
    // with `commit` is the provenance line; without that anchor a pack would be
    // attributed to whichever commit its prose happened to mention first, and
    // `policies add <owner>/<repo>@<sha>` would resolve that sha to this tag.
    const body = [
      "acme/finance@1.0.0",
      "",
      "Reverts the change in commit deadbeefdeadbeefdeadbeefdeadbeefdeadbeef.",
    ].join("\n");

    expect(parseReleaseBody(body).commit).toBeUndefined();
  });

  it("lowercases a commit somebody typed in capitals", () => {
    // Load-bearing rather than cosmetic. `resolveTagForCommit` lowercases what
    // the user typed and then asks `facts.commit.startsWith(prefix)`, so a
    // commit read back in capitals matches no prefix anybody can type: the
    // install reports "no release claims that commit" and falls through to
    // treating the sha as a literal tag.
    const body = `acme/finance@1.0.0\n\ncommit ${COMMIT.toUpperCase()}\n`;

    expect(parseReleaseBody(body).commit).toBe(COMMIT);
  });

  it("ignores a commit line that is too short to be a git prefix", () => {
    expect(parseReleaseBody("acme/finance@1.0.0\n\ncommit a1b2c3").commit).toBeUndefined();
  });

  it("ignores a non-hex commit", () => {
    expect(parseReleaseBody("acme/finance@1.0.0\n\ncommit not-a-sha-at-all").commit).toBeUndefined();
  });

  it("still reads the counts when the commit line is malformed", () => {
    // One bad line must not cost the rest of the listing. The counts and the
    // commit are matched independently for exactly this reason.
    const facts = parseReleaseBody("acme/finance@1.0.0\n\n7 policies, 3 on by default\ncommit zzz");

    expect(facts.policies).toBe(7);
    expect(facts.defaultOn).toBe(3);
    expect(facts.commit).toBeUndefined();
  });
});

describe("parsePackIdentity commit", () => {
  const base = { id: "acme/finance", version: "2026.08.26" };

  it("accepts a full 40-character commit", () => {
    expect(parsePackIdentity({ ...base, commit: COMMIT }).commit).toBe(COMMIT);
  });

  it("accepts a 7-character abbreviation, which is what git log prints", () => {
    expect(parsePackIdentity({ ...base, commit: "a1b2c3d" }).commit).toBe("a1b2c3d");
  });

  it("lowercases and trims what a publisher pasted", () => {
    expect(parsePackIdentity({ ...base, commit: `  ${COMMIT.toUpperCase()}\n` }).commit).toBe(
      COMMIT,
    );
  });

  it("omits the field entirely when there is no commit", () => {
    const identity = parsePackIdentity(base);

    expect(identity.commit).toBeUndefined();
    expect("commit" in identity).toBe(false);
  });

  it("DROPS a malformed commit without throwing, leaving a usable identity", () => {
    // Provenance is a label. A pack whose commit field is junk must still
    // install and still enforce — making it uninstallable would turn a
    // cosmetic mistake into a machine that enforces less than it did.
    const identity = parsePackIdentity({ ...base, commit: "not-a-sha" });

    expect(identity.commit).toBeUndefined();
    expect(identity.id).toBe("acme/finance");
    expect(identity.version).toBe("2026.08.26");
    expect(identity.effect).toBe("enforce");
  });

  it("drops a commit of the wrong type without throwing", () => {
    expect(parsePackIdentity({ ...base, commit: 12345 }).commit).toBeUndefined();
    expect(parsePackIdentity({ ...base, commit: { sha: COMMIT } }).commit).toBeUndefined();
    expect(parsePackIdentity({ ...base, commit: null }).commit).toBeUndefined();
  });

  it("drops a 41-character commit, which no git object has", () => {
    expect(parsePackIdentity({ ...base, commit: `${COMMIT}0` }).commit).toBeUndefined();
  });

  it("drops a 6-character commit, one below the floor the format is written to", () => {
    // The other end of the same range, and the one that would go unnoticed:
    // `parseReleaseBody` reads `{7,40}`, so a six-character commit accepted
    // here would be written into a release body no reader can take back out.
    expect(parsePackIdentity({ ...base, commit: "a1b2c3" }).commit).toBeUndefined();
  });

  it("drops a commit with anything appended, such as a --dirty suffix", () => {
    // `git describe --dirty` and `git rev-parse HEAD` are different strings,
    // and a publisher who pipes the first in gets no provenance rather than a
    // label naming a tree nobody else has. The pattern is anchored at BOTH
    // ends for this — a prefix match would record `<sha>` for `<sha>-dirty`.
    expect(parsePackIdentity({ ...base, commit: `${COMMIT}-dirty` }).commit).toBeUndefined();
    expect(parsePackIdentity({ ...base, commit: "a1b2c3d 4e5f6" }).commit).toBeUndefined();
  });

  it("carries an explicit observe effect through the commit drop", () => {
    // The drop happens after the effect check and returns the WHOLE identity,
    // so the two must not be coupled: a pack that asked to observe coming back
    // as `enforce` would let a junk provenance label turn a pack that
    // evaluates and discards into one that denies.
    const identity = parsePackIdentity({ ...base, effect: "observe", commit: "not-a-sha" });

    expect(identity.effect).toBe("observe");
    expect(identity.commit).toBeUndefined();
  });
});

describe("parsePackIdentity still refuses what it always refused", () => {
  // The commit field was added by LOOSENING one check into a drop. These prove
  // the loosening stayed in its lane: id and version are what decide where an
  // artifact is read from and which record it overwrites, so they still throw.
  it("rejects a bad id", () => {
    expect(() => parsePackIdentity({ id: "no-slash", version: "2026.08.26" })).toThrow(
      /unsafe pack id/,
    );
    expect(() =>
      parsePackIdentity({ id: "acme/../../etc", version: "2026.08.26", commit: COMMIT }),
    ).toThrow(/unsafe pack id/);
    expect(() => parsePackIdentity({ version: "2026.08.26" })).toThrow(/unsafe pack id/);
  });

  it("rejects a bad version", () => {
    expect(() => parsePackIdentity({ id: "acme/finance", version: "../etc/passwd" })).toThrow(
      /invalid version/,
    );
    expect(() =>
      parsePackIdentity({ id: "acme/finance", version: "", commit: COMMIT }),
    ).toThrow(/invalid version/);
    expect(() => parsePackIdentity({ id: "acme/finance" })).toThrow(/invalid version/);
  });

  it("rejects an unknown effect", () => {
    expect(() =>
      parsePackIdentity({ ...{ id: "acme/finance", version: "2026.08.26" }, effect: "audit" }),
    ).toThrow(/unknown effect/);
  });
});
