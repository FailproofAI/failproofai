// @vitest-environment node
/**
 * The config key a PACK policy's parameters live under.
 *
 * Nothing covered this, and that is exactly how the dashboard and the evaluator
 * disagreed for as long as they did: the dashboard wrote
 * `policyParams["<bare name>"]` while the evaluator looked up the registered
 * name `pack/<id>@<version>/<name>` and only fell back to a bare key inside the
 * `failproofai/` namespace. A parameter saved through the UI came back
 * displayed as saved and was ignored at runtime — no error on either side.
 *
 * `packPolicyParamKey()` builds the key both sides use and
 * `readPackPolicyParams()` performs the lookup both sides read through. These
 * tests pin the properties that make that work: the key is version-less (so a
 * saved parameter survives the publisher's next release), the bare-name
 * fallback is our own pack's alone (so two packs declaring `block-sudo` cannot
 * read each other's configuration), and the string the dashboard writes is the
 * string the evaluator reads back off disk.
 *
 * The scoping is the half that has to be shared rather than merely agreed: the
 * read side kept its own copy of the fallback, unscoped, so a stranger's pack
 * declaring `block-sudo` was SHOWN our saved parameters while the evaluator
 * gave it none — and the config modal seeds from what is shown, so a Save
 * wrote them under the stranger's key and made the display real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("@/src/hooks/hook-telemetry", () => ({
  trackHookEvent: vi.fn(() => Promise.resolve()),
  flushHookTelemetry: vi.fn(() => Promise.resolve()),
}));

// The dashboard's read side walks installed packs off disk. Only its key lookup
// is under test, so the pack listing is supplied rather than installed — an
// install would drag a pack server and a digest check into a test about a
// string. `vi.hoisted` because the mock factory runs while the imports below
// are still being evaluated, before a plain `const` here would exist.
const { installedPacks } = vi.hoisted(() => ({ installedPacks: [] as unknown[] }));
vi.mock("@/src/hooks/pack-manifest", () => ({
  readInstalledPacks: () => ({ packs: installedPacks, errors: [] }),
}));

// Keep the CLI probes off the real machine: `getHooksConfigAction` otherwise
// reads this developer's own settings files and shells out to detect installed
// agents, neither of which this test has an opinion about.
vi.mock("@/src/hooks/manager", () => ({
  hooksInstalledInSettings: () => false,
  getSettingsPath: () => "/tmp/.claude/settings.json",
}));
vi.mock("@/src/hooks/integrations", () => ({ listIntegrations: () => [] }));

import { evaluatePolicies, packPolicyParamKey } from "@/src/hooks/policy-evaluator";
import { registerPolicy, clearPolicies } from "@/src/hooks/policy-registry";
import { CORE_SOURCE } from "@/src/hooks/pack-store";
import { readMergedHooksConfig } from "@/src/hooks/hooks-config";
import { updatePolicyParamsAction } from "@/app/actions/update-policy-params";
import { getHooksConfigAction } from "@/app/actions/get-hooks-config";
import type { HooksConfig, PolicyParamsSchema } from "@/src/hooks/policy-types";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** How `handler.ts` registers a pack's policy — id AND version in the name. */
const registeredName = (packId: string, version: string, name: string) =>
  `pack/${packId}@${version}/${name}`;

/**
 * Register a policy under an exact canonical name and hand back whatever
 * `ctx.params` it is given. Registered with NO schema on purpose: with one, the
 * evaluator merges declared defaults over the lookup, so a missed key would
 * still produce a plausible-looking object. Schema-less, `ctx.params` IS the
 * result of the config lookup and a miss shows up as `{}`.
 */
function paramsSeenBy(canonicalName: string): () => Record<string, unknown> | undefined {
  let seen: Record<string, unknown> | undefined;
  registerPolicy(
    canonicalName,
    "d",
    async (ctx) => {
      seen = ctx.params;
      return { decision: "allow" };
    },
    { events: ["PreToolUse"] },
  );
  return () => seen;
}

