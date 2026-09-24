// @vitest-environment node
/**
 * `failproofai publish` for a pack that carries Jev questions as well as regex
 * policies.
 *
 * The manifest is what a machine reads, so a semantic policy left on the
 * registration and not written here is a question set that is published,
 * digest-pinned and then ignored — the same silent-nothing this whole lane exists
 * to make impossible. And because the build step is the last place an author can
 * still fix anything, every rule the loader applies is applied here too.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findEntry, runPackCommand } from "@/src/hooks/pack-cli";
import { parsePackSemanticPolicy, readInstalledPacks } from "@/src/hooks/pack-manifest";
import { MAX_PACK_QUESTION_CHARS } from "@/src/hooks/semantic/pack-policies";
import { version as packageVersion } from "../../package.json";

/** A probe declaration, as an entry file writes it. */
const PROBE = `{ id: "destroys", instructions: "It permanently deletes existing data." }`;

const SEMANTIC_ENTRY = `
  import { semanticPolicies } from "failproofai";
  semanticPolicies.add({
    name: "pack-destructive-deletion",
    title: "Deleted something irreplaceable",
    appliesTo: ["shell", "write"],
    mode: "deny",
    userCanOverride: true,
    precondition: "has_paths",
    probes: [${PROBE}],
    exempt: { id: "whatever", instructions: "The target is build output." },
    guidance: "Confirm the exact paths with the user first.",
  });
`;

const BOTH_ENTRY = `
  import { customPolicies, semanticPolicies, deny } from "failproofai";
  customPolicies.add({
    name: "block-big-refund",
    description: "Block refunds above the approved limit",
    category: "Finance",
    defaultEnabled: true,
    match: { events: ["PreToolUse"] },
    authority: "reviewable",
    reviewedBy: ["pack-destructive-deletion"],
    fn: async () => deny("no"),
  });
  ${SEMANTIC_ENTRY}
`;

let work: string;
let saved: Record<string, string | undefined>;

interface BuiltManifest {
  id: string;
  version: string;
  minCliVersion?: string;
  policies: Array<{ name: string; authority?: string; reviewedBy?: string[] }>;
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
          ...(manifest.minCliVersion ? { minCliVersion: manifest.minCliVersion } : {}),
          policies: manifest.policies,
          ...(manifest.semantic ? { semantic: manifest.semantic } : {}),
        },
      ],
    }),
  );
}

const build = (entry: string, extra: string[] = []) =>
  runPackCommand(["build", entry, "--id", "acme/guards", "--version", "1.0.0", "--out", join(work, "out"), ...extra]);

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "fpai-semantic-build-"));
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

describe("findEntry discovers both kinds of policy file", () => {
  it("finds a file that registers only semantic policies", () => {
    // It could not, and the failure was invisible: `publish` in that directory
    // reported no policy file rather than reaching the "registered no policies"
    // message that would have explained itself.
    const entry = write("jev-policies.mjs", SEMANTIC_ENTRY);
    expect(findEntry(work)).toEqual([entry]);
  });

  it("finds a file that registers both", () => {
    const entry = write("policies.mjs", BOTH_ENTRY);
    expect(findEntry(work)).toEqual([entry]);
  });

  it("still ignores a file that registers neither", () => {
    write("helper.mjs", `import { deny } from "failproofai";\nexport const x = deny;\n`);
    expect(findEntry(work)).toEqual([]);
  });
});

describe("build emits the semantic array", () => {
  it("writes every declared field, validated by the loader's own parser", async () => {
    const r = await build(write("policies.mjs", BOTH_ENTRY));
    expect(r.exitCode, r.lines.join("\n")).toBe(0);
    const manifest = manifestOf(join(work, "out"));
    expect(manifest.semantic).toHaveLength(1);
    expect(manifest.semantic?.[0]).toEqual({
      name: "pack-destructive-deletion",
      title: "Deleted something irreplaceable",
      appliesTo: ["shell", "write"],
      mode: "deny",
      userCanOverride: true,
      probes: [{ id: "destroys", instructions: "It permanently deletes existing data." }],
      // Forced, not copied: the answer map keys it `<policy>.exempt` regardless.
      exempt: { id: "exempt", instructions: "The target is build output." },
      precondition: "has_paths",
      guidance: "Confirm the exact paths with the user first.",
    });
    // And what was written parses as the loader will parse it.
    expect(() => parsePackSemanticPolicy("acme/guards", manifest.semantic?.[0], 0)).not.toThrow();
  });

  it("omits the key entirely when nothing declared one", async () => {
    // An EMPTY array would still read as "a pack that declares semantic
    // entries", and the replacement rule turns that into "replaced the
    // compiled-in set with nothing".
    const entry = write("policies.mjs", `
      import { customPolicies, deny } from "failproofai";
      customPolicies.add({ name: "block-x", description: "d", match: { events: ["PreToolUse"] }, fn: async () => deny("no") });
    `);
    const r = await build(entry);
    expect(r.exitCode, r.lines.join("\n")).toBe(0);
    expect("semantic" in manifestOf(join(work, "out"))).toBe(false);
  });

  it("builds a pack that registers ONLY semantic policies", async () => {
    // The regex floor may already be somebody else's pack, so this is a
    // legitimate thing to publish.
    const r = await build(write("jev-policies.mjs", SEMANTIC_ENTRY));
    expect(r.exitCode, r.lines.join("\n")).toBe(0);
    const manifest = manifestOf(join(work, "out"));
    expect(manifest.policies).toEqual([]);
    expect(manifest.semantic).toHaveLength(1);
  });

  it("still refuses an entry that registers neither, and names both APIs", async () => {
    const r = await build(write("empty.mjs", "export const nothing = 1;\n"));
    expect(r.exitCode).toBe(1);
    expect(r.lines.join("\n")).toMatch(/customPolicies\.add/);
    expect(r.lines.join("\n")).toMatch(/semanticPolicies\.add/);
  });

  it("refuses a semantic policy the loader would refuse", async () => {
    const entry = write("policies.mjs", `
      import { semanticPolicies } from "failproofai";
      semanticPolicies.add({
        name: "pack-check", title: "t", appliesTo: ["shell"], mode: "deny",
        probes: [${PROBE}], guidance: "g",
      });
    `);
    const r = await build(entry);
    expect(r.exitCode).toBe(1);
    // The field whose absence would be a security decision.
    expect(r.lines.join("\n")).toMatch(/missing userCanOverride/);
  });

  it("refuses two semantic policies with one name", async () => {
    const entry = write("policies.mjs", `${SEMANTIC_ENTRY}\n${SEMANTIC_ENTRY}`);
    const r = await build(entry);
    expect(r.exitCode).toBe(1);
    expect(r.lines.join("\n")).toMatch(/two semantic policies are called "pack-destructive-deletion"/);
  });

  it("refuses a question set one Jev request cannot carry", async () => {
    const fat = Array.from({ length: 30 }, (_, i) => `
      semanticPolicies.add({
        name: "check-${i}", title: "t", appliesTo: ["shell"], mode: "deny", userCanOverride: true,
        probes: [${Array.from({ length: 6 }, (_, j) => `{ id: "p${j}", instructions: "${"x".repeat(600)}" }`).join(",")}],
        guidance: "g",
      });`).join("\n");
    const r = await build(write("policies.mjs", `import { semanticPolicies } from "failproofai";\n${fat}`));
    expect(r.exitCode).toBe(1);
    expect(r.lines.join("\n")).toMatch(new RegExp(`over the ${MAX_PACK_QUESTION_CHARS} one Jev request has room for`));
  });
});

