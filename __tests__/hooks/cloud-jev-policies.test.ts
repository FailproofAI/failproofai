// @vitest-environment node
/**
 * FailproofAI Cloud Jev / regex / both policies on the machine (CONTRACT C6).
 *
 * The daemon places each `jev`/`both` policy's declarations at
 * `artifacts/<sha>.json` and names them in `active.json` `semanticPolicies`,
 * with an optional `jevMode`. What is pinned here:
 *
 *   - the loader verifies each artifact's digest and parses it with THE pack
 *     manifest's own semantic parser (the shared contract fixtures: every valid
 *     one accepted, every invalid one rejected — the reserved-name one is
 *     accepted by the parser and voided by the reserved-name rule);
 *   - a bad entry is dropped fail-open, logged, and reported in `errors.json`;
 *   - `resolveSemanticPolicies` = installed packs ∪ Cloud, Cloud winning a name
 *     clash, one question budget across both;
 *   - a `both` policy's `reviewedBy` names its own Cloud check and is honoured;
 *   - Cloud's `jevMode` overrides the local mode (a local `off` included), with
 *     `jev.json`'s provider or else the Cloud Jev credential, else
 *     `jev_unconfigured`;
 *   - `errors.json` is written atomically, only on change;
 *   - `policies`, `jev status` and `config --disconnect` show and clear it all.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RegisteredPolicy } from "@/src/hooks/policy-types";

const VALID = JSON.parse(
  readFileSync(resolve(__dirname, "../fixtures/cloud-jev/semantic-valid.json"), "utf8"),
) as Array<Record<string, unknown>>;
const INVALID = JSON.parse(
  readFileSync(resolve(__dirname, "../fixtures/cloud-jev/semantic-invalid.json"), "utf8"),
) as Array<{ why: string; decl: Record<string, unknown> }>;

const ENV_KEYS = [
  "FAILPROOFAI_HOME",
  "FAILPROOFAI_PACK_DIR",
  "FAILPROOFAI_CLOUD_POLICY_DIR",
  "FAILPROOFAI_JEV_API_KEY",
  "FAILPROOFAI_CLOUD_CREDENTIALS",
  "FAILPROOFAI_JEV_CONFIG_DIR",
  "FAILPROOFAI_EVALUATOR",
] as const;

// Built at runtime: this repo's own hooks refuse secret-shaped literals.
const KEY = ["tk", "cloudjev", "0123456789abcdef"].join("-");
const ORIGIN = "https://app.befailproof.ai";
const posix = process.platform !== "win32";

let home: string;
let project: string;
let packRoot: string;
let cloudRoot: string;
let saved: Record<string, string | undefined>;
let stderr: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "fpai-cloudjev-home-"));
  project = mkdtempSync(join(tmpdir(), "fpai-cloudjev-project-"));
  packRoot = mkdtempSync(join(tmpdir(), "fpai-cloudjev-packs-"));
  cloudRoot = mkdtempSync(join(tmpdir(), "fpai-cloudjev-cloud-"));
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.FAILPROOFAI_HOME = home;
  process.env.FAILPROOFAI_PACK_DIR = packRoot;
  process.env.FAILPROOFAI_CLOUD_POLICY_DIR = cloudRoot;
  process.env.FAILPROOFAI_JEV_CONFIG_DIR = join(home, "no-typesafe");
  chmodSync(home, 0o700);
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

const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

const decl = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  title: `Checked ${name}`,
  appliesTo: ["shell"],
  mode: "deny",
  userCanOverride: true,
  probes: [{ id: "fires", instructions: `The call does the ${name} thing.`, criteria: { true: "It does.", false: "It does not." } }],
  guidance: "Ask the user first.",
  ...over,
});

/** A JS policy artifact registering the named hooks. */
const jsArtifact = (tag: string, names: string[]) => `
  // ${tag}
  import { customPolicies, allow } from "failproofai";
  ${names
    .map((n) => `customPolicies.add({ name: ${JSON.stringify(n)}, description: "d", match: { events: ["PreToolUse"] }, fn: async () => allow() });`)
    .join("\n  ")}
`;

interface CloudJs {
  id: string;
  version: number;
  hooks?: string[];
  authority?: "hard" | "reviewable";
  reviewedBy?: string[];
  effect?: "enforce" | "observe";
}
interface CloudSemantic {
  id: string;
  version: number;
  /** The declarations, or raw artifact bytes. */
  declarations?: unknown;
  raw?: string;
  /** Record a digest other than the bytes' own. */
  wrongSha?: boolean;
  path?: string;
}