const evaluate = (config: HooksConfig) =>
  evaluatePolicies(
    "PreToolUse",
    { tool_name: "Bash", tool_input: { command: "ls" } },
    undefined,
    config,
  );

const configWith = (policyParams: Record<string, Record<string, unknown>>): HooksConfig => ({
  enabledPolicies: [],
  policyParams,
});

beforeEach(() => {
  clearPolicies();
  installedPacks.length = 0;
});

describe("packPolicyParamKey — the key is version-less", () => {
  it("produces the same key for two releases of one pack", () => {
    // The registered names differ by version and the key does not. This is the
    // whole reason the registered name cannot be used as the config key: a key
    // carrying `@1.0.0` is orphaned the moment the publisher ships `@2.0.0`,
    // and the parameter then reads as unset with nothing to indicate why.
    const v1 = registeredName("acme/ops", "1.0.0", "block-prod-deploy");
    const v2 = registeredName("acme/ops", "2.0.0", "block-prod-deploy");
    expect(v1).not.toBe(v2);

    const key = packPolicyParamKey("acme/ops", "block-prod-deploy");
    expect(key).toBe("pack/acme/ops/block-prod-deploy");
    expect(key).not.toBe(v1);
    expect(key).not.toBe(v2);
  });

  it("a parameter saved against one version is still read after a republish", async () => {
    // The behavioural half of the property above: one saved config, two
    // installed versions, both must see the parameter.
    const config = configWith({
      [packPolicyParamKey("acme/ops", "block-prod-deploy")]: { limit: 500 },
    });

    const before = paramsSeenBy(registeredName("acme/ops", "1.0.0", "block-prod-deploy"));
    await evaluate(config);
    expect(before()).toEqual({ limit: 500 });

    clearPolicies();
    const after = paramsSeenBy(registeredName("acme/ops", "2.0.0", "block-prod-deploy"));
    await evaluate(config);
    expect(after()).toEqual({ limit: 500 });
  });
});

describe("the evaluator's lookup for a pack policy", () => {
  it("finds params stored under the qualified key despite the versioned name", async () => {
    const seen = paramsSeenBy(registeredName("acme/ops", "1.0.0", "block-prod-deploy"));
    await evaluate(
      configWith({
        [packPolicyParamKey("acme/ops", "block-prod-deploy")]: { limit: 500, hint: "ask finance" },
      }),
    );
    expect(seen()).toEqual({ limit: 500, hint: "ask finance" });
  });

  it("prefers the exact canonical name over the qualified key", async () => {
    // A config written against the full registered name is the most specific
    // thing the user could have said, so the version-less key we now write must
    // not shadow it.
    const canonical = registeredName("acme/ops", "1.0.0", "block-prod-deploy");
    const seen = paramsSeenBy(canonical);
    await evaluate(
      configWith({
        [canonical]: { limit: 1 },
        [packPolicyParamKey("acme/ops", "block-prod-deploy")]: { limit: 2 },
      }),
    );
    expect(seen()).toEqual({ limit: 1 });
  });

  it("prefers the qualified key over the bare name for our own pack", async () => {
    // Both are readable for a core-pack policy; the qualified one is what the
    // dashboard writes today, so it has to win or an upgraded machine would go
    // on serving whatever the older build left behind.
    const seen = paramsSeenBy(registeredName(CORE_SOURCE, "1.0.0", "block-sudo"));
    await evaluate(
      configWith({
        [packPolicyParamKey(CORE_SOURCE, "block-sudo")]: { allowPatterns: ["sudo -n true"] },
        "block-sudo": { allowPatterns: ["LEGACY"] },
      }),
    );
    expect(seen()).toEqual({ allowPatterns: ["sudo -n true"] });
  });
});

