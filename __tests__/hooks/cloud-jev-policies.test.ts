// @vitest-environment node
/**
 * FailproofAI Cloud Jev on the machine, as CONTRACT C10 has it: Jev policies,
 * and the Jev half of `both` policies, live ONLY on FailproofAI Cloud. The
 * machine holds the Cloud Jev MODE (`active.json` `jevMode`) and a `both`
 * policy's JS half with `authority`/`reviewedBy`, and nothing else Jev-related.
 * What is pinned here:
 *
 *   - who calls Cloud (C10.2): `jevMode` × Cloud Jev credential × decisions-only
 *     connection × a local BYOK `jev.json`;
 *   - the request (C10.3): today's, the global intent questions ALWAYS, and a
 *     `cloud` block whose `targetScan` is `scanTargets` with sorted arrays;
 *   - the reply (C10.5): Cloud's verdict validated, local pack checks decided
 *     from the answers minus `droppedLocal`, the two merged (cloud first, most
 *     severe wins), and a `both` policy cleared ONLY by its own Cloud outcomes;
 *   - a Cloud failure is today's fallback, and writes nothing;
 *   - `errors.json` (`transcripts_disabled`, `jev_unconfigured`, budget drops),
 *     `jev status`, `policies` and `config --disconnect`;
 *   - the shared contract fixtures still pass the CLI's own parser and question
 *     count, which Cloud's publish validation mirrors.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RegisteredPolicy } from "@/src/hooks/policy-types";
import type { PolicyOutcome, SemanticInput, SemanticVerdict } from "@/src/hooks/semantic/types";

const VALID = JSON.parse(
  readFileSync(resolve(__dirname, "../fixtures/cloud-jev/semantic-valid.json"), "utf8"),
) as Array<Record<string, unknown>>;
const INVALID = JSON.parse(
  readFileSync(resolve(__dirname, "../fixtures/cloud-jev/semantic-invalid.json"), "utf8"),
) as Array<{ why: string; decl: Record<string, unknown> }>;
const TARGET_SCANS = JSON.parse(
  readFileSync(resolve(__dirname, "../fixtures/cloud-jev/target-scan-cases.json"), "utf8"),
) as { cases: Array<{ id: string; toolName: string; toolInput: Record<string, unknown>; targetScan: { groups: string[][]; complete: boolean } }> };

const ENV_KEYS = [
  "FAILPROOFAI_HOME",
  "FAILPROOFAI_PACK_DIR",
  "FAILPROOFAI_CLOUD_POLICY_DIR",
  "FAILPROOFAI_JEV_API_KEY",
  "FAILPROOFAI_CLOUD_CREDENTIALS",
  "FAILPROOFAI_JEV_CONFIG_DIR",
  "FAILPROOFAI_EVALUATOR",
  "FAILPROOFAI_JEV_TIMEOUT_MS",
  "FAILPROOFAI_JEV_MODEL",
] as const;

// Built at runtime: this repo's own hooks refuse secret-shaped literals.
const KEY = ["tk", "cloudjev", "0123456789abcdef"].join("-");
const ORIGIN = "https://app.befailproof.ai";
const CLOUD_ENDPOINT = `${ORIGIN}/enforcement/v1/jev/systemone`;
const MACHINE = "machine-7";
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
  vi.unstubAllGlobals();
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

/** A JS policy artifact registering the named hooks; `deny` makes every one of them deny. */
const jsArtifact = (tag: string, names: string[], verdict: "allow" | "deny") => `
  // ${tag}
  import { customPolicies, allow, deny } from "failproofai";
  ${names
    .map(
      (n) =>
        `customPolicies.add({ name: ${JSON.stringify(n)}, description: "d", match: { events: ["PreToolUse"] }, fn: async () => ${
          verdict === "deny" ? `deny(${JSON.stringify(`${n} says no`)})` : "allow()"
        } });`,
    )
    .join("\n  ")}
`;

interface CloudJs {
  id: string;
  version: number;
  hooks?: string[];
  authority?: "hard" | "reviewable";
  reviewedBy?: string[];
  effect?: "enforce" | "observe";
  verdict?: "allow" | "deny";
}

/** Write a deployment exactly as the daemon materialises it: JS artifacts, the Jev mode, nothing else Jev. */
function deploy(opts: { policies?: CloudJs[]; jevMode?: string; deployment?: number; extra?: Record<string, unknown> }): void {
  mkdirSync(join(cloudRoot, "artifacts"), { recursive: true });
  const policies = (opts.policies ?? []).map((p) => {
    const bytes = jsArtifact(`${p.id}@${p.version}`, p.hooks ?? [`${p.id}-hook`], p.verdict ?? "allow");
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
  // Written by rename, as the daemon does: a new deployment is a new inode.
  const tmp = join(cloudRoot, `active.json.tmp-${Math.random()}`);
  writeFileSync(
    tmp,
    JSON.stringify({
      schemaVersion: 2,
      deployment: opts.deployment ?? 43,
      policies,
      ...(opts.jevMode !== undefined ? { jevMode: opts.jevMode } : {}),
      ...(opts.extra ?? {}),
    }),
    { mode: 0o600 },
  );
  renameSync(tmp, join(cloudRoot, "active.json"));
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

/**
 * This machine connected to FailproofAI Cloud the way `config --token` leaves
 * it: a policy connection (with its machine id), the Jev credential on the
 * same origin, and `collector.sessions` true unless connected for decisions
 * only (`--no-transcripts`).
 */
async function connect(opts: { jev?: boolean; sessions?: boolean } = {}): Promise<void> {
  const { writeCredentials, writeJevCloudCredential } = await import("@/src/hooks/fp-config");
  writeCredentials({ cloud: { url: ORIGIN, machineId: MACHINE, token: KEY } });
  if (opts.jev !== false) writeJevCloudCredential({ url: ORIGIN, key: KEY });
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({ mode: { kind: "cloud" }, collector: { sessions: opts.sessions !== false, hooks: true } }),
    { mode: 0o600 },
  );
}

/** A local BYOK `jev.json` (TypeSafe direct). */
function localJev(mode: "observe" | "enforce" | "off" = "enforce"): void {
  const file = join(home, "jev.json");
  writeFileSync(file, JSON.stringify({ provider: "typesafe", apiKey: KEY, mode }), { mode: 0o600 });
  chmodSync(file, 0o600);
}

// ── A stand-in for FailproofAI Cloud (and any BYOK provider) on `fetch` ─────

interface SeenCall {
  url: string;
  body: { model: string; state: Record<string, unknown>; questions: Record<string, unknown>; cloud?: Record<string, unknown> };
}

/** Cloud's reply for one request: every question answered `base`, and the given `cloud` block. */
type Reply = (call: SeenCall) => { status?: number; body: unknown };

function stubFetch(reply: Reply): SeenCall[] {
  const seen: SeenCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: { body?: unknown }) => {
      const call: SeenCall = { url: String(url), body: JSON.parse(String(init?.body ?? "{}")) as SeenCall["body"] };
      seen.push(call);
      const { status = 200, body } = reply(call);
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }),
  );
  return seen;
}

const answerAll = (call: SeenCall, base = 0.05, overrides: Record<string, number> = {}) =>
  Object.fromEntries(Object.keys(call.body.questions).map((id) => [id, { noul: overrides[id] ?? base }]));

const allowVerdict = {
  decision: "allow",
  reason: null,
  outcomes: [],
  injectionSuspected: null,
  scopeWithinRequest: null,
  beyondTask: false,
};

/** One Cloud outcome, as the server sends it. */
function cloudOutcome(policy: string, cloudPolicyId: string, verdict: PolicyOutcome["verdict"], over: Record<string, unknown> = {}) {
  return {
    policy,
    mode: "deny",
    userCanOverride: true,
    evidence: verdict === "none" ? 0.05 : 0.95,
    exempt: null,
    userAsked: null,
    targetNamedByUser: false,
    escalatedByInjection: false,
    verdict,
    origin: { cloudPolicyId, cloudVersion: 3 },
    ...over,
  };
}

/** A Cloud reply block whose verdict follows from the given outcomes, as the server's decide would. */
function cloudBlock(outcomes: Array<ReturnType<typeof cloudOutcome>>, extra: Record<string, unknown> = {}) {
  const deny = outcomes.find((o) => o.verdict === "deny");
  const instructs = outcomes.filter((o) => o.verdict === "instruct");
  return {
    verdict: {
      decision: deny ? "deny" : instructs.length > 0 ? "instruct" : "allow",
      reason: deny
        ? `Checked ${deny.policy} (semantic/${deny.policy}, p=0.95). Ask the user first.`
        : instructs.length > 0
          ? instructs.map((o) => `Checked ${o.policy} (semantic/${o.policy}, p=0.95). Ask the user first.`).join("\n")
          : null,
      outcomes,
      injectionSuspected: 0.05,
      scopeWithinRequest: null,
      beyondTask: false,
    },
    asked: outcomes.map((o) => o.policy),
    droppedLocal: [],
    droppedCloud: [],
    ...extra,
  };
}

async function hook(command = "ls", sessionId = "cloud-jev-policies") {
  const { evaluateHookEvent } = await import("@/src/hooks/handler");
  return evaluateHookEvent(
    "PreToolUse",
    "claude",
    JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, session_id: sessionId, cwd: project }),
  );
}

async function registeredAfterOneEvent(): Promise<Map<string, RegisteredPolicy>> {
  await hook();
  const { getAllPolicies } = await import("@/src/hooks/policy-registry");
  return new Map(getAllPolicies().map((p) => [p.name, p]));
}

const errorsFile = () => join(cloudRoot, "errors.json");
const budgetFile = () => join(cloudRoot, "jev-budget.json");
const readErrors = () => JSON.parse(readFileSync(errorsFile(), "utf8")) as { errors: Array<Record<string, unknown>> };

// ── C10.2: who calls FailproofAI Cloud ───────────────────────────────────────

