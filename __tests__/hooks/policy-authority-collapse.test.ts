// @vitest-environment node
/**
 * Authority when several declarations land on ONE registration.
 *
 * Artifacts are content-addressed, so two cloud assignments — or two installed
 * packs — whose code is byte-identical share one file, load once, and register
 * one policy (see the collapse in `custom-hooks-loader.ts`). The effect of that
 * collapse already resolves toward enforce and the selections toward their
 * union. Authority used to be whichever record was listed first, so:
 *
 * - a team's `reviewable` assignment could make an org-wide `hard` one
 *   clearable by Jev, depending only on the order of `active.json`;
 * - one pack's manifest could make another pack's policy reviewable, which is
 *   the one thing a manifest may never do.
 *
 * It now resolves toward HARD: reviewable only when every declaration is, and
 * then through the union of their checks. Every case runs in both orders,
 * through the real loader and the real handler registration block.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RegisteredPolicy } from "@/src/hooks/policy-types";

const ENV_KEYS = ["FAILPROOFAI_HOME", "FAILPROOFAI_PACK_DIR", "FAILPROOFAI_CLOUD_POLICY_DIR"] as const;

let home: string;
let project: string;
let packRoot: string;
let cloudRoot: string;
let saved: Record<string, string | undefined>;
let stderr: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "fpai-collapse-home-"));
  project = mkdtempSync(join(tmpdir(), "fpai-collapse-project-"));
  packRoot = mkdtempSync(join(tmpdir(), "fpai-collapse-packs-"));
  cloudRoot = mkdtempSync(join(tmpdir(), "fpai-collapse-cloud-"));
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.FAILPROOFAI_HOME = home;
  process.env.FAILPROOFAI_PACK_DIR = packRoot;
  process.env.FAILPROOFAI_CLOUD_POLICY_DIR = cloudRoot;
  writeFileSync(join(home, "policies-config.json"), JSON.stringify({ enabledPolicies: [] }));
  stderr = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  });
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const dir of [home, project, packRoot, cloudRoot]) rmSync(dir, { recursive: true, force: true });
});

/** A temp home where Jev counts as configured for warnings. Never a valid config. */
const configureJev = () => writeFileSync(join(home, "jev.json"), "{}", { mode: 0o600 });

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

async function registeredAfterOneEvent(): Promise<Map<string, RegisteredPolicy>> {
  const { evaluateHookEvent } = await import("@/src/hooks/handler");
  await evaluateHookEvent(
    "PreToolUse",
    "claude",
    JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      session_id: "authority-collapse",
      cwd: project,
    }),
  );
  const { getAllPolicies } = await import("@/src/hooks/policy-registry");
  return new Map(getAllPolicies().map((p) => [p.name, p]));
}

const authorityOf = (p: RegisteredPolicy | undefined) =>
  p === undefined ? undefined : { authority: p.authority, ...(p.reviewedBy ? { reviewedBy: p.reviewedBy } : {}) };

/** Registered policies under a prefix, by their name after it. */
function under(registered: Map<string, RegisteredPolicy>, prefix: string): Map<string, RegisteredPolicy> {
  return new Map(
    [...registered].filter(([n]) => n.startsWith(prefix)).map(([n, p]) => [n.slice(n.lastIndexOf("/") + 1), p]),
  );
}

const ORDERS = [
  ["listed first", false],
  ["listed second", true],
] as const;

describe("two cloud assignments sharing one artifact", () => {
  const SOURCE = `
    import { customPolicies, allow } from "failproofai";
    customPolicies.add({ name: "db-guard", description: "d", match: { events: ["PreToolUse"] },
      fn: async () => allow() });
  `;

  function deploy(assignments: Array<Record<string, unknown>>): void {
    const digest = sha(SOURCE);
    mkdirSync(join(cloudRoot, "artifacts"), { recursive: true });
    writeFileSync(join(cloudRoot, "artifacts", `${digest}.mjs`), SOURCE);
    writeFileSync(
      join(cloudRoot, "active.json"),
      JSON.stringify({
        schemaVersion: 2,
        deployment: 7,
        policies: assignments.map((a) => ({ sha256: digest, path: `artifacts/${digest}.mjs`, ...a })),
      }),
    );
  }

  const teamReviewable = {
    id: "team-a-db-guard", version: 3, authority: "reviewable", reviewedBy: ["database-destruction"],
  };

  it.each(ORDERS)("stays hard when the reviewable assignment is %s beside a hard-by-default one", async (_l, flip) => {
    const orgHard = { id: "org-db-guard", version: 5 };
    deploy(flip ? [orgHard, teamReviewable] : [teamReviewable, orgHard]);
    const cloud = under(await registeredAfterOneEvent(), "cloud/");
    expect(cloud.size).toBe(1);
    expect(authorityOf(cloud.get("db-guard"))).toEqual({ authority: "hard" });
  });

  it.each(ORDERS)("stays hard beside an explicitly hard one, %s", async (_l, flip) => {
    const orgHard = { id: "org-db-guard", version: 5, authority: "hard" };
    deploy(flip ? [orgHard, teamReviewable] : [teamReviewable, orgHard]);
    const cloud = under(await registeredAfterOneEvent(), "cloud/");
    expect(authorityOf(cloud.get("db-guard"))).toEqual({ authority: "hard" });
  });

  it.each(ORDERS)("is reviewable through every check either names when both are reviewable, %s", async (_l, flip) => {
    const other = { id: "team-b-db-guard", version: 4, authority: "reviewable", reviewedBy: ["destructive-deletion"] };
    deploy(flip ? [other, teamReviewable] : [teamReviewable, other]);
    const p = under(await registeredAfterOneEvent(), "cloud/").get("db-guard");
    expect(p?.authority).toBe("reviewable");
    expect([...(p?.reviewedBy ?? [])].sort()).toEqual(["database-destruction", "destructive-deletion"]);
  });

  it("says why, once Jev is configured, and not before", async () => {
    deploy([teamReviewable, { id: "org-db-guard", version: 5 }]);
    await registeredAfterOneEvent();
    expect(stderr.join("")).not.toMatch(/do not all declare it reviewable/);

    vi.resetModules();
    configureJev();
    await registeredAfterOneEvent();
    expect(stderr.join("")).toMatch(
      /cloud-managed policies team-a-db-guard and org-db-guard share one artifact and do not all declare it reviewable, so it stays hard/,
    );
  });
});

