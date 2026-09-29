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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RegisteredPolicy } from "@/src/hooks/policy-types";
import type { CloudSemanticPolicySet } from "@/src/hooks/cloud-managed-policies";

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

/**
 * A working local Jev setup, so Jev can ask the deployed Cloud checks. Without
 * one (and no mode from Cloud) they are never asked, and `errors.json` says so
 * (review m5) — which a test about something else must not trip over.
 */
function localJev(): void {
  const file = join(home, "jev.json");
  writeFileSync(file, JSON.stringify({ provider: "typesafe", apiKey: KEY, mode: "enforce" }), { mode: 0o600 });
  chmodSync(file, 0o600);
}
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
    localJev();
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
        // Its own Jev half declares acme-x (CONTRACT C9.4 binds reviewedBy to it).
        sets: [{ policyId: "both-one", semantic: [{ name: "acme-x" }] } as unknown as CloudSemanticPolicySet],
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
    localJev();
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

  it("no Cloud mode: the local file decides, and a working one reports nothing", async () => {
    writeJev({ provider: "typesafe", apiKey: KEY, mode: "enforce" });
    deploy({ semantic: [{ id: "org-checks", version: 1, declarations: [decl("acme-a")] }] });
    const { readCloudJevMode } = await import("@/src/hooks/cloud-managed-policies");
    expect(readCloudJevMode()).toBeNull();
    await registeredAfterOneEvent();
    expect(existsSync(errorsFile())).toBe(false);
  });

  it("no Cloud mode and no local jev.json: the deployed Cloud checks are reported as never asked (review m5)", async () => {
    deploy({
      policies: [{ id: "no-prod-db", version: 3, authority: "reviewable", reviewedBy: ["acme-a"] }],
      semantic: [{ id: "no-prod-db", version: 3, declarations: [decl("acme-a")] }],
    });
    await registeredAfterOneEvent();
    expect(readErrors().errors).toEqual([
      {
        id: "jevMode",
        version: null,
        kind: "daemon",
        message:
          "jev_unconfigured: FailproofAI Cloud sets no Jev mode for this machine and it has no jev.json, " +
          "so its FailproofAI Cloud Jev checks are never asked",
      },
    ]);
  });

  it("no Cloud mode and a local jev.json switched off: reported too, and fixed by a Cloud mode", async () => {
    writeJev({ provider: "typesafe", apiKey: KEY, mode: "off" });
    deploy({ semantic: [{ id: "org-checks", version: 1, declarations: [decl("acme-a")] }] });
    await registeredAfterOneEvent();
    expect(readErrors().errors).toEqual([
      expect.objectContaining({ id: "jevMode", kind: "daemon", message: expect.stringMatching(/^jev_unconfigured: Jev is off on this machine/) }),
    ]);

    deploy({ semantic: [{ id: "org-checks", version: 1, declarations: [decl("acme-a")] }], jevMode: "observe" });
    vi.resetModules();
    await registeredAfterOneEvent();
    expect(readErrors()).toEqual({ errors: [] });
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

  it("config --disconnect's clear takes the Jev policies, the Jev mode, the snapshot and both error reports with active.json", async () => {
    deploy({ semantic: [{ id: "org-checks", version: 1, declarations: [decl("acme-a")] }], jevMode: "enforce" });
    writeFileSync(errorsFile(), JSON.stringify({ errors: [] }));
    writeFileSync(join(cloudRoot, "daemon-errors.json"), JSON.stringify({ errors: [] }));
    // The daemon's snapshot, which its maintenance lane rebuilds active.json
    // from: left behind, the old org's deployment came back (review M2).
    writeFileSync(join(cloudRoot, "desired-state.json"), JSON.stringify({ schemaVersion: 2, deployment: 43, policies: [] }));
    const { clearActiveCloudManagedPolicies, readCloudJevPolicies, readCloudJevMode } = await import("@/src/hooks/cloud-managed-policies");
    expect(clearActiveCloudManagedPolicies()).toBe(true);
    for (const name of ["desired-state.json", "active.json", "errors.json", "daemon-errors.json"]) {
      expect(existsSync(join(cloudRoot, name))).toBe(false);
    }
    expect(readCloudJevPolicies().sets).toEqual([]);
    expect(readCloudJevMode()).toBeNull();
  });
});