describe("C10.2 gating: jevMode × Cloud Jev credential × decisions-only × BYOK", () => {
  const cloudReplies: Reply = (call) => ({
    body: { model: "jev-1.13.0", answers: answerAll(call), cloud: { ...cloudBlock([]), verdict: allowVerdict } },
  });

  it.each([
    // [jevMode, credential, sessions, local jev.json, pack installed] → [Cloud calls, BYOK calls, report]
    ["enforce", true, true, false, false, 1, 0, null],
    ["observe", true, true, false, false, 1, 0, null],
    ["enforce", true, true, true, true, 1, 0, null],
    ["enforce", true, false, false, false, 0, 0, "transcripts_disabled"],
    ["enforce", true, false, true, true, 0, 0, "transcripts_disabled"],
    ["enforce", false, true, false, false, 0, 0, "jev_unconfigured"],
    ["observe", false, true, true, true, 0, 0, "jev_unconfigured"],
    ["off", true, true, true, true, 0, 0, null],
    [null, true, true, false, true, 0, 0, null],
    [null, true, true, true, true, 0, 1, null],
    [null, false, true, true, false, 0, 0, null],
  ] as const)(
    "mode %s, credential %s, transcripts %s, jev.json %s, pack %s → %i Cloud / %i BYOK calls, report %s",
    async (mode, credential, sessions, byok, pack, cloudCalls, byokCalls, report) => {
      await connect({ jev: credential, sessions });
      if (byok) localJev();
      if (pack) installPacks([{ id: "acme/pack", semantic: [decl("acme-local")] }]);
      deploy({ ...(mode !== null ? { jevMode: mode } : {}) });
      const seen = stubFetch((call) =>
        call.url === CLOUD_ENDPOINT ? cloudReplies(call) : { body: { model: "jev-1.13.0", answers: answerAll(call) } },
      );
      await hook();
      expect(seen.filter((c) => c.url === CLOUD_ENDPOINT)).toHaveLength(cloudCalls);
      expect(seen.filter((c) => c.url !== CLOUD_ENDPOINT)).toHaveLength(byokCalls);
      // A BYOK call is today's request: no `cloud` block, and to the file's provider.
      for (const c of seen.filter((s) => s.url !== CLOUD_ENDPOINT)) {
        expect(c.url).toBe("https://api.typesafe.ai/v1/systemone");
        expect(c.body.cloud).toBeUndefined();
      }
      const jevEntries = existsSync(errorsFile()) ? readErrors().errors.filter((e) => e.id === "jevMode") : [];
      expect(jevEntries.map((e) => e.message)).toEqual(report === null ? [] : [report]);
      if (report !== null) expect(jevEntries[0]).toEqual({ id: "jevMode", version: null, kind: "daemon", message: report });
    },
  );

  it("under a Cloud mode every gated call goes, with the global questions, even with no installed pack's check", async () => {
    await connect();
    deploy({ jevMode: "enforce" });
    const seen = stubFetch(cloudReplies);
    await hook("cat README.md");
    await hook("git status", "another-session");
    expect(seen).toHaveLength(2);
    for (const c of seen) {
      expect(c.url).toBe(CLOUD_ENDPOINT);
      expect(Object.keys(c.body.questions)).toEqual(["injection"]);
      expect(c.body.cloud).toMatchObject({ v: 1, machineId: MACHINE, intentMode: "v1", localPolicies: [] });
    }
  });

  it("a known tool with no side effects is not sent: Cloud's selection of it is empty by construction", async () => {
    await connect();
    installPacks([{ id: "acme/pack", semantic: [decl("acme-local", { appliesTo: ["shell", "write", "read", "network", "other"] })] }]);
    deploy({ jevMode: "enforce" });
    const seen = stubFetch(cloudReplies);
    const { evaluateHookEvent } = await import("@/src/hooks/handler");
    for (const tool of ["TodoWrite", "Task"]) {
      const result = await evaluateHookEvent(
        "PreToolUse",
        "claude",
        JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: { todos: [] }, session_id: "s", cwd: project }),
      );
      expect(result.evaluation?.decision).toBe("allow");
    }
    expect(seen).toHaveLength(0);
    // An unknown (MCP) tool is sent: every check may apply to it.
    await evaluateHookEvent(
      "PreToolUse",
      "claude",
      JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "mcp__db__query", tool_input: { sql: "select 1" }, session_id: "s", cwd: project }),
    );
    expect(seen).toHaveLength(1);
  });

  it("the Cloud credential's key is sent, never a local jev.json's", async () => {
    await connect();
    const other = ["tk", "local", "fedcba9876543210"].join("-");
    const file = join(home, "jev.json");
    writeFileSync(file, JSON.stringify({ provider: "typesafe", apiKey: other, mode: "enforce" }), { mode: 0o600 });
    deploy({ jevMode: "enforce" });
    const auth: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { headers?: Record<string, string>; body?: unknown }) => {
        auth.push(`${url} ${init?.headers?.Authorization ?? ""}`);
        const body = JSON.parse(String(init?.body)) as SeenCall["body"];
        return new Response(JSON.stringify({ model: "jev-1.13.0", answers: answerAll({ url, body }), cloud: { ...cloudBlock([]), verdict: allowVerdict } }), {
          status: 200,
        });
      }),
    );
    await hook();
    expect(auth).toEqual([`${CLOUD_ENDPOINT} Bearer ${KEY}`]);
  });

  it.each([
    ["a Cloud mode that asks, with no installed pack", "enforce", true],
    ["no Cloud mode and no pack", null, false],
  ] as const)("captures what the human types under %s: %s", async (_why, mode, captured) => {
    await connect();
    deploy({ ...(mode ? { jevMode: mode } : {}) });
    const { evaluateHookEvent } = await import("@/src/hooks/handler");
    await evaluateHookEvent(
      "UserPromptSubmit",
      "claude",
      JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "clean the build folder", session_id: "s1", cwd: project }),
    );
    const { readIntent } = await import("@/src/hooks/semantic/intent");
    expect(readIntent("s1").userSaid).toEqual(captured ? ["clean the build folder"] : []);
  });
});

// ── A session pause: Cloud's Jev checks are exempt, like Cloud JS ────────────

describe("a session pause: FailproofAI Cloud's Jev checks are exempt, installed packs' are paused", () => {
  const SESSION = "paused-session";
  const pause = async () => {
    const { writePause } = await import("@/src/hooks/session-pause");
    writePause({ sessionId: SESSION, durationMs: 60_000, setBy: "test" });
  };
  const cloudDenies: Reply = (call) => ({
    body: { model: "jev-1.13.0", answers: answerAll(call), cloud: cloudBlock([cloudOutcome("acme-cloud", "cloud-pol", "deny")]) },
  });

  it("under a Cloud mode a paused call still goes to Cloud, without the pack's check, and Cloud's deny applies", async () => {
    await connect();
    installPacks([{ id: "acme/pack", semantic: [decl("acme-local")] }]);
    deploy({ jevMode: "enforce" });
    await pause();
    const seen = stubFetch(cloudDenies);
    const result = await hook("rm -rf build", SESSION);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(CLOUD_ENDPOINT);
    expect(Object.keys(seen[0].body.questions)).toEqual(["injection"]);
    expect(seen[0].body.cloud).toMatchObject({ machineId: MACHINE, localPolicies: [] });
    expect(result.evaluation?.decision).toBe("deny");
  });

  it("the same call in a session that is not paused asks the pack's check too", async () => {
    await connect();
    installPacks([{ id: "acme/pack", semantic: [decl("acme-local")] }]);
    deploy({ jevMode: "enforce" });
    await pause();
    const seen = stubFetch(cloudDenies);
    await hook("rm -rf build", "another-session");
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0].body.questions)).toContain("acme-local.fires");
    expect(seen[0].body.cloud).toMatchObject({ localPolicies: ["acme-local"] });
  });

  it.each([
    ["no Cloud mode, a BYOK jev.json and a pack", null],
    ["Cloud off", "off"],
  ] as const)("%s: a pause switches Jev off, no call at all", async (_why, mode) => {
    await connect();
    localJev("enforce");
    installPacks([{ id: "acme/pack", semantic: [decl("acme-local")] }]);
    deploy({ ...(mode !== null ? { jevMode: mode } : {}) });
    await pause();
    const seen = stubFetch((call) => ({ body: { model: "jev-1.13.0", answers: answerAll(call, 0.95) } }));
    const result = await hook("rm -rf build", SESSION);
    expect(seen).toHaveLength(0);
    expect(result.evaluation?.decision).toBe("allow");
  });
});

// ── C10.3: the request ───────────────────────────────────────────────────────

