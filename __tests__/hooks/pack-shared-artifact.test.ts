// @vitest-environment node
/**
 * Two installed packs whose entry files are byte-identical.
 *
 * Pack artifacts are content-addressed, so identical source is ONE file on
 * disk, and `loadedPaths` imports any file exactly once — importing twice would
 * register every hook twice, because `customPolicies.add` is an unconditional
 * push. So the two pack records have to collapse into one, and everything
 * below is about what that collapse is allowed to throw away.
 *
 * The effect was resolved toward enforcement. The SELECTIONS were not: only the
 * winner's `enabled` reached the hook tag, and `handler.ts` gates every hook on
 * that one list, so the loser's policies never registered. Nothing reported it
 * either — `pack-failclosed.ts` deliberately ignores a pack absent from the
 * registered map, because "no registrations" cannot be told apart from a pause.
 * A policy the user installed and enabled simply did not run, silently. `clis`
 * had the identical shape: a pack scoped to one agent decided the scope for
 * both.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/src/hooks/hook-logger", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  hookLogWarn: vi.fn(),
}));
import { hookLogWarn } from "@/src/hooks/hook-logger";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadAllCustomHooks } from "@/src/hooks/custom-hooks-loader";
import { clearCustomHooks } from "@/src/hooks/custom-hooks-registry";
import type { ResolvedPack } from "@/src/hooks/pack-manifest";
import type { PolicyCatalogEntry } from "@/src/hooks/policy-types";
import type { IntegrationType } from "@/src/hooks/types";

/**
 * One artifact carrying TWO policies, each denying a different command. Two are
 * needed because a deny short-circuits: with one policy per pack record you
 * cannot tell "the second pack's selection survived" from "the first pack's
 * did", and the whole finding lives in that difference.
 *
 * `block-refunds` puts its params INTO the deny reason, which is the only way
 * to observe from outside that the policy got the schema its own pack declared
 * — `ctx.params` is populated from the registered schema's defaults, and a
 * policy registered without one silently sees `{}`.
 */
const ARTIFACT = `
  import { customPolicies, deny, allow } from "failproofai";
  customPolicies.add({
    name: "block-refunds",
    description: "d",
    match: { events: ["PreToolUse"] },
    fn: async (ctx) =>
      String(ctx.toolInput?.command ?? "").includes("refund")
        ? deny("refunds need a human over " + String(ctx.params?.limit ?? "any amount"))
        : allow(),
  });
  customPolicies.add({
    name: "require-deploy-note",
    description: "d",
    match: { events: ["PreToolUse"] },
    fn: async (ctx) =>
      String(ctx.toolInput?.command ?? "").includes("deploy")
        ? deny("deploys need a note")
        : allow(),
  });
`;
const DIGEST = createHash("sha256").update(ARTIFACT).digest("hex");

const CATALOG: PolicyCatalogEntry[] = [
  { name: "block-refunds", description: "d", category: "Ops", defaultEnabled: true, match: { events: ["PreToolUse"] } },
  { name: "require-deploy-note", description: "d", category: "Ops", defaultEnabled: true, match: { events: ["PreToolUse"] } },
];
/**
 * The same entry plus the params schema its publisher declared. A manifest is
 * exactly where two packs shipping identical bytes DO differ — a fork that
 * re-declares a default changes no source at all — so the catalogs behind one
 * shared artifact cannot be assumed equal.
 */
const refundsWithLimit = (limit: number): PolicyCatalogEntry => ({
  ...CATALOG[0],
  params: { limit: { type: "number", description: "d", default: limit } },
});
const REFUNDS_WITH_PARAMS = refundsWithLimit(500);

let home: string;
let packRoot: string;
let artifact: string;
let saved: Record<string, string | undefined>;

/**
 * Two manifest entries, distinct ids, the SAME entry file and digest — exactly
 * what `policies add` produces when two published packs happen to ship
 * identical source. `readInstalledPacks` refuses a duplicate ID, never a
 * duplicate path, so this is a manifest the machine really accepts.
 */
function installTwoPacks(a: Record<string, unknown>, b: Record<string, unknown>): void {
  const entry = (id: string, version: string, over: Record<string, unknown>) => ({
    id,
    version,
    source: `github:${id}@v${version}`,
    entry: `artifacts/${DIGEST}.mjs`,
    sha256: DIGEST,
    policies: CATALOG,
    ...over,
  });
  writeFileSync(
    join(packRoot, "installed.json"),
    JSON.stringify({
      schemaVersion: 1,
      packs: [entry("acme/first", "1.0.0", a), entry("other/second", "2.0.0", b)],
    }),
  );
}