/** Write a deployment exactly as the daemon materialises it. */
function deploy(opts: { policies?: CloudJs[]; semantic?: CloudSemantic[]; jevMode?: string; deployment?: number }): void {
  mkdirSync(join(cloudRoot, "artifacts"), { recursive: true });
  const policies = (opts.policies ?? []).map((p) => {
    const bytes = jsArtifact(`${p.id}@${p.version}`, p.hooks ?? [`${p.id}-hook`]);
    const digest = sha(bytes);
    writeFileSync(join(cloudRoot, "artifacts", `${digest}.mjs`), bytes, { mode: 0o600 });
    return {
      id: p.id,
      version: p.version,
      sha256: digest,
      path: `artifacts/${digest}.mjs`,
      effect: p.effect ?? "enforce",
      ...(p.authority ? { authority: p.authority } : {}),
      ...(p.reviewedBy ? { reviewedBy: p.reviewedBy } : {}),
    };
  });
  const semanticPolicies = (opts.semantic ?? []).map((s) => {
    const bytes = s.raw ?? JSON.stringify(s.declarations ?? []);
    const digest = sha(bytes);
    writeFileSync(join(cloudRoot, "artifacts", `${digest}.json`), bytes, { mode: 0o600 });
    return {
      id: s.id,
      version: s.version,
      sha256: s.wrongSha ? sha(`${bytes}!`) : digest,
      path: s.path ?? `artifacts/${digest}.json`,
    };
  });
  writeFileSync(
    join(cloudRoot, "active.json"),
    JSON.stringify({
      schemaVersion: 2,
      deployment: opts.deployment ?? 43,
      policies,
      ...(semanticPolicies.length > 0 ? { semanticPolicies } : {}),
      ...(opts.jevMode !== undefined ? { jevMode: opts.jevMode } : {}),
    }),
    { mode: 0o600 },
  );
}

/** Installed packs, as `policies add` leaves them. */
function installPacks(packs: Array<{ id: string; source?: string; semantic: unknown[] }>): void {
  mkdirSync(join(packRoot, "artifacts"), { recursive: true });
  const records = packs.map((p) => {
    const artifact = `// ${p.id}\nexport const hooks = [];\n`;
    const digest = sha(artifact);
    writeFileSync(join(packRoot, "artifacts", `${digest}.mjs`), artifact);
    return {
      id: p.id,
      version: "1.0.0",
      source: p.source ?? `github:${p.id}@v1.0.0`,
      entry: `artifacts/${digest}.mjs`,
      sha256: digest,
      policies: [],
      semantic: p.semantic,
    };
  });
  writeFileSync(join(packRoot, "installed.json"), JSON.stringify({ schemaVersion: 1, packs: records }));
}

async function registeredAfterOneEvent(): Promise<Map<string, RegisteredPolicy>> {
  const { evaluateHookEvent } = await import("@/src/hooks/handler");
  await evaluateHookEvent(
    "PreToolUse",
    "claude",
    JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      session_id: "cloud-jev-policies",
      cwd: project,
    }),
  );
  const { getAllPolicies } = await import("@/src/hooks/policy-registry");
  return new Map(getAllPolicies().map((p) => [p.name, p]));
}

const errorsFile = () => join(cloudRoot, "errors.json");
const readErrors = () => JSON.parse(readFileSync(errorsFile(), "utf8")) as { errors: Array<Record<string, unknown>> };

// ── The loader ───────────────────────────────────────────────────────────────