describe("C10.3 the cloud block", () => {
  async function prepared(input: Partial<SemanticInput> & { toolInput: Record<string, unknown> }, intent: "v0" | "v1" = "v1") {
    const { prepareSemantic } = await import("@/src/hooks/semantic/evaluator");
    const full: SemanticInput = { eventType: "PreToolUse", toolName: "Bash", userSaid: [], cwd: project, ...input };
    const policies = input.toolName === "none" ? [] : undefined;
    return { full, prep: prepareSemantic(full, { intent, ...(policies ? { policies } : {}) }) };
  }

  it.each([
    ["v1", [], ["injection"]],
    ["v1", ["clean the build"], ["injection", "task_step", "op_requested", "beyond_task"]],
    ["v0", [], ["injection"]],
    // v0: `scope` whenever a human message was recorded — Cloud's checks may be overridable.
    ["v0", ["clean the build"], ["injection", "scope"]],
  ] as const)("%s with userSaid %j carries exactly the global questions %j when no pack check applies", async (intent, said, keys) => {
    const { buildCloudRequest } = await import("@/src/hooks/semantic/cloud-jev");
    const { full, prep } = await prepared({ toolInput: { command: "rm -rf build/" }, userSaid: [...said] }, intent);
    const request = buildCloudRequest(prep, full, MACHINE);
    expect(Object.keys(request.questions)).toEqual(keys);
    expect(request.cloud).toMatchObject({ v: 1, machineId: MACHINE, intentMode: intent, localPolicies: [] });
  });

  it("keeps the machine's own per-policy questions, in order, and names their groups in localPolicies", async () => {
    installPacks([{ id: "acme/pack", semantic: [decl("acme-a"), decl("acme-b", { userCanOverride: false })] }]);
    const { buildCloudRequest } = await import("@/src/hooks/semantic/cloud-jev");
    const { full, prep } = await prepared({ toolInput: { command: "rm -rf build/" }, userSaid: ["clean the build"] }, "v0");
    const request = buildCloudRequest(prep, full, MACHINE);
    // compileRequest's own keys first, untouched; `scope` added because Cloud's
    // checks may be overridable (acme-b is not, and acme-a asked for it anyway).
    expect(Object.keys(request.questions)).toEqual([
      "acme-a.fires",
      "acme-a.user_asked",
      "acme-b.fires",
      "injection",
      "scope",
    ]);
    expect((request.cloud as { localPolicies: string[] }).localPolicies).toEqual(["acme-a", "acme-b"]);
    // Its request is today's otherwise: the same model and the same state.
    expect(request.model).toBe(prep.compiled.request.model);
    expect(request.state).toBe(prep.compiled.request.state);
  });

  it("carries the facts, the human's turns, the agent message and the cut flag as the local decider reads them", async () => {
    const { buildCloudBlock } = await import("@/src/hooks/semantic/cloud-jev");
    const { full, prep } = await prepared(
      { toolInput: { command: "rm -rf build/ ~/important" }, userSaid: ["clean the build"], agentLastMessage: "Shall I clean build/?" },
      "v1",
    );
    const block = buildCloudBlock(prep, full, MACHINE);
    expect(block.facts).toEqual(prep.facts);
    expect(block.facts).toMatchObject({ toolName: "Bash", toolClass: "shell", toolIsKnown: true, cwd: project });
    expect(block.userSaid).toEqual(prep.userSaid);
    expect(block.agentLastMessage).toBe(prep.agentLastMessage);
    expect(block.userSaidCut).toBe(false);
    expect(block.targetScan).toEqual({ groups: [["build"], ["important"]], complete: true });
  });

  it("targetScan is scanTargets with each group's Set as a sorted array — every case of the server's parity fixture", async () => {
    const { cloudTargetScan } = await import("@/src/hooks/semantic/cloud-jev");
    const { scanTargets } = await import("@/src/hooks/semantic/decide");
    expect(TARGET_SCANS.cases.length).toBeGreaterThanOrEqual(50);
    for (const c of TARGET_SCANS.cases) {
      const sent = cloudTargetScan(c.toolInput);
      const expected = { groups: c.targetScan.groups.map((g) => [...g].sort()), complete: c.targetScan.complete };
      expect(sent, c.id).toEqual(expected);
      // And it is exactly scanTargets, as sets.
      const scan = scanTargets(c.toolInput);
      expect(sent.groups.map((g) => new Set(g)), c.id).toEqual(scan.groups);
      for (const g of sent.groups) expect(g, c.id).toEqual([...g].sort());
    }
    // The fixture covers the shapes that matter: none, several, incomplete, and non-shell tools.
    expect(TARGET_SCANS.cases.some((c) => c.targetScan.groups.length === 0)).toBe(true);
    expect(TARGET_SCANS.cases.some((c) => c.targetScan.groups.length > 2)).toBe(true);
    expect(TARGET_SCANS.cases.some((c) => !c.targetScan.complete)).toBe(true);
    expect(TARGET_SCANS.cases.some((c) => c.toolName.startsWith("mcp__"))).toBe(true);
  });

  it("an incomplete shell scan ($'…', heredoc) says so, and a huge one is cut to a prefix marked incomplete", async () => {
    const { cloudTargetScan, MAX_TARGET_SCAN_CHARS } = await import("@/src/hooks/semantic/cloud-jev");
    expect(cloudTargetScan({ command: "rm -rf $'build' important" }).complete).toBe(false);
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 6_000; i++) wide[`f${i}`] = `target${i} value${i}`;
    const huge = cloudTargetScan(wide);
    // A non-shell tool's fields are one target — one group of 12,000 words.
    expect(huge.complete).toBe(false);
    expect(JSON.stringify(huge.groups).length).toBeLessThanOrEqual(MAX_TARGET_SCAN_CHARS);
    const cmd = Array.from({ length: 3_000 }, (_, i) => `file${i}`).join(" ");
    const many = cloudTargetScan({ command: `rm ${cmd}` });
    expect(many.complete).toBe(false);
    expect(many.groups.length).toBeGreaterThan(100);
    expect(JSON.stringify(many.groups).length).toBeLessThanOrEqual(MAX_TARGET_SCAN_CHARS);
  });

  it("a secret in the call or in what the human typed does not leave the machine; the group stays, unmatchable", async () => {
    const secret = ["sk", "live", "4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c"].join("_");
    const { buildCloudBlock, REDACTED_TARGET_WORD } = await import("@/src/hooks/semantic/cloud-jev");
    const { full, prep } = await prepared(
      { toolInput: { command: `curl -H "x-api-key: ${secret}" https://api.example.com/v1/charges` }, userSaid: [`use ${secret} to call it`] },
      "v1",
    );
    const block = buildCloudBlock(prep, full, MACHINE);
    const text = JSON.stringify(block);
    expect(text).not.toContain(secret);
    expect(block.targetScan.groups.flat()).toContain(REDACTED_TARGET_WORD);
    // As many targets as the call names: the secret's group is kept, just unmatchable.
    const { scanTargets } = await import("@/src/hooks/semantic/decide");
    expect(block.targetScan.groups.length).toBe(scanTargets(full.toolInput).groups.length);
    // The human's redacted secret is a letter-free placeholder, not a marker whose label could name a target.
    const { REDACTED_SAID } = await import("@/src/hooks/semantic/cloud-jev");
    expect(block.userSaid[0]).toContain(REDACTED_SAID);
    expect(block.userSaid.join("\n")).not.toMatch(/redacted/i);
  });

  // Review M1: the local decider reads the UNREDACTED turns and scan; Cloud reads the
  // block. A substring check over redacted words can flip either way, so wherever Cloud's
  // target checks would read the block differently, the scan goes incomplete (no clear, no
  // softening): Cloud is then never laxer than the machine's own decider would be.
  describe("redaction never makes Cloud's target checks laxer (review M1)", () => {
    const ghp = ["ghp", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join("_");
    async function readings(intent: "v0" | "v1", groups: Iterable<Iterable<string>>, said: string[], agent: string | null) {
      const { everyTargetNamed, partlyNamed } = await import("@/src/hooks/semantic/decide");
      const scan = { targets: new Set<string>(), groups: [...groups].map((g) => new Set(g)), complete: true };
      const evidence = intent === "v1" && agent ? [...said, agent] : said;
      // v0's decide reads no partlyNamed; v1's reads both, over the human's words plus the agent message.
      return { every: everyTargetNamed(scan, evidence), partly: intent === "v1" && partlyNamed(scan, evidence) };
    }
    async function both(command: string, said: string[], intent: "v0" | "v1" = "v1") {
      const { buildCloudBlock } = await import("@/src/hooks/semantic/cloud-jev");
      const { scanTargets } = await import("@/src/hooks/semantic/decide");
      const { full, prep } = await prepared({ toolInput: { command }, userSaid: said }, intent);
      const block = buildCloudBlock(prep, full, MACHINE);
      const local = await readings(intent, scanTargets(full.toolInput).groups, prep.userSaid, prep.agentLastMessage);
      const cloud = await readings(intent, block.targetScan.groups, block.userSaid, block.agentLastMessage);
      return { block, local, cloud };
    }

    it.each([
      // The reviewer's four probe rows (c10-review.md M1).
      ["a marker's label names the target", "rm -rf ~/.config/github", `here is my key ${ghp}, now clean up the old cache`],
      ["a password prompt names ./secret", "rm -rf ./secret", "run it with --password hunter2 and then tidy up"],
      ["a secret-shaped target hides the partly-named guard", `rm -rf ./${ghp} ./important`, `remove the ${ghp} folder`],
      ["a token both typed and passed", "git push --token abc123 origin release-v2", "push release-v2 using --token abc123 please"],
    ])("%s: Cloud reads the block as the machine reads the call, or the scan is incomplete", async (_why, command, said) => {
      for (const intent of ["v0", "v1"] as const) {
        const { block, local, cloud } = await both(command, [said], intent);
        if (block.targetScan.complete) expect(cloud, intent).toEqual(local);
        // A clear Cloud could give on the block that the machine would not give on the call never goes out whole.
        expect(block.targetScan.complete && cloud.every && !local.every, intent).toBe(false);
      }
    });

    it("`rm -rf ./secret` after a password prompt: the marker no longer names the target", async () => {
      const { block, local, cloud } = await both("rm -rf ./secret", ["run it with --password hunter2 and then tidy up"]);
      expect(local.every).toBe(false);
      // Before the fix the marker `<redacted:assigned secret>` named `secret` for Cloud alone.
      expect(cloud.every).toBe(false);
      expect(block.userSaid[0]).not.toContain("secret");
      expect(block.targetScan.complete).toBe(true);
    });

    it("a secret-shaped target that hid the partly-named guard sends the scan incomplete", async () => {
      const { block, local, cloud } = await both(`rm -rf ./${ghp} ./important`, [`remove the ${ghp} folder`]);
      // The machine sees the human draw a line (one of two targets named); Cloud's copy cannot.
      expect(local.partly).toBe(true);
      expect(cloud.partly).toBe(false);
      expect(block.targetScan.complete).toBe(false);
      // The groups themselves still go, as many as the call names.
      expect(block.targetScan.groups).toHaveLength(2);
      expect(JSON.stringify(block)).not.toContain(ghp);
    });

    // Live (c10-fix smoke SR.1): the intent store keeps the human's turns narrowly redacted, so the machine's
    // own reading holds the marker, whose label names `./secret`. The block's copy is letter-free: the readings
    // differ, the scan goes incomplete, and Cloud keeps a deny the machine's own decider would clear.
    it("a marker the intent store already put in the human's words: Cloud is stricter, never laxer", async () => {
      const { block, local, cloud } = await both("rm -rf ./secret", ["run it with --password <redacted:assigned secret> and then tidy up"]);
      expect(local.every).toBe(true);
      expect(cloud.every).toBe(false);
      expect(block.targetScan.complete).toBe(false);
    });

    it("no secret anywhere: the scan stays complete and the words go as they are", async () => {
      const { block, local, cloud } = await both("rm -rf build/ ~/important", ["clean the build"]);
      expect(block.targetScan).toEqual({ groups: [["build"], ["important"]], complete: true });
      expect(cloud).toEqual(local);
      expect(local).toEqual({ every: false, partly: true });
    });
  });

  it("the block never passes Cloud's size cap, counted in UTF-8 bytes: the human's turns go first", async () => {
    const { buildCloudBlock, MAX_CLOUD_BLOCK_BYTES } = await import("@/src/hooks/semantic/cloud-jev");
    const { full, prep } = await prepared({ toolInput: { command: "ls" }, userSaid: ["x"] }, "v1");
    // 18 turns of 6,000 CJK characters: 108,000 UTF-16 units, but ~324 KB of UTF-8.
    const padded = { ...prep, userSaid: Array.from({ length: 18 }, () => "界".repeat(6_000)) };
    expect(JSON.stringify(padded.userSaid).length).toBeLessThan(MAX_CLOUD_BLOCK_BYTES);
    const block = buildCloudBlock(padded, full, MACHINE);
    expect(Buffer.byteLength(JSON.stringify(block), "utf8")).toBeLessThanOrEqual(MAX_CLOUD_BLOCK_BYTES);
    // Review M1: `[""]` names nothing but still says a human spoke, so Cloud's
    // beyond-the-task flag is not switched off by the call's size; and with the
    // words gone the scan is incomplete, so nothing is cleared on them.
    expect(block.userSaid).toEqual([""]);
    expect(block.userSaidCut).toBe(false);
    expect(block.targetScan.complete).toBe(false);
    // A block that fits is left whole.
    const fits = buildCloudBlock({ ...prep, userSaid: ["clean the build"] }, full, MACHINE);
    expect(fits.userSaid).toEqual(["clean the build"]);
  });
});

// ── C10.5: the reply, the merge and the local decision ──────────────────────