describe("the bare-name fallback is our own pack's alone", () => {
  it("reads a bare key for a policy from OUR pack", async () => {
    // Every `policyParams["block-sudo"]` already on disk — written by a build
    // that predates packs, or by the dashboard before it qualified its keys —
    // means the builtin under the name it always had. Reading it is the
    // migration; dropping it silently unconfigures those machines.
    const seen = paramsSeenBy(registeredName(CORE_SOURCE, "1.0.0", "block-sudo"));
    await evaluate(configWith({ "block-sudo": { allowPatterns: ["sudo systemctl status"] } }));
    expect(seen()).toEqual({ allowPatterns: ["sudo systemctl status"] });
  });

  it("matches our pack's id case-insensitively", async () => {
    // The id reaches the evaluator from a manifest and from a source somebody
    // typed, and GitHub treats `failproofai/policies` and `FailproofAI/policies`
    // as one repository. A case-sensitive compare would drop the migration for
    // whichever spelling a machine happens to hold.
    expect(CORE_SOURCE.toLowerCase()).not.toBe(CORE_SOURCE);
    const seen = paramsSeenBy(registeredName(CORE_SOURCE.toLowerCase(), "1.0.0", "block-sudo"));
    await evaluate(configWith({ "block-sudo": { allowPatterns: ["sudo -n true"] } }));
    expect(seen()).toEqual({ allowPatterns: ["sudo -n true"] });
  });

  it("does NOT read a bare key for a STRANGER's pack of the same policy name", async () => {
    // The other direction, and the reason the fallback is scoped at all: two
    // packs may each declare a `block-sudo`, and a bare key cannot say which was
    // meant. Handing `acme/ops` the core pack's configuration runs a third
    // party's policy on parameters chosen for ours.
    const seen = paramsSeenBy(registeredName("acme/ops", "1.0.0", "block-sudo"));
    await evaluate(configWith({ "block-sudo": { allowPatterns: ["sudo systemctl status"] } }));
    expect(seen()).toEqual({});
  });

  it("does NOT let a stranger's pack read our pack's qualified key either", async () => {
    // Namespace isolation holds for the qualified key too — the packId is part
    // of it, so `acme/ops` must not match `pack/FailproofAI/policies/block-sudo`.
    const seen = paramsSeenBy(registeredName("acme/ops", "1.0.0", "block-sudo"));
    await evaluate(
      configWith({ [packPolicyParamKey(CORE_SOURCE, "block-sudo")]: { allowPatterns: ["x"] } }),
    );
    expect(seen()).toEqual({});
  });
});

describe("non-pack policies keep the fallback they had", () => {
  it("a builtin-namespace policy still reads a flat key", async () => {
    // The pack branch returns early, so it must not have swallowed the
    // `failproofai/<name>` → `policyParams["<name>"]` path that every config
    // already on disk depends on.
    const seen = paramsSeenBy("failproofai/no-schema");
    await evaluate(configWith({ "no-schema": { threshold: 7 } }));
    expect(seen()).toEqual({ threshold: 7 });
  });

  it("a third-party namespace still gets no bare fallback", async () => {
    const seen = paramsSeenBy("myorg/foo");
    await evaluate(configWith({ foo: { hint: "should NOT leak across namespaces" } }));
    expect(seen()).toEqual({});
  });
});