describe("authority against the pack's own semantic policies", () => {
  it("publishes a reviewedBy that names one of them", async () => {
    // The load-bearing case: a pack carrying both tiers replaces the compiled-in
    // semantic set where it installs, so its regex policies must be able to name
    // its OWN checks. Judged against this build's sixteen, this would be
    // "a check this build does not have" and silently downgraded to hard.
    const r = await build(write("policies.mjs", BOTH_ENTRY));
    expect(r.exitCode, r.lines.join("\n")).toBe(0);
    const entry = manifestOf(join(work, "out")).policies.find((p) => p.name === "block-big-refund");
    expect(entry?.authority).toBe("reviewable");
    expect(entry?.reviewedBy).toEqual(["pack-destructive-deletion"]);
  });

  it("still refuses a reviewedBy naming nothing that will exist", async () => {
    const entry = write("policies.mjs", BOTH_ENTRY.replace("pack-destructive-deletion\"]", "typo-check\"]"));
    const r = await build(entry);
    expect(r.exitCode).toBe(1);
    expect(r.lines.join("\n")).toMatch(/authority "reviewable" was refused/);
  });

  it("falls back to this build's names for a pack with no semantic entries", async () => {
    // Those machines keep running the compiled-in set, so a builtin name is the
    // right thing for such a pack to review by.
    const entry = write("policies.mjs", `
      import { customPolicies, deny } from "failproofai";
      customPolicies.add({
        name: "block-x", description: "d", match: { events: ["PreToolUse"] },
        authority: "reviewable", reviewedBy: ["secret-exposure"],
        fn: async () => deny("no"),
      });
    `);
    const r = await build(entry);
    expect(r.exitCode, r.lines.join("\n")).toBe(0);
    expect(manifestOf(join(work, "out")).policies[0].reviewedBy).toEqual(["secret-exposure"]);
  });
});

describe("--min-cli-version", () => {
  it("writes the field when given one", async () => {
    const r = await build(write("policies.mjs", BOTH_ENTRY), ["--min-cli-version", packageVersion]);
    expect(r.exitCode, r.lines.join("\n")).toBe(0);
    expect(manifestOf(join(work, "out")).minCliVersion).toBe(packageVersion);
    expect(r.lines.join("\n")).toMatch(new RegExp(`Requires failproofai ${packageVersion.replace(/[.-]/g, "\\$&")}`));
  });

  it("omits the field when not given one", async () => {
    const r = await build(write("policies.mjs", BOTH_ENTRY));
    expect(r.exitCode).toBe(0);
    expect("minCliVersion" in manifestOf(join(work, "out"))).toBe(false);
  });

  it("refuses a version nobody can compare, before writing anything", async () => {
    // The loader ignores an unreadable minimum rather than refusing the pack, so
    // a typo published here is a requirement that silently evaporates on every
    // machine. Caught where the author can still fix it.
    for (const bad of ["v1.0.0", "1.0", "latest"]) {
      const r = await build(write("policies.mjs", BOTH_ENTRY), ["--min-cli-version", bad]);
      expect(r.exitCode, bad).toBe(1);
      expect(r.lines.join("\n")).toMatch(/is not a version that can be compared/);
    }
  });
});

describe("what build writes, the reader reads", () => {
  it("round-trips a semantic pack through the real installed-manifest parser", async () => {
    const r = await build(write("policies.mjs", BOTH_ENTRY), ["--min-cli-version", packageVersion]);
    expect(r.exitCode, r.lines.join("\n")).toBe(0);
    const built = manifestOf(join(work, "out"));

    installBuilt(built);

    const read = readInstalledPacks();
    expect(read.errors).toEqual([]);
    expect(read.warnings).toBeUndefined();
    expect(read.packs[0].semantic?.map((s) => s.name)).toEqual(["pack-destructive-deletion"]);
    expect(read.packs[0].policies[0].reviewedBy).toEqual(["pack-destructive-deletion"]);
  });
});
