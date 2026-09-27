// @vitest-environment node
/**
 * Jev's checks come ONLY from installed packs.
 *
 * This build compiles in no Jev check that it asks: FailproofAI's sixteen ship
 * in the `FailproofAI/jev-policies` pack, and the definitions in
 * `semantic/policies.ts` are data for that pack and the reserved-name list.
 * So a machine with Jev configured and no such pack is IDLE — it asks nothing
 * (the handler side is pinned in `two-tier-handler.test.ts` and the golden in
 * `two-tier-unconfigured-equivalence.test.ts`) — and every surface a person
 * configures Jev from says, in one line, which command fixes that:
 * `config` connect, `jev setup` and `jev status`, human and `--json`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runJevCommand, type JevCliDeps, type JevCliResult } from "../../src/hooks/jev-cli";
import { connectToCloud, describeOutcome } from "../../src/hooks/cloud-connection";
import {
  JEV_CHECKS_PACK_COMMAND,
  NO_JEV_CHECKS_HINT,
  isReservedClaim,
  reviewerNamesFor,
} from "../../src/hooks/effective-reviewers";
import { parsePackSemanticPolicy, type SemanticManifestEntry } from "../../src/hooks/pack-manifest";
import { SEMANTIC_REVIEWER_NAMES } from "../../src/hooks/policy-authority";
import { SEMANTIC_POLICIES } from "../../src/hooks/semantic/policies";
import { NO_POLICIES, semanticPoliciesFromPacks } from "../../src/hooks/semantic/pack-policies";
import type { IntrospectResult } from "../../src/hooks/cloud-introspect";
import {
  JEV_POLICIES_ID,
  JEV_POLICIES_SEMANTIC,
  JEV_POLICIES_SOURCE,
  installJevPoliciesPack,
} from "../fixtures/jev-policies-pack";

const KEY = ["cli", "packonly", "0123456789abcdef"].join("-");
const noModelList = async () => ({ ok: false as const, reason: "no list read in tests" });
const RENDER = { render: { cols: 200, color: false }, readModelList: noModelList } satisfies JevCliDeps;
const withKey = (key: string): JevCliDeps => ({ ...RENDER, stdinIsTTY: false, readStdin: async () => `${key}\n` });
const text = (r: JevCliResult) => `${r.lines.join("\n")}\n${r.json ?? ""}`.replace(/\s+/g, " ");

const ENV_KEYS = ["FAILPROOFAI_HOME", "FAILPROOFAI_PACK_DIR", "FAILPROOFAI_CLOUD_POLICY_DIR", "FAILPROOFAI_CLOUD_CREDENTIALS", "FAILPROOFAI_EVALUATOR", "FAILPROOFAI_JEV_API_KEY"] as const;

let root: string;
let packRoot: string;
let saved: Record<string, string | undefined>;
let cwd: string;
let realFetch: typeof fetch;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fpai-jev-packonly-"));
  packRoot = join(root, "packs");
  mkdirSync(packRoot, { recursive: true });
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.FAILPROOFAI_HOME = join(root, "home", ".failproofai");
  process.env.FAILPROOFAI_PACK_DIR = packRoot;
  process.env.FAILPROOFAI_CLOUD_POLICY_DIR = join(root, "cloud");
  mkdirSync(process.env.FAILPROOFAI_HOME, { recursive: true, mode: 0o700 });
  chmodSync(process.env.FAILPROOFAI_HOME, 0o700);
  cwd = process.cwd();
  // A cwd with no `.failproofai/` above it, so nothing of this repo is surveyed.
  mkdirSync(join(root, "project"), { recursive: true });
  process.chdir(join(root, "project"));
  realFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  process.chdir(cwd);
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(root, { recursive: true, force: true });
});

describe("the jev-policies pack fixture", () => {
  it("is exactly what the loader's parser makes of FailproofAI's sixteen", () => {
    // Every other test that installs the fixture relies on this: what it
    // installs is what a machine reading the published manifest holds.
    JEV_POLICIES_SEMANTIC.forEach((entry, i) => {
      expect(parsePackSemanticPolicy(JEV_POLICIES_ID, entry, i)).toEqual(entry);
    });
    expect(JEV_POLICIES_SEMANTIC.map((e) => e.name)).toEqual(SEMANTIC_POLICIES.map((p) => p.name));
  });
});

describe("the reserved names stay FailproofAI's", () => {
  const claim = (name: string): SemanticManifestEntry => ({ ...JEV_POLICIES_SEMANTIC.find((e) => e.name === "destructive-deletion")!, name, guidance: "Nothing to see here." });

  it("refuses a third party's claim to credential-exfiltration, alone and beside jev-policies", () => {
    const stranger = { id: "acme/lenient", source: "github:acme/lenient@v1", semantic: [claim("credential-exfiltration")] };
    expect(isReservedClaim(stranger, "credential-exfiltration")).toBe(true);

    // Alone: the stranger's version is never asked and is no reviewer.
    const alone = semanticPoliciesFromPacks([stranger]);
    expect(alone.policies).toBe(NO_POLICIES);
    expect(alone.errors.join(" ")).toMatch(/credential-exfiltration, a name reserved for FailproofAI's own Jev checks/);
    expect(reviewerNamesFor([stranger]).has("credential-exfiltration")).toBe(false);

    // Beside the real pack: FailproofAI's question is the one asked, uncontested.
    const jev = { id: JEV_POLICIES_ID, source: JEV_POLICIES_SOURCE, semantic: JEV_POLICIES_SEMANTIC };
    const both = semanticPoliciesFromPacks([stranger, jev]);
    const asked = both.policies.filter((p) => p.name === "credential-exfiltration");
    expect(asked).toHaveLength(1);
    expect(asked[0].guidance).not.toBe("Nothing to see here.");
    expect(asked[0].origin?.packId).toBe(JEV_POLICIES_ID);
    expect(reviewerNamesFor([stranger, jev]).has("credential-exfiltration")).toBe(true);
  });

  it("is every one of the sixteen names", () => {
    for (const p of SEMANTIC_POLICIES) {
      expect(SEMANTIC_REVIEWER_NAMES.has(p.name)).toBe(true);
      expect(isReservedClaim({ source: "github:acme/x@v1" }, p.name)).toBe(true);
      expect(isReservedClaim({ source: JEV_POLICIES_SOURCE }, p.name)).toBe(false);
    }
  });
});

describe("jev setup names the pack when nothing supplies a check", () => {
  it("BYOK: saved, and one line with the command", async () => {
    const r = await runJevCommand(["setup", "--provider", "typesafe", "--key-stdin"], withKey(KEY));
    expect(r.exitCode).toBe(0);
    const out = text(r);
    expect(out).toContain(NO_JEV_CHECKS_HINT);
    expect(out.split(JEV_CHECKS_PACK_COMMAND)).toHaveLength(2);
    expect(out).not.toContain(KEY);
  });

  it("says nothing of it once jev-policies is installed", async () => {
    installJevPoliciesPack(packRoot);
    const out = text(await runJevCommand(["setup", "--provider", "typesafe", "--key-stdin"], withKey(KEY)));
    expect(out).not.toContain(JEV_CHECKS_PACK_COMMAND);
  });

  it("says nothing of it when Jev is saved switched off", async () => {
    const out = text(await runJevCommand(["setup", "--provider", "typesafe", "--mode", "off", "--key-stdin"], withKey(KEY)));
    expect(out).not.toContain(JEV_CHECKS_PACK_COMMAND);
  });
});

describe("jev status says Jev is idle, and how to fix it", () => {
  it("in text: the title says idle, and one line names the command", async () => {
    await runJevCommand(["setup", "--provider", "typesafe", "--key-stdin"], withKey(KEY));
    const r = await runJevCommand(["status"], RENDER);
    expect(r.exitCode).toBe(0);
    const out = text(r);
    expect(out).toMatch(/on · (shadow|enforce) · idle \(no Jev checks installed\)/);
    expect(out).toContain(NO_JEV_CHECKS_HINT);
    expect(out.split(JEV_CHECKS_PACK_COMMAND)).toHaveLength(2);
  });

  it("in --json: a machine-readable jevChecks field", async () => {
    await runJevCommand(["setup", "--provider", "typesafe", "--key-stdin"], withKey(KEY));
    const j = JSON.parse((await runJevCommand(["status", "--json"], RENDER)).json as string);
    expect(j.status).toBe("ok");
    expect(j.jevChecks).toEqual({ installed: 0, names: [], idle: true, fix: JEV_CHECKS_PACK_COMMAND });
    expect(j.reviewablePolicies.problem).toBe(NO_JEV_CHECKS_HINT);
  });

  it("and not idle once jev-policies is installed", async () => {
    installJevPoliciesPack(packRoot);
    await runJevCommand(["setup", "--provider", "typesafe", "--key-stdin"], withKey(KEY));
    const out = text(await runJevCommand(["status"], RENDER));
    expect(out).not.toContain("idle");
    expect(out).not.toContain(JEV_CHECKS_PACK_COMMAND);
    const j = JSON.parse((await runJevCommand(["status", "--json"], RENDER)).json as string);
    expect(j.jevChecks).toMatchObject({ installed: 16, idle: false, fix: null });
    expect(j.jevChecks.names).toEqual(SEMANTIC_POLICIES.map((p) => p.name));
  });
});

describe("jev test keeps working with no pack", () => {
  it("asks its own probe question, which no pack supplies", async () => {
    await runJevCommand(["setup", "--provider", "typesafe", "--key-stdin"], withKey(KEY));
    const calls: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ model: "jev-1.13.0", answers: { jev_test: { type: "noul", noul: 0.97 } } }), { status: 200 });
    }) as typeof fetch;
    const r = await runJevCommand(["test", "--json"], RENDER);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.json as string)).toMatchObject({ ok: true, answer: 0.97 });
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0].questions as object)).toEqual(["jev_test"]);
  });
});

describe("config connect names the pack when it turns Jev on idle", () => {
  const URL_ = "https://app.befailproof.ai";
  const TOKEN = ["fp", "machine", "0123456789abcdef"].join("_");
  const introspect = async (): Promise<IntrospectResult> => ({
    kind: "ok",
    identity: { orgId: "org_1", orgSlug: "acme", orgName: "Acme", permissions: ["events:add", "policies:pull", "jev:evaluate"] },
  });
  const connect = () =>
    connectToCloud({
      url: URL_,
      token: TOKEN,
      machineId: "machine-1",
      sessions: true,
      introspect,
      verifyPolicy: async () => ({ ok: true as const, policyCount: 1, deployment: 2 }),
      verifyIngest: async () => ({ ok: true as const }),
    });

  it("says so in one line, with no install and no prompt", async () => {
    const outcome = await connect();
    expect(outcome.jev).toMatchObject({ ok: true, noChecks: true });
    const lines = describeOutcome(outcome, "machine-1", URL_);
    const hint = lines.filter((l) => l.includes(JEV_CHECKS_PACK_COMMAND));
    expect(hint).toHaveLength(1);
    expect(hint[0].trim()).toBe(NO_JEV_CHECKS_HINT);
    // Named, never run: nothing was installed.
    expect(semanticPoliciesFromPacks([]).policies).toBe(NO_POLICIES);
  });

  it("says nothing of it once jev-policies is installed", async () => {
    installJevPoliciesPack(packRoot);
    const outcome = await connect();
    expect(outcome.jev?.noChecks).toBeUndefined();
    expect(describeOutcome(outcome, "machine-1", URL_).join("\n")).not.toContain(JEV_CHECKS_PACK_COMMAND);
  });
});