async function evaluate(command: string, cli: IntegrationType = "claude", toolName = "Bash") {
  const { evaluateHookEvent } = await import("@/src/hooks/handler");
  return JSON.stringify(
    await evaluateHookEvent(
      "PreToolUse",
      cli,
      JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: toolName,
        tool_input: { command },
        session_id: "s1",
        cwd: home,
      }),
    ),
  );
}

/** A resolved record for the loader-level half, pointing at the same artifact. */
function packRecord(over: Partial<ResolvedPack> = {}): ResolvedPack {
  return {
    id: "acme/first",
    version: "1.0.0",
    source: "github:acme/first@v1.0.0",
    path: artifact,
    sha256: DIGEST,
    effect: "enforce",
    policies: [],
    enabled: null,
    clis: null,
    ...over,
  };
}

type Tagged = { __pack?: ResolvedPack; __policyId?: string; name: string };

async function loadWith(packs: ResolvedPack[]): Promise<Tagged[]> {
  const result = await loadAllCustomHooks([artifact], { sessionCwd: home, packs });
  return result.hooks as unknown as Tagged[];
}

function warnings(): string {
  return vi
    .mocked(hookLogWarn)
    .mock.calls.map((c) => String(c[0]))
    .join("\n");
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "fpai-shared-artifact-home-"));
  packRoot = mkdtempSync(join(tmpdir(), "fpai-shared-artifact-packs-"));
  mkdirSync(join(packRoot, "artifacts"), { recursive: true });
  artifact = join(packRoot, "artifacts", `${DIGEST}.mjs`);
  writeFileSync(artifact, ARTIFACT);
  // No builtin is enabled, so nothing but the packs can produce a deny — and
  // handler.ts drops a pack policy whose name matches an enabled builtin.
  writeFileSync(join(home, "policies-config.json"), JSON.stringify({ enabledPolicies: [] }));
  saved = {
    FAILPROOFAI_HOME: process.env.FAILPROOFAI_HOME,
    FAILPROOFAI_PACK_DIR: process.env.FAILPROOFAI_PACK_DIR,
  };
  process.env.FAILPROOFAI_HOME = home;
  process.env.FAILPROOFAI_PACK_DIR = packRoot;
  clearCustomHooks();
  vi.mocked(hookLogWarn).mockClear();
  vi.resetModules();
});

afterEach(() => {
  clearCustomHooks();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const dir of [home, packRoot]) rmSync(dir, { recursive: true, force: true });
});