// ── Review fixes (CONTRACT C9) ───────────────────────────────────────────────

describe("C9.4: a both policy's reviewedBy is bound to its OWN Jev half", () => {
  it("a pack's same-named check never stands in when the Cloud half failed: the JS half is hard, and errors.json says so", async () => {
    // An installed third-party pack declares the org's check name, permissively.
    installPacks([{ id: "acme/lenient", semantic: [decl("acme-prod-db", { title: "Anything goes" })] }]);
    deploy({
      policies: [{ id: "no-prod-db", version: 3, hooks: ["block-prod-db"], authority: "reviewable", reviewedBy: ["acme-prod-db"] }],
      semantic: [{ id: "no-prod-db", version: 3, declarations: [decl("acme-prod-db")], wrongSha: true }],
    });
    const registered = await registeredAfterOneEvent();
    expect(registered.get("cloud/no-prod-db@3/block-prod-db")?.authority).toBe("hard");
    // The pack's check is still a reviewer on this machine — for the pack's own policies.
    const { effectiveReviewerNames } = await import("@/src/hooks/effective-reviewers");
    expect(effectiveReviewerNames().has("acme-prod-db")).toBe(true);
    const messages = readErrors().errors.filter((e) => e.id === "no-prod-db").map((e) => e.message);
    expect(messages).toContain(
      "reviewedBy names acme-prod-db, which this policy's own Jev half does not provide on this machine " +
        "(an installed pack's check of that name never stands in), so the policy stays hard",
    );
    expect(messages.some((m) => /integrity verification/.test(String(m)))).toBe(true);
  });

  it("a declaration the parser dropped is not replaced by a pack's either", async () => {
    installPacks([{ id: "acme/lenient", semantic: [decl("acme-prod-db")] }]);
    deploy({
      policies: [{ id: "no-prod-db", version: 3, hooks: ["block-prod-db"], authority: "reviewable", reviewedBy: ["acme-prod-db"] }],
      semantic: [{ id: "no-prod-db", version: 3, declarations: [decl("acme-other"), { ...decl("acme-prod-db"), mode: "maybe" }] }],
    });
    const registered = await registeredAfterOneEvent();
    expect(registered.get("cloud/no-prod-db@3/block-prod-db")?.authority).toBe("hard");
  });

  it("another Cloud policy's check does not review it either", async () => {
    deploy({
      policies: [{ id: "no-prod-db", version: 3, hooks: ["block-prod-db"], authority: "reviewable", reviewedBy: ["acme-prod-db"] }],
      semantic: [
        { id: "no-prod-db", version: 3, declarations: [decl("acme-own")] },
        { id: "someone-else", version: 1, declarations: [decl("acme-prod-db")] },
      ],
    });
    const registered = await registeredAfterOneEvent();
    expect(registered.get("cloud/no-prod-db@3/block-prod-db")?.authority).toBe("hard");
  });

  it("bindReviewedBy is pure: reviewable only on the allowed names", async () => {
    const { bindReviewedBy } = await import("@/src/hooks/policy-authority");
    const decl2 = { authority: "reviewable", reviewedBy: ["a", "b"] };
    expect(bindReviewedBy(decl2, new Set(["a", "b"]))).toEqual({ declaration: decl2, unowned: [] });
    expect(bindReviewedBy(decl2, new Set(["a"]))).toEqual({ declaration: { authority: "hard" }, unowned: ["b"] });
    expect(bindReviewedBy({ authority: "hard" }, new Set())).toEqual({ declaration: { authority: "hard" }, unowned: [] });
  });
});

