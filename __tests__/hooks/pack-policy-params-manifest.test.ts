// @vitest-environment node
/**
 * A pack policy's `params` schema, from the registration that declares it to the
 * `ctx.params` the policy is evaluated with.
 *
 * `failproofai publish` did not write the schema into the manifest at all, and
 * nothing anywhere said so. Registration reads a pack policy's schema from the
 * MANIFEST by name, so a published pack evaluated every one of its policies with
 * `ctx.params = {}` — which discards the values the USER configured, not merely
 * the declared defaults. Of the 39 builtins 20 carry a schema, and every one of
 * them would have failed in the same direction: stricter than asked for, which is
 * the direction people work around instead of reporting.
 *
 * So the chain is tested end to end, and both halves of the malformed-schema rule
 * are pinned: refused at publish, where the author can still fix it, and dropped
 * with a recorded reason at load, where refusing the pack would deny every tool
 * call it covers.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPackCommand } from "@/src/hooks/pack-cli";
import { readInstalledPacks } from "@/src/hooks/pack-manifest";
import { evaluatePolicies, packPolicyParamKey } from "@/src/hooks/policy-evaluator";
import { clearPolicies, registerPolicy } from "@/src/hooks/policy-registry";

let work: string;
let saved: Record<string, string | undefined>;

interface BuiltManifest {
  id: string;
  version: string;
  minCliVersion?: string;
  policies: Array<{ name: string; params?: Record<string, unknown> }>;
  semantic?: Array<Record<string, unknown>>;
}

const write = (name: string, body: string) => {
  const p = join(work, name);
  writeFileSync(p, body, "utf8");
  return p;
};

const manifestOf = (dir: string): BuiltManifest =>
  JSON.parse(readFileSync(join(dir, "failproofai-pack.json"), "utf8")) as BuiltManifest;

/** Put a built pack on disk as `installed.json` would have it, digest and all. */
function installBuilt(manifest: BuiltManifest): void {
  const packs = process.env.FAILPROOFAI_PACK_DIR!;
  mkdirSync(join(packs, "artifacts"), { recursive: true });
  const artifactSrc = join(work, "out", "failproofai-pack.mjs");
  const digest = createHash("sha256").update(readFileSync(artifactSrc)).digest("hex");
  copyFileSync(artifactSrc, join(packs, "artifacts", `${digest}.mjs`));
  writeFileSync(
    join(packs, "installed.json"),
    JSON.stringify({
      schemaVersion: 1,
      packs: [
        {
          id: manifest.id,
          version: manifest.version,
          source: "github:acme/guards@v1.0.0",
          entry: `artifacts/${digest}.mjs`,
          sha256: digest,
          policies: manifest.policies,
        },
      ],
    }),
  );
}

const build = (entry: string, extra: string[] = []) =>
  runPackCommand(["build", entry, "--id", "acme/guards", "--version", "1.0.0", "--out", join(work, "out"), ...extra]);

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "fpai-params-build-"));
  saved = { FAILPROOFAI_PACK_DIR: process.env.FAILPROOFAI_PACK_DIR };
  process.env.FAILPROOFAI_PACK_DIR = join(work, "packs");
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(work, { recursive: true, force: true });
});