describe("complementary selections across a shared artifact", () => {
  it("runs BOTH packs' enabled policies, not just the winner's", async () => {
    // THE FINDING, driven end to end through the gate that reads `enabled`:
    // `handler.ts` skips any hook not in `pack.enabled`, so when the collapse
    // kept only one record's list, the other pack's policy was installed,
    // enabled, listed — and evaluated nothing. Whichever half is dropped, one
    // of these two commands sails through.
    installTwoPacks({ enabled: ["require-deploy-note"] }, { enabled: ["block-refunds"] });
    expect(await evaluate("issue refund 500")).toContain("refunds need a human");
    expect(await evaluate("deploy to prod")).toContain("deploys need a note");
  });

  it("runs both regardless of which record the manifest lists first", async () => {
    // The old collapse kept whichever record arrived first, so the surviving
    // half was decided by manifest order — install the same two packs in the
    // other sequence and a different policy went dark.
    installTwoPacks({ enabled: ["block-refunds"] }, { enabled: ["require-deploy-note"] });
    expect(await evaluate("issue refund 500")).toContain("refunds need a human");
    expect(await evaluate("deploy to prod")).toContain("deploys need a note");
  });

  it("guards BOTH agents when the two packs were scoped to different ones", async () => {
    // Same shape on `clis`, driven through the gate in handler.ts that reads it:
    // one pack scoped to claude and one to codex collapsed to a single scope, so
    // one agent ran completely unguarded by a pack installed for it.
    installTwoPacks({ clis: ["claude"] }, { clis: ["codex"] });
    expect(await evaluate("issue refund 500", "claude")).toContain("refunds need a human");
    expect(await evaluate("issue refund 500", "codex")).toContain("refunds need a human");
    // And a THIRD agent neither record named stays unguarded. Widening `clis` to
    // `null` satisfies both lines above just as well, so without this the test
    // cannot tell a union from "give up and guard everything" — which enforces
    // on agents nobody installed the pack for.
    expect(await evaluate("issue refund 500", "cursor")).not.toContain("refunds need a human");
  });

  it("still respects a scope both packs agree on", async () => {
    // The union must widen only as far as the two records actually asked. If it
    // widened to "every agent" it would be enforcing where nobody installed
    // anything, and the narrowing choice would be worthless.
    installTwoPacks({ clis: ["claude"] }, { clis: ["claude"] });
    // The positive control is what stops this passing for the wrong reason: an
    // unread manifest, an artifact that never imported, or a pack gated off
    // entirely would each satisfy the `not` line on their own.
    expect(await evaluate("issue refund 500", "claude")).toContain("refunds need a human");
    expect(await evaluate("issue refund 500", "codex")).not.toContain("refunds need a human");
  });

  it("gives a union-enabled policy the params ITS OWN pack declared", async () => {
    // The union makes the LOSER's policy run, but the merged record kept only
    // the winner's catalog — and the catalog is where a pack declares its
    // params schema. So the policy the union rescued registered with NO schema:
    // every default its publisher declared silently became undefined, and
    // `ctx.params` came back `{}`. Enforcement that runs on the wrong numbers is
    // the same class of silent wrong as enforcement that does not run.
    installTwoPacks(
      { enabled: ["require-deploy-note"], policies: [CATALOG[1]] },
      { enabled: ["block-refunds"], policies: [REFUNDS_WITH_PARAMS] },
    );
    expect(await evaluate("issue refund 500")).toContain("refunds need a human over 500");
  });

  it("still runs neither policy when neither pack took it", async () => {
    // The union of two selections is not "everything": a policy no record
    // enabled must stay off, or the merge would turn a shared artifact into an
    // opt-out of the user's own choices.
    installTwoPacks({ enabled: ["block-refunds"] }, { enabled: ["block-refunds"] });
    // Same positive control, same reason: prove the pack is live before reading
    // anything into the policy that stayed quiet.
    expect(await evaluate("issue refund 500")).toContain("refunds need a human");
    expect(await evaluate("deploy to prod")).not.toContain("deploys need a note");
  });

  it("treats an EMPTY selection as a selection, not as 'the whole pack'", async () => {
    // `[]` and `null` are different answers — `[]` is a user who deselected
    // everything, `null` is one who took all of it — and handler.ts reads them
    // that way (`[]` is truthy, so it enables nothing). A union written as "an
    // empty side means unknown, so widen to null" passes every other test in
    // this file and quietly re-enables a policy both users turned off.
    installTwoPacks({ enabled: [] }, { enabled: ["block-refunds"] });
    expect(await evaluate("issue refund 500")).toContain("refunds need a human");
    expect(await evaluate("deploy to prod")).not.toContain("deploys need a note");
  });
});