describe("C9.3: an observe both policy arrives with its Jev half withheld", () => {
  it("registers without complaint, reports nothing, and is listed as both", async () => {
    deploy({
      policies: [{ id: "trial", version: 2, hooks: ["trial-hook"], effect: "observe", authority: "reviewable", reviewedBy: ["acme-trial"] }],
    });
    const registered = await registeredAfterOneEvent();
    // Hard, which an observed policy never acts on anyway.
    expect(registered.get("cloud/trial@2/trial-hook")?.authority).toBe("hard");
    expect(existsSync(errorsFile())).toBe(false);

    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.map(String).join(" ")));
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out.push(...String(chunk).split("\n"));
      return true;
    });
    const { listHooks } = await import("@/src/hooks/manager");
    await listHooks(project);
    const text = out.join("\n").replace(/\x1B\[[0-9;]*m/g, "");
    expect(text).toMatch(/trial\s+v2\s+both\s+\(not asked while observed\)/);
  });

  it("an ENFORCE both with its Jev half missing is still reported", async () => {
    deploy({ policies: [{ id: "real", version: 1, authority: "reviewable", reviewedBy: ["acme-real"] }] });
    await registeredAfterOneEvent();
    expect(readErrors().errors.map((e) => e.id)).toEqual(["real"]);
  });
});

describe("C9.2: one question budget, Cloud first, every drop reported", () => {
  const renamed = (prefix: string) => VALID.map((d) => ({ ...d, name: `${prefix}-${d.name as string}` }));

  it("keeps every Cloud check and drops installed-pack checks first, each reported as pack:<id>", async () => {
    installPacks([{ id: "acme/big", semantic: renamed("p") }]);
    deploy({ semantic: [{ id: "org-a", version: 4, declarations: renamed("c") }], jevMode: "observe" });
    const { readCloudJevPolicies } = await import("@/src/hooks/cloud-managed-policies");
    const { withCloudSemantic } = await import("@/src/hooks/effective-reviewers");
    const { semanticPoliciesFromPacks, MAX_PACK_QUESTION_CHARS, questionChars } = await import("@/src/hooks/semantic/pack-policies");
    const { readInstalledPacks } = await import("@/src/hooks/pack-manifest");
    const packs = readInstalledPacks().packs;
    const cloud = readCloudJevPolicies().sets;
    const resolved = semanticPoliciesFromPacks(withCloudSemantic(packs, cloud).sources);
    const names = resolved.policies.map((p) => p.name);
    for (const d of renamed("c")) expect(names).toContain(d.name);
    expect(resolved.budgetDropped.length).toBeGreaterThan(0);
    expect(resolved.budgetDropped.every((d) => d.source.id === "acme/big")).toBe(true);

    // `over` is exactly how far past the budget asking it as well would have been.
    const spentBefore = (name: string) => {
      let spent = 0;
      for (const p of [...cloud.flatMap((c) => c.semantic), ...packs.flatMap((p2) => p2.semantic ?? [])]) {
        if (p.name === name) break;
        if (names.includes(p.name)) spent += questionChars(p);
      }
      return spent;
    };
    const first = resolved.budgetDropped[0];
    const entry = packs[0].semantic!.find((e) => e.name === first.name)!;
    expect(first.over).toBe(spentBefore(first.name) + questionChars(entry) - MAX_PACK_QUESTION_CHARS);

    await registeredAfterOneEvent();
    const reported = readErrors().errors.filter((e) => String(e.message).startsWith("jev_budget"));
    expect(reported).toHaveLength(resolved.budgetDropped.length);
    for (const e of reported) {
      expect(e).toMatchObject({ id: "pack:acme/big", version: null, kind: "daemon" });
      expect(e.message).toMatch(/^jev_budget: dropped p-acme-[a-z-]+ \(\d+ chars over\)$/);
    }
    expect(reported[0].message).toBe(`jev_budget: dropped ${first.name} (${first.over} chars over)`);
  });

  it("a Cloud set that alone overruns the budget has its own drops reported as kind jev, under its id and version", async () => {
    deploy({
      semantic: [
        { id: "org-a", version: 1, declarations: renamed("a") },
        { id: "org-b", version: 2, declarations: renamed("b") },
      ],
      jevMode: "enforce",
    });
    await registeredAfterOneEvent();
    const reported = readErrors().errors.filter((e) => String(e.message).startsWith("jev_budget"));
    expect(reported.length).toBeGreaterThan(0);
    for (const e of reported) {
      expect(e).toMatchObject({ id: "org-b", version: 2, kind: "jev" });
    }
  });

  it("nothing is measured, or reported, when Cloud switches Jev off", async () => {
    installPacks([{ id: "acme/big", semantic: renamed("p") }]);
    deploy({ semantic: [{ id: "org-a", version: 4, declarations: renamed("c") }], jevMode: "off" });
    await registeredAfterOneEvent();
    expect(existsSync(errorsFile())).toBe(false);
  });
});