describe("C10.5 parseCloudReply", () => {
  // Review n8: bounded server-side already; cut, not refused, so Cloud's verdict is never dropped for it.
  it("cuts an overlong reason instead of refusing the reply", async () => {
    const { parseCloudReply, MAX_CLOUD_REASON_CHARS } = await import("@/src/hooks/semantic/cloud-jev");
    const long = "x".repeat(MAX_CLOUD_REASON_CHARS + 500);
    const reply = parseCloudReply({ ...cloudBlock([cloudOutcome("acme-x", "cloud-pol", "deny")]), verdict: { ...cloudBlock([cloudOutcome("acme-x", "cloud-pol", "deny")]).verdict, reason: long } });
    expect(reply.verdict.decision).toBe("deny");
    expect(reply.verdict.reason).toHaveLength(MAX_CLOUD_REASON_CHARS);
    expect(reply.verdict.reason!.endsWith("…")).toBe(true);
    const short = parseCloudReply(cloudBlock([cloudOutcome("acme-x", "cloud-pol", "deny")]));
    expect(short.verdict.reason).toBe("Checked acme-x (semantic/acme-x, p=0.95). Ask the user first.");
  });

  it("accepts the server's reply exactly as c10-server-shapes.md shows it, origin carried pack-shaped", async () => {
    const { parseCloudReply } = await import("@/src/hooks/semantic/cloud-jev");
    const reply = parseCloudReply({
      verdict: {
        decision: "deny",
        reason: "Tried to write to the production database (semantic/acme-prod-db, p=0.95). Ask the user first.",
        outcomes: [
          {
            policy: "acme-prod-db",
            mode: "deny",
            userCanOverride: true,
            evidence: 0.95,
            exempt: null,
            userAsked: 0.2,
            targetNamedByUser: false,
            escalatedByInjection: false,
            verdict: "deny",
            origin: { cloudPolicyId: "prod-db", cloudVersion: 3 },
          },
        ],
        injectionSuspected: 0.02,
        scopeWithinRequest: 0.1,
        beyondTask: false,
      },
      asked: ["acme-prod-db"],
      droppedLocal: [],
      droppedCloud: [],
      somethingNew: "ignored",
    });
    expect(reply.verdict.outcomes[0]).toEqual({
      policy: "acme-prod-db",
      mode: "deny",
      userCanOverride: true,
      origin: { packId: "cloud:prod-db", packVersion: "3" },
      evidence: 0.95,
      exempt: null,
      userAsked: 0.2,
      targetNamedByUser: false,
      escalatedByInjection: false,
      verdict: "deny",
    });
    expect(reply.asked).toEqual(["acme-prod-db"]);
  });

  it.each([
    ["no block", undefined],
    ["no verdict", { asked: [] }],
    ["an unknown decision", { verdict: { ...allowVerdict, decision: "maybe" } }],
    ["no outcomes list", { verdict: { ...allowVerdict, outcomes: null } }],
    ["an outcome with no Cloud origin", { verdict: { ...allowVerdict, outcomes: [{ ...cloudOutcome("a", "p", "none"), origin: undefined }] } }],
    ["an outcome from a pack", { verdict: { ...allowVerdict, outcomes: [{ ...cloudOutcome("a", "p", "none"), origin: { packId: "x" } }] } }],
    ["evidence out of range", { verdict: { ...allowVerdict, outcomes: [{ ...cloudOutcome("a", "p", "none"), evidence: 1.5 }] } }],
    ["an unknown verdict", { verdict: { ...allowVerdict, outcomes: [{ ...cloudOutcome("a", "p", "none"), verdict: "maybe" }] } }],
    ["a bad policy id", { verdict: { ...allowVerdict, outcomes: [cloudOutcome("a", "../x", "none")] } }],
    ["names that are not names", { verdict: allowVerdict, droppedLocal: [7] }],
  ])("refuses %s as malformed", async (_why, block) => {
    const { parseCloudReply } = await import("@/src/hooks/semantic/cloud-jev");
    const { JevError } = await import("@/src/hooks/semantic/jev-client");
    expect(() => parseCloudReply(block)).toThrow(JevError);
    try {
      parseCloudReply(block);
    } catch (err) {
      expect((err as InstanceType<typeof JevError>).code).toBe("malformed");
    }
  });
});

describe("C10.5 mergeCloudVerdict (table)", () => {
  const out = (policy: string, verdict: PolicyOutcome["verdict"], cloud = false): PolicyOutcome => ({
    policy,
    mode: "deny",
    evidence: 0.9,
    exempt: null,
    userAsked: null,
    targetNamedByUser: false,
    escalatedByInjection: false,
    verdict,
    ...(cloud ? { origin: { packId: "cloud:p", packVersion: "1" } } : {}),
  });
  const v = (
    decision: SemanticVerdict["decision"],
    reason: string | null,
    outcomes: PolicyOutcome[] = [],
    extra: Partial<SemanticVerdict> = {},
  ): SemanticVerdict => ({ decision, reason, outcomes, injectionSuspected: null, scopeWithinRequest: null, ...extra });

  const C = { deny: v("deny", "C deny", [out("c1", "deny", true)]), instruct: v("instruct", "C warn a\nC warn b", [out("c1", "instruct", true)]), allow: v("allow", null, [out("c1", "none", true)]), allowNote: v("allow", "C note", [out("c1", "overridden", true)]) };
  const L = { deny: v("deny", "L deny", [out("l1", "deny")]), instruct: v("instruct", "L warn", [out("l1", "instruct")]), allow: v("allow", null, [out("l1", "none")]), allowNote: v("allow", "L note", [out("l1", "overridden")]) };

  it.each([
    // cloud, local → decision, reason
    ["deny", "deny", "deny", "C deny"],
    ["deny", "instruct", "deny", "C deny"],
    ["deny", "allow", "deny", "C deny"],
    ["instruct", "deny", "deny", "L deny"],
    ["allow", "deny", "deny", "L deny"],
    ["instruct", "instruct", "instruct", "C warn a\nC warn b\nL warn"],
    ["instruct", "allow", "instruct", "C warn a\nC warn b"],
    ["allow", "instruct", "instruct", "L warn"],
    ["allowNote", "allowNote", "allow", "C note\nL note"],
    ["allow", "allowNote", "allow", "L note"],
    ["allowNote", "allow", "allow", "C note"],
    ["allow", "allow", "allow", null],
  ] as const)("cloud %s + local %s → %s, reason %j", async (c, l, decision, reason) => {
    const { mergeCloudVerdict } = await import("@/src/hooks/semantic/cloud-jev");
    const merged = mergeCloudVerdict(C[c], L[l]);
    expect(merged.decision).toBe(decision);
    expect(merged.reason).toBe(reason);
    // Outcomes: Cloud's first, then the machine's.
    expect(merged.outcomes.map((o) => o.policy)).toEqual(["c1", "l1"]);
  });

  it("beyondTask is either side's; the same warning line from both sides is said once", async () => {
    const { mergeCloudVerdict } = await import("@/src/hooks/semantic/cloud-jev");
    const line = "Goes beyond what the user asked for (semantic/beyond-task, p=0.90). Do only what they asked, or confirm the wider change with them first.";
    const merged = mergeCloudVerdict(v("instruct", line, [], { beyondTask: true }), v("instruct", `L warn\n${line}`, [], { beyondTask: true }));
    expect(merged.reason).toBe(`${line}\nL warn`);
    expect(merged.beyondTask).toBe(true);
    expect(mergeCloudVerdict(v("allow", null, [], { beyondTask: false }), v("allow", null, [], { beyondTask: true })).beyondTask).toBe(true);
    expect(mergeCloudVerdict(v("allow", null, [], { beyondTask: false }), v("allow", null)).beyondTask).toBe(false);
    expect("beyondTask" in mergeCloudVerdict(v("allow", null), v("allow", null))).toBe(false);
  });

  it("injection and scope: the machine's own reading of the shared answer, else Cloud's", async () => {
    const { mergeCloudVerdict } = await import("@/src/hooks/semantic/cloud-jev");
    const m = mergeCloudVerdict(v("allow", null, [], { injectionSuspected: 0.3, scopeWithinRequest: 0.9 }), v("allow", null, [], { injectionSuspected: 0.4 }));
    expect(m.injectionSuspected).toBe(0.4);
    expect(m.scopeWithinRequest).toBe(0.9);
  });
});

describe("C10.5 evaluateCloudSemantic", () => {
  const input = (command = "rm -rf build/"): SemanticInput => ({
    eventType: "PreToolUse",
    toolName: "Bash",
    toolInput: { command },
    cwd: project,
    userSaid: [],
  });

  async function evaluate(respond: (request: SeenCall["body"]) => unknown | Promise<unknown>) {
    const { evaluateCloudSemantic } = await import("@/src/hooks/semantic/cloud-jev");
    const requests: SeenCall["body"][] = [];
    const outcome = await evaluateCloudSemantic(input(), {
      machineId: MACHINE,
      intent: "v1",
      transport: async (request) => {
        requests.push(request as SeenCall["body"]);
        return (await respond(request as SeenCall["body"])) as never;
      },
    });
    return { outcome, requests };
  }

  // Review n10: decided from the tool's name alone, before the envelope is built.
  it("a known inert tool is answered without a request, and without reading its input", async () => {
    const { evaluateCloudSemantic } = await import("@/src/hooks/semantic/cloud-jev");
    let sent = 0;
    const toolInput = {
      get todos(): unknown {
        throw new Error("the input was read");
      },
    };
    const outcome = await evaluateCloudSemantic(
      { eventType: "PreToolUse", toolName: "TodoWrite", toolInput, cwd: project, userSaid: [] },
      { machineId: MACHINE, intent: "v1", transport: async () => { sent++; return {} as never; } },
    );
    expect(sent).toBe(0);
    expect(outcome).toMatchObject({ status: "ok", via: "none", questionCount: 0, verdict: { decision: "allow", outcomes: [] } });
  });

  it("the short-circuit reply (no answers, nothing asked) is an empty allow, not a malformed answer", async () => {
    const { outcome } = await evaluate(() => ({ model: "jev-1.13.0", answers: {}, cloud: { ...cloudBlock([]), verdict: allowVerdict } }));
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.verdict).toMatchObject({ decision: "allow", reason: null, outcomes: [] });
    expect(outcome.cloud).toEqual({ asked: [], droppedLocal: [], droppedCloud: [] });
  });

  it("decides the pack checks from the answers, minus the groups Cloud dropped, and merges Cloud's verdict first", async () => {
    installPacks([{ id: "acme/pack", semantic: [decl("acme-kept"), decl("acme-dropped")] }]);
    const { outcome, requests } = await evaluate((request) => {
      const answers = answerAll({ url: "", body: request }, 0.05, { "acme-kept.fires": 0.95 });
      delete (answers as Record<string, unknown>)["acme-dropped.fires"];
      return {
        model: "jev-1.13.0",
        answers: { ...answers, "acme-cloud.fires": { noul: 0.95 } },
        cloud: cloudBlock([cloudOutcome("acme-cloud", "org-policy", "instruct", { mode: "instruct" })], { droppedLocal: ["acme-dropped", "not-mine"] }),
      };
    });
    expect((requests[0].cloud as { localPolicies: string[] }).localPolicies).toEqual(["acme-kept", "acme-dropped"]);
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.verdict.decision).toBe("deny");
    expect(outcome.verdict.outcomes.map((o) => [o.policy, o.verdict, o.origin?.packId])).toEqual([
      ["acme-cloud", "instruct", "cloud:org-policy"],
      ["acme-kept", "deny", "acme/pack"],
    ]);
    expect(outcome.verdict.reason).toMatch(/^Checked acme-kept \(semantic\/acme-kept/);
    expect(outcome.cloud.droppedLocal).toEqual([{ name: "acme-dropped", packId: "acme/pack" }]);
  });

  it.each([
    ["a reply with no cloud block (a server without C10)", () => ({ model: "jev-1.13.0", answers: { injection: { noul: 0.05 } } }), "malformed"],
    [
      "a kept pack check left unanswered",
      () => ({ model: "jev-1.13.0", answers: { injection: { noul: 0.05 } }, cloud: cloudBlock([cloudOutcome("acme-cloud", "p", "none")]) }),
      "malformed",
    ],
    [
      "an answer from another model",
      (r: SeenCall["body"]) => ({ model: "gpt-9", answers: answerAll({ url: "", body: r }), cloud: cloudBlock([cloudOutcome("acme-cloud", "p", "none")]) }),
      "model-mismatch",
    ],
    [
      "a transport failure",
      () => {
        throw Object.assign(new Error("HTTP 503"), { name: "Error" });
      },
      "error: HTTP 503",
    ],
  ])("%s is a degrade (%s), never a verdict", async (_why, respond, reason) => {
    installPacks([{ id: "acme/pack", semantic: [decl("acme-kept")] }]);
    const { outcome } = await evaluate(respond as (r: SeenCall["body"]) => unknown);
    expect(outcome).toMatchObject({ status: "degraded", reason });
  });
});