describe("what the collapsed record carries", () => {
  it("takes the union of the two enabled lists", async () => {
    const hooks = await loadWith([
      packRecord({ id: "acme/first", enabled: ["require-deploy-note"] }),
      packRecord({ id: "other/second", enabled: ["block-refunds"] }),
    ]);
    // Both hooks come off one import and share one tag, so the ONE list on that
    // tag has to name everything either record selected.
    expect(hooks).toHaveLength(2);
    expect([...(hooks[0].__pack?.enabled ?? [])].sort()).toEqual([
      "block-refunds",
      "require-deploy-note",
    ]);
  });

  it("lets `enabled: null` on the SECOND record absorb the first's list", async () => {
    // `null` means the user took the whole pack. Intersecting it down to the
    // other record's selection would drop policies from a pack nobody narrowed.
    const hooks = await loadWith([
      packRecord({ id: "acme/first", enabled: ["block-refunds"] }),
      packRecord({ id: "other/second", enabled: null }),
    ]);
    expect(hooks[0].__pack?.enabled).toBeNull();
  });

  it("lets `enabled: null` on the FIRST record absorb the second's list", async () => {
    // The first record is the one the old code kept, so this direction would
    // pass by accident. It is here so the union cannot be re-implemented as
    // "keep the winner unless it is null".
    const hooks = await loadWith([
      packRecord({ id: "acme/first", enabled: null }),
      packRecord({ id: "other/second", enabled: ["block-refunds"] }),
    ]);
    expect(hooks[0].__pack?.enabled).toBeNull();
  });

  it("takes the union of the two clis lists", async () => {
    const hooks = await loadWith([
      packRecord({ id: "acme/first", clis: ["claude"] }),
      packRecord({ id: "other/second", clis: ["codex"] }),
    ]);
    expect([...(hooks[0].__pack?.clis ?? [])].sort()).toEqual(["claude", "codex"]);
  });

  it("lets `clis: null` on the SECOND record absorb the first's list", async () => {
    // Absent `clis` means every agent — including every pack installed before
    // the field existed. Narrowing that to the other record's agents would make
    // an upgrade silently enforce less than the day before.
    const hooks = await loadWith([
      packRecord({ id: "acme/first", clis: ["claude"] }),
      packRecord({ id: "other/second", clis: null }),
    ]);
    expect(hooks[0].__pack?.clis).toBeNull();
  });

  it("lets `clis: null` on the FIRST record absorb the second's list", async () => {
    const hooks = await loadWith([
      packRecord({ id: "acme/first", clis: null }),
      packRecord({ id: "other/second", clis: ["codex"] }),
    ]);
    expect(hooks[0].__pack?.clis).toBeNull();
  });

  it("folds a THIRD record sharing the same artifact into the same union", async () => {
    // The merge runs pairwise against whatever is already in the map, so a third
    // collision merges into a record that is ITSELF already merged. Written as a
    // two-record special case — reading the union off the original pair rather
    // than off the accumulated record — the first pack's selection is dropped
    // again, and it is dropped hardest in exactly this arrangement, where the
    // enforcing record arrives last and takes over the identity.
    const hooks = await loadWith([
      packRecord({ id: "acme/first", effect: "observe", enabled: ["block-refunds"] }),
      packRecord({ id: "other/second", effect: "observe", enabled: [] }),
      packRecord({
        id: "third/pack",
        version: "3.0.0",
        effect: "enforce",
        enabled: ["require-deploy-note"],
      }),
    ]);
    expect(hooks[0].__pack?.id).toBe("third/pack");
    expect(hooks[0].__pack?.effect).toBe("enforce");
    expect([...(hooks[0].__pack?.enabled ?? [])].sort()).toEqual([
      "block-refunds",
      "require-deploy-note",
    ]);
  });

  it("carries the loser's catalog entries too, so a union-enabled policy has a schema", async () => {
    // The unit-level half of the params finding: `registerPolicy` reads a
    // policy's params schema off `pack.policies` BY NAME, so an entry only the
    // loser declared has to survive the collapse or the policy the union just
    // rescued registers with no schema and loses every declared default.
    const hooks = await loadWith([
      packRecord({ id: "acme/first", policies: [CATALOG[1]] }),
      packRecord({ id: "other/second", policies: [REFUNDS_WITH_PARAMS] }),
    ]);
    const entry = hooks[0].__pack?.policies.find((p) => p.name === "block-refunds");
    expect(entry?.params?.limit.default).toBe(500);
  });

  it("keeps the WINNER's entry for a policy both catalogs declare", async () => {
    // Two declared defaults cannot be merged into one, and the collapsed record
    // carries the winner's id and version — so the winner's manifest is the one
    // that describes it. Without this, "union the catalogs" could just as
    // legitimately be read as last-writer-wins, and a fork's re-declared default
    // would silently override the pack the record claims to be.
    const hooks = await loadWith([
      packRecord({ id: "acme/first", policies: [refundsWithLimit(500)] }),
      packRecord({ id: "other/second", policies: [refundsWithLimit(9), CATALOG[1]] }),
    ]);
    expect(hooks[0].__pack?.policies.map((p) => p.name)).toEqual([
      "block-refunds",
      "require-deploy-note",
    ]);
    expect(hooks[0].__pack?.policies[0].params?.limit.default).toBe(500);
  });

  it("does not duplicate a policy both records enabled", async () => {
    // The union is a set. A repeated name in `enabled` is harmless to the gate
    // but would show up in listings twice, describing protection that exists
    // once.
    const hooks = await loadWith([
      packRecord({ id: "acme/first", enabled: ["block-refunds"] }),
      packRecord({ id: "other/second", enabled: ["block-refunds"] }),
    ]);
    expect(hooks[0].__pack?.enabled).toEqual(["block-refunds"]);
  });
});