describe("C9.2: the CLI's own question count, pinned to the shared fixture", () => {
  const CHARS = JSON.parse(
    readFileSync(resolve(__dirname, "../fixtures/cloud-jev/semantic-valid-chars.json"), "utf8"),
  ) as {
    budget: number;
    jevPoliciesQuestionChars: number;
    total: number;
    declarations: Array<{ name: string; chars: number }>;
    edge: Array<{ decl: Record<string, unknown>; chars: number }>;
  };

  it("measures every valid declaration exactly as the fixture Cloud mirrors", async () => {
    const { parsePackSemantic } = await import("@/src/hooks/pack-manifest");
    const { questionChars, MAX_PACK_QUESTION_CHARS, JEV_POLICIES_QUESTION_CHARS } = await import("@/src/hooks/semantic/pack-policies");
    expect(MAX_PACK_QUESTION_CHARS).toBe(CHARS.budget);
    expect(JEV_POLICIES_QUESTION_CHARS).toBe(CHARS.jevPoliciesQuestionChars);
    const parsed = parsePackSemantic("cloud:acme@1", VALID, []);
    expect(parsed.map((e) => ({ name: e.name, chars: questionChars(e) }))).toEqual(CHARS.declarations);
    expect(parsed.reduce((n, e) => n + questionChars(e), 0)).toBe(CHARS.total);
  });

  it("and every edge case (escapes, unicode, no criteria, exempt)", async () => {
    const { parsePackSemantic } = await import("@/src/hooks/pack-manifest");
    const { questionChars } = await import("@/src/hooks/semantic/pack-policies");
    for (const { decl: d, chars } of CHARS.edge) {
      const warnings: string[] = [];
      const [entry] = parsePackSemantic("cloud:acme@1", [d], warnings);
      expect(warnings).toEqual([]);
      expect({ name: entry.name, chars: questionChars(entry) }).toEqual({ name: d.name, chars });
    }
  });
});