describe("readCloudJevPolicies", () => {
  it("reads nothing, and reports nothing, on a machine with no deployment", async () => {
    const { readCloudJevPolicies, readCloudJevMode } = await import("@/src/hooks/cloud-managed-policies");
    expect(readCloudJevPolicies()).toEqual({ sets: [], semanticIds: [], jevMode: null, errors: [] });
    expect(readCloudJevMode()).toBeNull();
  });

  it("verifies and parses a jev and a both policy into pack-shaped sets", async () => {
    deploy({
      policies: [{ id: "no-prod-db", version: 3, authority: "reviewable", reviewedBy: ["acme-prod-db"] }],
      semantic: [
        { id: "no-prod-db", version: 3, declarations: [decl("acme-prod-db")] },
        { id: "secrets-in-output", version: 1, declarations: [decl("acme-secrets"), decl("acme-tokens")] },
      ],
      jevMode: "observe",
    });
    const { readCloudJevPolicies, readCloudJevMode } = await import("@/src/hooks/cloud-managed-policies");
    const read = readCloudJevPolicies();
    expect(read.errors).toEqual([]);
    expect(read.jevMode).toBe("observe");
    expect(readCloudJevMode()).toBe("observe");
    expect(read.semanticIds).toEqual(["no-prod-db", "secrets-in-output"]);
    expect(read.sets.map((s) => [s.id, s.version, s.source, s.effect, s.kind, s.semantic.map((e) => e.name)])).toEqual([
      ["cloud:no-prod-db", "3", "cloud:no-prod-db@3", "enforce", "both", ["acme-prod-db"]],
      ["cloud:secrets-in-output", "1", "cloud:secrets-in-output@1", "enforce", "jev", ["acme-secrets", "acme-tokens"]],
    ]);
    expect(read.sets[0].clis).toBeNull();
    expect(read.sets[0].deployment).toBe(43);
  });

  it("drops a policy whose artifact fails its digest, reports it, and keeps the rest", async () => {
    deploy({
      semantic: [
        { id: "tampered", version: 2, declarations: [decl("acme-a")], wrongSha: true },
        { id: "fine", version: 1, declarations: [decl("acme-b")] },
      ],
    });
    const { readCloudJevPolicies } = await import("@/src/hooks/cloud-managed-policies");
    const read = readCloudJevPolicies();
    expect(read.sets.map((s) => s.policyId)).toEqual(["fine"]);
    expect(read.errors).toHaveLength(1);
    expect(read.errors[0]).toMatchObject({ id: "tampered", version: 2, kind: "jev" });
    expect(read.errors[0].message).toMatch(/integrity verification/);
    // Logged once, not per read.
    readCloudJevPolicies();
    expect(stderr.join("").match(/tampered@2/g)?.length ?? 0).toBeLessThanOrEqual(1);
  });

  it("drops an artifact that is not JSON, or not an array, or escapes the root", async () => {
    deploy({
      semantic: [
        { id: "not-json", version: 1, raw: "{nope" },
        { id: "not-array", version: 1, raw: JSON.stringify({ name: "x" }) },
        { id: "escape", version: 1, declarations: [decl("acme-c")], path: "../../etc/passwd" },
      ],
    });
    const { readCloudJevPolicies } = await import("@/src/hooks/cloud-managed-policies");
    const read = readCloudJevPolicies();
    expect(read.sets).toEqual([]);
    const byId = Object.fromEntries(read.errors.map((e) => [e.id, e.message]));
    expect(byId["not-json"]).toMatch(/not valid JSON/);
    expect(byId["not-array"]).toMatch(/not a JSON array/);
    expect(byId.escape).toMatch(/escapes its root/);
  });

  it("reports a declaration its parser drops, and loads the rest of that policy", async () => {
    deploy({
      semantic: [{ id: "mixed", version: 5, declarations: [decl("acme-ok"), { ...decl("acme-bad"), mode: "maybe" }] }],
    });
    const { readCloudJevPolicies } = await import("@/src/hooks/cloud-managed-policies");
    const read = readCloudJevPolicies();
    expect(read.sets[0].semantic.map((e) => e.name)).toEqual(["acme-ok"]);
    expect(read.errors).toHaveLength(1);
    expect(read.errors[0]).toMatchObject({ id: "mixed", version: 5, kind: "jev" });
    expect(read.errors[0].message).toMatch(/declaration dropped: .*acme-bad.*mode/);
  });

  it("ignores and reports a jevMode it cannot read", async () => {
    deploy({ semantic: [], jevMode: "shadow" });
    const { readCloudJevPolicies, readCloudJevMode } = await import("@/src/hooks/cloud-managed-policies");
    expect(readCloudJevMode()).toBeNull();
    expect(readCloudJevPolicies().errors).toEqual([
      { id: "jevMode", version: null, kind: "daemon", message: 'unknown Jev mode "shadow" ignored' },
    ]);
  });
});

// ── The shared contract fixtures ─────────────────────────────────────────────