// ── C10.5: a `both` policy is reviewed by its OWN Cloud checks only ─────────

describe("C10.5 both reviewability: only its own Cloud outcomes clear it", () => {
  const both: CloudJs = { id: "no-prod-db", version: 3, hooks: ["block-prod-db"], authority: "reviewable", reviewedBy: ["acme-x"], verdict: "deny" };

  it("registers reviewable by cloud:<id>/<name> under a Cloud mode that asks, and hard otherwise", async () => {
    for (const [mode, effect, expected] of [
      ["enforce", "enforce", { authority: "reviewable", reviewedBy: ["cloud:no-prod-db/acme-x"] }],
      ["observe", "enforce", { authority: "reviewable", reviewedBy: ["cloud:no-prod-db/acme-x"] }],
      ["enforce", "observe", { authority: "hard" }],
      ["off", "enforce", { authority: "hard" }],
      [undefined, "enforce", { authority: "hard" }],
    ] as const) {
      vi.resetModules();
      deploy({ policies: [{ ...both, effect }], ...(mode ? { jevMode: mode } : {}) });
      const registered = await registeredAfterOneEvent();
      const policy = registered.get("cloud/no-prod-db@3/block-prod-db");
      expect({ authority: policy?.authority, ...(policy?.reviewedBy ? { reviewedBy: policy.reviewedBy } : {}) }, `${mode}/${effect}`).toEqual(expected);
    }
    // Never a warning: an org's own mode choice is not a broken policy.
    expect(stderr.join("")).not.toMatch(/asks to be reviewable/);
  });

  it.each([
    ["its own Cloud check found nothing", [cloudOutcome("acme-x", "no-prod-db", "none")], "allow"],
    ["its own Cloud check was what the human asked for", [cloudOutcome("acme-x", "no-prod-db", "overridden")], "allow"],
    ["its own Cloud check denied", [cloudOutcome("acme-x", "no-prod-db", "deny")], "deny"],
    ["another Cloud policy's check of that name found nothing", [cloudOutcome("acme-x", "someone-else", "none")], "deny"],
    ["Cloud did not ask it", [], "deny"],
  ])("%s → %s", async (_why, outcomes, decision) => {
    await connect();
    deploy({ policies: [both], jevMode: "enforce" });
    stubFetch((call) => ({ body: { model: "jev-1.13.0", answers: answerAll(call), cloud: cloudBlock(outcomes) } }));
    const result = await hook("psql -h prod-db -c 'select 1'");
    expect(result.evaluation?.decision).toBe(decision);
  });

  it("an installed pack's check of the same name, answered locally, never clears it", async () => {
    await connect();
    installPacks([{ id: "acme/lenient", semantic: [decl("acme-x", { title: "Anything goes" })] }]);
    deploy({ policies: [both], jevMode: "enforce" });
    const seen = stubFetch((call) => ({ body: { model: "jev-1.13.0", answers: answerAll(call), cloud: cloudBlock([]) } }));
    const result = await hook("psql -h prod-db -c 'select 1'");
    // The pack's acme-x was asked (through Cloud) and found nothing…
    expect(Object.keys(seen[0].body.questions)).toContain("acme-x.fires");
    // …and the regex deny stands: only no-prod-db's own Cloud outcome could clear it.
    expect(result.evaluation?.decision).toBe("deny");
    // The pack's check is still a reviewer — for the pack's own policies.
    const { effectiveReviewerNames } = await import("@/src/hooks/effective-reviewers");
    expect([...effectiveReviewerNames()].sort()).toEqual(["acme-x", "cloud:no-prod-db/acme-x"]);
  });

  it("a Cloud check's deny is attributed to its Cloud policy and version on the activity row", async () => {
    await connect();
    deploy({ jevMode: "enforce" });
    const store = await import("@/src/hooks/hook-activity-store");
    store._resetForTest(join(home, "activity"));
    stubFetch((call) => ({ body: { model: "jev-1.13.0", answers: answerAll(call), cloud: cloudBlock([cloudOutcome("acme-prod-db", "prod-db", "deny")]) } }));
    const result = await hook("psql -h prod-db -c 'delete from users'");
    expect(result.evaluation?.decision).toBe("deny");
    expect(result.evaluation?.reason).toMatch(/semantic\/acme-prod-db/);
    const row = store.getAllHookActivityEntries()[0] as unknown as Record<string, unknown>;
    expect(row).toMatchObject({ policySource: "jev", cloudPolicyId: "prod-db", cloudVersion: 3 });
    store._resetForTest();
  });

  it("observe mode records Cloud's verdict and enforces the regex result", async () => {
    await connect();
    deploy({ jevMode: "observe" });
    stubFetch((call) => ({ body: { model: "jev-1.13.0", answers: answerAll(call), cloud: cloudBlock([cloudOutcome("acme-prod-db", "prod-db", "deny")]) } }));
    const result = await hook("psql -h prod-db -c 'delete from users'");
    expect(result.evaluation?.decision).toBe("allow");
  });
});

// ── C10.5: a Cloud failure is today's fallback ───────────────────────────────

describe("C10.5 failure: the regex decides alone, a both policy stays hard, nothing is written", () => {
  const both: CloudJs = { id: "no-prod-db", version: 3, hooks: ["block-prod-db"], authority: "reviewable", reviewedBy: ["acme-x"], verdict: "deny" };

  it.each([
    ["a 503", () => ({ status: 503, body: { error: "jev_unavailable" } })],
    ["a 400 over the block", () => ({ status: 400, body: { error: "bad_request", message: "cloud block is malformed" } })],
    ["a reply with no cloud block", (call: SeenCall) => ({ body: { model: "jev-1.13.0", answers: answerAll(call) } })],
    ["a malformed cloud block", (call: SeenCall) => ({ body: { model: "jev-1.13.0", answers: answerAll(call), cloud: { verdict: "yes" } } })],
  ])("%s", async (_why, reply) => {
    await connect();
    installPacks([{ id: "acme/pack", semantic: [decl("acme-local")] }]);
    deploy({ policies: [both], jevMode: "enforce" });
    stubFetch(reply as Reply);
    const result = await hook("psql -h prod-db -c 'select 1'");
    expect(result.evaluation?.decision).toBe("deny");
    expect(result.evaluation?.policyName).toBe("cloud/no-prod-db@3/block-prod-db");
    expect(existsSync(errorsFile())).toBe(false);
    expect(existsSync(budgetFile())).toBe(false);
  });

  // The Cloud route's timeout is CLOUD_JEV_TIMEOUT_MS (5 s): jev.json's is not used under a Cloud mode.
  it("a transport that never answers times out to the same fallback", { timeout: 20_000 }, async () => {
    await connect();
    deploy({ policies: [both], jevMode: "enforce" });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: { signal?: AbortSignal }) =>
          new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("stopped", "AbortError")))),
      ),
    );
    const result = await hook("psql -h prod-db -c 'select 1'");
    expect(result.evaluation?.decision).toBe("deny");
    expect(existsSync(errorsFile())).toBe(false);
  });

  // Past the local 3 s default (and its 250 ms grace), inside Cloud's 5 s: applied.
  it("a Cloud answer slower than the local default but inside Cloud's 5 s is applied", { timeout: 20_000 }, async () => {
    await connect();
    deploy({ jevMode: "enforce" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { body?: unknown }) => {
        await new Promise((r) => setTimeout(r, 3_600));
        const body = JSON.parse(String(init?.body)) as SeenCall["body"];
        const reply = { model: "jev-1.13.0", answers: answerAll({ url: CLOUD_ENDPOINT, body }), cloud: cloudBlock([cloudOutcome("acme-x", "cloud-pol", "deny")]) };
        return new Response(JSON.stringify(reply), { status: 200 });
      }),
    );
    const result = await hook("ls");
    expect(result.evaluation?.decision).toBe("deny");
    expect(result.evaluation?.reason).toContain("acme-x");
  });
});

// ── C10.5: installed packs' checks Cloud dropped for the budget ──────────────

