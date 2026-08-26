// @vitest-environment node
/**
 * `policies add <pack> --category X` on a pack that is ALREADY installed.
 *
 * The command's first word is `add`, and it used to REPLACE the enabled set.
 * Following the pack README's own path — take the defaults, then add a
 * category — left the user with fewer policies on than they started with,
 * silently. `PackAddOptions.merge` is the fix: the CLI flags union with what is
 * already enabled, while the interactive picker keeps replacing because its
 * list is the complete answer and unticking something has to be able to turn it
 * off.
 *
 * Driven through `addPack` against a real HTTP server serving a real release
 * layout, the same way `pack-store.test.ts` does — `resolveSelection` is not
 * exported, and the merge only means anything once a prior record exists on
 * disk for it to merge WITH.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { addPack, removePack } from "@/src/hooks/pack-store";
import { readInstalledPacks } from "@/src/hooks/pack-manifest";

// Registers exactly the policies the manifest declares. `addPack` imports the
// artifact and refuses any pack whose registrations do not match its manifest —
// in EITHER direction — so a release that drops a policy has to drop it from
// both files or nothing here gets as far as a selection. Generated from the
// same list the manifest is built from, so the two cannot drift apart.
function entryFor(policies: Array<{ name: string }>): string {
  return [
    `import { customPolicies } from "failproofai";`,
    ...policies.map(
      (p) =>
        `customPolicies.add({ name: ${JSON.stringify(p.name)}, description: "d", ` +
        `match: { events: ["PreToolUse"] }, fn: async () => ({ decision: "allow" }) });`,
    ),
  ].join("\n");
}

// Two categories and exactly ONE defaultEnabled, so "the pack's defaults",
// "one category" and "everything" are three different sets. A fixture where
// they coincided would let a merge that quietly replaced still pass.
const POLICY = {
  name: "block-big-refund",
  description: "Block refunds above the approved limit",
  category: "Finance",
  defaultEnabled: true,
  match: { events: ["PreToolUse"] },
};
const POLICY_2 = { ...POLICY, name: "require-approval-note", defaultEnabled: false };
const POLICY_3 = {
  name: "audit-log-writes", description: "Log every write",
  category: "Audit Trail", defaultEnabled: false, match: { events: ["PostToolUse"] },
};

/**
 * A SECOND, unrelated pack, so the merge has somebody else's record to get
 * wrong. Different id, different names, and a different entry — a fixture that
 * shared entry bytes with the first would be absorbed as the same pack renamed
 * rather than sitting beside it.
 */
const OTHER_POLICY = {
  name: "other-default-on",
  description: "Somebody else's policy",
  category: "Other",
  defaultEnabled: true,
  match: { events: ["PreToolUse"] },
};
const OTHER_POLICY_2 = { ...OTHER_POLICY, name: "other-default-off", defaultEnabled: false };

/** The pack's DECLARED order, which every result is supposed to come back in. */
const DECLARED = ["block-big-refund", "require-approval-note", "audit-log-writes"];

let server: Server;
let root: string;
let prevPackDir: string | undefined;
let prevBase: string | undefined;
let prevNoDownload: string | undefined;
let prevHome: string | undefined;

/** Release contents per `owner/repo`, so two packs can be served at once. */
let assets: Record<string, Record<string, string>>;

function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Build a well-formed release: manifest, entry, and matching SHA256SUMS.
 *
 * `policies` is overridable because a pack that SHRINKS between versions is the
 * case where the record on disk becomes somebody else's data — it names a
 * policy this version does not have.
 */