describe("C9.5: reports carry no local paths", () => {
  it("redactLocalPaths: home becomes ~, other absolute paths their last segment (the daemon's cases)", async () => {
    const { redactLocalPaths } = await import("@/src/hooks/cloud-policy-errors");
    const home = "/home/alice";
    const cases: Array<[string, string]> = [
      [
        "path missing: /home/alice/.failproofai/policies/cloud-policies/artifacts/ab.mjs",
        "path missing: ~/.failproofai/policies/cloud-policies/artifacts/ab.mjs",
      ],
      ["Cannot find module '/tmp/fp-load-1/x.mjs' imported from /opt/app/y.mjs", "Cannot find module 'x.mjs' imported from y.mjs"],
      ["jev.json is too open (chmod 600 /home/alice/.failproofai/jev.json)", "jev.json is too open (chmod 600 ~/.failproofai/jev.json)"],
      ["/home/alice2/notes.txt is not home", "notes.txt is not home"],
      ["home is /home/alice", "home is ~"],
      ["dir=/var/lib/fp/, done", "dir=fp, done"],
      [
        "GET https://cloud.example/enforcement/v1/artifacts/ab failed; a/b stays",
        "GET https://cloud.example/enforcement/v1/artifacts/ab failed; a/b stays",
      ],
      ["the root / itself", "the root / itself"],
    ];
    for (const [input, expected] of cases) expect(redactLocalPaths(input, home)).toBe(expected);
    expect(redactLocalPaths("/home/alice/x", null)).toBe("x");
  });

  it("the hook path's report names no local path", async () => {
    // A JS artifact that is gone: the whole JS half fails with the loader's own ENOENT text.
    deploy({ policies: [{ id: "guard", version: 1 }] });
    const active = JSON.parse(readFileSync(join(cloudRoot, "active.json"), "utf8")) as { policies: Array<{ path: string }> };
    rmSync(join(cloudRoot, active.policies[0].path));
    await registeredAfterOneEvent();
    const text = readFileSync(errorsFile(), "utf8");
    expect(text).toMatch(/Cloud policies could not be loaded/);
    expect(text).not.toContain(cloudRoot);
    expect(text).not.toMatch(/"\/|[ '(]\/(tmp|home|var|private)\//);
    expect(text).toContain(active.policies[0].path.split("/").pop()!);
  });
});

describe("m3: read once per change", () => {
  it("readCloudJevPolicies answers from its cache until active.json or an artifact changes", async () => {
    deploy({ semantic: [{ id: "org-checks", version: 1, declarations: [decl("acme-a")] }], jevMode: "observe" });
    const mod = await import("@/src/hooks/cloud-managed-policies");
    const first = mod.readCloudJevPolicies();
    expect(mod.readCloudJevPolicies()).toBe(first);
    expect(mod.readCloudJevMode()).toBe("observe");

    // A new deployment arrives the daemon's way: tmp + rename, a new inode.
    const next = JSON.parse(readFileSync(join(cloudRoot, "active.json"), "utf8")) as Record<string, unknown>;
    next.jevMode = "enforce";
    writeFileSync(join(cloudRoot, "active.json.tmp"), JSON.stringify(next));
    renameSync(join(cloudRoot, "active.json.tmp"), join(cloudRoot, "active.json"));
    const second = mod.readCloudJevPolicies();
    expect(second).not.toBe(first);
    expect(second.jevMode).toBe("enforce");
    expect(mod.readCloudJevMode()).toBe("enforce");

    // An artifact tampered with in place: re-read, and refused.
    const entry = (next.semanticPolicies as Array<{ path: string }>)[0];
    writeFileSync(join(cloudRoot, entry.path), JSON.stringify([decl("acme-a"), decl("acme-evil")]));
    const third = mod.readCloudJevPolicies();
    expect(third.sets).toEqual([]);
    expect(third.errors[0].message).toMatch(/integrity verification/);
  });

  it("loadJevConfigForCloudMode answers from its memo until jev.json or the credential changes", async () => {
    const file = join(home, "jev.json");
    writeFileSync(file, JSON.stringify({ provider: "typesafe", apiKey: KEY, mode: "enforce" }), { mode: 0o600 });
    chmodSync(file, 0o600);
    const { loadJevConfigForCloudMode } = await import("@/src/hooks/semantic/jev-config");
    const first = loadJevConfigForCloudMode("observe");
    expect(first.config?.mode).toBe("observe");
    expect(loadJevConfigForCloudMode("observe")).toBe(first);
    expect(loadJevConfigForCloudMode("enforce")).not.toBe(first);
    if (posix) {
      chmodSync(file, 0o644);
      const refused = loadJevConfigForCloudMode("observe");
      expect(refused.config).toBeNull();
      expect(refused.problem).toMatch(/^jev_unconfigured: jev\.json is refused/);
    }
  });
});

describe("policies lists every Cloud Jev half, loaded or not (review n3)", () => {
  it("a jev policy whose artifact failed, and a both policy whose JS half could not be read", async () => {
    deploy({
      policies: [{ id: "both-one", version: 5 }],
      semantic: [
        { id: "broken-jev", version: 2, declarations: [decl("acme-x")], wrongSha: true },
        { id: "both-one", version: 5, declarations: [decl("acme-y")] },
      ],
    });
    const active = JSON.parse(readFileSync(join(cloudRoot, "active.json"), "utf8")) as { policies: Array<{ path: string }> };
    rmSync(join(cloudRoot, active.policies[0].path));
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.map(String).join(" ")));
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out.push(...String(chunk).split("\n"));
      return true;
    });
    const { listHooks } = await import("@/src/hooks/manager");
    await listHooks(project);
    const text = out.join("\n").replace(/\x1B\[[0-9;]*m/g, "");
    expect(text).toMatch(/broken-jev\s+v2\s+jev\s+\(not loaded\)/);
    expect(text).toMatch(/both-one\s+v5\s+both\s+acme-y/);
    expect(text).toMatch(/Cloud JavaScript policies could not be read/);
  });
});
