// @vitest-environment node
/**
 * Calendar versioning for published packs — `2026.08.26`, `2026.08.26-2`.
 *
 * The four functions under test are pure by design: `nextCalendarVersion` takes
 * the day as a string and the published record as an array, so the cases that
 * matter — two publishers disagreeing about what day it is, a clock that is
 * simply wrong — are ordinary arguments here rather than a faked clock and a
 * faked GitHub. Nothing in this file touches the network or `new Date()`
 * except the two tests that are ABOUT the clock, and those pass the instant in.
 *
 * The clamp is the reason this is not a one-liner and is therefore the centre
 * of the file: a version that is lower than one already published, but newer,
 * is precisely the failure calendar versioning is chosen to prevent, and it is
 * reachable from a laptop in Los Angeles publishing after one in Auckland.
 */
import { describe, it, expect } from "vitest";

import {
  formatCalendarVersion,
  nextCalendarVersion,
  parseCalendarVersion,
  utcToday,
} from "@/src/hooks/pack-cli";

/**
 * Order two published versions the way the scheme means them: by date, then by
 * ordinal as a NUMBER. Written out longhand rather than calling
 * `parseCalendarVersion`, because a clamp checked with the parser it is built
 * on proves only that the two agree with each other. The numeric ordinal is
 * load-bearing too — a lexical compare puts `-10` before `-2`.
 */
function cmp(a: string, b: string): number {
  const split = (s: string): [string, number] => {
    const [date, ordinal] = s.replace(/^v/, "").split("-");
    return [date, ordinal === undefined ? 1 : Number(ordinal)];
  };
  const [dateA, ordinalA] = split(a);
  const [dateB, ordinalB] = split(b);
  if (dateA !== dateB) return dateA < dateB ? -1 : 1;
  return ordinalA - ordinalB;
}

