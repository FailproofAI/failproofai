import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";

// The interactive prompts, the install manager, telemetry and CLI detection are
// mocked so the wizard can be driven head-lessly and its exact side effects
// asserted without touching a real TTY, systemd, or the network.
vi.mock("../../src/hooks/tui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hooks/tui")>();
  // Keep the pure helpers (screenKit, paint, collapseAfter) real; stub only the
  // interactive prompts.
  return {
    ...actual,
    selectOne: vi.fn(),
    multiSelect: vi.fn(),
    promptText: vi.fn(),
    promptCloudKey: vi.fn(),
  };
});
vi.mock("../../src/hooks/manager", () => ({
  installHooks: vi.fn(async () => {}),
  notEnforcingReason: vi.fn(() => "no-policies"),
  enforcingPolicyCount: vi.fn(() => ({ count: 0, custom: false })),
}));
// The apply path resolves project-scoped config from `process.cwd()` — this
// repository, under test. A run that wrote there once committed custom policies
// switched off for everyone who pulled. Redirected rather than stubbed, so the
// real code still runs against a temp file.
vi.mock("../../src/hooks/hooks-config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hooks/hooks-config")>();
  const { mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { resolve: join } = await import("node:path");
  const dir = join(tmpdir(), `fpai-wizard-cfg-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  return {
    ...actual,
    getConfigPathForScope: (scope: string, cwd?: string) =>
      scope === "user"
        ? actual.getConfigPathForScope("user", cwd)
        : join(dir, scope === "local" ? "policies-config.local.json" : "policies-config.json"),
  };
});
// Only what shells out is stubbed; setDaemonConfigured stays real so the
// `daemonConfigured` assertions test the actual marker write.
vi.mock("../../src/hooks/daemon-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hooks/daemon-service")>();
  return {
    ...actual,
    isDaemonSupportedPlatform: vi.fn(() => true),
    installDaemonService: vi.fn(async () => ({ installed: true })),
    daemonServiceFilePath: vi.fn(() => null),
    daemonServiceStatus: vi.fn(() => "running" as const),
    daemonServiceNeedsUpgrade: vi.fn(() => false),
    ensureDaemonServiceCurrent: vi.fn(async () => ({ outcome: "current" as const })),
    daemonStatusCommand: vi.fn(() => "systemctl status failproofaid@test"),
    primeElevation: vi.fn(() => true),
    canElevate: vi.fn(() => true),
    probeDaemonEndToEnd: vi.fn(async () => true),
    probeDaemon: vi.fn(async () => ({ ok: true })),
    uninstallDaemonService: vi.fn(async () => {}),
  };
});
vi.mock("../../src/hooks/cloud-connection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hooks/cloud-connection")>();
  return {
    ...actual,
    connectToCloud: vi.fn(async () => ({
      policy: { ok: true, policyCount: 2, deployment: 7 },
      ingest: { ok: true },
      anyConfigured: true,
    })),
  };
});
vi.mock("../../src/hooks/collector-config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hooks/collector-config")>();
  return { ...actual, validateIngestKey: vi.fn(async () => ({ ok: true })) };
});
// Introspect is the first check a key gets. "unsupported" (an older server)
// hands the decision to the ingest probe above, which each test controls.
vi.mock("../../src/hooks/cloud-introspect", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hooks/cloud-introspect")>();
  return { ...actual, introspectKey: vi.fn(async () => ({ kind: "unsupported" })) };
});
vi.mock("../../src/audit/cli", () => ({ runPostSetupAudit: vi.fn(async () => {}) }));
vi.mock("../../src/hooks/hook-telemetry", () => ({ trackHookEvent: vi.fn(async () => {}) }));
vi.mock("../../lib/telemetry-id", () => ({ getInstanceId: vi.fn(() => "test-id") }));
vi.mock("../../src/hooks/integrations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hooks/integrations")>();
  return { ...actual, detectInstalledClis: vi.fn(() => ["claude"]) };
});

import {
  multiSelect,
  promptCloudKey,
  OPEN_SOURCE,
  paint,
  screenKit,
  type CloudKeyAnswer,
  type CloudKeyPromptOptions,
  type MultiSelectOptions,
  type OpenSource,
  type TTYIn,
  type TTYOut,
} from "../../src/hooks/tui";
import { connectToCloud } from "../../src/hooks/cloud-connection";
import { validateIngestKey, writeIngestCredential, writeCollectorSettings } from "../../src/hooks/collector-config";
import { introspectKey } from "../../src/hooks/cloud-introspect";
import { installHooks, notEnforcingReason, enforcingPolicyCount } from "../../src/hooks/manager";
import {
  isDaemonSupportedPlatform,
  installDaemonService,
  daemonServiceStatus,
  daemonServiceNeedsUpgrade,
  ensureDaemonServiceCurrent,
  primeElevation,
  canElevate,
  probeDaemon,
  probeDaemonEndToEnd,
  uninstallDaemonService,
} from "../../src/hooks/daemon-service";
import {
  agentChanges,
  agentChoices,
  agentTag,
  agentsCollapsedLines,
  checkCloudKey,
  cloudCollapsedLines,
  defaultSelection,
  doneLines,
  planAgents,
  removeUserScopeHooks,
  resolveCloudUrl,
  runConfigureWizard,
  maybeFirstRunConfigure,
  hasSeenLauncher,
  markLauncherSeen,
} from "../../src/hooks/configure-wizard";
import { INTEGRATION_TYPES, type IntegrationType } from "../../src/hooks/types";
import { detectInstalledClis, getIntegration } from "../../src/hooks/integrations";
import { runPostSetupAudit } from "../../src/audit/cli";
import { trackHookEvent } from "../../src/hooks/hook-telemetry";
import { configFile as fpConfigFile, credentialsFile, launcherMarker } from "../../src/hooks/fp-home";
import { readConfig as readFpConfig, updateConfig } from "../../src/hooks/fp-config";
import { backfillRequestPath } from "../../src/hooks/backfill-request";

const mkTtyStdin = (): TTYIn => ({ isTTY: true }) as unknown as TTYIn;
const mkTtyStdout = (): TTYOut => ({ isTTY: true, write: vi.fn(() => true), columns: 80 }) as unknown as TTYOut;
const ttyIO = () => ({ stdin: mkTtyStdin(), stdout: mkTtyStdout() });
/** A pipe, a CI job, or an agent driving the CLI — anything without a terminal. */
const headlessIO = () => ({
  stdin: { isTTY: false } as unknown as TTYIn,
  stdout: { isTTY: false, write: vi.fn(() => true), columns: 80 } as unknown as TTYOut,
});
const printed = (stdout: TTYOut): string =>
  vi.mocked(stdout.write).mock.calls.map((c) => String(c[0])).join("").replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b[78]/g, "");

/**
 * Queue answers for a run BY NAME. Two prompts are left: the cloud-key field
 * and the agents picker. Without an answer queued, the cloud step takes Tab
 * (open source) and the picker takes Enter on whatever it opened with.
 */
function drive(answers: { cloud?: CloudKeyAnswer | OpenSource | null; agents?: IntegrationType[] | null }) {
  if ("cloud" in answers) vi.mocked(promptCloudKey).mockResolvedValueOnce(answers.cloud as never);
  if ("agents" in answers) vi.mocked(multiSelect).mockResolvedValueOnce(answers.agents as never);
}
const cloudOpts = (): CloudKeyPromptOptions => vi.mocked(promptCloudKey).mock.calls[0]![0];
const agentOpts = (): MultiSelectOptions<IntegrationType> =>
  vi.mocked(multiSelect).mock.calls[0]![0] as unknown as MultiSelectOptions<IntegrationType>;

// The apply path writes under homedir()/.failproofai — HOME is isolated for the
// whole file so no test ever touches the developer's real config.
let fileHome: string;
let realHome: string | undefined;
/** Must match the path built inside the hooks-config mock factory above. */
const WIZARD_TEST_CONFIG_DIR = resolve(tmpdir(), `fpai-wizard-cfg-${process.pid}`);
beforeAll(() => {
  realHome = process.env.HOME;
  fileHome = mkdtempSync(resolve(tmpdir(), "fpai-cfg-"));
  process.env.HOME = fileHome;
});
afterAll(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(fileHome, { recursive: true, force: true });
  rmSync(WIZARD_TEST_CONFIG_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  // Every run starts on a fresh machine: no saved selection, no credentials,
  // no pending request, no marker.
  rmSync(fpConfigFile(), { force: true });
  rmSync(credentialsFile(), { force: true });
  rmSync(backfillRequestPath(), { force: true });
  rmSync(launcherMarker(fileHome), { force: true });
  delete process.env.FAILPROOFAI_CLOUD_URL;
  vi.mocked(promptCloudKey).mockReset().mockResolvedValue(OPEN_SOURCE);
  vi.mocked(multiSelect)
    .mockReset()
    .mockImplementation(async (opts) => opts.choices.filter((c) => c.checked).map((c) => c.value) as never);
  vi.mocked(installHooks).mockClear();
  vi.mocked(runPostSetupAudit).mockClear();
  vi.mocked(trackHookEvent).mockClear();
  vi.mocked(detectInstalledClis).mockReset().mockReturnValue(["claude"]);
  vi.mocked(notEnforcingReason).mockReset().mockReturnValue("no-policies");
  vi.mocked(enforcingPolicyCount).mockReset().mockReturnValue({ count: 0, custom: false });
  vi.mocked(connectToCloud)
    .mockReset()
    .mockResolvedValue({ policy: { ok: true, policyCount: 2, deployment: 7 }, ingest: { ok: true }, anyConfigured: true });
  vi.mocked(validateIngestKey).mockReset().mockResolvedValue({ ok: true });
  vi.mocked(introspectKey).mockReset().mockResolvedValue({ kind: "unsupported" });
  // Healthy and already running is the default: the DAEMON step is one line
  // and needs no password. Daemon tests override these.
  vi.mocked(isDaemonSupportedPlatform).mockReset().mockReturnValue(true);
  vi.mocked(daemonServiceStatus).mockReset().mockReturnValue("running");
  vi.mocked(daemonServiceNeedsUpgrade).mockReset().mockReturnValue(false);
  vi.mocked(ensureDaemonServiceCurrent).mockReset().mockResolvedValue({ outcome: "current" });
  vi.mocked(installDaemonService).mockReset().mockResolvedValue({ installed: true });
  vi.mocked(primeElevation).mockReset().mockReturnValue(true);
  vi.mocked(canElevate).mockReset().mockReturnValue(true);
  vi.mocked(probeDaemonEndToEnd).mockReset().mockResolvedValue(true);
  vi.mocked(probeDaemon).mockReset().mockResolvedValue({ ok: true });
  vi.mocked(uninstallDaemonService).mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const c = paint(false);
const kit = screenKit({ cols: 80, color: false });

// ── Pure builders ────────────────────────────────────────────────────────────

describe("planAgents", () => {
  it("first run: ticks what is detected, lists all twelve, detected first", () => {
    const plan = planAgents({ detected: ["codex", "claude"], hooked: [] });
    expect(plan.mode).toBe("first");
    expect(plan.initial).toEqual(["claude", "codex"]);
    expect(plan.order).toHaveLength(INTEGRATION_TYPES.length);
    expect(plan.order.slice(0, 2)).toEqual(["claude", "codex"]);
    expect(plan.seen).toEqual(["claude", "codex"]);
  });

  it("rerun: restores the saved selection exactly, plus anything new, ticked", () => {
    const plan = planAgents({
      detected: ["claude", "codex", "goose", "hermes"],
      saved: { selected: ["claude", "openclaw"], seen: ["claude", "codex", "goose"] },
      hooked: [],
    });
    expect(plan.mode).toBe("rerun");
    // codex and goose were seen and left unticked: they stay unticked. hermes
    // was never seen: it arrives ticked. openclaw is not detected but saved.
    expect(new Set(plan.initial)).toEqual(new Set(["claude", "hermes", "openclaw"]));
    expect([...plan.fresh]).toEqual(["hermes"]);
  });

  it("seen accumulates, so a PATH glitch cannot make an unticked agent new again", () => {
    const glitch = planAgents({
      detected: ["claude"],
      saved: { selected: ["claude"], seen: ["claude", "goose"] },
      hooked: [],
    });
    expect(glitch.seen).toContain("goose");
    const back = planAgents({ detected: ["claude", "goose"], saved: { selected: ["claude"], seen: glitch.seen }, hooked: [] });
    expect(back.fresh.size).toBe(0);
    expect(back.initial).toEqual(["claude"]);
  });

  it("upgrade: what is protected today, neither widened nor narrowed", () => {
    // A machine set up since 1.0.2 has every agent hooked, detected or not.
    const plan = planAgents({ detected: ["claude"], hooked: [...INTEGRATION_TYPES] });
    expect(plan.mode).toBe("upgrade");
    expect(new Set(plan.initial)).toEqual(new Set(INTEGRATION_TYPES));
  });

  it("drops names it does not know instead of offering them", () => {
    const plan = planAgents({ detected: ["claude"], saved: { selected: ["claude", "claud"], seen: ["nope"] }, hooked: [] });
    expect(plan.initial).toEqual(["claude"]);
    expect(plan.seen).toEqual(["claude"]);
  });

  it("keeps a saved empty selection: an unattended re-run puts nothing back", () => {
    const plan = planAgents({ detected: ["claude"], saved: { selected: [], seen: ["claude"] }, hooked: [] });
    expect(defaultSelection(plan)).toEqual([]);
    expect(agentsCollapsedLines(kit, plan, [], false, c)).toEqual(["AGENTS", "▲ Tracing no agents.  ·  failproofai config"]);
  });

  it("defaults to every agent only when nothing is detected, hooked or saved", () => {
    expect(defaultSelection(planAgents({ detected: [], hooked: [] }))).toHaveLength(INTEGRATION_TYPES.length);
    expect(defaultSelection(planAgents({ detected: ["claude"], hooked: [] }))).toEqual(["claude"]);
  });

  it("names what a selection adds and removes against the baseline", () => {
    const plan = planAgents({ detected: ["claude", "goose"], saved: { selected: ["claude", "goose"], seen: ["claude", "goose"] }, hooked: [] });
    expect(agentChanges(plan, ["claude", "codex"])).toEqual({ added: ["codex"], removed: ["goose"] });
    // A first run adds nothing back: nothing was traced before it.
    expect(agentChanges(planAgents({ detected: ["claude"], hooked: [] }), ["claude"]).added).toEqual([]);
  });
});

describe("agent rows and tags", () => {
  it("one row per agent, ticked as the plan opens", () => {
    const rows = agentChoices(planAgents({ detected: ["claude"], hooked: [] }));
    expect(rows).toHaveLength(INTEGRATION_TYPES.length);
    expect(rows[0]).toMatchObject({ label: "Claude Code", value: "claude", checked: true });
    expect(rows.filter((r) => r.checked)).toHaveLength(1);
  });

  it("tags new, will be added, will be removed and not installed, in that order", () => {
    const plan = planAgents({
      detected: ["claude", "hermes", "goose"],
      saved: { selected: ["claude", "goose"], seen: ["claude", "goose"] },
      hooked: [],
    });
    const tag = agentTag(plan, c);
    expect(tag("hermes", true)).toBe("new on this machine");
    expect(tag("openclaw", true)).toBe("will be added");
    expect(tag("goose", false)).toBe("will be removed");
    expect(tag("pi", false)).toBe("not installed");
    expect(tag("claude", true)).toBeUndefined();
  });

  it("puts no change tags on a first run, where every tick would read as added", () => {
    const tag = agentTag(planAgents({ detected: ["claude"], hooked: [] }), c);
    expect(tag("claude", true)).toBeUndefined();
    expect(tag("codex", true)).toBe("not installed");
  });
});

describe("agentsCollapsedLines", () => {
  it("names the agents when nothing changed, wrapped inside the width", () => {
    const plan = planAgents({ detected: [...INTEGRATION_TYPES], hooked: [] });
    const lines = agentsCollapsedLines(kit, plan, plan.initial, false, c);
    expect(lines[0]).toBe("AGENTS");
    expect(lines[1]).toMatch(/^✓ Tracing 12 agents: Claude Code, /);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);
    expect(lines.slice(2).every((l) => l.startsWith("  "))).toBe(true);
  });

  it("says what was added and removed, promising only what the code does", () => {
    const plan = planAgents({ detected: ["claude", "goose"], saved: { selected: ["claude", "goose"], seen: ["claude", "goose"] }, hooked: [] });
    const connected = agentsCollapsedLines(kit, plan, ["claude", "openclaw", "hermes"], true, c).join("\n");
    expect(connected).toContain("✓ Tracing 3 agents");
    expect(connected).toContain("Added Hermes and OpenClaw.");
    expect(connected).toContain("Removed Goose: no longer hooked or collected. Sessions already collected are kept.");
    // No history clause anywhere (decision D7).
    expect(connected).not.toMatch(/days|history/);
    // Open source collects nothing, so it promises nothing about collection.
    const local = agentsCollapsedLines(kit, plan, ["claude"], false, c).join("\n");
    expect(local).toContain("Removed Goose: no longer hooked.");
    expect(local).not.toContain("collected");
  });
});

describe("cloud helpers", () => {
  it("resolves --url, then FAILPROOFAI_CLOUD_URL, then the existing connection, then hosted", () => {
    expect(resolveCloudUrl(undefined, undefined)).toEqual({ ok: true, url: "https://app.befailproof.ai" });
    expect(resolveCloudUrl(undefined, "https://self.example.com")).toEqual({ ok: true, url: "https://self.example.com" });
    process.env.FAILPROOFAI_CLOUD_URL = "http://localhost:8080";
    expect(resolveCloudUrl(undefined, "https://self.example.com")).toEqual({ ok: true, url: "http://localhost:8080", source: "FAILPROOFAI_CLOUD_URL" });
    expect(resolveCloudUrl("http://localhost:9911", undefined)).toMatchObject({ url: "http://localhost:9911", source: "--url" });
  });

  it("refuses an unusable override instead of falling back to hosted", () => {
    const r = resolveCloudUrl("http://cloud.example.com", undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("--url is");
  });

  it("accepts a key that can do both, naming its organisation", async () => {
    vi.mocked(introspectKey).mockResolvedValue({ kind: "ok", identity: { orgName: "Acme", permissions: ["events:add", "policies:pull"] } });
    expect(await checkCloudKey("https://x.example.com", "k")).toEqual({ ok: true, org: "Acme", note: undefined });
    expect(validateIngestKey).not.toHaveBeenCalled();
  });

  it("accepts half a key with a note, and refuses one that can do neither", async () => {
    vi.mocked(introspectKey).mockResolvedValueOnce({ kind: "ok", identity: { permissions: ["events:add"] } });
    expect(await checkCloudKey("u", "k")).toMatchObject({ ok: true, note: expect.stringContaining("policies:pull") });
    vi.mocked(introspectKey).mockResolvedValueOnce({ kind: "ok", identity: { permissions: ["jev:evaluate"] } });
    expect(await checkCloudKey("u", "k")).toEqual({ ok: false, refused: true, reason: "it is missing the events:add permission" });
  });

  it("tells a refusal from not being able to ask", async () => {
    vi.mocked(introspectKey).mockResolvedValueOnce({ kind: "rejected" });
    expect(await checkCloudKey("u", "k")).toMatchObject({ ok: false, refused: true });
    vi.mocked(introspectKey).mockResolvedValueOnce({ kind: "unreachable", reason: "ENOTFOUND" });
    expect(await checkCloudKey("u", "k")).toEqual({ ok: false, refused: false, reason: "ENOTFOUND" });
  });

  it("falls back to the ingest probe on a server too old for introspect", async () => {
    vi.mocked(validateIngestKey).mockResolvedValueOnce({ ok: false, reason: "the server rejected that key (401)" });
    expect(await checkCloudKey("https://x.example.com", "k")).toMatchObject({ ok: false, refused: true });
    expect(vi.mocked(validateIngestKey).mock.calls[0]![0]).toEqual({ url: "https://x.example.com/v1/events", key: "k" });
    vi.mocked(validateIngestKey).mockResolvedValueOnce({ ok: false, reason: "could not reach the server (fetch failed)" });
    expect(await checkCloudKey("u", "k")).toMatchObject({ ok: false, refused: false });
  });

  it("collapses the CONNECT step to what was checked, never what was written", () => {
    const at = { host: "app.befailproof.ai", savedHost: "app.befailproof.ai", savedOrg: "acme" };
    expect(cloudCollapsedLines(kit, { kind: "oss" }, at)).toEqual(["CONNECT TO CLOUD", "✓ Using open source."]);
    expect(cloudCollapsedLines(kit, { kind: "kept", how: "skip", verified: false }, at)[1]).toBe(
      "✓ Not connecting. The connection to app.befailproof.ai is unchanged.",
    );
    expect(cloudCollapsedLines(kit, { kind: "kept", how: "saved", verified: true }, at)[1]).toBe(
      "✓ Connected as acme to app.befailproof.ai",
    );
    expect(cloudCollapsedLines(kit, { kind: "connect", token: "k", org: "acme" }, at)[1]).toBe(
      "✓ Key accepted for acme on app.befailproof.ai",
    );
    expect(cloudCollapsedLines(kit, { kind: "oss" }, { ...at, source: "--url" })[0]).toBe(
      "CONNECT TO CLOUD  app.befailproof.ai  ·  from --url",
    );
  });
});

describe("doneLines", () => {
  it("gives the one generic warning, and our pack, when nothing enforces", () => {
    const lines = doneLines(kit, { elapsedMs: 2100, done: [], cwd: "/tmp/x", agents: 9, connected: false });
    expect(lines[0]).toBe("DONE  in 2.1s");
    expect(lines).toContain("▲ Policies are not enforcing yet.");
    expect(lines).toContain("  Turn on ours:  failproofai policies add FailproofAI/policies");
    expect(lines).toContain("  Connect to cloud any time:  failproofai config");
  });

  it("counts what enforces, on how many agents", () => {
    vi.mocked(notEnforcingReason).mockReturnValue(null);
    vi.mocked(enforcingPolicyCount).mockReturnValue({ count: 10, custom: false });
    const lines = doneLines(kit, { elapsedMs: 800, done: [], cwd: "/tmp/x", agents: 8, connected: true });
    expect(lines).toContain("✓ 10 policies are enforcing on 8 agents.");
    expect(lines.join("\n")).not.toContain("Connect to cloud any time");
    vi.mocked(enforcingPolicyCount).mockReturnValue({ count: 0, custom: true });
    expect(doneLines(kit, { elapsedMs: 1, done: [], cwd: "/x", agents: 1, connected: true })).toContain(
      "✓ Your custom policies are enforcing on 1 agent.",
    );
  });
});

describe("doneLines — custom policy files", () => {
  it("names a policy file that will not load, which the review step used to", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "fpai-done-"));
    try {
      mkdirSync(resolve(dir, ".failproofai", "policies"), { recursive: true });
      writeFileSync(resolve(dir, ".failproofai", "policies", "team.mjs"), "export {};\n");
      const lines = doneLines(kit, { elapsedMs: 1, done: [], cwd: dir, agents: 1, connected: true }).join("\n");
      expect(lines).toContain("is NOT loaded — rename to team-policies.mjs");
      expect(lines).toMatch(/▲ .*team\.mjs/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("removeUserScopeHooks", () => {
  it("takes hooks out of that agent's user settings and touches no policy config", () => {
    const userCfg = resolve(fileHome, ".failproofai", "policies-config.json");
    mkdirSync(dirname(userCfg), { recursive: true });
    writeFileSync(userCfg, JSON.stringify({ enabledPolicies: ["block-sudo"], policyParams: { x: { y: 1 } } }));
    const projectCfg = resolve(WIZARD_TEST_CONFIG_DIR, "policies-config.json");
    writeFileSync(projectCfg, JSON.stringify({ enabledPolicies: ["block-rm-rf"] }));
    const before = [readFileSync(userCfg, "utf8"), readFileSync(projectCfg, "utf8")];
    const goose = getIntegration("goose");
    const settings = goose.getSettingsPath("user");
    mkdirSync(dirname(settings), { recursive: true });
    writeFileSync(settings, "{}");
    const remove = vi.spyOn(goose, "removeHooksFromFile").mockReturnValue(3);
    const claudeRemove = vi.spyOn(getIntegration("claude"), "removeHooksFromFile");

    expect(removeUserScopeHooks(["goose"], "/tmp/x")).toBe(3);

    expect(remove).toHaveBeenCalledWith(settings);
    expect(claudeRemove).not.toHaveBeenCalled();
    expect([readFileSync(userCfg, "utf8"), readFileSync(projectCfg, "utf8")]).toEqual(before);
    rmSync(userCfg, { force: true });
    rmSync(projectCfg, { force: true });
  });
});

// ── The run ──────────────────────────────────────────────────────────────────

describe("runConfigureWizard", () => {
  it("asks two things — the key, then the agents — and installs at user scope", async () => {
    const result = await runConfigureWizard(ttyIO());

    expect(result.applied).toBe(true);
    expect(promptCloudKey).toHaveBeenCalledTimes(1);
    expect(multiSelect).toHaveBeenCalledTimes(1);
    expect(agentOpts().message).toBe("Which agents should failproofai trace?");
    expect(installHooks).toHaveBeenCalledTimes(1);
    const call = vi.mocked(installHooks).mock.calls[0]!;
    expect(call[1]).toBe("user");
    expect(call[4]).toBe("configure-wizard");
    expect(call[7]).toEqual(["claude"]);
    expect(call[8]).toEqual({ replace: true, quiet: true });
  });

  it("saves the selection, and what it saw", async () => {
    vi.mocked(detectInstalledClis).mockReturnValue(["claude", "goose"]);
    drive({ agents: ["goose"] });
    await runConfigureWizard(ttyIO());
    expect(readFpConfig().agents).toEqual({ selected: ["goose"], seen: ["claude", "goose"] });
  });

  it("opens a rerun on the saved selection, with what is new ticked", async () => {
    updateConfig({ agents: { selected: ["claude"], seen: ["claude"] } });
    vi.mocked(detectInstalledClis).mockReturnValue(["claude", "hermes"]);
    await runConfigureWizard(ttyIO());
    const opts = agentOpts();
    expect(opts.choices.filter((ch) => ch.checked).map((ch) => ch.value)).toEqual(["claude", "hermes"]);
    const meta = typeof opts.meta === "function" ? opts.meta(["claude", "hermes"]) : "";
    expect(meta).toBe("2 of 12 selected  ·  from last setup");
    // The longest heading this can draw still fits 80 columns.
    expect(`${opts.message.toUpperCase()}  ${typeof opts.meta === "function" ? opts.meta([...INTEGRATION_TYPES]) : ""}`.length).toBeLessThanOrEqual(80);
    expect(opts.minSelected).toBe(1);
    expect(opts.minMessage).toBe("Pick at least one agent.");
  });

  it("seeds an upgrade from the agents hooked at user scope today", async () => {
    vi.spyOn(getIntegration("codex"), "hooksInstalledInSettings").mockImplementation((scope) => scope === "user");
    await runConfigureWizard(ttyIO());
    expect(agentOpts().choices.filter((ch) => ch.checked).map((ch) => ch.value)).toEqual(["codex"]);
    const meta = agentOpts().meta;
    expect(typeof meta === "function" && meta([...INTEGRATION_TYPES])).toBe("12 of 12 selected  ·  as protected today");
  });

  it("writes back exactly the policies already enabled, adding none of its own", async () => {
    const cfgPath = resolve(fileHome, ".failproofai", "policies-config.json");
    mkdirSync(dirname(cfgPath), { recursive: true });
    writeFileSync(cfgPath, JSON.stringify({ enabledPolicies: ["block-kubectl", "some-pack-policy"] }));
    try {
      await runConfigureWizard(ttyIO());
      expect(vi.mocked(installHooks).mock.calls[0]![0]).toEqual(["block-kubectl", "some-pack-policy"]);
    } finally {
      rmSync(cfgPath, { force: true });
    }
  });

  it("removes hooks only for agents unticked, at user scope", async () => {
    updateConfig({ agents: { selected: ["claude", "goose"], seen: ["claude", "goose"] } });
    const goose = vi.spyOn(getIntegration("goose"), "removeHooksFromFile").mockReturnValue(1);
    const settings = getIntegration("goose").getSettingsPath("user");
    mkdirSync(dirname(settings), { recursive: true });
    writeFileSync(settings, "{}");
    drive({ agents: ["claude"] });

    const result = await runConfigureWizard(ttyIO());

    expect(result.agents).toEqual({ selected: ["claude"], added: [], removed: ["goose"] });
    expect(goose).toHaveBeenCalledWith(settings);
    expect(vi.mocked(installHooks).mock.calls[0]![7]).toEqual(["claude"]);
  });

  it("never writes into the repository's own config", async () => {
    const repoConfig = resolve(process.cwd(), ".failproofai", "policies-config.json");
    const before = existsSync(repoConfig) ? readFileSync(repoConfig, "utf8") : null;
    await runConfigureWizard(ttyIO());
    expect(existsSync(repoConfig) ? readFileSync(repoConfig, "utf8") : null).toBe(before);
  });

  it("Esc at the key leaves everything untouched, the daemon included", async () => {
    vi.mocked(daemonServiceStatus).mockReturnValue("not-installed");
    drive({ cloud: null });
    const result = await runConfigureWizard(ttyIO());
    expect(result).toEqual({ applied: false, abort: "cancelled" });
    expect(installDaemonService).not.toHaveBeenCalled();
    expect(connectToCloud).not.toHaveBeenCalled();
    expect(installHooks).not.toHaveBeenCalled();
  });

  it("Esc at the agents leaves everything untouched, a typed key included", async () => {
    vi.mocked(daemonServiceStatus).mockReturnValue("not-installed");
    drive({ cloud: { kind: "typed", key: "a-real-looking-key" }, agents: null });
    const result = await runConfigureWizard(ttyIO());
    expect(result.abort).toBe("cancelled");
    expect(installDaemonService).not.toHaveBeenCalled();
    expect(connectToCloud).not.toHaveBeenCalled();
    expect(readFpConfig().agents).toBeUndefined();
  });

  it("draws the design: logo, header, then a section per step, then DONE", async () => {
    const io = ttyIO();
    await runConfigureWizard(io);
    const out = printed(io.stdout);
    expect(out).toContain("Set up this machine");
    expect(out.indexOf("DAEMON")).toBeLessThan(out.indexOf("DONE"));
    expect(out).toContain("✓ failproofaid");
    expect(out).toContain("▲ Policies are not enforcing yet.");
  });

  it("sends counts, never names, with the completion event", async () => {
    vi.mocked(detectInstalledClis).mockReturnValue(["claude", "codex"]);
    await runConfigureWizard(ttyIO());
    const props = vi.mocked(trackHookEvent).mock.calls.find((call) => call[1] === "configure_applied")![2] as Record<string, unknown>;
    expect(props).toMatchObject({ mode: "oss", agents_selected: 2, agents_detected: 2, agents_changed: false });
  });
});

describe("headless runs", () => {
  it("sets the machine up with no terminal, asking nothing", async () => {
    const result = await runConfigureWizard(headlessIO());
    expect(result.applied).toBe(true);
    expect(promptCloudKey).not.toHaveBeenCalled();
    expect(multiSelect).not.toHaveBeenCalled();
    expect(primeElevation).not.toHaveBeenCalled();
    expect(installHooks).toHaveBeenCalled();
  });

  it("keeps the saved selection, or takes the detected agents", async () => {
    vi.mocked(detectInstalledClis).mockReturnValue(["claude", "codex"]);
    await runConfigureWizard(headlessIO());
    expect(vi.mocked(installHooks).mock.calls[0]![7]).toEqual(["claude", "codex"]);
    updateConfig({ agents: { selected: ["codex"], seen: ["claude", "codex"] } });
    vi.mocked(installHooks).mockClear();
    await runConfigureWizard(headlessIO());
    expect(vi.mocked(installHooks).mock.calls[0]![7]).toEqual(["codex"]);
  });

  it("changes nothing about a connection when no key was given", async () => {
    writeIngestCredential({ url: "https://app.befailproof.ai/v1/events", key: "s".repeat(20) });
    const result = await runConfigureWizard(headlessIO());
    expect(result.mode).toBe("cloud");
    expect(connectToCloud).not.toHaveBeenCalled();
  });

  it("hooks nothing on a re-run whose saved selection is empty", async () => {
    updateConfig({ agents: { selected: [], seen: ["claude"] } });
    const result = await runConfigureWizard(headlessIO());
    expect(result.applied).toBe(true);
    expect(installHooks).not.toHaveBeenCalled();
    expect(readFpConfig().agents?.selected).toEqual([]);
  });

  it("takes --agents as given and skips the step", async () => {
    await runConfigureWizard(ttyIO(), { agents: ["goose", "claude"] });
    expect(multiSelect).not.toHaveBeenCalled();
    expect(vi.mocked(installHooks).mock.calls[0]![7]).toEqual(["claude", "goose"]);
  });
});

describe("connect step", () => {
  it("draws the field with the host, and the saved key when there is one", async () => {
    await runConfigureWizard(ttyIO());
    expect(cloudOpts()).toMatchObject({ message: "Connect to cloud", meta: "app.befailproof.ai", tabHint: "use open source instead" });
    expect(cloudOpts().saved).toBeUndefined();
  });

  it("connects a typed key at apply, with transcripts on", async () => {
    drive({ cloud: { kind: "typed", key: "a-real-looking-key" } });
    const result = await runConfigureWizard(ttyIO());
    expect(result.connected).toBe(true);
    expect(vi.mocked(connectToCloud).mock.calls[0]![0]).toMatchObject({
      url: "https://app.befailproof.ai",
      token: "a-real-looking-key",
      sessions: true,
    });
  });

  it("checks a typed key without writing it, and reports a refusal", async () => {
    vi.mocked(validateIngestKey).mockResolvedValue({ ok: false, reason: "the server rejected that key (401)" });
    await runConfigureWizard(ttyIO());
    expect(await cloudOpts().check("bad-key-123")).toEqual({
      ok: false,
      line: "That key was refused: the server rejected that key (401).",
    });
    expect(connectToCloud).not.toHaveBeenCalled();
  });

  it("keeps a saved connection as it is on enter, without reconnecting", async () => {
    writeIngestCredential({ url: "https://app.befailproof.ai/v1/events", key: "saved-key-3f2a" });
    drive({ cloud: { kind: "saved", verified: true } });
    const result = await runConfigureWizard(ttyIO());
    expect(cloudOpts().saved?.masked).toBe("****3f2a");
    expect(cloudOpts().tabHint).toBe("skip");
    expect(connectToCloud).not.toHaveBeenCalled();
    expect(result.mode).toBe("cloud");
    expect(readFpConfig().mode).toBe("cloud");
  });

  it("checks the saved key in the background and says what it found", async () => {
    writeIngestCredential({ url: "https://app.befailproof.ai/v1/events", key: "saved-key-3f2a" });
    await runConfigureWizard(ttyIO());
    expect(await cloudOpts().saved!.check()).toEqual({ ok: true, line: "Your saved key works: ****3f2a" });
    vi.mocked(validateIngestKey).mockResolvedValueOnce({ ok: false, reason: "the server rejected that key (401)" });
    expect(await cloudOpts().saved!.check()).toEqual({ ok: false, line: "Your saved key no longer works: the server rejected that key (401)" });
    vi.mocked(validateIngestKey).mockResolvedValueOnce({ ok: false, reason: "could not reach the server (offline)" });
    expect(await cloudOpts().saved!.check()).toMatchObject({ ok: false, usable: true });
  });

  it("tab never disconnects a connected machine (decision D4)", async () => {
    writeIngestCredential({ url: "https://app.befailproof.ai/v1/events", key: "saved-key-3f2a" });
    const io = ttyIO();
    const result = await runConfigureWizard(io);
    expect(result.mode).toBe("cloud");
    expect(connectToCloud).not.toHaveBeenCalled();
    const collapsed = cloudOpts().collapsed!(OPEN_SOURCE).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
    expect(collapsed[1]).toBe("✓ Not connecting. The connection to app.befailproof.ai is unchanged.");
  });

  it("--oss skips the step and connects nothing", async () => {
    const result = await runConfigureWizard(ttyIO(), { oss: true });
    expect(promptCloudKey).not.toHaveBeenCalled();
    expect(result.mode).toBe("oss");
    expect(connectToCloud).not.toHaveBeenCalled();
  });

  it("takes the endpoint from FAILPROOFAI_CLOUD_URL, and names it", async () => {
    process.env.FAILPROOFAI_CLOUD_URL = "http://localhost:8080";
    drive({ cloud: { kind: "typed", key: "a-real-looking-key" } });
    await runConfigureWizard(ttyIO());
    expect(cloudOpts().meta).toBe("localhost:8080  ·  from FAILPROOFAI_CLOUD_URL");
    expect(vi.mocked(connectToCloud).mock.calls[0]![0]).toMatchObject({ url: "http://localhost:8080" });
  });

  it("refuses an unusable FAILPROOFAI_CLOUD_URL instead of falling back to hosted", async () => {
    process.env.FAILPROOFAI_CLOUD_URL = "http://cloud.example.com";
    const result = await runConfigureWizard(ttyIO());
    expect(result.applied).toBe(false);
    expect(promptCloudKey).not.toHaveBeenCalled();
  });

  it("survives a key revoked between the check and the apply", async () => {
    vi.mocked(connectToCloud).mockResolvedValue({ policy: { ok: false, reason: "403" }, ingest: { ok: false, reason: "403" }, anyConfigured: false });
    drive({ cloud: { kind: "typed", key: "a-real-looking-key" } });
    const io = ttyIO();
    const result = await runConfigureWizard(io);
    expect(result.applied).toBe(true);
    expect(result.connected).toBe(false);
    expect(printed(io.stdout)).toContain("▲ Not connected: 403");
  });

  it("does not fail setup when connecting throws outright", async () => {
    vi.mocked(connectToCloud).mockRejectedValue(new Error("network down"));
    drive({ cloud: { kind: "typed", key: "a-real-looking-key" } });
    const result = await runConfigureWizard(ttyIO());
    expect(result.applied).toBe(true);
    expect(result.connected).toBe(false);
  });

  it("asks nothing but sudo when a key is on the command line", async () => {
    const result = await runConfigureWizard(ttyIO(), { token: "k".repeat(20) });
    expect(promptCloudKey).not.toHaveBeenCalled();
    expect(multiSelect).not.toHaveBeenCalled();
    expect(result.connected).toBe(true);
  });

  it("asks again on a terminal when the --token key is refused", async () => {
    vi.mocked(validateIngestKey).mockResolvedValueOnce({ ok: false, reason: "the server rejected that key (401)" });
    drive({ cloud: OPEN_SOURCE });
    const result = await runConfigureWizard(ttyIO(), { token: "k".repeat(20) });
    expect(promptCloudKey).toHaveBeenCalledTimes(1);
    expect(result.applied).toBe(true);
    expect(connectToCloud).not.toHaveBeenCalled();
  });

  it("fails a headless run whose key was refused, writing nothing", async () => {
    vi.mocked(validateIngestKey).mockResolvedValueOnce({ ok: false, reason: "401" });
    const result = await runConfigureWizard(headlessIO(), { token: "k".repeat(20) });
    expect(result).toEqual({ applied: false, abort: "cloud_unverified" });
    expect(installHooks).not.toHaveBeenCalled();
  });
});

describe("backfill for agents traced again", () => {
  function connectMachine(): void {
    writeIngestCredential({ url: "https://app.befailproof.ai/v1/events", key: "s".repeat(20) });
    writeCollectorSettings({ sessions: true, hooks: true });
  }

  it("asks the daemon to start an added agent fresh, before the selection lands", async () => {
    connectMachine();
    updateConfig({ agents: { selected: ["claude"], seen: ["claude", "goose"] } });
    vi.mocked(detectInstalledClis).mockReturnValue(["claude", "goose"]);
    drive({ agents: ["claude", "goose"] });

    await runConfigureWizard(ttyIO());

    const request = JSON.parse(readFileSync(backfillRequestPath(), "utf8"));
    expect(request).toMatchObject({ kind: "added", agents: ["goose"] });
    expect(request.sinceMs).toBeUndefined();
  });

  it("writes no request on an open-source machine, or when nothing was added", async () => {
    updateConfig({ agents: { selected: ["claude"], seen: ["claude", "goose"] } });
    vi.mocked(detectInstalledClis).mockReturnValue(["claude", "goose"]);
    drive({ agents: ["claude", "goose"] });
    await runConfigureWizard(ttyIO());
    expect(existsSync(backfillRequestPath())).toBe(false);

    connectMachine();
    await runConfigureWizard(ttyIO());
    expect(existsSync(backfillRequestPath())).toBe(false);
  });
});

describe("daemon step", () => {
  const readFlag = (): boolean => readFpConfig().daemon.configured;

  it("installs a missing daemon at apply and marks it configured", async () => {
    vi.mocked(daemonServiceStatus).mockReturnValue("not-installed");
    const io = ttyIO();
    const result = await runConfigureWizard(io);
    expect(result.daemonInstalled).toBe(true);
    expect(installDaemonService).toHaveBeenCalledTimes(1);
    expect(readFlag()).toBe(true);
    const out = printed(io.stdout);
    expect(out).toContain("✓ Root granted to install failproofaid");
    expect(out).toContain("✓ failproofaid installed and running");
  });

  it("asks for sudo before any prompt draws", async () => {
    vi.mocked(daemonServiceStatus).mockReturnValue("not-installed");
    const order: string[] = [];
    vi.mocked(primeElevation).mockImplementation(() => (order.push("sudo"), true));
    vi.mocked(promptCloudKey).mockImplementation(async () => (order.push("key"), OPEN_SOURCE));
    await runConfigureWizard(ttyIO());
    expect(order).toEqual(["sudo", "key"]);
  });

  it("stops before writing anything when sudo cannot be had", async () => {
    vi.mocked(daemonServiceStatus).mockReturnValue("not-installed");
    vi.mocked(primeElevation).mockReturnValue(false);
    const io = ttyIO();
    const result = await runConfigureWizard(io);
    expect(result).toEqual({ applied: false, abort: "needs_root" });
    expect(promptCloudKey).not.toHaveBeenCalled();
    expect(installHooks).not.toHaveBeenCalled();
    expect(readFlag()).toBe(false);
    expect(hasSeenLauncher()).toBe(false);
    expect(printed(io.stdout)).toContain("✕ Couldn't get root, so setup stopped before changing anything.");
  });

  it("uses sudo -n, never a prompt, without a terminal", async () => {
    vi.mocked(daemonServiceStatus).mockReturnValue("not-installed");
    await runConfigureWizard(headlessIO());
    expect(primeElevation).not.toHaveBeenCalled();
    expect(canElevate).toHaveBeenCalled();
  });

  it("stops before writing anything when the service will not install", async () => {
    vi.mocked(daemonServiceStatus).mockReturnValue("not-installed");
    vi.mocked(installDaemonService).mockResolvedValue({ installed: false, reason: "systemctl enable failed" });
    const result = await runConfigureWizard(ttyIO());
    expect(result).toEqual({ applied: false, abort: "daemon_failed" });
    expect(installHooks).not.toHaveBeenCalled();
    expect(readFlag()).toBe(false);
  });

  it("refuses to finish when the fresh daemon cannot answer", async () => {
    vi.mocked(daemonServiceStatus).mockReturnValue("not-installed");
    vi.mocked(probeDaemonEndToEnd).mockResolvedValue(false);
    vi.mocked(probeDaemon).mockResolvedValue({ ok: false, reason: "worker" });
    const result = await runConfigureWizard(ttyIO());
    expect(result.abort).toBe("daemon_failed");
    expect(installHooks).not.toHaveBeenCalled();
    expect(readFlag()).toBe(false);
  });

  it("needs no password and installs nothing when the daemon is healthy", async () => {
    const io = ttyIO();
    const result = await runConfigureWizard(io);
    expect(primeElevation).not.toHaveBeenCalled();
    expect(installDaemonService).not.toHaveBeenCalled();
    expect(uninstallDaemonService).not.toHaveBeenCalled();
    expect(result.daemonInstalled).toBe(true);
    expect(readFlag()).toBe(true);
    expect(printed(io.stdout)).toMatch(/✓ failproofaid \S+ is already running/);
  });

  it("rebuilds a daemon that runs but cannot evaluate, keeping the consequence on screen", async () => {
    vi.mocked(probeDaemonEndToEnd).mockResolvedValueOnce(false).mockResolvedValue(true);
    const io = ttyIO();
    const result = await runConfigureWizard(io);
    expect(result.applied).toBe(true);
    expect(uninstallDaemonService).toHaveBeenCalled();
    expect(installDaemonService).toHaveBeenCalled();
    const out = printed(io.stdout);
    expect(out).toContain("failproofaid can't evaluate — every tool call is denied. Rebuilding needs sudo.");
    expect(out).toContain("✓ failproofaid rebuilt and running");
  });

  it("reinstalls a daemon that is installed but stopped", async () => {
    vi.mocked(daemonServiceStatus).mockReturnValue("stopped");
    await runConfigureWizard(ttyIO());
    expect(primeElevation).toHaveBeenCalled();
    expect(installDaemonService).toHaveBeenCalledTimes(1);
  });

  it("refreshes a stale unit instead of reinstalling", async () => {
    vi.mocked(daemonServiceNeedsUpgrade).mockReturnValue(true);
    vi.mocked(ensureDaemonServiceCurrent).mockResolvedValue({ outcome: "rewritten" });
    const io = ttyIO();
    const result = await runConfigureWizard(io);
    expect(result.applied).toBe(true);
    expect(ensureDaemonServiceCurrent).toHaveBeenCalledTimes(1);
    expect(installDaemonService).not.toHaveBeenCalled();
    expect(printed(io.stdout)).toContain("✓ failproofaid's service definition is up to date");
  });

  it("finishes anyway when the unit refresh fails", async () => {
    vi.mocked(daemonServiceNeedsUpgrade).mockReturnValue(true);
    vi.mocked(ensureDaemonServiceCurrent).mockResolvedValue({ outcome: "failed", reason: "sudo: a password is required" });
    const result = await runConfigureWizard(ttyIO());
    expect(result.applied).toBe(true);
    expect(readFlag()).toBe(true);
  });

  it("stops claiming a daemon the refresh left stopped", async () => {
    vi.mocked(daemonServiceNeedsUpgrade).mockReturnValue(true);
    vi.mocked(ensureDaemonServiceCurrent).mockResolvedValue({ outcome: "failed", reason: "did not come back", daemonRunning: false });
    const result = await runConfigureWizard(ttyIO());
    expect(result.applied).toBe(true);
    expect(result.daemonInstalled).toBe(false);
    expect(readFlag()).toBe(false);
  });

  it("leaves a stale unit alone, without aborting, when root is unavailable", async () => {
    vi.mocked(daemonServiceNeedsUpgrade).mockReturnValue(true);
    vi.mocked(primeElevation).mockReturnValue(false);
    const result = await runConfigureWizard(ttyIO());
    expect(result.applied).toBe(true);
    expect(ensureDaemonServiceCurrent).not.toHaveBeenCalled();
  });

  it("sends a classification, never the raw reason, in the install telemetry", async () => {
    vi.mocked(daemonServiceStatus).mockReturnValue("not-installed");
    vi.mocked(installDaemonService).mockResolvedValue({
      installed: false,
      reason: "EACCES: permission denied, open '/home/alice/.config/systemd/user/x.service'",
    });
    await runConfigureWizard(ttyIO());
    const props = vi.mocked(trackHookEvent).mock.calls.find((call) => call[1] === "configure_daemon_install")![2] as Record<string, unknown>;
    expect(props.installed).toBe(false);
    expect(String(props.reason)).not.toContain("alice");
  });

  it("refuses an unsupported platform before drawing anything", async () => {
    vi.mocked(isDaemonSupportedPlatform).mockReturnValue(false);
    const io = ttyIO();
    const result = await runConfigureWizard(io);
    expect(result).toEqual({ applied: false, abort: "unsupported_platform" });
    expect(promptCloudKey).not.toHaveBeenCalled();
    expect(primeElevation).not.toHaveBeenCalled();
    expect(printed(io.stdout)).toContain("Linux and macOS");
  });

  it("reports why it configured nothing when run under sudo", async () => {
    const getuid = process.getuid;
    Object.defineProperty(process, "getuid", { value: () => 0, configurable: true });
    vi.stubEnv("SUDO_USER", "someone");
    try {
      expect(await runConfigureWizard(ttyIO())).toEqual({ applied: false, abort: "running_as_sudo" });
      expect(installHooks).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "getuid", { value: getuid, configurable: true });
      vi.unstubAllEnvs();
    }
  });
});

describe("config --token with --url", () => {
  let fpHome: string;
  let prevFpHome: string | undefined;
  beforeEach(() => {
    prevFpHome = process.env.FAILPROOFAI_HOME;
    fpHome = mkdtempSync(resolve(tmpdir(), "fpai-wizard-url-"));
    process.env.FAILPROOFAI_HOME = fpHome;
  });
  afterEach(() => {
    if (prevFpHome === undefined) delete process.env.FAILPROOFAI_HOME;
    else process.env.FAILPROOFAI_HOME = prevFpHome;
    rmSync(fpHome, { recursive: true, force: true });
  });

  it("connects to the URL it was given, checks the key there, and names the source", async () => {
    const io = headlessIO();
    const result = await runConfigureWizard(io, { token: "k".repeat(20), url: "http://localhost:9911" });
    expect(result.connected).toBe(true);
    expect(vi.mocked(connectToCloud).mock.calls[0]![0]).toMatchObject({ url: "http://localhost:9911" });
    expect(vi.mocked(validateIngestKey).mock.calls[0]![0]).toMatchObject({ url: "http://localhost:9911/v1/events" });
    expect(printed(io.stdout)).toContain("localhost:9911  ·  from --url");
  });

  it("prefers --url to FAILPROOFAI_CLOUD_URL", async () => {
    process.env.FAILPROOFAI_CLOUD_URL = "http://localhost:7000";
    await runConfigureWizard(headlessIO(), { token: "k".repeat(20), url: "http://localhost:9911" });
    expect(vi.mocked(connectToCloud).mock.calls[0]![0]).toMatchObject({ url: "http://localhost:9911" });
  });

  it("accepts the ingest endpoint as --url", async () => {
    await runConfigureWizard(headlessIO(), { token: "k".repeat(20), url: "https://cloud.example.com/v1/events" });
    expect(vi.mocked(connectToCloud).mock.calls[0]![0]).toMatchObject({ url: "https://cloud.example.com" });
  });

  it("refuses an unusable --url rather than connecting somewhere else", async () => {
    const result = await runConfigureWizard(headlessIO(), { token: "k".repeat(20), url: "http://cloud.example.com" });
    expect(result.applied).toBe(false);
    expect(connectToCloud).not.toHaveBeenCalled();
  });

  it("an already-enrolled machine given --url enrols THERE", async () => {
    const { writeCloudCredentials } = await import("../../src/hooks/cloud-enrollment");
    writeCloudCredentials({ url: "https://old.example.com", machineId: "m-1", token: "o".repeat(20) });
    await runConfigureWizard(headlessIO(), { token: "k".repeat(20), url: "http://localhost:9911" });
    expect(vi.mocked(connectToCloud).mock.calls[0]![0]).toMatchObject({ url: "http://localhost:9911", token: "k".repeat(20) });
  });

  it("with neither, uses the hosted default", async () => {
    await runConfigureWizard(headlessIO(), { token: "k".repeat(20) });
    expect(vi.mocked(connectToCloud).mock.calls[0]![0]).toMatchObject({ url: "https://app.befailproof.ai" });
  });
});

describe("config --token with --no-transcripts", () => {
  it("connects with transcripts off, and says so", async () => {
    const io = headlessIO();
    const result = await runConfigureWizard(io, { token: "k".repeat(20), noTranscripts: true });
    expect(result.connected).toBe(true);
    expect(vi.mocked(connectToCloud).mock.calls[0]![0]).toMatchObject({ sessions: false });
    expect(printed(io.stdout)).toContain("Decisions only: session transcripts are not sent (--no-transcripts).");
  });

  it("says Jev is available, and nothing that reads as on", async () => {
    vi.mocked(connectToCloud).mockResolvedValue({
      policy: { ok: true, policyCount: 2, deployment: 7 },
      ingest: { ok: true },
      jev: { ok: true, optIn: true },
      anyConfigured: true,
    });
    const io = headlessIO();
    await runConfigureWizard(io, { token: "k".repeat(20), noTranscripts: true });
    const jev = printed(io.stdout).split("\n").filter((l) => /\bJev\b/.test(l));
    expect(jev).toHaveLength(1);
    expect(jev[0]).toContain("available on this key");
  });

  it("defaults to transcripts on without the flag", async () => {
    const io = headlessIO();
    await runConfigureWizard(io, { token: "k".repeat(20) });
    expect(vi.mocked(connectToCloud).mock.calls[0]![0]).toMatchObject({ sessions: true });
    expect(printed(io.stdout)).not.toContain("--no-transcripts");
  });
});

describe("first-run redirect", () => {
  let origHome: string | undefined;
  let tmp: string;
  beforeEach(() => {
    origHome = process.env.HOME;
    delete process.env.FAILPROOFAI_NO_FIRST_RUN;
    tmp = mkdtempSync(resolve(tmpdir(), "fpai-firstrun-"));
    process.env.HOME = tmp;
  });
  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("does nothing when FAILPROOFAI_NO_FIRST_RUN=1", async () => {
    process.env.FAILPROOFAI_NO_FIRST_RUN = "1";
    expect(await maybeFirstRunConfigure(ttyIO())).toBe(false);
    expect(promptCloudKey).not.toHaveBeenCalled();
    delete process.env.FAILPROOFAI_NO_FIRST_RUN;
  });

  it("prints a hint but does not redirect without a terminal", async () => {
    const stdout = mkTtyStdout();
    expect(await maybeFirstRunConfigure({ stdin: { isTTY: false } as unknown as TTYIn, stdout })).toBe(false);
    expect(printed(stdout)).toContain("failproofai config");
    expect(hasSeenLauncher()).toBe(false);
  });

  it("does not mark seen when the first run is cancelled", async () => {
    drive({ cloud: null });
    expect(await maybeFirstRunConfigure(ttyIO())).toBe(true);
    expect(hasSeenLauncher()).toBe(false);
    expect(installHooks).not.toHaveBeenCalled();
    expect(runPostSetupAudit).not.toHaveBeenCalled();
  });

  it("marks seen after a completed apply, then hands off to the audit", async () => {
    expect(await maybeFirstRunConfigure(ttyIO())).toBe(true);
    expect(installHooks).toHaveBeenCalledTimes(1);
    expect(hasSeenLauncher()).toBe(true);
    expect(runPostSetupAudit).toHaveBeenCalledTimes(1);
  });

  it("does not redirect again once seen", async () => {
    markLauncherSeen();
    expect(await maybeFirstRunConfigure(ttyIO())).toBe(false);
    expect(promptCloudKey).not.toHaveBeenCalled();
  });

  it("hard-fails cleanly on an unsupported platform, and does not nag again", async () => {
    vi.mocked(isDaemonSupportedPlatform).mockReturnValue(false);
    expect(await maybeFirstRunConfigure(ttyIO())).toBe(true);
    expect(installHooks).not.toHaveBeenCalled();
    expect(await maybeFirstRunConfigure(ttyIO())).toBe(false);
  });
});