describe("two installed packs sharing one artifact", () => {
  const SOURCE = `
    import { customPolicies, allow } from "failproofai";
    const ok = async () => allow();
    customPolicies.add({ name: "prod-guard", description: "d", match: { events: ["PreToolUse"] }, fn: ok });
    customPolicies.add({ name: "fork-only", description: "d", match: { events: ["PreToolUse"] }, fn: ok });
  `;
  const entry = (name: string, extra: Record<string, unknown> = {}) => ({
    name, description: "d", category: "Ops", defaultEnabled: true, match: { events: ["PreToolUse"] }, ...extra,
  });

  function install(packs: Array<{ id: string; version: string; policies: unknown[]; semantic?: unknown[] }>): void {
    const digest = sha(SOURCE);
    mkdirSync(join(packRoot, "artifacts"), { recursive: true });
    writeFileSync(join(packRoot, "artifacts", `${digest}.mjs`), SOURCE);
    writeFileSync(
      join(packRoot, "installed.json"),
      JSON.stringify({
        schemaVersion: 1,
        packs: packs.map((p) => ({
          ...p, source: `github:${p.id}@v${p.version}`, entry: `artifacts/${digest}.mjs`, sha256: digest,
        })),
      }),
    );
  }

  const lenient = {
    id: "lenient/ops",
    version: "1.0.0",
    policies: [entry("prod-guard", { authority: "reviewable", reviewedBy: ["production-infra-change"] })],
  };

  it.each(ORDERS)("stays hard when the lenient pack is %s beside a strict one", async (_l, flip) => {
    const strict = { id: "strict/ops", version: "2.0.0", policies: [entry("prod-guard", { authority: "hard" })] };
    install(flip ? [strict, lenient] : [lenient, strict]);
    const packs = under(await registeredAfterOneEvent(), "pack/");
    expect(authorityOf(packs.get("prod-guard"))).toEqual({ authority: "hard" });
  });

  it.each(ORDERS)("stays hard beside a pack that declares it but says nothing about authority, %s", async (_l, flip) => {
    const silent = { id: "silent/ops", version: "2.0.0", policies: [entry("prod-guard")] };
    install(flip ? [silent, lenient] : [lenient, silent]);
    const packs = under(await registeredAfterOneEvent(), "pack/");
    expect(authorityOf(packs.get("prod-guard"))).toEqual({ authority: "hard" });
  });

  it.each(ORDERS)(
    "stays hard beside a pack that runs the same bytes without declaring the policy, %s",
    async (_l, flip) => {
      // The fork's manifest lists only fork-only, but its copy of the artifact
      // registers prod-guard all the same — undeclared, and so hard.
      const fork = {
        id: "fork/ops",
        version: "2.0.0",
        policies: [entry("fork-only", { authority: "reviewable", reviewedBy: ["secret-exposure"] })],
      };
      install(flip ? [fork, lenient] : [lenient, fork]);
      const packs = under(await registeredAfterOneEvent(), "pack/");
      expect(authorityOf(packs.get("prod-guard"))).toEqual({ authority: "hard" });
      expect(authorityOf(packs.get("fork-only"))).toEqual({ authority: "hard" });
    },
  );

  it.each(ORDERS)("is reviewable through every check either names when both are reviewable, %s", async (_l, flip) => {
    const other = {
      id: "other/ops",
      version: "2.0.0",
      policies: [entry("prod-guard", { authority: "reviewable", reviewedBy: ["external-destructive-action"] })],
    };
    install(flip ? [other, lenient] : [lenient, other]);
    const p = under(await registeredAfterOneEvent(), "pack/").get("prod-guard");
    expect(p?.authority).toBe("reviewable");
    expect([...(p?.reviewedBy ?? [])].sort()).toEqual(["external-destructive-action", "production-infra-change"]);
  });

  it.each(ORDERS)("still reports a refused declaration it kept for the reason, %s", async (_l, flip) => {
    const typo = {
      id: "typo/ops",
      version: "2.0.0",
      policies: [entry("prod-guard", { authority: "reviewable", reviewedBy: ["production-infra-chnage"] })],
    };
    install(flip ? [typo, lenient] : [lenient, typo]);
    configureJev();
    const packs = under(await registeredAfterOneEvent(), "pack/");
    expect(authorityOf(packs.get("prod-guard"))).toEqual({ authority: "hard" });
    expect(stderr.join("")).toMatch(/prod-guard asks to be reviewable, but reviewedBy names "production-infra-chnage"/);
  });

  it("says which policies stayed hard, once Jev is configured", async () => {
    install([lenient, { id: "strict/ops", version: "2.0.0", policies: [entry("prod-guard", { authority: "hard" })] }]);
    await registeredAfterOneEvent();
    expect(stderr.join("")).not.toMatch(/do not all declare/);

    vi.resetModules();
    configureJev();
    await registeredAfterOneEvent();
    expect(stderr.join("")).toMatch(
      /packs lenient\/ops and strict\/ops share one artifact and do not all declare prod-guard reviewable, so it stays hard/,
    );
  });

  /**
   * The same collapse, for a pack that ships BOTH tiers — which is the shipped
   * configuration, and the case the merge got wrong.
   *
   * `reviewedBy` here names a check that exists only because a pack declared it,
   * so it is in no compiled-in set. The merge used to judge both declarations
   * against the builtins, where that name is unknown: the reviewable entry and
   * its hard peer resolved alike, the first raw declaration was carried forward,
   * and registration — which does read the pack's checks — honoured it. So a
   * hard declaration behind the same artifact was cleared by Jev, decided by
   * which pack `installed.json` listed first.
   */
  describe("with a pack-declared reviewer behind the artifact", () => {
    const CHECK = "pack-prod-infra";
    const semantic = [
      {
        name: CHECK,
        title: "Changed production infrastructure",
        appliesTo: ["shell"],
        mode: "deny",
        userCanOverride: true,
        probes: [{ id: "touches_prod", instructions: "It changes production infrastructure." }],
        guidance: "Confirm the target environment with the user first.",
      },
    ];
    const reviewable = {
      id: "lenient/ops",
      version: "1.0.0",
      policies: [entry("prod-guard", { authority: "reviewable", reviewedBy: [CHECK] })],
      semantic,
    };

    it.each(ORDERS)("stays hard beside a hard peer, %s", async (_l, flip) => {
      const strict = { id: "strict/ops", version: "2.0.0", policies: [entry("prod-guard", { authority: "hard" })] };
      install(flip ? [strict, reviewable] : [reviewable, strict]);
      configureJev();
      const packs = under(await registeredAfterOneEvent(), "pack/");
      expect(authorityOf(packs.get("prod-guard"))).toEqual({ authority: "hard" });
    });

    it.each(ORDERS)("stays hard beside a peer that declares it and says nothing, %s", async (_l, flip) => {
      const silent = { id: "silent/ops", version: "2.0.0", policies: [entry("prod-guard")] };
      install(flip ? [silent, reviewable] : [reviewable, silent]);
      configureJev();
      const packs = under(await registeredAfterOneEvent(), "pack/");
      expect(authorityOf(packs.get("prod-guard"))).toEqual({ authority: "hard" });
    });

    it("is still reviewable with no peer to overrule it, and says nothing about it", async () => {
      // The control, and the reason this is not fixed by hardening everything:
      // one pack carrying both tiers is the shipped pairing, and its policy is
      // reviewable by its own check. The diagnostic has to agree with the
      // registry about that — it used to be computed against the builtins and
      // told every such policy it stays hard while registering it reviewable.
      install([reviewable]);
      configureJev();
      const packs = under(await registeredAfterOneEvent(), "pack/");
      expect(authorityOf(packs.get("prod-guard"))).toEqual({ authority: "reviewable", reviewedBy: [CHECK] });
      expect(stderr.join("")).not.toMatch(/asks to be reviewable/);
    });
  });

  it("changes nothing for packs that declare no authority at all", async () => {
    // The pre-existing collapse (params, selections, effect) is untouched: no
    // record is rewritten when there is no authority to merge.
    const a = { id: "acme/first", version: "1.0.0", policies: [entry("prod-guard"), entry("fork-only")] };
    const b = { id: "other/second", version: "2.0.0", policies: [entry("prod-guard")] };
    install([a, b]);
    const packs = under(await registeredAfterOneEvent(), "pack/");
    expect(authorityOf(packs.get("prod-guard"))).toEqual({ authority: "hard" });
    expect(authorityOf(packs.get("fork-only"))).toEqual({ authority: "hard" });
    expect(stderr.join("")).not.toMatch(/reviewable/);
  });
});