describe("C10.5 droppedLocal → errors.json jev_budget, for the deployment it happened under", () => {
  it("reports each dropped pack check once, keeps them across calls, and starts afresh on a new deployment", async () => {
    await connect();
    installPacks([{ id: "acme/big", semantic: [decl("acme-a"), decl("acme-b"), decl("acme-c")] }]);
    deploy({ jevMode: "enforce", deployment: 7 });
    let dropped = ["acme-c"];
    stubFetch((call) => {
      const answers = answerAll(call);
      for (const name of dropped) delete (answers as Record<string, unknown>)[`${name}.fires`];
      return { body: { model: "jev-1.13.0", answers, cloud: { ...cloudBlock([]), droppedLocal: dropped } } };
    });
    await hook();
    const expectDrops = (names: string[]) =>
      expect(existsSync(errorsFile()) ? readErrors().errors.filter((e) => String(e.message).startsWith("jev_budget")) : []).toEqual(
        names.map((name) => ({ id: "pack:acme/big", version: null, kind: "daemon", message: `jev_budget: dropped ${name}` })),
      );
    expectDrops(["acme-c"]);
    expect(JSON.parse(readFileSync(budgetFile(), "utf8"))).toEqual({
      machineId: MACHINE,
      deployment: 7,
      jevMode: "enforce",
      dropped: [{ packId: "acme/big", name: "acme-c" }],
    });
    if (posix) expect(statSync(budgetFile()).mode & 0o777).toBe(0o600);

    // Another call drops another group: the union is reported, not the latest.
    dropped = ["acme-b", "acme-c"];
    await hook("git status", "s2");
    expectDrops(["acme-b", "acme-c"]);
    // A call that drops nothing does not flap the report.
    dropped = [];
    await hook("pwd", "s3");
    expectDrops(["acme-b", "acme-c"]);

    // A new deployment: the old drops describe a deployment that is gone.
    deploy({ jevMode: "enforce", deployment: 8 });
    await hook("whoami", "s4");
    expectDrops([]);
  });

  it("is not reported when Cloud's mode stops asking", async () => {
    await connect();
    installPacks([{ id: "acme/big", semantic: [decl("acme-a")] }]);
    deploy({ jevMode: "enforce", deployment: 7 });
    stubFetch((call) => ({ body: { model: "jev-1.13.0", answers: answerAll(call), cloud: { ...cloudBlock([]), droppedLocal: ["acme-a"] } } }));
    await hook();
    expect(readErrors().errors.some((e) => e.id === "pack:acme/big")).toBe(true);
    deploy({ jevMode: "off", deployment: 7 });
    await hook("pwd");
    expect(readErrors().errors).toEqual([]);
  });

  it("a group dropped because a Cloud check has its name is a jev_name_clash, not a budget drop", async () => {
    await connect();
    installPacks([{ id: "acme/big", semantic: [decl("acme-a"), decl("acme-b"), decl("acme-c")] }]);
    deploy({ jevMode: "enforce", deployment: 7 });
    stubFetch((call) => {
      const answers = answerAll(call);
      for (const name of ["acme-a", "acme-b", "acme-c"]) delete (answers as Record<string, unknown>)[`${name}.fires`];
      return {
        body: {
          model: "jev-1.13.0",
          answers,
          // acme-a: a Cloud check of that name was asked; acme-c: one was selected and then budget-dropped itself.
          cloud: { ...cloudBlock([cloudOutcome("acme-a", "cloud-pol", "none")]), droppedLocal: ["acme-a", "acme-b", "acme-c"], droppedCloud: ["acme-c"] },
        },
      };
    });
    await hook();
    expect(readErrors().errors.filter((e) => e.id === "pack:acme/big")).toEqual([
      { id: "pack:acme/big", version: null, kind: "daemon", message: "jev_name_clash: acme-a (the FailproofAI Cloud check is used)" },
      { id: "pack:acme/big", version: null, kind: "daemon", message: "jev_budget: dropped acme-b" },
      { id: "pack:acme/big", version: null, kind: "daemon", message: "jev_name_clash: acme-c (the FailproofAI Cloud check is used)" },
    ]);
    expect(JSON.parse(readFileSync(budgetFile(), "utf8")).dropped).toEqual([
      { packId: "acme/big", name: "acme-a", clash: true },
      { packId: "acme/big", name: "acme-b" },
      { packId: "acme/big", name: "acme-c", clash: true },
    ]);
  });

  it("a drop of a pack uninstalled since is no longer reported (review m2)", async () => {
    await connect();
    installPacks([{ id: "acme/big", semantic: [decl("acme-a")] }]);
    deploy({ jevMode: "enforce", deployment: 7 });
    stubFetch((call) => ({ body: { model: "jev-1.13.0", answers: answerAll(call), cloud: { ...cloudBlock([]), droppedLocal: ["acme-a"] } } }));
    await hook();
    expect(readErrors().errors.some((e) => e.id === "pack:acme/big")).toBe(true);
    installPacks([]);
    await hook("pwd");
    expect(readErrors().errors).toEqual([]);
  });
});

// ── Review M3: FailproofAI Cloud Jev rate-limited or unavailable ─────────────

describe("M3 FailproofAI Cloud Jev health: a circuit breaker and a report", () => {
  const SCOPE = "scope-1";

  it("classifies a review by what it says about FailproofAI Cloud", async () => {
    const { classifyCloudJevReview } = await import("@/src/hooks/semantic/cloud-jev-health");
    const fb = (reason: string) => ({ kind: "fallback" as const, reason, latencyMs: null, model: null });
    expect(classifyCloudJevReview({ kind: "not-consulted" } as never)).toBe("neutral");
    for (const code of ["timeout", "network", "malformed", "model-mismatch", "upstream-error", "error", "http-500", "http-502", "http-503", "http-504"]) {
      expect(classifyCloudJevReview(fb(code)), code).toBe("failed");
    }
    // Cloud's rate limit, or the machine's own budget a Cloud 429 empties.
    expect(classifyCloudJevReview(fb("http-429"))).toBe("rate-limited");
    expect(classifyCloudJevReview(fb("rate-limited"))).toBe("rate-limited");
    // Not Cloud's health: the machine aborted (regex decided first), its own config, Cloud refusing THIS request.
    for (const code of ["aborted", "config", "no-transport", "prepare", "http-400", "http-401", "http-402", "http-413", "unavailable"]) {
      expect(classifyCloudJevReview(fb(code)), code).toBe("neutral");
    }
  });

  it("opens after 3 failures in a row, skips Cloud for 60 s, then lets ONE call through (half-open)", async () => {
    const h = await import("@/src/hooks/semantic/cloud-jev-health");
    let t = 1_000;
    const fail = (probe = false) => h.recordCloudJevResult(SCOPE, "failed", "timeout", probe, t);
    for (let i = 0; i < 2; i++) {
      expect(h.cloudJevGate(SCOPE, t)).toEqual({ ask: true, probe: false });
      fail();
    }
    expect(h.cloudJevHealthErrors(t)).toEqual([]);
    // A neutral result (an abort) neither counts nor resets.
    h.recordCloudJevResult(SCOPE, "neutral", "aborted", false, t);
    fail();
    expect(h.cloudJevGate(SCOPE, t)).toEqual({ ask: false });
    expect(h.cloudJevHealthErrors(t)).toEqual([
      {
        id: "jevMode",
        version: null,
        kind: "daemon",
        message:
          "jev_unavailable: FailproofAI Cloud Jev failed 3 or more calls in a row (last: timeout), so tool calls skip it for 60 s at a time and the regex decides alone",
      },
    ]);
    t += h.BREAKER_OPEN_MS - 1;
    expect(h.cloudJevGate(SCOPE, t)).toEqual({ ask: false });
    t += 1;
    // Half-open: one trial; the others keep skipping while it is in flight.
    expect(h.cloudJevGate(SCOPE, t)).toEqual({ ask: true, probe: true });
    expect(h.cloudJevGate(SCOPE, t)).toEqual({ ask: false });
    // The trial fails: open again for another 60 s.
    fail(true);
    expect(h.cloudJevGate(SCOPE, t + h.BREAKER_OPEN_MS - 1)).toEqual({ ask: false });
    t += h.BREAKER_OPEN_MS;
    expect(h.cloudJevGate(SCOPE, t)).toEqual({ ask: true, probe: true });
    // The trial is answered: closed, and the report clears.
    h.recordCloudJevResult(SCOPE, "answered", null, true, t);
    expect(h.cloudJevGate(SCOPE, t)).toEqual({ ask: true, probe: false });
    expect(h.cloudJevHealthErrors(t)).toEqual([]);
  });

  it("an aborted trial frees the half-open slot; a 429 is not a failure and ends the streak", async () => {
    const h = await import("@/src/hooks/semantic/cloud-jev-health");
    h.cloudJevGate(SCOPE, 0);
    for (let i = 0; i < 3; i++) h.recordCloudJevResult(SCOPE, "failed", "http-502", false, 0);
    expect(h.cloudJevGate(SCOPE, h.BREAKER_OPEN_MS)).toEqual({ ask: true, probe: true });
    h.recordCloudJevResult(SCOPE, "neutral", "aborted", true, h.BREAKER_OPEN_MS);
    expect(h.cloudJevGate(SCOPE, h.BREAKER_OPEN_MS)).toEqual({ ask: true, probe: true });
    // Cloud answered the trial with a 429: it is up, the breaker closes; its Retry-After holds the calls behind.
    h.recordCloudJevResult(SCOPE, "rate-limited", "http-429", true, h.BREAKER_OPEN_MS);
    expect(h.cloudJevGate(SCOPE, h.BREAKER_OPEN_MS)).toEqual({ ask: true, probe: false });
    // Two failures, a 429, two failures: never three in a row.
    for (const r of ["failed", "failed", "rate-limited", "failed", "failed"] as const) {
      h.recordCloudJevResult(SCOPE, r, r === "rate-limited" ? "http-429" : "timeout", false, 1);
    }
    expect(h.cloudJevGate(SCOPE, 1)).toEqual({ ask: true, probe: false });
    // The machine's own budget ("rate-limited") is reported, but says nothing about Cloud: the streak goes on.
    h.recordCloudJevResult(SCOPE, "rate-limited", "rate-limited", false, 1);
    h.recordCloudJevResult(SCOPE, "failed", "timeout", false, 1);
    expect(h.cloudJevGate(SCOPE, 1)).toEqual({ ask: false });
  });

  it("jev_rate_limited counts the fallbacks in the last 10 min, refreshes the count at most every 30 s, and clears on an answer", async () => {
    const h = await import("@/src/hooks/semantic/cloud-jev-health");
    const msg = (at: number) => h.cloudJevHealthErrors(at).map((e) => e.message);
    h.cloudJevGate(SCOPE, 0);
    h.recordCloudJevResult(SCOPE, "rate-limited", "http-429", false, 0);
    expect(h.cloudJevHealthErrors(0)).toEqual([
      { id: "jevMode", version: null, kind: "daemon", message: "jev_rate_limited: 1 call fell back to regex in the last 10 min" },
    ]);
    for (let i = 1; i <= 4; i++) h.recordCloudJevResult(SCOPE, "rate-limited", "http-429", false, i * 1_000);
    // Five now, but the report said one less than 30 s ago: not rewritten yet.
    expect(msg(5_000)).toEqual(["jev_rate_limited: 1 call fell back to regex in the last 10 min"]);
    expect(msg(30_000)).toEqual(["jev_rate_limited: 5 calls fell back to regex in the last 10 min"]);
    // Out of the window, they stop counting.
    expect(msg(h.RATE_LIMIT_WINDOW_MS + 3_500)).toEqual(["jev_rate_limited: 1 call fell back to regex in the last 10 min"]);
    expect(msg(h.RATE_LIMIT_WINDOW_MS + 4_000)).toEqual([]);
    h.recordCloudJevResult(SCOPE, "rate-limited", "http-429", false, h.RATE_LIMIT_WINDOW_MS + 6_000);
    h.recordCloudJevResult(SCOPE, "answered", null, false, h.RATE_LIMIT_WINDOW_MS + 7_000);
    expect(msg(h.RATE_LIMIT_WINDOW_MS + 7_000)).toEqual([]);
  });

  it("a reconnect (another endpoint or machine) starts clean", async () => {
    const h = await import("@/src/hooks/semantic/cloud-jev-health");
    h.cloudJevGate(SCOPE, 0);
    for (let i = 0; i < 3; i++) h.recordCloudJevResult(SCOPE, "failed", "timeout", false, 0);
    expect(h.cloudJevGate(SCOPE, 0)).toEqual({ ask: false });
    expect(h.cloudJevGate("scope-2", 0)).toEqual({ ask: true, probe: false });
    // A late result for the old connection changes nothing.
    h.recordCloudJevResult(SCOPE, "failed", "timeout", false, 0);
    expect(h.cloudJevHealthErrors(0)).toEqual([]);
  });

  it("through the hook: three 502s open it, the next call is not sent and the regex decides alone, and errors.json says so", async () => {
    await connect();
    const both: CloudJs = { id: "no-prod-db", version: 3, hooks: ["block-prod-db"], authority: "reviewable", reviewedBy: ["acme-x"], verdict: "deny" };
    deploy({ policies: [both], jevMode: "enforce" });
    const seen = stubFetch(() => ({ status: 502, body: { error: "upstream_error" } }));
    for (let i = 0; i < 3; i++) await hook(`echo ${i}`, `s${i}`);
    expect(seen).toHaveLength(3);
    const unavailable = () => readErrors().errors.filter((e) => String(e.message).startsWith("jev_unavailable"));
    expect(unavailable()).toEqual([
      {
        id: "jevMode",
        version: null,
        kind: "daemon",
        message:
          "jev_unavailable: FailproofAI Cloud Jev failed 3 or more calls in a row (last: http-502), so tool calls skip it for 60 s at a time and the regex decides alone",
      },
    ]);
    // Skipped: no request, and the both policy's regex half stays hard.
    const result = await hook("psql -h prod-db -c 'select 1'", "s4");
    expect(seen).toHaveLength(3);
    expect(result.evaluation?.decision).toBe("deny");
    expect(result.evaluation?.policyName).toBe("cloud/no-prod-db@3/block-prod-db");
    // Every hook keeps the report while it lasts.
    await hook("pwd", "s5");
    expect(unavailable()).toHaveLength(1);
  });

  it("through the hook: a 429 is reported as jev_rate_limited, never opens the breaker, and an answer clears it", async () => {
    await connect();
    deploy({ jevMode: "enforce" });
    let limited = true;
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { body?: unknown }) => {
        calls++;
        if (limited) {
          // Retry-After 0: nothing held, so every call reaches the stand-in.
          return new Response(JSON.stringify({ error: "rate_limited" }), { status: 429, headers: { "retry-after": "0" } });
        }
        const body = JSON.parse(String(init?.body)) as SeenCall["body"];
        return new Response(JSON.stringify({ model: "jev-1.13.0", answers: answerAll({ url: CLOUD_ENDPOINT, body }), cloud: cloudBlock([]) }), { status: 200 });
      }),
    );
    // The throttle empties the machine's own bucket on a 429 (those calls would fall back as
    // `rate-limited`, which counts too); emptied here so every call reaches the stand-in.
    const { resetJevThrottle } = await import("@/src/hooks/semantic/jev-throttle");
    for (let i = 0; i < 4; i++) {
      resetJevThrottle();
      await hook(`echo ${i}`, `r${i}`);
    }
    expect(calls).toBe(4);
    expect(readErrors().errors).toEqual([
      { id: "jevMode", version: null, kind: "daemon", message: "jev_rate_limited: 1 call fell back to regex in the last 10 min" },
    ]);
    limited = false;
    resetJevThrottle();
    await hook("echo ok", "r5");
    expect(calls).toBe(5);
    expect(readErrors().errors).toEqual([]);
  });

  it("a healthy machine never gets a report", async () => {
    await connect();
    deploy({ jevMode: "enforce" });
    stubFetch((call) => ({ body: { model: "jev-1.13.0", answers: answerAll(call), cloud: cloudBlock([]) } }));
    for (let i = 0; i < 3; i++) await hook(`echo ${i}`, `h${i}`);
    expect(existsSync(errorsFile())).toBe(false);
  });
});