function release(
  over: { version?: string; policies?: Array<{ name: string }>; repo?: string; id?: string } = {},
): void {
  const policies = over.policies ?? [POLICY, POLICY_2, POLICY_3];
  const entry = entryFor(policies);
  const manifest = JSON.stringify({
    id: over.id ?? "acme/finance",
    version: over.version ?? "1.2.0",
    policies,
  });
  assets[over.repo ?? "acme/finance"] = {
    "failproofai-pack.json": manifest,
    "failproofai-pack.mjs": entry,
    SHA256SUMS:
      `${sha(manifest)}  failproofai-pack.json\n` +
      `${sha(entry)}  failproofai-pack.mjs\n`,
  };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "fpai-pack-merge-"));
  prevPackDir = process.env.FAILPROOFAI_PACK_DIR;
  prevBase = process.env.FAILPROOFAI_PACK_BASE_URL;
  prevNoDownload = process.env.FAILPROOFAI_NO_DOWNLOAD;
  prevHome = process.env.HOME;
  delete process.env.FAILPROOFAI_NO_DOWNLOAD;
  process.env.FAILPROOFAI_PACK_DIR = join(root, "packs");
  // A throwaway HOME as well as a throwaway pack dir: every install here writes
  // a real `installed.json`, and one of these tests reaching the developer's own
  // `~/.failproofai` would rewrite the enabled set of packs they actually run.
  mkdirSync(join(root, "home"), { recursive: true });
  process.env.HOME = join(root, "home");
  assets = {};
  release();
  release({ repo: "acme/other", id: "acme/other", version: "0.1.0",
    policies: [OTHER_POLICY, OTHER_POLICY_2] });

  // Serves ONLY the real release path, so a wrong owner/repo/tag 404s the way
  // GitHub would rather than quietly matching some other asset — including the
  // second pack's assets, which live under their own repo.
  server = createServer((req, res) => {
    const url = req.url ?? "";
    const m = url.match(/^\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/([^/]+)$/);
    const body = m ? assets[`${m[1]}/${m[2]}`]?.[m[4]] : undefined;
    if (body === undefined) {
      res.writeHead(404).end("no such asset");
      return;
    }
    res.writeHead(200).end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.FAILPROOFAI_PACK_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  for (const [k, v] of Object.entries({
    FAILPROOFAI_PACK_DIR: prevPackDir,
    FAILPROOFAI_PACK_BASE_URL: prevBase,
    FAILPROOFAI_NO_DOWNLOAD: prevNoDownload,
    HOME: prevHome,
  })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

const SOURCE = "github:acme/finance@v1.2.0";
const OTHER_SOURCE = "github:acme/other@v0.1.0";
/**
 * The raw record for ONE pack, found by id. `installed.json` is a single array
 * for every pack on the machine, so reaching for `packs[0]` would read whichever
 * happened to be written first — the exact confusion the two-pack case below is
 * about.
 */
const record = (id = "acme/finance") =>
  JSON.parse(readFileSync(join(root, "packs", "installed.json"), "utf8"))
    .packs.find((p: { id: string }) => p.id === id);

describe("a flag on a FRESH install", () => {
  it("takes only what the flag named, and does not call that a merge", async () => {
    // The CLI flags always carry `merge: true`, so a first install is the case
    // where the merge has to be a NO-OP — there is no prior record to union
    // with, and `previouslyInstalled` is what says so. Without that guard the
    // install still enables the right policies but reports itself as `added`,
    // and `pack-cli` then prints "what you added, plus what was already on"
    // over a pack that had nothing on it a moment ago.
    const byCategory = await addPack(SOURCE, { categories: ["audit-trail"], merge: true });
    expect(byCategory.enabled).toEqual(["audit-log-writes"]);
    expect(byCategory.selection).toBe("selected");
    expect(record().enabled).toEqual(["audit-log-writes"]);

    // `block-big-refund` is the pack's one defaultEnabled policy and is named
    // by neither flag, so a first install that reached the union branch and
    // pulled the publisher's defaults in beside the flag would show up here.
    expect(byCategory.enabled).not.toContain("block-big-refund");

    // The same call again, now that a record exists, is the contrast that makes
    // the guard the only difference: identical input, identical result, and
    // only the REASON moves. A guard keyed on anything but "was this pack
    // already installed" — the shape of the expressed selection, the size of
    // the union — cannot tell these two calls apart.
    const again = await addPack(SOURCE, { categories: ["audit-trail"], merge: true });
    expect(again.enabled).toEqual(["audit-log-writes"]);
    expect(again.selection).toBe("added");
  });
});

describe("a flag on an ALREADY-INSTALLED pack adds", () => {
  it("unions --category with what was already on, and the count goes UP", async () => {
    // The reported bug, in miniature: take the defaults, then add a category.
    // Replacing left the user with strictly FEWER policies enforcing than
    // before, from a command whose first word is `add`, and said nothing.
    const first = await addPack(SOURCE);
    expect(first.enabled).toEqual(["block-big-refund"]);

    const second = await addPack(SOURCE, { categories: ["audit-trail"], merge: true });
    expect(second.enabled).toEqual(["block-big-refund", "audit-log-writes"]);
    expect(second.enabled.length).toBeGreaterThan(first.enabled.length);
  });

  it("unions --policy with what was already on", async () => {
    // Same rule for the other flag. `--policy` and `--category` are one
    // selection built in one place, so a fix that only covered categories would
    // still lose the defaults for anybody who typed policy names.
    await addPack(SOURCE);
    const second = await addPack(SOURCE, {
      only: ["require-approval-note", "audit-log-writes"],
      merge: true,
    });
    expect(second.enabled).toEqual(DECLARED);
  });

  it("writes the union to disk, so the next hook event enforces all of it", async () => {
    // The returned set is what gets PRINTED; `installed.json` is what actually
    // enforces. A merge that only fixed the printed line would report ten
    // policies on and run six.
    await addPack(SOURCE);
    await addPack(SOURCE, { categories: ["audit-trail"], merge: true });
    expect(record().enabled).toEqual(["block-big-refund", "audit-log-writes"]);
    expect(readInstalledPacks().packs[0].enabled).toEqual(["block-big-refund", "audit-log-writes"]);
  });

  it("unions an OVERLAPPING flag without dropping the rest or listing a name twice", async () => {
    // `--category Finance` names `block-big-refund`, which is already on, and
    // `require-approval-note`, which is not. Replacing here would keep the two
    // Finance policies and silently drop `audit-log-writes` — the same loss as
    // the bug above, hidden behind a flag that looks like it only adds. The
    // overlapping name has to come back exactly once.
    await addPack(SOURCE, { only: ["audit-log-writes", "block-big-refund"], merge: true });
    const second = await addPack(SOURCE, { categories: ["finance"], merge: true });
    expect(second.enabled).toEqual(DECLARED);
    expect(new Set(second.enabled).size).toBe(second.enabled.length);
  });

  it("adds to a pack with NOTHING on, without reading none as everything", async () => {
    // `[]` and absent are OPPOSITE records — enable none of it, and take the
    // whole thing — and the merge branch distinguishes them by testing
    // `previous === null`. Untick everything in the picker, then add one
    // category, and a branch that asked whether the prior selection was empty
    // instead hands back the entire catalog: three policies enforcing on a pack
    // its owner had deliberately left at zero, reported as an addition of one.
    await addPack(SOURCE);
    await addPack(SOURCE, { only: [], merge: false });
    expect(record().enabled).toEqual([]);

    const third = await addPack(SOURCE, { categories: ["audit-trail"], merge: true });
    expect(third.enabled).toEqual(["audit-log-writes"]);
    expect(third.selection).toBe("added");
    expect(record().enabled).toEqual(["audit-log-writes"]);
  });

  it("keeps the result in the pack's DECLARED order, not the order things arrived", async () => {
    // The flag's names are added to the set BEFORE the prior selection, so
    // insertion order here is audit, block, require — while the pack declares
    // block, require, audit. Everything else lists a pack in declared order, so
    // returning the accumulator raw would make the enabled set the one listing
    // that disagrees with the rest.
    await addPack(SOURCE, { only: ["require-approval-note"], merge: true });
    const second = await addPack(SOURCE, {
      only: ["audit-log-writes", "block-big-refund"],
      merge: true,
    });
    expect(second.enabled).toEqual(DECLARED);
    expect(record().enabled).toEqual(DECLARED);
  });
});

describe("an upgrade that DROPPED one of the pack's policies", () => {
  it("refuses a flag naming a policy this version dropped, and writes nothing", async () => {
    // An additive operation is the tempting place to go lenient — the name adds
    // nothing, so skipping it looks harmless — and that turns a typo, or a
    // policy the publisher removed, into a success message over a policy that
    // is not on and does not exist. The refusal has to come before anything is
    // written, too: the machine stays on 1.2.0 with the selection it had,
    // rather than half-upgraded to a version whose flag was rejected.
    await addPack(SOURCE, { only: ["block-big-refund", "require-approval-note"], merge: true });

    release({ version: "1.3.0", policies: [POLICY, POLICY_3] });
    await expect(
      addPack("github:acme/finance@v1.3.0", { only: ["require-approval-note"], merge: true }),
    ).rejects.toThrow(/does not contain require-approval-note/);

    expect(record().version).toBe("1.2.0");
    expect(record().enabled).toEqual(["block-big-refund", "require-approval-note"]);
  });

  it("carries the surviving half of a selection and drops the rest", async () => {
    // Same shrinking upgrade with no flags at all, which is the path that has
    // to filter the prior names itself — the merge branch is spared it because
    // it rebuilds the answer from the new version's own list. Carry the record
    // through unfiltered and the stale name is written straight back.
    await addPack(SOURCE, { only: ["block-big-refund", "require-approval-note"], merge: true });

    release({ version: "1.3.0", policies: [POLICY, POLICY_3] });
    const upgraded = await addPack("github:acme/finance@v1.3.0", { merge: true });
    expect(upgraded.selection).toBe("carried");
    expect(upgraded.enabled).toEqual(["block-big-refund"]);
    expect(record().enabled).toEqual(["block-big-refund"]);
  });
});

describe("a second pack on the machine", () => {
  it("unions with THIS pack's selection and leaves the other one alone", async () => {
    // `installed.json` holds every pack in one array, so the prior record has
    // to be found by id. Take the first row instead and a merge unions this
    // pack's flag with a stranger's enabled names — which are not policies of
    // this pack at all, so they filter away to nothing and the "add" quietly
    // becomes a replace. Installed first on purpose: the other pack is `packs[0]`.
    await addPack(OTHER_SOURCE);
    expect(record("acme/other").enabled).toEqual(["other-default-on"]);

    await addPack(SOURCE);
    const merged = await addPack(SOURCE, { categories: ["audit-trail"], merge: true });
    expect(merged.enabled).toEqual(["block-big-refund", "audit-log-writes"]);
    expect(record("acme/finance").enabled).toEqual(["block-big-refund", "audit-log-writes"]);

    // And the neighbour is untouched — same row, same selection, still there.
    expect(record("acme/other").enabled).toEqual(["other-default-on"]);
    expect(readInstalledPacks().packs).toHaveLength(2);
  });
});

describe("the picker still REPLACES", () => {
  it("drops what the picker did not tick", async () => {
    // `merge: false` is the picker's override. Its list is the complete answer,
    // so a policy left unticked has to come off — if the flag's additive
    // reading leaked in here, unticking could never turn anything off again.
    await addPack(SOURCE);
    const second = await addPack(SOURCE, { only: ["audit-log-writes"], merge: false });
    expect(second.enabled).toEqual(["audit-log-writes"]);
    expect(second.enabled).not.toContain("block-big-refund");
    expect(second.selection).toBe("selected");
  });

  it("enables NONE when everything was unticked", async () => {
    // The case that made replace the default in the first place: you untick
    // every pre-ticked default, press enter, and the pack must end up with
    // nothing on. `enabled: []` and `enabled: undefined` mean opposite things —
    // none, and all — so the empty array has to survive to disk as an array.
    await addPack(SOURCE);
    const second = await addPack(SOURCE, { only: [], merge: false });
    expect(second.enabled).toEqual([]);
    expect(record().enabled).toEqual([]);
    expect(record().enabled).not.toBeUndefined();
  });

  it("is what an empty pick needs — the same empty list from a FLAG would not clear", async () => {
    // The other half of why the picker overrides the flag default. Under merge,
    // an empty expressed selection adds nothing to what is already on and the
    // pack keeps enforcing exactly what it did, so `merge: false` is the only
    // thing that makes "untick everything" mean anything.
    await addPack(SOURCE);
    const second = await addPack(SOURCE, { only: [], merge: true });
    expect(second.enabled).toEqual(["block-big-refund"]);
    // On disk as well as in the returned value: the claim is that this install
    // changed nothing, and the file is the half that keeps enforcing.
    expect(record().enabled).toEqual(["block-big-refund"]);
  });

  it("replaces when no caller expressed an opinion about merging", async () => {
    // Anything that calls `addPack` without the flag — the dashboard's
    // `addPackFromSource`, the cloud reconciler — keeps the old replacing
    // behaviour. Merging is opt-in, so an omitted `merge` must not start
    // accumulating selections behind a caller that never asked for it.
    await addPack(SOURCE);
    const second = await addPack(SOURCE, { categories: ["audit-trail"] });
    expect(second.enabled).toEqual(["audit-log-writes"]);
    expect(second.selection).toBe("selected");
  });
});

describe("a pack taken whole", () => {
  it("stays whole when a category is added to it, and does not become a list", async () => {
    // `--all` records `enabled` as ABSENT, which is how "the whole pack" is
    // stored so a later version's new policies are included too. Adding a
    // category to everything is still everything — materialising the union into
    // a list of the three names that exist today would freeze the pack at this
    // version and silently exclude whatever the publisher adds next.
    const first = await addPack(SOURCE, { all: true });
    expect(record().enabled).toBeUndefined();

    const second = await addPack(SOURCE, { categories: ["audit-trail"], merge: true });
    expect(record().enabled).toBeUndefined();
    expect(readInstalledPacks().packs[0].enabled).toBeNull();
    // Reported back as the full catalog, the same as the `--all` install was.
    expect(second.enabled).toEqual(first.enabled);
    expect(second.enabled).toEqual(DECLARED);
  });

  it("becomes whole from a LIST, clearing the names that were stored", async () => {
    // The widening direction, which the flags reach with `--all` alongside the
    // same `merge: true` every flag carries. "Everything" is stored as an
    // ABSENT `enabled`, so the previous list has to be cleared out of the
    // record rather than left beside it — an upsert that preserved fields it
    // was not given would report the whole pack while enforcing the one policy
    // still named on disk, and `readInstalledPacks` would agree with the file.
    await addPack(SOURCE, { only: ["require-approval-note"], merge: true });
    expect(record().enabled).toEqual(["require-approval-note"]);

    const all = await addPack(SOURCE, { all: true, merge: true });
    expect(all.selection).toBe("all");
    expect(all.enabled).toEqual(DECLARED);
    expect(record().enabled).toBeUndefined();
    expect(readInstalledPacks().packs[0].enabled).toBeNull();
  });

  it("reports that as carried, not added — nothing was added to everything", async () => {
    // `added` is the sentence that says the set is larger than what was asked
    // for. Nothing grew here, so saying so would be a lie about a set that did
    // not move.
    await addPack(SOURCE, { all: true });
    const second = await addPack(SOURCE, { categories: ["audit-trail"], merge: true });
    expect(second.selection).toBe("carried");
  });
});

describe("the reason the CLI prints", () => {
  it("says added for a merge and selected for a replace", async () => {
    // `pack-cli` maps these two to different sentences — "what you added, plus
    // what was already on" against "your selection" — because the merge is the
    // one outcome where the result is LARGER than what the user typed. Collapse
    // them into one string and the reader takes the printed set for their whole
    // answer.
    await addPack(SOURCE);
    const merged = await addPack(SOURCE, { categories: ["audit-trail"], merge: true });
    expect(merged.selection).toBe("added");

    const replaced = await addPack(SOURCE, { categories: ["audit-trail"], merge: false });
    expect(replaced.selection).toBe("selected");
  });

  it("still says defaults and carried on the paths that express no selection", async () => {
    // The merge branch sits inside the expressed-selection block, so it must not
    // capture an install that named no flags at all. A first install still gets
    // the publisher's defaults, and a bare re-add still carries what the machine
    // had rather than re-deciding for the user.
    const first = await addPack(SOURCE);
    expect(first.selection).toBe("defaults");

    release({ version: "1.3.0" });
    const upgrade = await addPack("github:acme/finance@v1.3.0", { merge: true });
    expect(upgrade.selection).toBe("carried");
    expect(upgrade.enabled).toEqual(["block-big-refund"]);
  });
});

describe("an agent narrowing survives the next add", () => {
  // The same bug as the one `merge` fixes, in the WIDENING direction — and that
  // is the worse one. `upsertInstalled` replaces the row wholesale, so writing
  // no `clis` threw away a scope the user had chosen: a pack narrowed to Claude
  // silently started guarding every supported agent on the next
  // `policies add`, enforcing on agents nobody picked, with nothing said.
  it("carries a prior --cli through a later flag that names no agents", async () => {
    await addPack(SOURCE, { clis: ["claude"], categories: ["audit-trail"], merge: true });
    expect(record().clis).toEqual(["claude"]);

    await addPack(SOURCE, { categories: ["finance"], merge: true });
    expect(record().clis).toEqual(["claude"]);
  });

  it("carries it through a bare re-add, which is what an upgrade is", async () => {
    await addPack(SOURCE, { clis: ["claude", "codex"], merge: true });
    expect(record().clis).toEqual(["claude", "codex"]);

    await addPack(SOURCE, { merge: true });
    expect(record().clis).toEqual(["claude", "codex"]);
  });

  it("still lets a later --cli replace it, rather than accumulating agents", async () => {
    // Carrying is for a caller that expressed NO opinion. One that names agents
    // has expressed one, and a union here would make narrowing impossible —
    // every `--cli` would only ever add to the set.
    await addPack(SOURCE, { clis: ["claude", "codex"], merge: true });
    await addPack(SOURCE, { clis: ["codex"], merge: true });
    expect(record().clis).toEqual(["codex"]);
  });

  it("does NOT carry for the picker, whose silence means every agent", async () => {
    // The one caller for which an absent `clis` is an ANSWER rather than an
    // omission: ticking every agent deliberately writes nothing, so that a CLI
    // supported later is included too. Carrying a prior narrowing there would
    // make widening back to all impossible — the picker could never undo a
    // `--cli` typed once.
    await addPack(SOURCE, { clis: ["claude"], merge: true });
    expect(record().clis).toEqual(["claude"]);

    await addPack(SOURCE, { only: [], merge: false });
    expect(record().clis).toBeUndefined();
  });
});

describe("removing a pack by the name you actually have", () => {
  // Exactly one spelling used to work — the stored id, byte for byte — and it
  // is shown nowhere on its own, so every spelling a user could SEE or had
  // TYPED was refused:
  //
  //   add    failproofai/policies              stores `FailproofAI/policies`
  //   remove failproofai/policies              no installed pack with id …
  //   remove FailproofAI/policies@06b8…        no installed pack with id …
  //
  // The first is what they installed it with — GitHub is case-insensitive, so
  // `add` takes any case and records the canonical id off the manifest. The
  // second is the listing's own heading, copied. A pack whose owner happens to
  // be lowercase removes on the first try, which is what made this look like
  // one particular pack being unremovable rather than a name-matching bug.
  it.each([
    ["the case it was installed with", (id: string) => id.toLowerCase()],
    ["shouted", (id: string) => id.toUpperCase()],
    ["the listing's heading, version and all", (id: string) => `${id}@1.0.0`],
    ["a heading in the wrong case", (id: string) => `${id.toLowerCase()}@1.0.0`],
    ["surrounded by whitespace", (id: string) => `  ${id}  `],
  ])("removes it when named %s", async (_label, spell) => {
    await addPack(SOURCE, { all: true });
    const stored = record().id;
    expect(removePack(spell(stored))).toBe(stored);
    expect(readInstalledPacks().packs).toHaveLength(0);
  });

  it("reports the id the MACHINE holds, not the spelling that was typed", async () => {
    // A `remove FAILPROOFAI/POLICIES` that succeeds and echoes that back
    // teaches a name nothing else in the product uses.
    await addPack(SOURCE, { all: true });
    const stored = record().id;
    expect(removePack(stored.toUpperCase())).toBe(stored);
  });

  it("still refuses a name that is genuinely not installed", async () => {
    // The loosening must not turn into "removes whatever is there". A wrong
    // name has to stay wrong, or a typo silently uninstalls the pack.
    await addPack(SOURCE, { all: true });
    expect(removePack("acme/not-installed")).toBeNull();
    expect(removePack("acme/not-installed@1.0.0")).toBeNull();
    expect(readInstalledPacks().packs).toHaveLength(1);
  });

  it("does not match on the owner alone, or on the name alone", async () => {
    // `@` is the only separator dropped. A pack id cannot contain one —
    // PACK_ID_RE forbids it — but the halves either side of the SLASH are
    // still both significant, and matching on one would remove a stranger's
    // pack that happened to share an owner.
    await addPack(SOURCE, { all: true });
    const [owner, name] = record().id.split("/");
    expect(removePack(owner)).toBeNull();
    expect(removePack(name)).toBeNull();
    expect(removePack(`${owner}/something-else`)).toBeNull();
    expect(readInstalledPacks().packs).toHaveLength(1);
  });
});
