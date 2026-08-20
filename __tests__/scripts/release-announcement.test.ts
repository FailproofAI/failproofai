// @vitest-environment node
/**
 * The release announcement is posted exactly once per stable release, from a
 * workflow job that only runs on a real release — so nothing routine exercises
 * this code, and the first time anyone sees its output is in a public channel
 * with a role ping attached. These tests are the rehearsal.
 *
 * The cases that matter most are the ones that FAIL QUIETLY: a description
 * truncated past the changelog link (a message showing a third of a release and
 * pointing nowhere), a mention placed inside the embed (renders as raw
 * `<@&123>` and pings nobody), and `allowed_mentions` wide enough to let an
 * `@everyone` in someone's release notes reach the whole server.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  parseChangelog,
  parseSectionBody,
  collectRelease,
  parseReleaseBody,
  chooseNotes,
  firstSentence,
  truncate,
  summarizeEntry,
  fitDescription,
  buildDiscordPayload,
  BRAND_COLOR,
} from "../../scripts/release-announcement.mjs";

const REPO = "failproof-ai/failproofai";

const CHANGELOG = `# Changelog

## 2.1.0 — 2026-09-01

The prose preamble. It runs to two sentences.

A second paragraph nobody needs in a notification.

### Features

- Add the first thing. It has a long tail of explanation that goes on and on and should not survive. (#101)

- Add the second thing, whose headline mentions \`some.file.ts\` and version 1.2.3 mid-sentence. Then more. (#102)

### Fixes

- Fix a thing. (#103)

## 2.1.0-beta.1 — 2026-08-20

### Features

- A beta feature. (#104)

### Fixes

- A beta fix. (#105)

### Fixes

- A second block of fixes under a repeated heading. (#106)

### Dependencies

- Bump something from 1.0.0 to 1.0.1. (#107)

## 2.0.0 — 2026-07-01

### Features

- Something from an older release nobody is announcing. (#001)
`;

describe("parseChangelog", () => {
  it("splits on version headings and keeps file order", () => {
    const sections = parseChangelog(CHANGELOG);
    expect(sections.map((s) => s.version)).toEqual(["2.1.0", "2.1.0-beta.1", "2.0.0"]);
    expect(sections[0].date).toBe("2026-09-01");
  });

  it("accepts an em dash, an en dash, a hyphen, or no date at all", () => {
    const sections = parseChangelog("## 1.0.0 — a\n## 1.0.1 – b\n## 1.0.2 - c\n## 1.0.3\n");
    expect(sections.map((s) => s.version)).toEqual(["1.0.0", "1.0.1", "1.0.2", "1.0.3"]);
    expect(sections[3].date).toBe("");
  });

  it("keeps two sections carrying the same version rather than dropping one", () => {
    // The real file has two `## 1.0.0-beta.13` and two `## 1.0.0-beta.15`
    // headings; collapsing by version would silently drop half their entries.
    const sections = parseChangelog("## 1.0.0 — a\n\n### Fixes\n\n- one\n\n## 1.0.0 — b\n\n### Fixes\n\n- two\n");
    expect(sections).toHaveLength(2);
  });
});

describe("parseSectionBody", () => {
  it("separates the prose preamble from the grouped entries", () => {
    const section = parseChangelog(CHANGELOG)[0];
    const { lead, groups } = parseSectionBody(section.body);
    expect(lead).toMatch(/^The prose preamble\./);
    expect(groups.map((g) => g.name)).toEqual(["Features", "Fixes"]);
    expect(groups[0].entries).toHaveLength(2);
  });

  it("joins an entry that wraps across lines", () => {
    const { groups } = parseSectionBody("### Fixes\n\n- A headline\n  that wrapped onto a second line. (#9)\n");
    expect(groups[0].entries[0]).toBe("A headline that wrapped onto a second line. (#9)");
  });
});

describe("collectRelease", () => {
  it("gathers the stable section and its whole beta line", () => {
    const notes = collectRelease(CHANGELOG, "2.1.0");
    expect(notes!.sections).toEqual(["2.1.0", "2.1.0-beta.1"]);
    expect(notes!.total).toBe(7);
  });

  it("merges groups that share a heading instead of listing them twice", () => {
    const notes = collectRelease(CHANGELOG, "2.1.0");
    const fixes = notes!.groups.filter((g) => g.name === "Fixes");
    expect(fixes).toHaveLength(1);
    // The stable section's one fix plus both repeated beta blocks.
    expect(fixes[0].entries).toHaveLength(3);
  });

  it("does not reach into an unrelated version's section", () => {
    const notes = collectRelease(CHANGELOG, "2.1.0");
    const headlines = notes!.groups.flatMap((g) => g.entries.map((e: { headline: string }) => e.headline));
    expect(headlines.join(" ")).not.toContain("older release");
  });

  it("returns null when the version has no section", () => {
    expect(collectRelease(CHANGELOG, "9.9.9")).toBeNull();
  });

  it("does not treat 2.1.0 as a prefix of 2.1.05", () => {
    // Only an exact match or a `-` suffix counts; otherwise a 1.0.1 release
    // would sweep in 1.0.10's entries.
    const notes = collectRelease("## 1.0.1 — a\n\n### Fixes\n\n- one\n\n## 1.0.10 — b\n\n### Fixes\n\n- two\n", "1.0.1");
    expect(notes!.total).toBe(1);
  });
});

describe("firstSentence", () => {
  it("stops at the first real sentence boundary", () => {
    expect(firstSentence("Add the first thing. It has a long tail of explanation.")).toBe("Add the first thing.");
  });

  it("does not split inside an inline code span", () => {
    expect(firstSentence("It reads `~/.failproofai/run/socket` at startup. Then it binds.")).toBe(
      "It reads `~/.failproofai/run/socket` at startup.",
    );
  });

  it("does not split on a version number", () => {
    expect(firstSentence("Bump h2 from 0.4.15 to 0.4.16 in the lockfile. It clears an advisory.")).toBe(
      "Bump h2 from 0.4.15 to 0.4.16 in the lockfile.",
    );
  });

  it("keeps a whole sentence that is wrapped in bold", () => {
    const text = "**Stop the digest shipping assigned secrets verbatim.** Four options were wrong.";
    expect(firstSentence(text)).toBe("**Stop the digest shipping assigned secrets verbatim.**");
  });

  it("does not split on an abbreviation", () => {
    expect(firstSentence("Every path bearing tool, e.g. Read and Write, is canonicalized now. Then mapped.")).toBe(
      "Every path bearing tool, e.g. Read and Write, is canonicalized now.",
    );
  });

  it("returns the whole text when there is no boundary", () => {
    expect(firstSentence("A headline with no terminator")).toBe("A headline with no terminator");
  });
});

describe("truncate", () => {
  it("leaves short text alone", () => {
    expect(truncate("short", 20)).toBe("short");
  });

  it("cuts at a word boundary and marks the cut", () => {
    const out = truncate("alpha beta gamma delta epsilon zeta", 20);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out).not.toMatch(/\s…$/);
  });
});

describe("summarizeEntry", () => {
  it("links a trailing changelog PR reference", () => {
    expect(summarizeEntry("Do a thing. (#123)")).toEqual({ headline: "Do a thing.", pr: 123 });
  });

  it("strips GitHub's attribution and keeps the pull number", () => {
    expect(
      summarizeEntry("Close four ways enforcement failed silently by @someone in https://github.com/o/r/pull/683"),
    ).toEqual({ headline: "Close four ways enforcement failed silently", pr: 683 });
  });

  it("reads a bare pull URL", () => {
    expect(summarizeEntry("Do a thing https://github.com/o/r/pull/42").pr).toBe(42);
  });

  it("yields no link for a non-numeric placeholder rather than a broken one", () => {
    // `(#PR)` is a real thing that reached this changelog unfilled.
    expect(summarizeEntry("Do a thing. (#PR)")).toEqual({ headline: "Do a thing.", pr: null });
  });
});

describe("parseReleaseBody", () => {
  const GENERATED = [
    "The lead paragraph.",
    "",
    "## What's Changed",
    "* Close four ways enforcement failed silently by @a in https://github.com/o/r/pull/683",
    "* Give config a Recommended path by @b in https://github.com/o/r/pull/684",
    "",
    "### Fixes",
    "* Make a deny actually enforce by @c in https://github.com/o/r/pull/690",
    "",
    "**Full Changelog**: https://github.com/o/r/compare/v1.0.0...v1.0.1",
  ].join("\n");

  it("parses GitHub's generated shape", () => {
    const notes = parseReleaseBody(GENERATED)!;
    expect(notes.lead).toBe("The lead paragraph.");
    expect(notes.groups.map((g) => g.name)).toEqual(["Changes", "Fixes"]);
    expect(notes.total).toBe(3);
  });

  it("keeps the compare URL and takes it out of the entries", () => {
    const notes = parseReleaseBody(GENERATED)!;
    expect(notes.compareUrl).toBe("https://github.com/o/r/compare/v1.0.0...v1.0.1");
    const headlines = notes.groups.flatMap((g) => g.entries.map((e) => e.headline));
    expect(headlines.join(" ")).not.toContain("Full Changelog");
  });

  it("renames GitHub's 'What's Changed' to something that reads in a chat message", () => {
    expect(parseReleaseBody(GENERATED)!.groups[0].name).toBe("Changes");
  });

  it("keeps bullets that have no heading above them", () => {
    const notes = parseReleaseBody("- one thing\n- another thing\n")!;
    expect(notes.groups).toHaveLength(1);
    expect(notes.groups[0].name).toBe("Highlights");
    expect(notes.total).toBe(2);
  });

  it("keeps notes that are prose only", () => {
    const notes = parseReleaseBody("Just a paragraph about this release.")!;
    expect(notes.lead).toBe("Just a paragraph about this release.");
    expect(notes.total).toBe(0);
  });

  it("returns null for an empty or whitespace-only body", () => {
    expect(parseReleaseBody("")).toBeNull();
    expect(parseReleaseBody("   \n\n  ")).toBeNull();
    expect(parseReleaseBody(undefined)).toBeNull();
  });
});

describe("chooseNotes", () => {
  it("prefers the GitHub Release body over the changelog", () => {
    const notes = chooseNotes({
      releaseBody: "## What's Changed\n* From the release page by @a in https://github.com/o/r/pull/1",
      changelog: CHANGELOG,
      version: "2.1.0",
    })!;
    expect(notes.sections).toEqual(["the GitHub Release body"]);
    expect(notes.groups[0].entries[0].headline).toBe("From the release page");
  });

  it("falls back to the changelog when the body is empty", () => {
    const notes = chooseNotes({ releaseBody: "", changelog: CHANGELOG, version: "2.1.0" })!;
    expect(notes.sections).toEqual(["2.1.0", "2.1.0-beta.1"]);
  });

  it("returns null when neither source has anything", () => {
    expect(chooseNotes({ releaseBody: "", changelog: CHANGELOG, version: "9.9.9" })).toBeNull();
  });
});

describe("fitDescription", () => {
  const link = "https://example.com/changelog";

  it("always ends on the changelog link", () => {
    const out = fitDescription({
      lead: "lead",
      blocks: [{ text: "x".repeat(3000), entries: 10 }, { text: "y".repeat(3000), entries: 10 }],
      deprioritized: 0,
      changelogUrl: link,
      budget: 4096,
    });
    expect(out.length).toBeLessThanOrEqual(4096);
    // The link is the LAST line, not merely present somewhere in the middle of
    // a truncated body — that was the bug this whole function exists to fix.
    expect(out.trimEnd().split("\n").at(-1)).toMatch(/^\[Full changelog\]\(https:\/\/example\.com\/changelog\)/);
  });

  it("drops whole blocks rather than cutting one mid-sentence", () => {
    const out = fitDescription({
      lead: "",
      blocks: [{ text: "AAA", entries: 1 }, { text: "y".repeat(5000), entries: 4 }],
      deprioritized: 0,
      changelogUrl: link,
      budget: 4096,
    });
    expect(out).toContain("AAA");
    expect(out).not.toContain("yyy");
  });

  it("counts what it left out instead of implying it showed everything", () => {
    const out = fitDescription({
      lead: "",
      blocks: [{ text: "AAA", entries: 1 }, { text: "y".repeat(5000), entries: 4 }],
      deprioritized: 2,
      changelogUrl: link,
      budget: 4096,
    });
    expect(out).toContain("4 more entries");
    expect(out).toContain("2 dependency updates");
  });

  it("says nothing about omissions when nothing was omitted", () => {
    const out = fitDescription({
      lead: "",
      blocks: [{ text: "AAA", entries: 1 }],
      deprioritized: 0,
      changelogUrl: link,
      budget: 4096,
    });
    expect(out).toBe(`AAA\n\n[Full changelog](${link})`);
  });

  it("cuts an oversized lead rather than losing the link", () => {
    const out = fitDescription({
      lead: "L".repeat(9000),
      blocks: [],
      deprioritized: 0,
      changelogUrl: link,
      budget: 500,
    });
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out).toContain(link);
  });
});

describe("buildDiscordPayload", () => {
  const notes = collectRelease(CHANGELOG, "2.1.0");
  const base = { version: "2.1.0", repo: REPO, notes, timestamp: "2026-09-01T00:00:00.000Z" };

  it("puts the role mention in content, where Discord will actually resolve it", () => {
    const payload = buildDiscordPayload({ ...base, roleId: "555" });
    expect(payload.content).toContain("<@&555>");
    // Mentions inside an embed render as raw text and ping nobody.
    expect(JSON.stringify(payload.embeds)).not.toContain("<@&555>");
  });

  it("allows the release role and nothing else to ping", () => {
    const payload = buildDiscordPayload({ ...base, roleId: "555" });
    expect(payload.allowed_mentions).toEqual({ parse: [], roles: ["555"] });
  });

  it("cannot ping @everyone even when the notes contain it", () => {
    const payload = buildDiscordPayload({
      ...base,
      notes: parseReleaseBody("- heads up @everyone something changed"),
      roleId: "555",
    });
    // The text survives; `parse: []` is what stops it resolving.
    expect(payload.embeds[0].description).toContain("@everyone");
    expect(payload.allowed_mentions.parse).toEqual([]);
  });

  it("announces without a mention when no role is configured", () => {
    const payload = buildDiscordPayload({ ...base, roleId: null });
    expect(payload.content).not.toContain("<@&");
    expect(payload.allowed_mentions.roles).toEqual([]);
  });

  it("carries the version, the release link and the install line", () => {
    const payload = buildDiscordPayload({ ...base, releaseUrl: "https://example.com/rel" });
    const [embed] = payload.embeds;
    expect(embed.title).toBe("failproofai v2.1.0");
    expect(embed.url).toBe("https://example.com/rel");
    expect(embed.color).toBe(BRAND_COLOR);
    expect(embed.fields.find((f: { name: string }) => f.name === "Install")!.value).toContain(
      "npm install -g failproofai",
    );
  });

  it("links each entry to its pull request", () => {
    const payload = buildDiscordPayload(base);
    expect(payload.embeds[0].description).toContain(`[#101](https://github.com/${REPO}/pull/101)`);
  });

  it("leaves dependency bumps out of the highlights but counts them", () => {
    const payload = buildDiscordPayload(base);
    const { description } = payload.embeds[0];
    expect(description).not.toContain("**Dependencies**");
    expect(description).toContain("1 dependency update");
  });

  it("shows dependency bumps when they are all the release has", () => {
    const onlyDeps = collectRelease("## 3.0.0 — x\n\n### Dependencies\n\n- Bump a thing. (#1)\n", "3.0.0");
    const description = buildDiscordPayload({ ...base, version: "3.0.0", notes: onlyDeps }).embeds[0].description;
    expect(description).toContain("**Dependencies**");
    expect(description).toContain("Bump a thing.");
  });

  it("still announces when there are no notes at all", () => {
    const payload = buildDiscordPayload({ ...base, notes: null });
    expect(payload.content).toContain("failproofai v2.1.0");
    expect(payload.embeds[0].description).toContain("Full changelog");
  });

  it("prefers the release body's compare link over a blob link when one exists", () => {
    const payload = buildDiscordPayload({
      ...base,
      notes: parseReleaseBody("- a thing\n\n**Full Changelog**: https://github.com/o/r/compare/v1...v2"),
    });
    expect(payload.embeds[0].description).toContain("https://github.com/o/r/compare/v1...v2");
  });

  it("stays inside every Discord limit, even for the largest release this repo has cut", () => {
    // 1.0.0 aggregates 24 changelog sections and 246 entries — comfortably the
    // worst case, and the one that first pushed the description past 4096.
    const real = collectRelease(readFileSync(resolve(process.cwd(), "CHANGELOG.md"), "utf8"), "1.0.0");
    const payload = buildDiscordPayload({ version: "1.0.0", repo: REPO, notes: real, roleId: "555" });
    const [embed] = payload.embeds;

    expect(payload.content.length).toBeLessThanOrEqual(2000);
    expect(embed.title.length).toBeLessThanOrEqual(256);
    expect(embed.description.length).toBeLessThanOrEqual(4096);
    for (const field of embed.fields) {
      expect(field.name.length).toBeLessThanOrEqual(256);
      expect(field.value.length).toBeLessThanOrEqual(1024);
    }
    const total =
      embed.title.length +
      embed.description.length +
      embed.footer.text.length +
      embed.fields.reduce((n: number, f: { name: string; value: string }) => n + f.name.length + f.value.length, 0);
    expect(total).toBeLessThanOrEqual(6000);
    expect(embed.description).toContain("Full changelog");
  });
});