describe("parseCalendarVersion", () => {
  it("reads a bare date as the first publish of that day", () => {
    expect(parseCalendarVersion("2026.08.26")).toEqual({ date: "2026.08.26", ordinal: 1 });
  });

  it("reads a `-N` suffix as the Nth publish of that day", () => {
    expect(parseCalendarVersion("2026.08.26-2")).toEqual({ date: "2026.08.26", ordinal: 2 });
    expect(parseCalendarVersion("2026.08.26-17")).toEqual({ date: "2026.08.26", ordinal: 17 });
  });

  it("accepts a `v` prefix, because git tags are routinely written that way", () => {
    expect(parseCalendarVersion("v2026.08.26")).toEqual({ date: "2026.08.26", ordinal: 1 });
    expect(parseCalendarVersion("v2026.08.26-3")).toEqual({ date: "2026.08.26", ordinal: 3 });
  });

  it("refuses `-0` and `-1`, which are second names for a version that exists", () => {
    // The first publish of a day carries NO suffix. Normalising these to
    // ordinal 1 would mean one release addressable as two strings, and two
    // spellings for one version is the ambiguity the scheme exists to remove —
    // so they are refused outright rather than quietly repaired.
    expect(parseCalendarVersion("2026.08.26-0")).toBeNull();
    expect(parseCalendarVersion("2026.08.26-1")).toBeNull();
    expect(parseCalendarVersion("v2026.08.26-1")).toBeNull();
  });

  it("refuses a date-SHAPED tag that is not a day", () => {
    // Shape is not meaning. `2026.88.26` is what one fat-fingered hand-tag
    // looks like, and it used to parse — after which it outranked every real
    // date for the rest of that year and the clamp pinned every later publish
    // onto it (`2026.88.26-2`, `-3`, …), with no way back to real days. Same
    // rule as `nightly`: a tag that names no day orders nothing.
    for (const tag of [
      "2026.88.26",
      "2026.13.45",
      "2026.00.26", // month 0
      "2026.08.00", // day 0
      "2026.02.30", // February never has one
      "2026.04.31", // April never has one
      "v2026.88.26-2",
    ]) {
      expect(parseCalendarVersion(tag), tag).toBeNull();
    }
  });

  it("accepts the real days at the edges of the calendar", () => {
    // The refusal above is a date check, not a range guess: the last day of a
    // month, a leap day, and the two ends of a year are all days, and a repo
    // that published on one has a sequence to continue.
    for (const date of ["2024.02.29", "2026.02.28", "2026.01.01", "2026.12.31", "2026.04.30"]) {
      expect(parseCalendarVersion(date), date).toEqual({ date, ordinal: 1 });
    }
  });

  it("refuses an ordinal `Number` cannot hold the digits of", () => {
    // Two silent failures, one bound. `-9007199254740993` rounds on the way in,
    // so the parse would report a version whose text is not the tag's; the
    // larger one renders back out as `2026.08.26-1e+23`, which this parser then
    // refuses — leaving the next publish seeing no sequence, restarting at
    // `-2`, and creating a release that already exists.
    expect(parseCalendarVersion("2026.08.26-99999999999999999999999")).toBeNull();
    expect(parseCalendarVersion("2026.08.26-9007199254740993")).toBeNull();
    // The whole safe range still counts, and still renders in digits rather
    // than in exponential form — that is the property the bound is for.
    const big = Number.MAX_SAFE_INTEGER;
    expect(parseCalendarVersion(`2026.08.26-${big}`)).toEqual({ date: "2026.08.26", ordinal: big });
    expect(formatCalendarVersion({ date: "2026.08.26", ordinal: big })).toBe(`2026.08.26-${big}`);
    expect(formatCalendarVersion({ date: "2026.08.26", ordinal: big })).not.toContain("e+");
  });

  it("reads a leading-zero ordinal as the number it spells, unlike `-1`", () => {
    // Deliberate asymmetry with `-0`/`-1` above. Those name a version that
    // already exists under its own spelling, so ignoring them costs nothing.
    // `-02` names one that exists under NO other spelling — ignore it and the
    // next publish mints `2026.08.26`, beneath a release that is already out,
    // which is the single outcome the clamp exists to prevent.
    expect(parseCalendarVersion("2026.08.26-02")).toEqual({ date: "2026.08.26", ordinal: 2 });
    expect(nextCalendarVersion(["2026.08.26-02"], "2026.08.26")).toBe("2026.08.26-3");
  });

  it("refuses semver, which stays installable by tag but seeds no date", () => {
    expect(parseCalendarVersion("1.0.0")).toBeNull();
    expect(parseCalendarVersion("v2.1.3")).toBeNull();
    expect(parseCalendarVersion("0.0.15-beta.1")).toBeNull();
  });

  it("refuses junk rather than parsing it heroically", () => {
    for (const tag of [
      "nightly",
      "release/2.1",
      "",
      "latest",
      // Not zero-padded, so it would not sort chronologically beside the rest.
      "2026.8.26",
      "2026.08.26-",
      "2026.08.26-x",
      "2026.08.26.1",
      "x2026.08.26",
    ]) {
      expect(parseCalendarVersion(tag), tag).toBeNull();
    }
  });

  it("tolerates surrounding whitespace, which a tag list can carry", () => {
    expect(parseCalendarVersion("  2026.08.26-4\n")).toEqual({ date: "2026.08.26", ordinal: 4 });
  });
});

describe("formatCalendarVersion", () => {
  it("renders the first of a day bare and later ones with `-N`", () => {
    expect(formatCalendarVersion({ date: "2026.08.26", ordinal: 1 })).toBe("2026.08.26");
    expect(formatCalendarVersion({ date: "2026.08.26", ordinal: 2 })).toBe("2026.08.26-2");
    expect(formatCalendarVersion({ date: "2026.08.26", ordinal: 12 })).toBe("2026.08.26-12");
  });

  it("round-trips every version it renders back through the parser", () => {
    // The two halves are used at opposite ends of a publish — one mints the
    // tag, the other reads it back off the release list — so a spelling either
    // one accepts and the other does not is a version nobody can continue from.
    for (const ordinal of [1, 2, 9, 10, 99]) {
      const rendered = formatCalendarVersion({ date: "2026.08.26", ordinal });
      expect(parseCalendarVersion(rendered), rendered).toEqual({ date: "2026.08.26", ordinal });
    }
  });
});