describe("round trip: the dashboard writes the key the evaluator reads", () => {
  const PACK_ID = "acme/ops";
  const POLICY = "block-prod-deploy";
  const SCHEMA: PolicyParamsSchema = {
    limit: { type: "number", description: "Largest refund allowed", default: 100 },
  };

  let home: string;
  let project: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "fpai-param-home-"));
    project = mkdtempSync(join(tmpdir(), "fpai-param-proj-"));
    saved = {
      FAILPROOFAI_HOME: process.env.FAILPROOFAI_HOME,
      FAILPROOFAI_LAUNCH_CWD: process.env.FAILPROOFAI_LAUNCH_CWD,
    };
    // Both are load-bearing: without them the write lands in the developer's
    // real ~/.failproofai and the read walks up into THIS repo's own
    // .failproofai/policies-config.json.
    process.env.FAILPROOFAI_HOME = home;
    process.env.FAILPROOFAI_LAUNCH_CWD = project;

    installedPacks.push({
      id: PACK_ID,
      version: "1.0.0",
      source: `github:${PACK_ID}@1.0.0`,
      path: join(project, "pack.mjs"),
      sha256: "0".repeat(64),
      effect: "enforce",
      enabled: null,
      clis: null,
      policies: [
        {
          name: POLICY,
          description: "Block refunds above the approved limit",
          category: "Finance",
          defaultEnabled: true,
          match: { events: ["PreToolUse"] },
          params: SCHEMA,
        },
      ],
    });
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const dir of [home, project]) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * The exact expression `handleSaveParams` in `app/policies/hooks-client.tsx`
   * evaluates for a pack policy. Mirrored rather than imported because that
   * side lives inside a React client component; the source assertion below is
   * what pins the mirror to the real thing.
   */
  const dashboardKey = (policy: { packId?: string; name: string }) =>
    policy.packId ? packPolicyParamKey(policy.packId, policy.name) : policy.name;

  it("a save through the dashboard action reaches the running policy", async () => {
    // Start from what the dashboard actually renders, so the packId and name
    // the key is built from are the ones the UI had in hand, not values this
    // test chose for it.
    const rendered = (await getHooksConfigAction()).policies.find((p) => p.name === POLICY)!;
    expect(rendered.packId).toBe(PACK_ID);

    await updatePolicyParamsAction(dashboardKey(rendered), { limit: 500 });

    // The key on disk, exactly. The bug was a bare `"block-prod-deploy"` here,
    // which every layer accepted and nothing read.
    const onDisk = JSON.parse(
      readFileSync(join(home, "policies-config.json"), "utf8"),
    ) as HooksConfig;
    expect(Object.keys(onDisk.policyParams ?? {})).toEqual(["pack/acme/ops/block-prod-deploy"]);
    expect(onDisk.policyParams?.[POLICY]).toBeUndefined();

    // And the evaluator, reading that same file back through the scope merge,
    // hands it to the policy registered under the versioned name.
    const seen = paramsSeenBy(registeredName(PACK_ID, "1.0.0", POLICY));
    await evaluate(readMergedHooksConfig(project));
    expect(seen()).toEqual({ limit: 500 });
  });

  it("the dashboard reads back what it saved, so what is displayed is what runs", async () => {
    await updatePolicyParamsAction(packPolicyParamKey(PACK_ID, POLICY), { limit: 500 });
    const rendered = (await getHooksConfigAction()).policies.find((p) => p.name === POLICY)!;
    expect(rendered.currentParams).toEqual({ limit: 500 });
  });

  it("both dashboard sides go through the evaluator's own helpers", () => {
    // The failure being pinned is the two sides drifting apart, and the write
    // side cannot be imported here (a React client component). So assert on its
    // source: each must call the shared helper for its half and must never
    // assemble a `pack/...` key of its own, which is how it would drift again
    // without either behavioural test above going red.
    //
    // The two halves are NOT the same helper. The write side needs a key, so it
    // calls `packPolicyParamKey`. The read side needs the whole LOOKUP —
    // qualified key, then the bare name for our pack alone — so it calls
    // `readPackPolicyParams`. Sharing only the key format is what left the read
    // side free to keep its own unscoped bare fallback and show a stranger's
    // pack our saved parameters.
    const expected = {
      "app/policies/hooks-client.tsx": "packPolicyParamKey",
      "app/actions/get-hooks-config.ts": "readPackPolicyParams",
    } as const;

    for (const [file, helper] of Object.entries(expected)) {
      const src = readFileSync(join(REPO_ROOT, file), "utf8");
      expect(src, file).toMatch(
        new RegExp(`import \\{ ${helper} \\} from "@/src/hooks/policy-evaluator";`),
      );
      expect(src, file).toMatch(new RegExp(`${helper}\\(`));
      // An interpolated `pack/${...}` literal is a hand-rolled key; the helper
      // is the only place that format may be spelled.
      expect(src, file).not.toMatch(/`pack\/\$\{/);
    }

    // And the read side must not reach past the helper to a bare name of its
    // own — the exact expression that leaked our pack's parameters into every
    // other pack that happened to reuse a policy name.
    const readSide = readFileSync(join(REPO_ROOT, "app/actions/get-hooks-config.ts"), "utf8");
    expect(readSide).not.toMatch(/policyParams\?\.\[policy\.name\]/);
  });
});

describe("two installed packs declaring the SAME policy name", () => {
  const POLICY = "block-sudo";
  const SCHEMA: PolicyParamsSchema = {
    allowPatterns: { type: "pattern[]", description: "sudo commands to permit", default: [] },
  };

  let home: string;
  let project: string;
  let saved: Record<string, string | undefined>;

  const packWithBlockSudo = (id: string) => ({
    id,
    version: "1.0.0",
    source: `github:${id}@1.0.0`,
    path: join(project, `${id.replace(/\W/g, "-")}.mjs`),
    sha256: "0".repeat(64),
    effect: "enforce",
    enabled: null,
    clis: null,
    policies: [
      {
        name: POLICY,
        description: `${id} take on sudo`,
        category: "safety",
        defaultEnabled: true,
        match: { events: ["PreToolUse"] },
        params: SCHEMA,
      },
    ],
  });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "fpai-dup-home-"));
    project = mkdtempSync(join(tmpdir(), "fpai-dup-proj-"));
    saved = {
      FAILPROOFAI_HOME: process.env.FAILPROOFAI_HOME,
      FAILPROOFAI_LAUNCH_CWD: process.env.FAILPROOFAI_LAUNCH_CWD,
    };
    process.env.FAILPROOFAI_HOME = home;
    process.env.FAILPROOFAI_LAUNCH_CWD = project;
    installedPacks.push(packWithBlockSudo(CORE_SOURCE), packWithBlockSudo("acme/ops"));
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const dir of [home, project]) rmSync(dir, { recursive: true, force: true });
  });

  const rowFor = async (packId: string) =>
    (await getHooksConfigAction()).policies.find((p) => p.packId === packId)!;

  it("gives each pack its own row, so a name is never the identity of one", async () => {
    // The dashboard renders one flat list across every installed pack, and a
    // pack policy's name is unique only WITHIN its pack. Anything keyed on the
    // name alone — a React key, an optimistic toggle, a param lookup — is
    // holding two different policies by one handle.
    const rows = (await getHooksConfigAction()).policies.filter((p) => p.name === POLICY);
    expect(rows.map((p) => p.packId).sort()).toEqual(["FailproofAI/policies", "acme/ops"]);
  });

  it("does NOT show a stranger's pack the bare key our pack owns", async () => {
    // The read side had an UNSCOPED bare-name fallback while the evaluator
    // scopes it to our own pack. A legacy `policyParams["block-sudo"]` — ours,
    // written before packs existed — was therefore displayed as acme/ops's own
    // configuration while the evaluator handed that policy the schema defaults.
    // Worse than a wrong label: the modal seeds its inputs from `currentParams`
    // and Save writes them back under acme/ops's qualified key, so opening and
    // saving launders our configuration into a third party's policy, where it
    // then really does take effect.
    await updatePolicyParamsAction(POLICY, { allowPatterns: ["LEGACY"] });

    expect((await rowFor("acme/ops")).currentParams).toEqual({});

    // What the evaluator gives it, for comparison, read back off the same
    // file through the same scope merge: nothing of ours. `paramsSeenBy`
    // registers schema-less, so a miss shows up as `{}` rather than as a
    // plausible object of merged defaults.
    const seen = paramsSeenBy(registeredName("acme/ops", "1.0.0", POLICY));
    await evaluate(readMergedHooksConfig(project));
    expect(seen()).toEqual({});
  });

  it("still shows OUR pack the bare key, so the migration survives", async () => {
    // The other half: scoping the fallback must not drop the read that keeps a
    // pre-pack `policyParams["block-sudo"]` visible after the upgrade.
    await updatePolicyParamsAction(POLICY, { allowPatterns: ["LEGACY"] });
    expect((await rowFor(CORE_SOURCE)).currentParams).toEqual({ allowPatterns: ["LEGACY"] });
  });

  it("keeps two saved parameter sets apart, one per pack", async () => {
    await updatePolicyParamsAction(packPolicyParamKey(CORE_SOURCE, POLICY), { allowPatterns: ["ours"] });
    await updatePolicyParamsAction(packPolicyParamKey("acme/ops", POLICY), { allowPatterns: ["theirs"] });

    expect((await rowFor(CORE_SOURCE)).currentParams).toEqual({ allowPatterns: ["ours"] });
    expect((await rowFor("acme/ops")).currentParams).toEqual({ allowPatterns: ["theirs"] });
  });

  it("clearing OUR pack's parameters does not resurrect the legacy bare key", async () => {
    // Emptying a parameter is a real edit, not an absence: a user who deletes
    // the last entry from `block-sudo`'s allowPatterns is REVOKING a permitted
    // command. The qualified key then holds `{}`, and the legacy bare key still
    // holds what they just removed — so a lookup that treats an empty object as
    // "nothing saved" and falls through would hand the policy back the
    // allowlist the user deleted, on both sides at once, with the UI showing it
    // as cleared. `readPackPolicyParams` returns the qualified entry on
    // presence, never on emptiness, and this is what holds it to that.
    await updatePolicyParamsAction(POLICY, { allowPatterns: ["LEGACY"] });
    await updatePolicyParamsAction(packPolicyParamKey(CORE_SOURCE, POLICY), {});

    // The cleared entry really is on disk as an empty object — the assertion
    // below means nothing if the write dropped the key instead.
    const onDisk = JSON.parse(
      readFileSync(join(home, "policies-config.json"), "utf8"),
    ) as HooksConfig;
    expect(onDisk.policyParams?.[packPolicyParamKey(CORE_SOURCE, POLICY)]).toEqual({});
    expect(onDisk.policyParams?.[POLICY]).toEqual({ allowPatterns: ["LEGACY"] });

    expect((await rowFor(CORE_SOURCE)).currentParams).toEqual({});

    const seen = paramsSeenBy(registeredName(CORE_SOURCE, "1.0.0", POLICY));
    await evaluate(readMergedHooksConfig(project));
    expect(seen()).toEqual({});
  });
});

describe("the key format is reversible only because of what an id and a name may hold", () => {
  it("refuses a pack policy name carrying the separator the key is built from", async () => {
    // `packPolicyParamKey` joins with `/` and `parsePackPolicyName` splits back
    // at the LAST one, so a name containing a slash makes the two sides
    // disagree silently: the dashboard writes `pack/acme/ops/deploy/prod` while
    // the evaluator looks up `pack/acme/ops/prod` and the policy runs on
    // defaults. The manifest validator is the only thing that makes that
    // unreachable, so pin it here — relaxing that regex would reopen the exact
    // write-here/read-there split this key was introduced to close.
    expect(packPolicyParamKey("acme/ops", "deploy/prod")).toBe("pack/acme/ops/deploy/prod");

    // `pack-manifest` is mocked at the top of this file for the dashboard's
    // read path; the validator has to come from the real module.
    const { parsePackPolicy, PACK_ID_RE } =
      await vi.importActual<typeof import("@/src/hooks/pack-manifest")>(
        "@/src/hooks/pack-manifest",
      );
    expect(() =>
      parsePackPolicy("acme/ops", { name: "deploy/prod", description: "d", match: {} }, 0),
    ).toThrow(/unsafe name/);

    // And the id half is bounded to exactly one slash, so `pack/<id>/<name>`
    // always splits back into the same two parts. Without that, a pack called
    // `acme/ops/x` could mint the key of pack `acme/ops`'s policy `x` and read
    // a stranger's configuration — the leak the scoped fallback exists to stop.
    expect(PACK_ID_RE.test("acme/ops")).toBe(true);
    expect(PACK_ID_RE.test("acme/ops/x")).toBe(false);
  });
});