describe("the effect resolution the selections were bolted onto", () => {
  it("still resolves observe + enforce to enforce", async () => {
    // The reason the collapse picks a winner at all. Over-enforcing is visible
    // to whoever hits it; under-enforcing is the silent failure this codebase
    // exists to remove — so unioning the selections must not disturb it.
    const hooks = await loadWith([
      packRecord({ id: "acme/first", version: "1.0.0", effect: "observe" }),
      packRecord({ id: "other/second", version: "2.0.0", effect: "enforce" }),
    ]);
    expect(hooks[0].__pack?.effect).toBe("enforce");
  });

  it("attributes the merged policy to the ENFORCING pack's identity", async () => {
    // The spread that carries the unioned lists starts from the winner, so id
    // and version have to be the winner's too. Attribute a live deny to the
    // observe-only record and the decision log names a pack that, by
    // construction, decides nothing.
    const hooks = await loadWith([
      packRecord({ id: "acme/first", version: "1.0.0", effect: "observe" }),
      packRecord({ id: "other/second", version: "2.0.0", effect: "enforce" }),
    ]);
    expect(hooks[0].__pack?.id).toBe("other/second");
    expect(hooks[0].__pack?.version).toBe("2.0.0");
    expect(hooks[0].__policyId).toBe("pack:other/second@2.0.0:block-refunds");
  });

  it("keeps the first record's identity when both already enforce", async () => {
    // No effect difference means no reason to swap, and a stable answer is what
    // keeps attribution from depending on manifest order.
    const hooks = await loadWith([
      packRecord({ id: "acme/first", version: "1.0.0" }),
      packRecord({ id: "other/second", version: "2.0.0" }),
    ]);
    expect(hooks[0].__pack?.id).toBe("acme/first");
    // Version and the logged id belong to the same record as the id does. A
    // merge that spreads the fields one by one instead of starting from the
    // winner can take these off the other record and still satisfy the line
    // above — leaving a decision log naming a version that never decided it.
    expect(hooks[0].__pack?.version).toBe("1.0.0");
    expect(hooks[0].__policyId).toBe("pack:acme/first@1.0.0:block-refunds");
  });
});

describe("what the operator is told", () => {
  it("warns naming BOTH pack ids", async () => {
    // The merge is not correctable from inside failproofai — only the
    // publishers can give the two packs distinguishable source. So the one
    // thing this can do is say which two collapsed, by name.
    await loadWith([
      packRecord({ id: "acme/first", enabled: ["block-refunds"] }),
      packRecord({ id: "other/second", enabled: ["require-deploy-note"] }),
    ]);
    const msg = warnings();
    expect(msg).toContain("acme/first");
    expect(msg).toContain("other/second");
    expect(msg).toContain("load as one pack");
  });

  it("says the selections and the agents were unioned, not just the effect", async () => {
    // The message described only the effect resolution while quietly dropping a
    // list, which is how the gap read as intended behaviour to anyone who saw
    // the warning.
    await loadWith([
      packRecord({ id: "acme/first", enabled: ["block-refunds"] }),
      packRecord({ id: "other/second", enabled: ["require-deploy-note"] }),
    ]);
    expect(warnings()).toContain("union");
  });

  it("says nothing when two packs have genuinely different artifacts", async () => {
    // Nothing collapsed, so there is nothing to report — a warning here would
    // train operators to ignore the one that matters.
    const other = join(packRoot, "artifacts", "other.mjs");
    writeFileSync(other, `${ARTIFACT}\n// different bytes`);
    const result = await loadAllCustomHooks([artifact, other], {
      sessionCwd: home,
      packs: [
        packRecord({ id: "acme/first", enabled: ["block-refunds"] }),
        packRecord({
          id: "other/second",
          path: other,
          sha256: createHash("sha256").update(`${ARTIFACT}\n// different bytes`).digest("hex"),
          enabled: ["require-deploy-note"],
        }),
      ],
    });
    expect(warnings()).not.toContain("load as one pack");
    // Silence alone proves nothing — a load that imported neither file, or one
    // that collapsed the two records ANYWAY on some other key, is just as quiet.
    // So pin the state the silence is supposed to describe: two separate
    // imports, two separate tags, and each record's own selection untouched by
    // the other's. A union leaking across distinct artifacts would widen both.
    const hooks = result.hooks as unknown as Tagged[];
    expect(hooks).toHaveLength(4);
    expect(hooks[0].__pack?.id).toBe("acme/first");
    expect(hooks[0].__pack?.enabled).toEqual(["block-refunds"]);
    expect(hooks[2].__pack?.id).toBe("other/second");
    expect(hooks[2].__pack?.enabled).toEqual(["require-deploy-note"]);
  });
});