describe("utcToday", () => {
  it("zero-pads month and day, so a lexical sort is a chronological one", () => {
    expect(utcToday(new Date("2026-01-05T12:00:00Z"))).toBe("2026.01.05");
    // The whole point of the padding: these strings are compared as strings, by
    // the clamp below and by anyone reading a release list. Unpadded,
    // `2026.1.15` sorts before `2026.1.5` and October sorts before January.
    const days = ["2026-10-05", "2026-01-15", "2026-01-05", "2026-12-31"]
      .map((d) => utcToday(new Date(`${d}T12:00:00Z`)))
      .sort();
    expect(days).toEqual(["2026.01.05", "2026.01.15", "2026.10.05", "2026.12.31"]);
  });

  it("rolls over exactly at UTC midnight, and knows a leap day", () => {
    // The last millisecond of a day and the first of the next: the version
    // minted a millisecond apart across that line has to be two different days,
    // and everywhere else in the day it has to be one. Feb 29 is here because
    // the value is produced by real date arithmetic, and a day the calendar has
    // is a day this can mint — the parser has to keep accepting it.
    expect(utcToday(new Date("2026-12-31T23:59:59.999Z"))).toBe("2026.12.31");
    expect(utcToday(new Date("2027-01-01T00:00:00.000Z"))).toBe("2027.01.01");
    expect(utcToday(new Date("2026-08-26T00:00:00.000Z"))).toBe("2026.08.26");
    const leap = utcToday(new Date("2024-02-29T12:00:00Z"));
    expect(leap).toBe("2024.02.29");
    expect(parseCalendarVersion(leap)).toEqual({ date: leap, ordinal: 1 });
  });

  it("reads the day in UTC, not in whatever zone the publisher is sitting in", () => {
    // Both instants below are the 26th in UTC and a different date locally, in
    // the two most extreme inhabited zones. A local-time reading would mint a
    // version a day ahead of or behind the record for the same instant, which
    // is the disagreement the clamp then has to clean up after.
    //
    // Each half asserts the LOCAL day first. That guard is what keeps this test
    // from being vacuous: a runner that ignores a mid-process `TZ` change (or a
    // machine already sitting in UTC) leaves local and UTC identical, and then
    // a `getDate()`-based implementation would pass this test unnoticed. If the
    // shift did not land, the guard fails and says so rather than the test
    // quietly proving nothing.
    const saved = process.env.TZ;
    try {
      process.env.TZ = "Pacific/Kiritimati"; // UTC+14 — already the 27th there.
      const ahead = new Date("2026-08-26T23:30:00Z");
      expect(ahead.getDate(), "TZ change did not take effect").toBe(27);
      expect(utcToday(ahead)).toBe("2026.08.26");
      process.env.TZ = "Pacific/Midway"; // UTC-11 — still the 25th there.
      const behind = new Date("2026-08-26T00:30:00Z");
      expect(behind.getDate(), "TZ change did not take effect").toBe(25);
      expect(utcToday(behind)).toBe("2026.08.26");
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });
});

describe("nextCalendarVersion", () => {
  it("gives a repo that has never published today's date, bare", () => {
    expect(nextCalendarVersion([], "2026.08.26")).toBe("2026.08.26");
  });

  it("gives today, bare, when the newest release is an earlier date", () => {
    expect(nextCalendarVersion(["2026.08.20", "2026.07.01-3"], "2026.08.26")).toBe("2026.08.26");
  });

  it("counts up within a day: bare, then -2, then -3", () => {
    const published: string[] = [];
    for (const expected of ["2026.08.26", "2026.08.26-2", "2026.08.26-3"]) {
      const next = nextCalendarVersion(published, "2026.08.26");
      expect(next).toBe(expected);
      published.push(next);
    }
  });

  it("continues the highest ordinal, not the count of releases", () => {
    // Release lists arrive newest-first from the API and a release can be
    // deleted, so the answer has to come from the highest version seen rather
    // than from how many there are or which one happens to be first.
    expect(nextCalendarVersion(["2026.08.26-2", "2026.08.26", "2026.08.26-4"], "2026.08.26")).toBe(
      "2026.08.26-5",
    );
  });

  it("clamps: a release dated LATER than today continues that day, never goes back", () => {
    // The Auckland/Los Angeles case, and the wrong-clock case, are the same
    // defect from two sides — this machine believes it is the 26th while the
    // record already carries the 27th. Restarting at today would mint a version
    // that is lower than one already published and yet newer, which is exactly
    // what calendar versioning is chosen to prevent.
    const existing = ["2026.08.27-2", "2026.08.26", "2026.08.20"];
    const next = nextCalendarVersion(existing, "2026.08.26");
    expect(next).toBe("2026.08.27-3");
    for (const tag of existing) expect(cmp(next, tag), `${next} vs ${tag}`).toBeGreaterThan(0);
  });

  it("clamps against a clock that is wrong by years, and past ordinal 9", () => {
    // A machine whose clock never got set is the same shape as a timezone
    // ahead, only larger. `-10` is here because the ordinal has to keep
    // counting as a NUMBER: a lexical bump would produce `2026.08.26-2` again,
    // a version that already exists.
    const existing = ["2026.08.26-9", "2026.08.26"];
    const next = nextCalendarVersion(existing, "2020.01.01");
    expect(next).toBe("2026.08.26-10");
    for (const tag of existing) expect(cmp(next, tag), `${next} vs ${tag}`).toBeGreaterThan(0);
  });

  it("lets semver and junk seed nothing — a fresh date sequence starts beside them", () => {
    // Those releases stay installable by tag forever; they simply do not order
    // a date. Reading them as a sequence would be worse than ignoring them:
    // `nightly` and `v2.1.3` both sort ABOVE any `2026.…` as raw strings, so a
    // parser that accepted them would clamp every future publish to a tag that
    // is not a date at all.
    expect(nextCalendarVersion(["1.0.0", "v2.1.3", "nightly", "release/2.1"], "2026.08.26")).toBe(
      "2026.08.26",
    );
  });

  it("continues the dates in a repo that has BOTH semver history and dates", () => {
    const tags = ["v2.1.3", "1.0.0", "nightly", "2026.08.26", "2026.08.20", "0.9.0"];
    expect(nextCalendarVersion(tags, "2026.08.26")).toBe("2026.08.26-2");
    // And the same list a day later resumes at the new day, bare.
    expect(nextCalendarVersion(tags, "2026.08.27")).toBe("2026.08.27");
  });

  it("reads `v`-prefixed date tags as part of the same sequence", () => {
    // A repo whose earlier releases were tagged `v2026.08.26` has published
    // that day. Skipping the prefix would restart the ordinal and collide.
    expect(nextCalendarVersion(["v2026.08.26"], "2026.08.26")).toBe("2026.08.26-2");
    expect(nextCalendarVersion(["v2026.08.27-2"], "2026.08.26")).toBe("2026.08.27-3");
  });

  it("lets a date-SHAPED tag that is no day seed nothing, like any other junk", () => {
    // `2026.88.26` is one fat-fingered hand-tag, and as a raw string it sorts
    // above every real date in 2026 — so a parser that took it clamped every
    // publish for the rest of that year onto a version that names no day, with
    // no way back. The real dates beside it are the sequence to continue.
    expect(nextCalendarVersion(["2026.88.26", "2026.08.26"], "2026.08.26")).toBe("2026.08.26-2");
    expect(nextCalendarVersion(["2026.02.30-4"], "2026.08.26")).toBe("2026.08.26");
  });

  it("lets an ordinal past counting seed nothing, rather than minting one twice", () => {
    // The failure this prevents needs three publishes to show itself: the
    // absurd tag rounds under `Number`, renders as `2026.08.26-1e+23`, and is
    // then unreadable — so the publish AFTER it sees only `2026.08.26`, mints
    // `-2`, and the one after that mints `-2` again, over a release that is
    // already out. Ignoring the tag keeps the sequence counting.
    const published = ["2026.08.26", "2026.08.26-99999999999999999999999"];
    for (const expected of ["2026.08.26-2", "2026.08.26-3", "2026.08.26-4"]) {
      const next = nextCalendarVersion(published, "2026.08.26");
      expect(next).toBe(expected);
      published.push(next);
    }
  });

  it("honours a real date in the future, because a zone ahead looks the same", () => {
    // The clamp cannot tell a publisher fourteen hours ahead from a clock set
    // to 2099 — both are "the record already carries a later day" — and it
    // treats them alike ON PURPOSE, because refusing the future would break the
    // Auckland case the clamp exists for. The other direction is undetectable
    // here by construction: with nothing published, a wrong clock IS today, and
    // that is the documented edge of what a pure function can check.
    expect(nextCalendarVersion(["2099.12.31"], "2026.08.26")).toBe("2099.12.31-2");
    expect(nextCalendarVersion([], "2099.01.01")).toBe("2099.01.01");
  });

  it("refuses `-1` as a sequence but does not collide with the tag either", () => {
    // `-1` is a second name for the bare version, so it seeds nothing — and the
    // bare version it then mints is a different TAG from `2026.08.26-1`, so the
    // release still creates. Worth pinning: "ignored by the parser" and "safe to
    // publish over" are two claims, and only the second one is about GitHub.
    expect(nextCalendarVersion(["2026.08.26-1"], "2026.08.26")).toBe("2026.08.26");
  });

  it("never mints a version that is already published", () => {
    // The property every case above is a specific instance of, checked against
    // the whole list rather than the one tag the case is about — including the
    // `v`-prefixed spelling, which is the same version wearing a prefix and so
    // has to be compared parsed, not as a string.
    const cases: string[][] = [
      ["2026.08.26"],
      ["v2026.08.26", "2026.08.26-2"],
      ["2026.08.26-2", "2026.08.26", "2026.08.26-4"], // -3 deleted
      ["2026.08.27-2", "2026.08.26", "2026.08.20"],
      ["2026.08.26-9", "2026.08.26"],
      ["nightly", "1.0.0", "2026.08.26-02"],
      ["2026.88.26", "2026.08.26"],
      ["2026.08.26", "2026.08.26-99999999999999999999999"],
    ];
    for (const today of ["2026.08.26", "2026.01.01", "2030.06.15"]) {
      for (const tags of cases) {
        const next = nextCalendarVersion(tags, today);
        const minted = parseCalendarVersion(next);
        expect(minted, `${next} must parse`).not.toBeNull();
        for (const tag of tags) {
          expect(next, `${next} collides with ${tag}`).not.toBe(tag.replace(/^v/, ""));
          const taken = parseCalendarVersion(tag);
          if (taken) expect(minted, `${next} is ${tag}`).not.toEqual(taken);
        }
      }
    }
  });

  it("does not depend on the order the release list arrives in", () => {
    // The API returns newest-first and pages, a release can be deleted, and a
    // second publisher's release lands wherever it lands. The answer comes from
    // the highest version in the list, so any ordering of the same list has to
    // give the same one.
    const tags = ["2026.08.26-2", "v2026.08.26", "nightly", "2026.08.20", "2026.08.26-4", "1.0.0"];
    const answer = nextCalendarVersion(tags, "2026.08.26");
    expect(answer).toBe("2026.08.26-5");
    for (const ordering of [[...tags].reverse(), [...tags].sort(), [...tags].sort().reverse()]) {
      expect(nextCalendarVersion(ordering, "2026.08.26"), ordering.join(",")).toBe(answer);
    }
  });
});