// ── errors.json ──────────────────────────────────────────────────────────────

describe("errors.json", () => {
  const entry = { id: "p", version: 1, kind: "regex" as const, message: "m" };

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
    const { collectCloudPolicyErrors, TRANSCRIPTS_DISABLED } = await import("@/src/hooks/cloud-policy-errors");
    const errors = collectCloudPolicyErrors({
      manifestError: null,
      jsPolicies: [
        { id: "both-one", version: 2, effect: "enforce", sha256: "a", path: "p", deployment: 1, authority: "reviewable", reviewedBy: ["acme-x"] },
        { id: "regex-one", version: 1, effect: "enforce", sha256: "b", path: "q", deployment: 1 },
      ],
      jsFailures: new Map([
        ["regex-one", { type: "syntax_error" as const, reason: "Unexpected token" }],
        ["both-one", { type: "path_missing" as const, reason: "path missing: artifacts/a.mjs" }],
      ]),
      jev: { errors: [{ id: "jevMode", version: null, kind: "daemon", message: 'unknown Jev mode "loud" ignored' }] },
      jevProblem: TRANSCRIPTS_DISABLED,
      budgetDrops: [
        { id: "pack:acme/big", version: null, kind: "daemon", message: "jev_budget: dropped acme-a" },
        { id: "pack:acme/big", version: null, kind: "daemon", message: "jev_budget: dropped acme-a" },
      ],
    });
    expect(errors).toEqual([
      { id: "both-one", version: 2, kind: "both", message: "policy did not load (path_missing): path missing: artifacts/a.mjs" },
      { id: "regex-one", version: 1, kind: "regex", message: "policy did not load (syntax_error): Unexpected token" },
      { id: "jevMode", version: null, kind: "daemon", message: 'unknown Jev mode "loud" ignored' },
      { id: "pack:acme/big", version: null, kind: "daemon", message: "jev_budget: dropped acme-a" },
      { id: "jevMode", version: null, kind: "daemon", message: "transcripts_disabled" },
    ]);
  });

  it("a both policy on a machine whose Cloud mode does not ask is simply hard, and not reported", async () => {
    deploy({ policies: [{ id: "no-prod-db", version: 3, authority: "reviewable", reviewedBy: ["acme-x"] }] });
    const registered = await registeredAfterOneEvent();
    expect(registered.get("cloud/no-prod-db@3/no-prod-db-hook")?.authority).toBe("hard");
    expect(existsSync(errorsFile())).toBe(false);
  });

  it("the hook path reports a Cloud JS policy that fails to load, as kind both when it names Cloud reviewers", async () => {
    mkdirSync(join(cloudRoot, "artifacts"), { recursive: true });
    const broken = "export default {{{ not javascript";
    const digest = sha(broken);
    writeFileSync(join(cloudRoot, "artifacts", `${digest}.mjs`), broken);
    writeFileSync(
      join(cloudRoot, "active.json"),
      JSON.stringify({
        schemaVersion: 2,
        deployment: 9,
        policies: [
          { id: "broken", version: 1, sha256: digest, path: `artifacts/${digest}.mjs`, effect: "enforce", authority: "reviewable", reviewedBy: ["acme-z"] },
        ],
      }),
    );
    await registeredAfterOneEvent();
    const [problem] = readErrors().errors;
    expect(problem).toMatchObject({ id: "broken", version: 1, kind: "both" });
    expect(problem.message).toMatch(/policy did not load/);
  });

  it("an active.json a pre-release build left with semanticPolicies is read as if the key were not there", async () => {
    await connect();
    stubFetch((call) => ({ body: { model: "jev-1.13.0", answers: answerAll(call), cloud: { ...cloudBlock([]), verdict: allowVerdict } } }));
    deploy({
      policies: [{ id: "no-prod-db", version: 3, authority: "reviewable", reviewedBy: ["acme-x"] }],
      jevMode: "enforce",
      extra: { semanticPolicies: [{ id: "no-prod-db", version: 3, sha256: "a".repeat(64), path: "artifacts/gone.json" }] },
    });
    const registered = await registeredAfterOneEvent();
    expect(registered.get("cloud/no-prod-db@3/no-prod-db-hook")?.reviewedBy).toEqual(["cloud:no-prod-db/acme-x"]);
    expect(existsSync(errorsFile())).toBe(false);
  });
});

// ── Surfaces ─────────────────────────────────────────────────────────────────