// One artifact, two packs, and bytes that will not import. A failure is
// recorded per PACK ID while the collapse leaves ONE id holding the merged
// record, so the second pack got no failure — and `missingGuards` skips a pack
// missing from both the failure map and the registration map. Its selected
// policy was absent, unguarded, and unreported.
describe("a broken artifact two packs share", () => {
  const BROKEN = "export const = ;\n";
  const BROKEN_DIGEST = createHash("sha256").update(BROKEN).digest("hex");

  /** Complementary selections, each scoped to a different tool. */
  function installTwoBrokenPacks(): void {
    const scoped = (name: string, tool: string): PolicyCatalogEntry => ({
      name,
      description: "d",
      category: "Ops",
      defaultEnabled: true,
      match: { events: ["PreToolUse"], toolNames: [tool] },
    });
    const entry = (id: string, version: string, enabled: string[], tool: string) => ({
      id,
      version,
      source: `github:${id}@v${version}`,
      entry: `artifacts/${BROKEN_DIGEST}.mjs`,
      sha256: BROKEN_DIGEST,
      policies: [scoped(enabled[0], tool)],
      enabled,
    });
    writeFileSync(join(packRoot, "artifacts", `${BROKEN_DIGEST}.mjs`), BROKEN);
    writeFileSync(
      join(packRoot, "installed.json"),
      JSON.stringify({
        schemaVersion: 1,
        packs: [
          entry("acme/first", "1.0.0", ["block-refunds"], "Bash"),
          entry("other/second", "2.0.0", ["require-deploy-note"], "Write"),
        ],
      }),
    );
  }

  it("denies for BOTH packs' scopes, not just the collapse winner's", async () => {
    installTwoBrokenPacks();
    // Whichever pack loses the collapse used to have no guard at all, so one of
    // these two sails through while the machine reports itself enforcing.
    expect(await evaluate("anything", "claude", "Bash")).toContain("deny");
    expect(await evaluate("anything", "claude", "Write")).toContain("deny");
  });

  it("names both packs in what it reports", async () => {
    installTwoBrokenPacks();
    const denied = await evaluate("anything", "claude", "Write");
    expect(denied).toContain("other/second");
  });

  it("leaves a tool neither pack guarded alone", async () => {
    installTwoBrokenPacks();
    expect(await evaluate("anything", "claude", "Read")).not.toContain("deny");
  });

  // The other half of the same fix, and it only shows when the two guards
  // differ on BOTH axes. Unioning them independently produces a cross product —
  // (PreToolUse, Write) is inside the combined matcher and inside neither
  // guard — while the registry ANDs the axes, so the combined policy denied a
  // pair no pack ever asked to guard. The matcher cannot be tightened without
  // losing dispatch, so the pairing is settled during evaluation.
  it("does not deny a pair the cross product invented", async () => {
    const entry = (id: string, version: string, name: string, event: string, tool: string) => ({
      id,
      version,
      source: `github:${id}@v${version}`,
      entry: `artifacts/${BROKEN_DIGEST}.mjs`,
      sha256: BROKEN_DIGEST,
      policies: [
        {
          name,
          description: "d",
          category: "Ops",
          defaultEnabled: true,
          match: { events: [event], toolNames: [tool] },
        },
      ],
      enabled: [name],
    });
    writeFileSync(join(packRoot, "artifacts", `${BROKEN_DIGEST}.mjs`), BROKEN);
    writeFileSync(
      join(packRoot, "installed.json"),
      JSON.stringify({
        schemaVersion: 1,
        packs: [
          entry("acme/first", "1.0.0", "block-refunds", "PreToolUse", "Bash"),
          entry("other/second", "2.0.0", "require-deploy-note", "PostToolUse", "Write"),
        ],
      }),
    );

    // Declared by a pack, so it denies.
    expect(await evaluate("anything", "claude", "Bash")).toContain("deny");
    // Invented by the union of the two axes, so it must not.
    expect(await evaluate("anything", "claude", "Write")).not.toContain("deny");
  });
});