describe("the contract fixtures, through the manifest's own parser", () => {
  it("has the shape the contract names: 16 valid, 8 invalid", () => {
    expect(VALID).toHaveLength(16);
    expect(INVALID).toHaveLength(8);
  });

  it("accepts every valid declaration, unchanged in count and name, with nothing dropped", async () => {
    const { parsePackSemantic } = await import("@/src/hooks/pack-manifest");
    const warnings: string[] = [];
    const parsed = parsePackSemantic("cloud:acme@1", VALID, warnings);
    expect(warnings).toEqual([]);
    expect(parsed.map((e) => e.name)).toEqual(VALID.map((d) => d.name));

    // And end to end, as one deployed Cloud policy.
    deploy({ semantic: [{ id: "acme-baseline", version: 1, declarations: VALID }] });
    const { readCloudJevPolicies } = await import("@/src/hooks/cloud-managed-policies");
    const read = readCloudJevPolicies();
    expect(read.errors).toEqual([]);
    expect(read.sets[0].semantic).toHaveLength(16);
  });

  for (const { why, decl: bad } of INVALID) {
    if (why === "reserved FailproofAI name") continue;
    it(`rejects: ${why}`, async () => {
      const { parsePackSemantic } = await import("@/src/hooks/pack-manifest");
      const warnings: string[] = [];
      expect(parsePackSemantic("cloud:acme@1", [bad], warnings)).toEqual([]);
      expect(warnings).toHaveLength(1);

      deploy({ semantic: [{ id: "acme-bad", version: 1, declarations: [bad] }] });
      const { readCloudJevPolicies } = await import("@/src/hooks/cloud-managed-policies");
      const read = readCloudJevPolicies();
      expect(read.sets[0].semantic).toEqual([]);
      expect(read.errors.map((e) => e.message).join("\n")).toMatch(/declaration dropped/);
    });
  }

  it("the reserved-name fixture: the PARSER accepts it, and the reserved-name rule voids it for a Cloud source", async () => {
    const reserved = INVALID.find((c) => c.why === "reserved FailproofAI name")!.decl;
    const { parsePackSemantic } = await import("@/src/hooks/pack-manifest");
    const warnings: string[] = [];
    expect(parsePackSemantic("cloud:acme@1", [reserved], warnings).map((e) => e.name)).toEqual([reserved.name]);
    expect(warnings).toEqual([]);

    deploy({ semantic: [{ id: "acme-reserved", version: 1, declarations: [reserved] }] });
    const { readCloudJevPolicies } = await import("@/src/hooks/cloud-managed-policies");
    const read = readCloudJevPolicies();
    // Loaded, and reported so the org sees why it is never asked…
    expect(read.sets[0].semantic.map((e) => e.name)).toEqual([reserved.name]);
    expect(read.errors[0].message).toMatch(/reserved for FailproofAI's own Jev checks/);
    // …and voided by the unchanged rule: never asked, never a reviewer.
    const { isReservedClaim, reviewerNamesFor, withCloudSemantic } = await import("@/src/hooks/effective-reviewers");
    expect(isReservedClaim(read.sets[0], reserved.name as string)).toBe(true);
    const sources = withCloudSemantic([], read.sets).sources;
    expect(reviewerNamesFor(sources).has(reserved.name as string)).toBe(false);
    const { semanticPoliciesFromPacks } = await import("@/src/hooks/semantic/pack-policies");
    expect(semanticPoliciesFromPacks(sources).policies.map((p) => p.name)).not.toContain(reserved.name);
  });
});

// ── packs ∪ Cloud ────────────────────────────────────────────────────────────

describe("resolveSemanticPolicies: installed packs ∪ FailproofAI Cloud", () => {
  it("asks both, and Cloud wins a name clash — the pack's same-named check is dropped, with one warning", async () => {
    installPacks([{ id: "acme/checks", semantic: [decl("acme-shared", { title: "The pack's version" }), decl("acme-pack-only")] }]);
    deploy({ semantic: [{ id: "org-checks", version: 4, declarations: [decl("acme-shared", { title: "The org's version" }), decl("acme-cloud-only")] }] });
    const { resolveSemanticPolicies } = await import("@/src/hooks/semantic/pack-policies");
    const policies = resolveSemanticPolicies("claude");
    const byName = Object.fromEntries(policies.map((p) => [p.name, p]));
    expect(Object.keys(byName).sort()).toEqual(["acme-cloud-only", "acme-pack-only", "acme-shared"]);
    expect(byName["acme-shared"].title).toBe("The org's version");
    expect(byName["acme-shared"].origin).toEqual({ packId: "cloud:org-checks", packVersion: "4" });
    expect(byName["acme-pack-only"].origin?.packId).toBe("acme/checks");
    const warned = stderr.join("").match(/declares Jev check acme-shared, which FailproofAI Cloud policy cloud:org-checks@4 also declares/g);
    expect(warned).toHaveLength(1);
    resolveSemanticPolicies("claude");
    expect(stderr.join("").match(/declares Jev check acme-shared/g)).toHaveLength(1);
  });

  it("a Cloud claim to a reserved name shadows nothing: FailproofAI's own pack keeps it", async () => {
    const reserved = INVALID.find((c) => c.why === "reserved FailproofAI name")!.decl;
    installPacks([{ id: "FailproofAI/jev-policies", source: "github:FailproofAI/jev-policies@v0.2.0", semantic: [reserved] }]);
    deploy({ semantic: [{ id: "org-copy", version: 1, declarations: [{ ...reserved, title: "An org's copy" }] }] });
    const { resolveSemanticPolicies } = await import("@/src/hooks/semantic/pack-policies");
    const [only] = resolveSemanticPolicies("claude");
    expect(only.name).toBe(reserved.name);
    expect(only.origin?.packId).toBe("FailproofAI/jev-policies");
    expect(only.title).toBe(reserved.title);
  });

  it("spends ONE question budget across packs and Cloud", async () => {
    const renamed = (prefix: string) => VALID.map((d) => ({ ...d, name: `${prefix}-${d.name as string}` }));
    deploy({
      semantic: [
        { id: "org-a", version: 1, declarations: renamed("a") },
        { id: "org-b", version: 1, declarations: renamed("b") },
        { id: "org-c", version: 1, declarations: renamed("c") },
      ],
    });
    const { readCloudJevPolicies } = await import("@/src/hooks/cloud-managed-policies");
    const { withCloudSemantic } = await import("@/src/hooks/effective-reviewers");
    const { semanticPoliciesFromPacks, MAX_PACK_QUESTION_CHARS, questionChars } = await import("@/src/hooks/semantic/pack-policies");
    const resolved = semanticPoliciesFromPacks(withCloudSemantic([], readCloudJevPolicies().sets).sources);
    const spent = readCloudJevPolicies()
      .sets.flatMap((s) => s.semantic)
      .filter((e) => resolved.policies.some((p) => p.name === e.name))
      .reduce((n, e) => n + questionChars(e), 0);
    expect(spent).toBeLessThanOrEqual(MAX_PACK_QUESTION_CHARS);
    expect(resolved.policies.length).toBeLessThan(48);
    expect(resolved.errors.join("\n")).toMatch(/pack cloud:org-[abc] semantic policy .* was dropped: its questions need/);
  });
});

// ── Reviewers: a `both` policy's reviewedBy ──────────────────────────────────

describe("a both policy's reviewedBy names its own Cloud check", () => {
  it("is honoured: the JS half registers reviewable, and nothing is reported", async () => {
    deploy({
      policies: [{ id: "no-prod-db", version: 3, hooks: ["block-prod-db"], authority: "reviewable", reviewedBy: ["acme-prod-db"] }],
      semantic: [{ id: "no-prod-db", version: 3, declarations: [decl("acme-prod-db")] }],
    });
    const registered = await registeredAfterOneEvent();
    const policy = registered.get("cloud/no-prod-db@3/block-prod-db");
    expect(policy?.authority).toBe("reviewable");
    expect(policy?.reviewedBy).toEqual(["acme-prod-db"]);
    const { effectiveReviewerNames, jevChecksInstalled } = await import("@/src/hooks/effective-reviewers");
    expect(effectiveReviewerNames().has("acme-prod-db")).toBe(true);
    expect(jevChecksInstalled()).toBe(true);
    expect(existsSync(errorsFile())).toBe(false);
  });

  it("stays hard when the check is not deployed, and errors.json says why", async () => {
    deploy({
      policies: [{ id: "no-prod-db", version: 3, hooks: ["block-prod-db"], authority: "reviewable", reviewedBy: ["acme-prod-db"] }],
    });
    const registered = await registeredAfterOneEvent();
    expect(registered.get("cloud/no-prod-db@3/block-prod-db")?.authority).toBe("hard");
    expect(readErrors().errors).toEqual([
      {
        id: "no-prod-db",
        version: 3,
        kind: "regex",
        message: "reviewedBy names acme-prod-db, which is not a Jev check this machine can ask, so the policy stays hard",
      },
    ]);
  });
});

// ── errors.json ──────────────────────────────────────────────────────────────

describe("errors.json", () => {
  const entry = { id: "p", version: 1, kind: "jev" as const, message: "m" };

  it("is written only on a managed machine, only on change, atomically and owner-only", async () => {
    const { writeCloudPolicyErrors, _resetCloudPolicyErrorsCacheForTest } = await import("@/src/hooks/cloud-policy-errors");
    // No deployment: never a file.
    expect(writeCloudPolicyErrors([entry])).toBe("skipped");
    expect(existsSync(errorsFile())).toBe(false);

    deploy({});
    // Nothing to say and nothing to clear: still no file, so the poll stays silent.
    expect(writeCloudPolicyErrors([])).toBe("skipped");
    expect(existsSync(errorsFile())).toBe(false);

    expect(writeCloudPolicyErrors([entry])).toBe("written");
    expect(readErrors()).toEqual({ errors: [entry] });
    if (posix) expect(statSync(errorsFile()).mode & 0o777).toBe(0o600);
    const before = statSync(errorsFile()).mtimeMs;
    expect(writeCloudPolicyErrors([entry])).toBe("unchanged");
    _resetCloudPolicyErrorsCacheForTest();
    expect(writeCloudPolicyErrors([{ ...entry }])).toBe("unchanged");
    expect(statSync(errorsFile()).mtimeMs).toBe(before);

    // Fixed: `[]` replaces the list, which is what clears the server's copy.
    expect(writeCloudPolicyErrors([])).toBe("written");
    expect(readErrors()).toEqual({ errors: [] });
    expect(readdirSync(cloudRoot).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });

  it("collects every kind of problem, deduplicated, with the right kind", async () => {
    const { collectCloudPolicyErrors, JEV_UNCONFIGURED } = await import("@/src/hooks/cloud-policy-errors");
    const errors = collectCloudPolicyErrors({
      manifestError: null,
      jsPolicies: [
        { id: "both-one", version: 2, effect: "enforce", sha256: "a", path: "p", deployment: 1, authority: "reviewable", reviewedBy: ["acme-x", "acme-y"] },
        { id: "regex-one", version: 1, effect: "enforce", sha256: "b", path: "q", deployment: 1 },
      ],
      jsFailures: new Map([["regex-one", { type: "syntax_error" as const, reason: "Unexpected token" }]]),
      jev: {
        sets: [],
        semanticIds: ["both-one"],
        jevMode: "enforce",
        errors: [{ id: "both-one", version: 2, kind: "both", message: "not loaded: bad" }, { id: "both-one", version: 2, kind: "both", message: "not loaded: bad" }],
      },
      reviewerNames: new Set(["acme-x"]),
      jevUnconfigured: JEV_UNCONFIGURED,
    });
    expect(errors).toEqual([
      { id: "both-one", version: 2, kind: "both", message: "reviewedBy names acme-y, which is not a Jev check this machine can ask, so the policy stays hard" },
      { id: "regex-one", version: 1, kind: "regex", message: "policy did not load (syntax_error): Unexpected token" },
      { id: "both-one", version: 2, kind: "both", message: "not loaded: bad" },
      { id: "jevMode", version: null, kind: "daemon", message: "jev_unconfigured" },
    ]);
  });

  it("the hook path reports a broken Cloud Jev artifact, and clears the report once it is fixed", async () => {
    deploy({ semantic: [{ id: "org-checks", version: 7, declarations: [decl("acme-a")], wrongSha: true }] });
    await registeredAfterOneEvent();
    expect(readErrors().errors).toEqual([
      expect.objectContaining({ id: "org-checks", version: 7, kind: "jev", message: expect.stringMatching(/integrity verification/) }),
    ]);

    deploy({ semantic: [{ id: "org-checks", version: 8, declarations: [decl("acme-a")] }] });
    vi.resetModules();
    await registeredAfterOneEvent();
    expect(readErrors()).toEqual({ errors: [] });
  });

  it("the hook path reports a Cloud JS policy that fails to load, as kind both when it has Jev checks", async () => {
    mkdirSync(join(cloudRoot, "artifacts"), { recursive: true });
    const broken = "export default {{{ not javascript";
    const digest = sha(broken);
    writeFileSync(join(cloudRoot, "artifacts", `${digest}.mjs`), broken);
    const decls = JSON.stringify([decl("acme-z")]);
    writeFileSync(join(cloudRoot, "artifacts", `${sha(decls)}.json`), decls);
    writeFileSync(
      join(cloudRoot, "active.json"),
      JSON.stringify({
        schemaVersion: 2,
        deployment: 9,
        policies: [{ id: "broken", version: 1, sha256: digest, path: `artifacts/${digest}.mjs`, effect: "enforce" }],
        semanticPolicies: [{ id: "broken", version: 1, sha256: sha(decls), path: `artifacts/${sha(decls)}.json` }],
      }),
    );
    await registeredAfterOneEvent();
    const [problem] = readErrors().errors;
    expect(problem).toMatchObject({ id: "broken", version: 1, kind: "both" });
    expect(problem.message).toMatch(/policy did not load/);
  });
});

// ── Jev mode set by FailproofAI Cloud ────────────────────────────────────────

describe("Cloud's jevMode overrides the local mode", () => {
  const writeJev = (obj: unknown, mode = 0o600) => {
    const file = join(home, "jev.json");
    writeFileSync(file, JSON.stringify(obj), { mode });
    chmodSync(file, mode);
  };
  const connect = async () => {
    const { readCredentials, writeCredentials, writeJevCloudCredential } = await import("@/src/hooks/fp-config");
    writeCredentials({ ...readCredentials(), ingest: { url: `${ORIGIN}/v1/events`, key: KEY } });
    writeJevCloudCredential({ url: ORIGIN, key: KEY });
  };
  const load = async (mode: "off" | "observe" | "enforce") =>
    (await import("@/src/hooks/semantic/jev-config")).loadJevConfigForCloudMode(mode);

  it("Cloud off: no Jev, even over a working local config, and nothing to report", async () => {
    writeJev({ provider: "typesafe", apiKey: KEY, mode: "enforce" });
    expect(await load("off")).toEqual({ config: null, provider: null, problem: null });
  });

  it("Cloud observe over a local enforce: jev.json's provider, Cloud's mode", async () => {
    writeJev({ provider: "typesafe", apiKey: KEY, mode: "enforce" });
    const r = await load("observe");
    expect(r.provider).toBe("jev.json");
    expect(r.config).toMatchObject({ provider: "typesafe", mode: "observe", apiKey: KEY });
  });

  it("Cloud enforce over a local OFF: the local off is overridden, its routing and key reused", async () => {
    writeJev({ provider: "typesafe", apiKey: KEY, mode: "off" });
    const { loadJevConfig } = await import("@/src/hooks/semantic/jev-config");
    expect(loadJevConfig()).toBeNull();
    const r = await load("enforce");
    expect(r.config).toMatchObject({ provider: "typesafe", mode: "enforce", apiKey: KEY });
  });

  it("Cloud enforce over a local Cloud-provider off, with the Cloud credential", async () => {
    await connect();
    writeJev({ provider: "failproofai", baseUrl: `${ORIGIN}/enforcement/v1/jev`, mode: "off" });
    const r = await load("enforce");
    expect(r.config).toMatchObject({ provider: "failproofai", mode: "enforce", apiKey: KEY, credentialOrigin: ORIGIN });
  });

  it("no jev.json: the Cloud Jev credential answers as provider failproofai", async () => {
    await connect();
    const r = await load("enforce");
    expect(r.provider).toBe("cloud-credential");
    expect(r.problem).toBeNull();
    expect(r.config).toMatchObject({
      provider: "failproofai",
      baseUrl: `${ORIGIN}/enforcement/v1/jev`,
      mode: "enforce",
      apiKey: KEY,
      credentialOrigin: ORIGIN,
    });
    const { validateLoadedJevConfig } = await import("@/src/hooks/semantic/jev-config");
    expect(validateLoadedJevConfig(r.config!).ok).toBe(true);
  });

  it("neither: no Jev, and jev_unconfigured", async () => {
    expect(await load("observe")).toEqual({ config: null, provider: null, problem: "jev_unconfigured" });
  });

  it.skipIf(!posix)("a jev.json that is unusable is not swapped for the Cloud credential", async () => {
    await connect();
    writeJev({ provider: "typesafe", apiKey: KEY, mode: "enforce" }, 0o644);
    const r = await load("enforce");
    expect(r.config).toBeNull();
    expect(r.problem).toMatch(/^jev_unconfigured: jev\.json is refused/);
  });

  it("keeps the plain-http rule: enforce is refused on a loopback http endpoint, observe runs", async () => {
    writeJev({ provider: "custom", apiKey: KEY, baseUrl: "http://127.0.0.1:4000/v1", mode: "observe" });
    expect((await load("observe")).config?.mode).toBe("observe");
    const r = await load("enforce");
    expect(r.config).toBeNull();
    expect(r.problem).toMatch(/^jev_unconfigured: .*plain http/);
  });

  it("the hook path reports jev_unconfigured when Cloud sets a mode nothing can answer", async () => {
    deploy({ semantic: [{ id: "org-checks", version: 1, declarations: [decl("acme-a")] }], jevMode: "observe" });
    await registeredAfterOneEvent();
    expect(readErrors().errors).toEqual([{ id: "jevMode", version: null, kind: "daemon", message: "jev_unconfigured" }]);
  });

  it("no Cloud mode: the local file decides, exactly as before", async () => {
    deploy({ semantic: [{ id: "org-checks", version: 1, declarations: [decl("acme-a")] }] });
    const { readCloudJevMode } = await import("@/src/hooks/cloud-managed-policies");
    expect(readCloudJevMode()).toBeNull();
    await registeredAfterOneEvent();
    expect(existsSync(errorsFile())).toBe(false);
  });
});

// ── Surfaces ─────────────────────────────────────────────────────────────────

describe("surfaces", () => {
  const RENDER = { render: { cols: 120, color: false }, readModelList: async () => ({ ok: false as const, reason: "no list read in tests" }) };

  it("jev status: Cloud checks, and the mode set by FailproofAI Cloud", async () => {
    const { readCredentials, writeCredentials, writeJevCloudCredential } = await import("@/src/hooks/fp-config");
    writeCredentials({ ...readCredentials(), ingest: { url: `${ORIGIN}/v1/events`, key: KEY } });
    writeJevCloudCredential({ url: ORIGIN, key: KEY });
    deploy({
      policies: [{ id: "no-prod-db", version: 3, authority: "reviewable", reviewedBy: ["acme-prod-db"] }],
      semantic: [{ id: "no-prod-db", version: 3, declarations: [decl("acme-prod-db")] }],
      jevMode: "enforce",
    });
    const { runJevCommand } = await import("@/src/hooks/jev-cli");
    const human = await runJevCommand(["status"], RENDER);
    const text = human.lines.join("\n");
    expect(text).toMatch(/on · enforce — mode set by FailproofAI Cloud/);
    expect(text).toMatch(/FailproofAI Cloud Jev checks/);
    expect(text).toMatch(/no-prod-db v3\s+acme-prod-db · reviews its own regex policy/);
    expect(text).not.toMatch(/AgentEye/);

    const json = JSON.parse((await runJevCommand(["status", "--json"], RENDER)).json as string);
    expect(json).toMatchObject({
      status: "ok",
      mode: "enforce",
      modeSetBy: "FailproofAI Cloud",
      provider: "failproofai",
      providerSource: "cloud-credential",
      cloud: { jevMode: "enforce", checks: [{ policy: "no-prod-db", version: 3, kind: "both", checks: ["acme-prod-db"] }] },
    });
  });

  it("jev status with Cloud checks and no Cloud mode: the local answer, plus the checks", async () => {
    deploy({ semantic: [{ id: "org-checks", version: 2, declarations: [decl("acme-a")] }] });
    const { runJevCommand } = await import("@/src/hooks/jev-cli");
    const json = JSON.parse((await runJevCommand(["status", "--json"], RENDER)).json as string);
    expect(json.status).toBe("absent");
    expect(json.cloud).toMatchObject({ jevMode: null, checks: [{ policy: "org-checks", version: 2, kind: "jev", checks: ["acme-a"] }] });
  });

  it("policies lists Cloud jev and both policies with a FailproofAI Cloud label", async () => {
    deploy({
      policies: [{ id: "no-prod-db", version: 3, authority: "reviewable", reviewedBy: ["acme-prod-db"] }, { id: "plain", version: 1 }],
      semantic: [
        { id: "no-prod-db", version: 3, declarations: [decl("acme-prod-db")] },
        { id: "secrets", version: 1, declarations: [decl("acme-secrets")] },
      ],
      jevMode: "observe",
    });
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.map(String).join(" ")));
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out.push(...String(chunk).split("\n"));
      return true;
    });
    const { listHooks } = await import("@/src/hooks/manager");
    await listHooks(project);
    const text = out.join("\n").replace(/\x1B\[[0-9;]*m/g, "");
    expect(text).toMatch(/Cloud-managed — deployment 43 · FailproofAI Cloud/);
    expect(text).toMatch(/no-prod-db\s+v3\s+both\s+acme-prod-db/);
    expect(text).toMatch(/plain\s+v1\s+regex/);
    expect(text).toMatch(/secrets\s+v1\s+jev\s+acme-secrets/);
    expect(text).toMatch(/Jev mode: observe — mode set by FailproofAI Cloud/);
  });

  it("config --disconnect's clear takes the Jev policies, the Jev mode and both error reports with active.json", async () => {
    deploy({ semantic: [{ id: "org-checks", version: 1, declarations: [decl("acme-a")] }], jevMode: "enforce" });
    writeFileSync(errorsFile(), JSON.stringify({ errors: [] }));
    writeFileSync(join(cloudRoot, "daemon-errors.json"), JSON.stringify({ errors: [] }));
    const { clearActiveCloudManagedPolicies, readCloudJevPolicies, readCloudJevMode } = await import("@/src/hooks/cloud-managed-policies");
    expect(clearActiveCloudManagedPolicies()).toBe(true);
    for (const name of ["active.json", "errors.json", "daemon-errors.json"]) expect(existsSync(join(cloudRoot, name))).toBe(false);
    expect(readCloudJevPolicies().sets).toEqual([]);
    expect(readCloudJevMode()).toBeNull();
  });
});