describe("surfaces", () => {
  const RENDER = { render: { cols: 140, color: false }, readModelList: async () => ({ ok: false as const, reason: "no list read in tests" }) };

  it("jev status: Jev checks run on FailproofAI Cloud (mode: X), the both policies' Cloud reviewers, no check contents", async () => {
    await connect();
    localJev("off");
    deploy({
      policies: [
        { id: "no-prod-db", version: 3, authority: "reviewable", reviewedBy: ["acme-prod-db"] },
        { id: "trial", version: 1, effect: "observe", authority: "reviewable", reviewedBy: ["acme-trial"] },
        { id: "plain", version: 1 },
      ],
      jevMode: "enforce",
    });
    const { runJevCommand } = await import("@/src/hooks/jev-cli");
    const human = await runJevCommand(["status"], RENDER);
    const text = human.lines.join("\n");
    expect(text).toMatch(/on · enforce — Jev checks run on FailproofAI Cloud \(mode: enforce\)/);
    expect(text).toMatch(/no-prod-db v3\s+acme-prod-db/);
    expect(text).toMatch(/trial v1\s+acme-trial \(not asked while observed\)/);
    expect(text).not.toMatch(/plain v1/);
    expect(text).toMatch(/runs on\s+FailproofAI Cloud/);
    expect(text).not.toMatch(/AgentEye/);
    // No check contents: the machine does not have them.
    expect(text).not.toMatch(/instructions|probes|Ask the user first/);

    // No installed pack: "Jev has no checks installed" would be false under a Cloud mode.
    expect(text).not.toMatch(/no checks installed/);

    const json = JSON.parse((await runJevCommand(["status", "--json"], RENDER)).json as string);
    expect(json.reviewablePolicies).toMatchObject({ jevChecks: 0, problem: null });
    expect(json).toMatchObject({
      status: "ok",
      mode: "enforce",
      modeSetBy: "FailproofAI Cloud",
      runsOn: "FailproofAI Cloud",
      provider: "failproofai",
      cloud: {
        jevMode: "enforce",
        reviewers: [
          { policy: "no-prod-db", version: 3, effect: "enforce", reviewedBy: ["acme-prod-db"] },
          { policy: "trial", version: 1, effect: "observe", reviewedBy: ["acme-trial"] },
        ],
      },
    });
  });

  it("jev status on a decisions-only connection says why Jev does not run", async () => {
    await connect({ sessions: false });
    deploy({ jevMode: "observe" });
    const { runJevCommand } = await import("@/src/hooks/jev-cli");
    const text = (await runJevCommand(["status"], RENDER)).lines.join("\n");
    expect(text).toMatch(/FailproofAI Cloud set observe, and this machine cannot run it/);
    expect(text).toMatch(/connected for decisions only \(--no-transcripts\)/);
    const json = JSON.parse((await runJevCommand(["status", "--json"], RENDER)).json as string);
    expect(json).toMatchObject({ status: "unconfigured", problem: "transcripts_disabled" });
  });

  it("jev status with Cloud's off, and with no Cloud mode (the local answer)", async () => {
    localJev("enforce");
    deploy({ jevMode: "off" });
    const { runJevCommand } = await import("@/src/hooks/jev-cli");
    expect((await runJevCommand(["status"], RENDER)).lines.join("\n")).toMatch(/off — mode set by FailproofAI Cloud/);
    deploy({ deployment: 44 });
    const json = JSON.parse((await runJevCommand(["status", "--json"], RENDER)).json as string);
    expect(json.status).toBe("ok");
    expect(json.provider).toBe("typesafe");
    expect(json.cloud).toBeUndefined();
  });

  it("policies lists the both JS policies as both, no Jev-only entry, and the Cloud mode", async () => {
    deploy({
      policies: [
        { id: "no-prod-db", version: 3, authority: "reviewable", reviewedBy: ["acme-prod-db"] },
        { id: "trial", version: 2, effect: "observe", authority: "reviewable", reviewedBy: ["acme-trial"] },
        { id: "plain", version: 1 },
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
    expect(text).toMatch(/trial\s+v2\s+both\s+acme-trial \(not asked while observed\)/);
    expect(text).toMatch(/plain\s+v1\s+regex/);
    expect(text).not.toMatch(/\bjev\s+acme/);
    expect(text).toMatch(/Jev mode: observe — mode set by FailproofAI Cloud\. Jev checks run on\s+FailproofAI Cloud/);
  });

  it("config --disconnect's clear takes the Jev mode, the snapshot, both error reports and the budget record with active.json", async () => {
    deploy({ jevMode: "enforce" });
    writeFileSync(errorsFile(), JSON.stringify({ errors: [] }));
    writeFileSync(join(cloudRoot, "daemon-errors.json"), JSON.stringify({ errors: [] }));
    writeFileSync(budgetFile(), JSON.stringify({ machineId: MACHINE, deployment: 43, jevMode: "enforce", dropped: [] }));
    // The daemon's snapshot, which its maintenance lane rebuilds active.json
    // from: left behind, the old org's deployment came back (review M2).
    writeFileSync(join(cloudRoot, "desired-state.json"), JSON.stringify({ schemaVersion: 2, deployment: 43, policies: [] }));
    const { clearActiveCloudManagedPolicies, readCloudJevMode } = await import("@/src/hooks/cloud-managed-policies");
    expect(clearActiveCloudManagedPolicies()).toBe(true);
    for (const name of ["desired-state.json", "active.json", "errors.json", "daemon-errors.json", "jev-budget.json"]) {
      expect(existsSync(join(cloudRoot, name)), name).toBe(false);
    }
    expect(readCloudJevMode()).toBeNull();
  });
});

// ── The Cloud-mode config ────────────────────────────────────────────────────

describe("loadJevConfigForCloudMode", () => {
  const load = async (mode: "off" | "observe" | "enforce") =>
    (await import("@/src/hooks/semantic/jev-config")).loadJevConfigForCloudMode(mode);

  it("is the Cloud Jev credential as provider failproofai, whatever jev.json says", async () => {
    await connect();
    localJev("enforce");
    const r = await load("observe");
    expect(r.problem).toBeNull();
    expect(r.machineId).toBe(MACHINE);
    expect(r.config).toMatchObject({
      provider: "failproofai",
      baseUrl: `${ORIGIN}/enforcement/v1/jev`,
      mode: "observe",
      apiKey: KEY,
      credentialOrigin: ORIGIN,
    });
  });

  it("waits CLOUD_JEV_TIMEOUT_MS (5 s) for Cloud; a local BYOK jev.json keeps the 3 s default", async () => {
    const jevConfig = await import("@/src/hooks/semantic/jev-config");
    expect(jevConfig.CLOUD_JEV_TIMEOUT_MS).toBe(5_000);
    await connect();
    localJev("enforce");
    expect((await load("enforce")).config?.timeoutMs).toBe(jevConfig.CLOUD_JEV_TIMEOUT_MS);
    expect(jevConfig.loadJevConfig()?.timeoutMs).toBe(jevConfig.JEV_CONFIG_DEFAULT_TIMEOUT_MS);
    expect(jevConfig.JEV_CONFIG_DEFAULT_TIMEOUT_MS).toBe(3_000);
  });

  it.each([
    ["off", {}, { config: null, machineId: null, problem: null }],
    ["enforce", { sessions: false }, { config: null, machineId: null, problem: "transcripts_disabled" }],
    ["enforce", { jev: false }, { config: null, machineId: null, problem: "jev_unconfigured" }],
  ] as const)("mode %s with %j → %j", async (mode, connection, expected) => {
    await connect(connection);
    expect(await load(mode)).toEqual(expected);
  });

  it("no connection at all: jev_unconfigured, and decisions-only is said first", async () => {
    // No config.json: the collector's `sessions` reads false.
    expect((await load("enforce")).problem).toBe("transcripts_disabled");
    writeFileSync(join(home, "config.json"), JSON.stringify({ collector: { sessions: true } }));
    expect((await load("enforce")).problem).toBe("jev_unconfigured");
  });

  it("answers from its memo until the credentials or config.json change", async () => {
    await connect();
    const { loadJevConfigForCloudMode } = await import("@/src/hooks/semantic/jev-config");
    const first = loadJevConfigForCloudMode("observe");
    expect(loadJevConfigForCloudMode("observe")).toBe(first);
    expect(loadJevConfigForCloudMode("enforce")).not.toBe(first);
    writeFileSync(join(home, "config.json"), JSON.stringify({ mode: { kind: "cloud" }, collector: { sessions: false } }));
    expect(loadJevConfigForCloudMode("observe").problem).toBe("transcripts_disabled");
  });
});

// ── The shared contract fixtures, through the CLI's own parser ───────────────

describe("the contract fixtures, through the manifest's own parser (Cloud's publish validation mirrors it)", () => {
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
  });

  for (const { why, decl: bad } of INVALID) {
    if (why === "reserved FailproofAI name") continue;
    it(`rejects: ${why}`, async () => {
      const { parsePackSemantic } = await import("@/src/hooks/pack-manifest");
      const warnings: string[] = [];
      expect(parsePackSemantic("cloud:acme@1", [bad], warnings)).toEqual([]);
      expect(warnings).toHaveLength(1);
    });
  }

  it("the reserved-name fixture: the PARSER accepts it — Cloud's publish refuses it by name", async () => {
    const reserved = INVALID.find((c) => c.why === "reserved FailproofAI name")!.decl;
    const { parsePackSemantic } = await import("@/src/hooks/pack-manifest");
    const warnings: string[] = [];
    expect(parsePackSemantic("cloud:acme@1", [reserved], warnings).map((e) => e.name)).toEqual([reserved.name]);
    expect(warnings).toEqual([]);
    const { SEMANTIC_REVIEWER_NAMES } = await import("@/src/hooks/policy-authority");
    expect(SEMANTIC_REVIEWER_NAMES.has(reserved.name as string)).toBe(true);
  });
});

describe("the CLI's own question count, pinned to the shared fixture Cloud's budget mirrors", () => {
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

// ── C9.5: reports carry no local paths ───────────────────────────────────────

describe("C9.5: reports carry no local paths", () => {
  it("redactLocalPaths: home becomes ~, other absolute paths their last segment (the daemon's cases)", async () => {
    const { redactLocalPaths } = await import("@/src/hooks/cloud-policy-errors");
    const home2 = "/home/alice";
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
      // After `:` too (review F6), but never a URL's `//host`.
      ["import failed: file:///tmp/fp-load-1/x.mjs not found", "import failed: file:x.mjs not found"],
      ["open:/etc/fp/x failed", "open:x failed"],
      ["at file:///home/alice/.failproofai/x.mjs:3", "at file://~/.failproofai/x.mjs:3"],
      ["see http://localhost:8080/a/b and ssh://git@host/r", "see http://localhost:8080/a/b and ssh://git@host/r"],
      ["a bare scheme:// stays", "a bare scheme:// stays"],
    ];
    for (const [input, expected] of cases) {
      expect(redactLocalPaths(input, home2)).toBe(expected);
      // Applied twice (CLI, then daemon): the second pass changes nothing.
      expect(redactLocalPaths(expected, home2)).toBe(expected);
    }
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

describe("read once per change", () => {
  it("readCloudJevMode and readCloudJevState answer from the cached active.json until it changes", async () => {
    deploy({ jevMode: "observe", deployment: 5 });
    const mod = await import("@/src/hooks/cloud-managed-policies");
    expect(mod.readCloudJevMode()).toBe("observe");
    expect(mod.readCloudJevState()).toEqual({ jevMode: "observe", deployment: 5, errors: [] });
    deploy({ jevMode: "enforce", deployment: 6 });
    expect(mod.readCloudJevMode()).toBe("enforce");
    expect(mod.readCloudJevState().deployment).toBe(6);
    deploy({ jevMode: "loud", deployment: 7 });
    expect(mod.readCloudJevState()).toEqual({
      jevMode: null,
      deployment: 7,
      errors: [{ id: "jevMode", version: null, kind: "daemon", message: 'unknown Jev mode "loud" ignored' }],
    });
  });
});