describe("a policy's params schema survives publishing", () => {
  const PARAMS_ENTRY = `
    import { customPolicies, deny } from "failproofai";
    customPolicies.add({
      name: "block-sudo",
      description: "Block sudo",
      category: "Shell",
      defaultEnabled: true,
      match: { events: ["PreToolUse"] },
      params: {
        allowPatterns: { type: "pattern[]", description: "Commands to allow anyway", default: [] },
        strict: { type: "boolean", description: "Refuse even a read-only sudo", default: true },
      },
      fn: async () => deny("no sudo"),
    });
  `;

  it("writes the schema into the manifest", async () => {
    // It did not, and nothing said so: `registerPolicy` reads a pack policy's
    // schema from the manifest by name, so an omitted one means `ctx.params = {}`
    // at evaluation time — which discards the user's OWN configured values, not
    // just the defaults, and every one of those policies then fails stricter.
    const r = await build(write("policies.mjs", PARAMS_ENTRY));
    expect(r.exitCode, r.lines.join("\n")).toBe(0);
    const entry = manifestOf(join(work, "out")).policies[0] as { params?: Record<string, unknown> };
    expect(entry.params).toEqual({
      allowPatterns: { type: "pattern[]", description: "Commands to allow anyway", default: [] },
      strict: { type: "boolean", description: "Refuse even a read-only sudo", default: true },
    });
  });

  it("refuses a schema a machine could not use", async () => {
    for (const [params, match] of [
      [`{ allowPatterns: { type: "regexp", description: "d", default: [] } }`, /not one of string, number/],
      [`{ allowPatterns: { type: "string", default: [] } }`, /missing a description/],
      [`{ allowPatterns: { type: "string", description: "d" } }`, /missing a default/],
      [`{ allowPatterns: "patterns" }`, /params\.allowPatterns is not an object/],
      [`["allowPatterns"]`, /params is not an object/],
    ] as Array<[string, RegExp]>) {
      const r = await build(write("policies.mjs", PARAMS_ENTRY.replace(/params: \{[\s\S]*?\n      \},/, `params: ${params},`)));
      expect(r.exitCode, params).toBe(1);
      expect(r.lines.join("\n")).toMatch(match);
    }
  });

  it("carries a user-set value onto the published default, end to end", async () => {
    // The chain the omission broke: registration reads the schema from the
    // MANIFEST by name (`handler.ts`), and the evaluator merges the user's saved
    // value over it. With no schema published, `ctx.params` was `{}` — so the
    // user's own value was discarded too, not merely the default.
    const built = await build(write("policies.mjs", PARAMS_ENTRY));
    expect(built.exitCode, built.lines.join("\n")).toBe(0);
    const manifest = manifestOf(join(work, "out"));
    installBuilt(manifest);

    const pack = readInstalledPacks().packs[0];
    // Exactly the lookup `handler.ts` performs.
    const schema = pack.policies.find((p) => p.name === "block-sudo")?.params;
    expect(schema).toBeDefined();

    clearPolicies();
    let seen: Record<string, unknown> | undefined;
    registerPolicy(
      `pack/${pack.id}@${pack.version}/block-sudo`,
      "d",
      async (ctx) => {
        seen = ctx.params;
        return { decision: "allow" };
      },
      { events: ["PreToolUse"] },
      -1,
      schema,
    );
    await evaluatePolicies(
      "PreToolUse",
      { tool_name: "Bash", tool_input: { command: "ls" } },
      undefined,
      { enabledPolicies: [], policyParams: { [packPolicyParamKey(pack.id, "block-sudo")]: { strict: false } } },
    );
    // The user's value wins; the other parameter still arrives with its default.
    expect(seen).toEqual({ allowPatterns: [], strict: false });
    clearPolicies();
  });

  it("drops an unusable schema at LOAD time instead of refusing the pack", async () => {
    // The other side of the same rule: refusing here fails the pack closed and
    // denies every tool call it covers, over a typo in an optional field.
    const packs = join(work, "packs2");
    mkdirSync(join(packs, "artifacts"), { recursive: true });
    const artifact = "// never executed here\n";
    const digest = createHash("sha256").update(artifact).digest("hex");
    writeFileSync(join(packs, "artifacts", `${digest}.mjs`), artifact);
    writeFileSync(
      join(packs, "installed.json"),
      JSON.stringify({
        schemaVersion: 1,
        packs: [
          {
            id: "acme/guards",
            version: "1.0.0",
            source: "github:acme/guards@v1.0.0",
            entry: `artifacts/${digest}.mjs`,
            sha256: digest,
            policies: [
              {
                name: "block-sudo",
                description: "d",
                category: "Shell",
                defaultEnabled: true,
                match: { events: ["PreToolUse"] },
                params: { allowPatterns: { type: "regexp", description: "d", default: [] } },
              },
            ],
          },
        ],
      }),
    );
    process.env.FAILPROOFAI_PACK_DIR = packs;
    const read = readInstalledPacks();
    expect(read.errors).toEqual([]);
    expect(read.packs[0].policies[0].params).toBeUndefined();
    expect(read.warnings?.[0]).toMatch(/params schema that was dropped/);
  });
});
