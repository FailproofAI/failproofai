import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { summarize } from "../../src/hooks/tui";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

// The interactive prompts, the install manager, telemetry and CLI detection are
// mocked so we can drive the wizard head-lessly and assert the exact side effect
// (the installHooks call) without touching the filesystem or a real TTY.
vi.mock("../../src/hooks/tui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hooks/tui")>();
  // Keep the pure helpers (summarize, ellipsize) real; stub only the interactive prompts.
  return {
    ...actual,
    selectOne: vi.fn(),
    multiSelect: vi.fn(),
    promptText: vi.fn(),
    intro: vi.fn(),
    outro: vi.fn(),
  };
});
vi.mock("../../src/hooks/manager", () => ({ installHooks: vi.fn(async () => {}) }));
// The wizard's apply path writes `customPoliciesEnabled` to the config for the
// CHOSEN SCOPE, and project scope resolves from `process.cwd()` — which, in a
// test, is this repository. So every applied project-scope run wrote
// `"customPoliciesEnabled": false` into the committed dogfood config, and the
// next `git add -A` committed it: custom policies silently off for everyone who
// pulled. Isolating HOME (below) could never catch this, because project scope
// never consults HOME.
//
// Redirect the resolved path rather than stubbing the write, so the real
// setCustomPoliciesEnabled still runs and stays under test — just against a
// temp file. `WIZARD_TEST_CONFIG_DIR` is recomputed identically outside the
// factory so afterAll can clean it up.
vi.mock("../../src/hooks/hooks-config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hooks/hooks-config")>();
  const { mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { resolve: join } = await import("node:path");
  const dir = join(tmpdir(), `fpai-wizard-cfg-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  return {
    ...actual,
    // Only the cwd-derived scopes are redirected. User scope already resolves
    // from HOME, which this file isolates, and the daemon tests depend on that
    // real path — redirecting it too would move `daemonConfigured` out from
    // under them.
    getConfigPathForScope: (scope: string, cwd?: string) =>
      scope === "user"
        ? actual.getConfigPathForScope("user", cwd)
        : join(dir, scope === "local" ? "policies-config.local.json" : "policies-config.json"),
  };
});
// installDaemonService shells out to real systemctl/launchctl — several tests
// below drive the wizard with scope "user", which is exactly the condition
// that triggers it. Mocked so an ordinary unit test run never touches this
// machine's real systemd/launchd state.
// Only the three that shell out are stubbed; setDaemonConfigured stays real
// so the `daemonConfigured` assertions below test the actual marker write
// (against this file's isolated HOME), not a mock of it.
vi.mock("../../src/hooks/daemon-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hooks/daemon-service")>();
  return {
    ...actual,
    isDaemonSupportedPlatform: vi.fn(() => false),
    installDaemonService: vi.fn(async () => ({ installed: false, reason: "mocked" })),
    daemonServiceFilePath: vi.fn(() => null),
    // Drives the already-installed / crash-looped branches without touching
    // this machine's real service manager.
    daemonServiceStatus: vi.fn(() => "not-installed" as const),
    // Reads /etc/systemd/system on the real machine, so a developer box with a
    // pre-FAILPROOFAI_CLI_CMD unit installed would otherwise send every
    // already-running test down the refresh branch.
    daemonServiceNeedsUpgrade: vi.fn(() => false),
    ensureDaemonServiceCurrent: vi.fn(async () => ({ outcome: "current" as const })),
    daemonStatusCommand: vi.fn(() => "systemctl status failproofaid@test"),
    // Step 0 primes sudo before anything is drawn. Mocked true by default so
    // no test can block on a real password prompt.
    primeElevation: vi.fn(() => true),
    // The end-to-end health probe opens the real daemon socket. Default true —
    // "the service manager says running" and "it can actually answer" agree on
    // a healthy machine, which is what every pre-existing test here means by
    // running. The tests that drive the broken-worker branch override it.
    probeDaemonEndToEnd: vi.fn(async () => true),
    uninstallDaemonService: vi.fn(async () => {}),
  };
});
// The wizard kicks off the audit pipeline after a completed apply; stub it so
// tests never scan real history.
// The connect step reaches the network twice — once to probe the key before
// the review screen, once via connectToCloud at apply. Both stubbed so no test
// talks to a server, and so the "revoked between probe and apply" case can be
// driven deterministically.
vi.mock("../../src/hooks/cloud-connection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hooks/cloud-connection")>();
  return {
    ...actual,
    connectToCloud: vi.fn(async () => ({
      policy: { ok: true, policyCount: 2, generation: 7 },
      ingest: { ok: true },
      anyConfigured: true,
    })),
  };
});
vi.mock("../../src/hooks/collector-config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hooks/collector-config")>();
  return { ...actual, validateIngestKey: vi.fn(async () => ({ ok: true })) };
});
vi.mock("../../src/audit/cli", () => ({ runPostSetupAudit: vi.fn(async () => {}) }));
vi.mock("../../src/hooks/hook-telemetry", () => ({ trackHookEvent: vi.fn(async () => {}) }));
vi.mock("../../lib/telemetry-id", () => ({ getInstanceId: vi.fn(() => "test-id") }));
vi.mock("../../src/hooks/integrations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hooks/integrations")>();
  return { ...actual, detectInstalledClis: vi.fn(() => ["claude"]) };
});

import { selectOne, multiSelect, promptText, outro, type TTYIn, type TTYOut } from "../../src/hooks/tui";
import { connectToCloud } from "../../src/hooks/cloud-connection";
import { validateIngestKey } from "../../src/hooks/collector-config";
import { installHooks } from "../../src/hooks/manager";
import {
  isDaemonSupportedPlatform,
  installDaemonService,
  daemonServiceStatus,
  daemonServiceNeedsUpgrade,
  daemonServiceFilePath,
  ensureDaemonServiceCurrent,
  primeElevation,
  probeDaemonEndToEnd,
  uninstallDaemonService,
} from "../../src/hooks/daemon-service";
import {
  buildAgentChoices,
  buildPresetChoices,
  clisSupportingScope,
  resolvePresetSelection,
  reviewLines,
  runConfigureWizard,
  maybeFirstRunConfigure,
  hasSeenLauncher,
  markLauncherSeen,
  classifyDaemonInstallFailure,
} from "../../src/hooks/configure-wizard";
import { resolvePreset, resolveEverything } from "../../src/hooks/policy-presets";
import { INTEGRATION_TYPES, type IntegrationType } from "../../src/hooks/types";
import { getIntegration } from "../../src/hooks/integrations";
import { runPostSetupAudit } from "../../src/audit/cli";
import { trackHookEvent } from "../../src/hooks/hook-telemetry";
import { globalPolicyConfigFile, configFile as fpConfigFile, launcherMarker } from "../../src/hooks/fp-home";
import { readConfig as readFpConfig } from "../../src/hooks/fp-config";

const mkTtyStdin = (): TTYIn => ({ isTTY: true }) as unknown as TTYIn;
const mkTtyStdout = (): TTYOut =>
  ({ isTTY: true, write: vi.fn(() => true), columns: 80 }) as unknown as TTYOut;
const ttyIO = () => ({ stdin: mkTtyStdin(), stdout: mkTtyStdout() });

/**
 * Queue answers for a wizard run BY NAME rather than by position.
 *
 * The wizard's step order is a product decision that has already changed once
 * (policies moved ahead of assistants, a connect step replaced the old
 * AgentEye question). Positional `mockResolvedValueOnce` chains meant every
 * such change broke every test at once and each had to be re-counted by hand
 * — which is exactly the kind of churn that tempts someone to "fix" a test by
 * loosening it. Naming the steps keeps a reorder to a one-line change here.
 *
 * Current order — selectOne: target, connect, review.
 *                 multiSelect: policies, assistants.
 * `undefined` means "this step is not reached in this test".
 */
function drive(answers: {
  /** Scope step. Omitted when the run is expected to abort before it. */
  target?: "user" | "project" | "both" | null;
  policies?: string[] | null;
  clis?: string[] | null;
  connect?: "key" | "local" | null;
  review?: "apply" | "cancel" | null;
}) {
  const one = vi.mocked(selectOne);
  const many = vi.mocked(multiSelect);
  if ("target" in answers) one.mockResolvedValueOnce(answers.target as never);
  if ("connect" in answers) one.mockResolvedValueOnce(answers.connect as never);
  if ("review" in answers) one.mockResolvedValueOnce(answers.review as never);
  if ("policies" in answers) many.mockResolvedValueOnce(answers.policies as never);
  if ("clis" in answers) many.mockResolvedValueOnce(answers.clis as never);
}

/** The happy path: global scope, two bundles, Claude, stay local, apply. */
const HAPPY = {
  target: "user" as const,
  policies: ["secrets", "git"],
  clis: ["claude"],
  connect: "local" as const,
  review: "apply" as const,
};

// The wizard's apply path calls markLauncherSeen(), which writes under
// homedir()/.failproofai — isolate HOME for the whole file so no test ever
// touches the developer's real config.
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
  try {
    rmSync(fileHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  try {
    rmSync(WIZARD_TEST_CONFIG_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

beforeEach(() => {
  vi.mocked(selectOne).mockReset();
  vi.mocked(multiSelect).mockReset();
  vi.mocked(installHooks).mockClear();
  vi.mocked(runPostSetupAudit).mockClear();
  vi.mocked(outro).mockClear();
  vi.mocked(isDaemonSupportedPlatform).mockReset().mockReturnValue(false);
  vi.mocked(installDaemonService)
    .mockReset()
    .mockResolvedValue({ installed: false, reason: "mocked" });
  // Reset too, or call counts leak across tests and "was never asked for sudo"
  // silently passes on history from an earlier one.
  vi.mocked(primeElevation).mockReset().mockReturnValue(true);
  // Same reason: "a healthy daemon was left alone" asserts a call count of
  // zero, which the broken-worker test above would otherwise satisfy for it.
  vi.mocked(probeDaemonEndToEnd).mockReset().mockResolvedValue(true);
  vi.mocked(uninstallDaemonService).mockReset().mockResolvedValue(undefined);
});

describe("configure-wizard pure builders", () => {
  // Pass an explicit cwd with no `.failproofai/policies/`. Relying on the
  // default (process.cwd()) made this depend on whether the directory the
  // suite happens to run from has custom policies — this repo's does, so it
  // asserted on ambient filesystem state rather than on the builder. Same
  // class of defect as #569.
  it("buildPresetChoices lists the presets, Everything, then Custom", () => {
    const values = buildPresetChoices(mkdtempSync(resolve(tmpdir(), "fpai-nocustom-"))).map(
      (c) => c.value,
    );
    // Custom is always last and always present — even with nothing on disk, it
    // is the only place a user can discover that custom policies are a thing.
    expect(values).toEqual(["secrets", "git", "ship", "infra", "__everything__", "__custom__"]);
  });

  // With files on disk the Custom row is a real checkbox (unticking writes
  // customPoliciesEnabled:false); with none it is a locked status row. Full
  // behaviour is covered in custom-policy-discovery.test.ts.
  it("buildPresetChoices makes Custom togglable once custom policies exist", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "fpai-custom-"));
    mkdirSync(resolve(dir, ".failproofai", "policies"), { recursive: true });
    writeFileSync(resolve(dir, ".failproofai", "policies", "team-policies.mjs"), "// x\n");
    const custom = buildPresetChoices(dir).find((c) => c.label === "Custom");
    expect(custom).toBeDefined();
    expect(custom!.locked).toBeUndefined();
    expect(custom!.checked).toBe(true);
  });

  it("resolvePresetSelection returns a single preset's policies", () => {
    expect(resolvePresetSelection(["git"])).toEqual(resolvePreset("git"));
  });

  it("resolvePresetSelection unions multiple selected presets (deduped)", () => {
    const combined = resolvePresetSelection(["secrets", "git"]);
    // Concrete behavior, not a re-derivation of the implementation: one known
    // policy from each bundle is present, and nothing is duplicated.
    expect(combined).toContain("sanitize-api-keys"); // from "secrets"
    expect(combined).toContain("block-force-push"); // from "git"
    expect(new Set(combined).size).toBe(combined.length);
  });

  it("resolvePresetSelection returns the full set when Everything is ticked (wins over presets)", () => {
    expect(resolvePresetSelection(["__everything__"])).toEqual(resolveEverything());
    expect(resolvePresetSelection(["git", "__everything__"])).toEqual(resolveEverything());
  });

  it("buildAgentChoices pre-checks detected CLIs and sections the rest", () => {
    const choices = buildAgentChoices("user", "/tmp/proj");
    const claude = choices.find((c) => c.value === "claude");
    expect(claude?.checked).toBe(true);
    expect(claude?.section).toBe("Detected");
    const codex = choices.find((c) => c.value === "codex");
    expect(codex?.section).toBe("Not installed · set up ahead of time");
    // every integration is represented (sourced dynamically from INTEGRATION_TYPES)
    expect(choices.length).toBe(INTEGRATION_TYPES.length);
  });

  it("reviewLines summarizes scope, assistants, policy count and target files", () => {
    const lines = reviewLines({
      target: "user",
      clis: ["claude"],
      policies: ["block-sudo", "block-rm-rf"],
      cwd: "/tmp/proj",
    }).join("\n");
    expect(lines).toContain("Everywhere (global)");
    expect(lines).toContain("Claude Code");
    expect(lines).toContain("2 enabled");
    expect(lines).toContain("policies-config.json");
    expect(lines).toContain("settings.json");
  });

  it("reviewLines reports an empty policy set as a choice, not a count of zero", () => {
    const lines = reviewLines({
      target: "user",
      clis: ["claude"],
      policies: [],
      cwd: "/tmp/proj",
    }).join("\n");
    expect(lines).toContain("none enabled");
    expect(lines).not.toContain("0 enabled");
    // Tell the user where to change their mind, so an intentional "none" does
    // not read like the wizard dropped the selection.
    expect(lines).toContain("failproofai policies --install");
  });
});

describe("configure-wizard orchestration", () => {
  it("applies the union of selected presets, REPLACING the enabled set", async () => {
    drive({ target: "user", policies: ["secrets", "git"], clis: ["claude"], connect: "local", review: "apply" }); // policy sources (multi-select)

    const result = await runConfigureWizard(ttyIO());

    expect(result.applied).toBe(true);
    expect(installHooks).toHaveBeenCalledTimes(1);
    const call = vi.mocked(installHooks).mock.calls[0];
    const policies = call[0] as string[];
    expect(policies).toContain("sanitize-api-keys"); // from "secrets"
    expect(policies).toContain("block-force-push"); // from "git"
    expect(new Set(policies).size).toBe(policies.length); // deduped union
    expect(call[1]).toBe("user"); // scope
    expect(call[4]).toBe("configure-wizard"); // source tag
    expect(call[7]).toEqual(["claude"]); // clis
    expect(call[8]).toEqual({ replace: true, quiet: true }); // options
  });

  it("'Everything available' protects every supported CLI", async () => {
    drive({ target: "user", policies: ["git"], clis: ["__all_clis__"], connect: "local", review: "apply" }); // policy sources
    await runConfigureWizard(ttyIO());
    const call = vi.mocked(installHooks).mock.calls[0];
    expect(call[7]).toEqual([...INTEGRATION_TYPES]); // all CLIs, regardless of detection
  });

  it("accepts an empty policy selection and still installs the hooks", async () => {
    drive({ target: "user", policies: [], clis: ["claude"], connect: "local", review: "apply" }); // policy sources → nothing ticked

    const result = await runConfigureWizard(ttyIO());

    expect(result.applied).toBe(true);
    // The whole point: setup completes. Hooks are installed for the chosen
    // assistant with an empty enabled set, so enforcement can be switched on
    // later without re-running the wizard.
    expect(installHooks).toHaveBeenCalledTimes(1);
    const call = vi.mocked(installHooks).mock.calls[0];
    expect(call[0]).toEqual([]); // no builtins enabled
    expect(call[7]).toEqual(["claude"]); // assistants unaffected
    expect(call[8]).toEqual({ replace: true, quiet: true }); // empty set REPLACES
  });

  it("does not impose a minimum on the policy step, but keeps one on assistants", async () => {
    drive({ target: "user", policies: [], clis: ["claude"], connect: "local", review: "apply" });

    await runConfigureWizard(ttyIO());

    // Policies are asked FIRST now — "what do you want guarded" is the
    // question the user came for; which CLIs to wire it into follows from it.
    const [policyOpts] = vi.mocked(multiSelect).mock.calls[0];
    const [assistantsOpts] = vi.mocked(multiSelect).mock.calls[1];
    // Asymmetric on purpose: an empty CLI list does NOT mean "no assistants" —
    // installHooksImpl falls back to ["claude"] — so that step must keep its
    // minimum or it would silently install for a CLI nobody picked.
    expect(assistantsOpts.minSelected).toBe(1);
    expect(policyOpts.minSelected).toBeUndefined();
  });

  it("never writes into the repository's own config when applying at project scope", async () => {
    // The defect this pins: project scope resolves its config from
    // process.cwd(), which under test is this repo, so an applied run wrote
    // `customPoliciesEnabled: false` into the tracked dogfood config — and the
    // next `git add -A` committed custom policies switched off for everyone.
    // Isolating HOME did not help, because project scope never reads HOME.
    const repoConfig = resolve(process.cwd(), ".failproofai", "policies-config.json");
    const before = existsSync(repoConfig) ? readFileSync(repoConfig, "utf8") : null;

    drive({ target: "project", policies: ["git"], clis: ["claude"], connect: "local", review: "apply" }); // Custom deliberately unticked — the write that leaked
    await runConfigureWizard(ttyIO());

    const after = existsSync(repoConfig) ? readFileSync(repoConfig, "utf8") : null;
    expect(after).toBe(before);
  });

  it("cancelling at the review step makes no changes", async () => {
    drive({ target: "user", policies: ["git"], clis: ["claude"], connect: "local", review: "cancel" }); // policy sources
    const result = await runConfigureWizard(ttyIO());
    expect(result.applied).toBe(false);
    expect(installHooks).not.toHaveBeenCalled();
  });

  it("cancelling at the scope step makes no changes", async () => {
    vi.mocked(selectOne).mockResolvedValueOnce(null); // scope → quit
    const result = await runConfigureWizard(ttyIO());
    expect(result.applied).toBe(false);
    expect(installHooks).not.toHaveBeenCalled();
  });

  it("returns guidance and does nothing in a non-TTY context", async () => {
    const stdout = mkTtyStdout();
    const result = await runConfigureWizard({
      stdin: { isTTY: false } as unknown as TTYIn,
      stdout,
    });
    expect(result.applied).toBe(false);
    expect(installHooks).not.toHaveBeenCalled();
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
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("does nothing when FAILPROOFAI_NO_FIRST_RUN=1", async () => {
    process.env.FAILPROOFAI_NO_FIRST_RUN = "1";
    const handled = await maybeFirstRunConfigure(ttyIO());
    expect(handled).toBe(false);
    expect(selectOne).not.toHaveBeenCalled();
    delete process.env.FAILPROOFAI_NO_FIRST_RUN;
  });

  it("prints a hint but does not redirect in a non-TTY context", async () => {
    const stdout = mkTtyStdout();
    const handled = await maybeFirstRunConfigure({
      stdin: { isTTY: false } as unknown as TTYIn,
      stdout,
    });
    expect(handled).toBe(false);
    const written = vi.mocked(stdout.write).mock.calls.map((c) => String(c[0])).join("");
    expect(written).toContain("failproofai config");
    expect(hasSeenLauncher()).toBe(false); // not marked in non-TTY
  });

  it("runs the wizard on a fresh first run but does NOT mark seen if cancelled", async () => {
    vi.mocked(selectOne).mockResolvedValueOnce(null); // wizard cancels immediately
    const handled = await maybeFirstRunConfigure(ttyIO());
    expect(handled).toBe(true); // it took over the turn (no dashboard)
    expect(hasSeenLauncher()).toBe(false); // cancelled → not marked → redirects again next time
    expect(existsSync(resolve(tmp, ".failproofai", ".launcher-configured"))).toBe(false);
    expect(installHooks).not.toHaveBeenCalled();
    expect(runPostSetupAudit).not.toHaveBeenCalled(); // no apply → no auto-audit
  });

  it("marks the launcher seen only after a completed apply", async () => {
    drive({ target: "user", policies: ["git"], clis: ["claude"], connect: "local", review: "apply" }); // policy sources
    const handled = await maybeFirstRunConfigure(ttyIO());
    expect(handled).toBe(true);
    expect(installHooks).toHaveBeenCalledTimes(1);
    expect(hasSeenLauncher()).toBe(true);
    expect(runPostSetupAudit).toHaveBeenCalledTimes(1); // completed apply → auto-audit handoff
  });

  it("does not redirect again once the launcher has been seen", async () => {
    markLauncherSeen(); // simulate a prior completed setup
    const handled = await maybeFirstRunConfigure(ttyIO());
    expect(handled).toBe(false);
    expect(selectOne).not.toHaveBeenCalled();
  });
});

describe("assistant selection summary", () => {
  // The "Everything available" row is a selector, not an assistant. Counting it
  // produced "13 assistants · Everything available, Claude Code, …" for the 12
  // supported CLIs — an off-by-one visible on the wizard's own summary line.
  it("excludes the Everything-available selector from the assistant count", () => {
    const real = INTEGRATION_TYPES.map((t) => getIntegration(t).displayName);
    // What the wizard used to pass: the selector row alongside every CLI.
    expect(summarize(["Everything available", ...real], "assistants")).toContain(
      `${real.length + 1} assistants`,
    );
    // What it passes now — the selector is marked summaryExclude.
    const fixed = summarize(real, "assistants");
    expect(fixed).toContain(`${real.length} assistants`);
    expect(fixed).not.toContain("Everything available");
  });
});

describe("scope-aware assistant selection", () => {
  // Regression: the wizard offered all 12 CLIs at project scope and expanded
  // "Everything available" to all 12, so applying died with
  // `Scope "project" is not supported by Hermes` — after every question had
  // been answered, with nothing written.
  it("locks CLIs that cannot be configured at the chosen scope", () => {
    const projectRows = buildAgentChoices("project", "/tmp/proj");
    const locked = projectRows.filter((c) => c.locked);
    expect(locked.length).toBeGreaterThan(0);
    for (const row of locked) {
      expect(row.checked).toBe(false); // never selectable, so never installed
      expect(getIntegration(row.value).scopes).not.toContain("project");
    }
  });

  it("locks nothing at user scope, which every CLI supports", () => {
    expect(buildAgentChoices("user", "/tmp/proj").filter((c) => c.locked)).toHaveLength(0);
  });

  it("clisSupportingScope excludes the user-only gateways from project scope", () => {
    const project = clisSupportingScope("project");
    const user = clisSupportingScope("user");
    expect(user).toHaveLength(INTEGRATION_TYPES.length);
    expect(project.length).toBeLessThan(user.length);
    for (const id of project) expect(getIntegration(id).scopes).toContain("project");
  });

  // writeLines truncates with a hard cut and no ellipsis, so an over-long
  // closing line does not merely lose its tail — it reads as broken output.
  // Naming all ten CLIs made it 182 characters against an 80-column terminal,
  // cutting off the custom-policy note entirely and then stopping mid-word.
  it("keeps the closing line inside an 80-column terminal", async () => {
    const stdout = mkTtyStdout();
    drive({ target: "project", policies: ["__everything__"], clis: ["__all_clis__"], connect: "local", review: "apply" }); // widest: every policy

    await runConfigureWizard({ stdin: mkTtyStdin(), stdout });

    const message = vi.mocked(outro).mock.calls[0]![0];
    expect(message).toContain("Setup complete");
    // 3 columns of gutter ("└  ") sit in front of it when rendered.
    expect(message.length + 3).toBeLessThanOrEqual(80);
    expect(message).toContain("assistants"); // the tail survived
  });

  it("applies to only the scope-supported CLIs when Everything available is ticked", async () => {
    drive({ target: "project", policies: ["git"], clis: ["__all_clis__"], connect: "local", review: "apply" }); // one bundle

    await runConfigureWizard(ttyIO());

    const clis = vi.mocked(installHooks).mock.calls[0]![7] as IntegrationType[];
    expect(clis.length).toBe(clisSupportingScope("project").length);
    for (const id of clis) expect(getIntegration(id).scopes).toContain("project");
  });
});

describe("configure-wizard daemon integration", () => {
  function globalConfigPath(): string {
    return fpConfigFile();
  }
  function readGlobalConfig(): Record<string, unknown> {
    // Layout 2 moved this flag out of policies-config.json and into
    // config.toml [daemon]. Shaped back to the old key so the assertions below
    // keep reading as statements about daemonConfigured rather than about TOML.
    const cfg = readFpConfig();
    return cfg.daemon.configured ? { daemonConfigured: true } : {};
  }

  // fileHome (and therefore the global config file) is shared across every
  // test in this file — a prior test's daemonConfigured: true write would
  // otherwise leak into a later test that expects it to be absent.
  beforeEach(() => {
    rmSync(globalConfigPath(), { force: true });
    // Same leak, one file over: an earlier test's completed apply leaves the
    // marker behind, so an abort test asserting "not marked seen" would read a
    // previous test's success as its own.
    rmSync(launcherMarker(fileHome), { force: true });
    vi.mocked(daemonServiceStatus).mockReturnValue("not-installed");
    vi.mocked(daemonServiceNeedsUpgrade).mockReturnValue(false);
    vi.mocked(ensureDaemonServiceCurrent).mockClear();
    // The telemetry assertions below locate their event with `.find()`, which
    // would otherwise match an identically-named event emitted by an earlier
    // test in this file and assert against the wrong run's props.
    vi.mocked(trackHookEvent).mockClear();
  });

  it("installs the daemon and marks it configured, with no question asked", async () => {
    // The daemon is REQUIRED now, so there is no step-0 prompt to answer —
    // a supported platform simply gets one.
    vi.mocked(isDaemonSupportedPlatform).mockReturnValue(true);
    vi.mocked(installDaemonService).mockResolvedValue({ installed: true });
    drive(HAPPY);

    const result = await runConfigureWizard(ttyIO());

    expect(result.applied).toBe(true);
    expect(result.daemonInstalled).toBe(true);
    expect(installDaemonService).toHaveBeenCalledTimes(1);
    expect(readGlobalConfig().daemonConfigured).toBe(true);
  });

  it("primes sudo before anything is drawn", async () => {
    // `sudo -v` must prompt on a clean terminal. Fired from underneath a
    // rendered TUI the prompt is invisible and the typed password lands in a
    // redrawn frame.
    vi.mocked(isDaemonSupportedPlatform).mockReturnValue(true);
    vi.mocked(installDaemonService).mockResolvedValue({ installed: true });
    const order: string[] = [];
    vi.mocked(primeElevation).mockImplementation(() => {
      order.push("sudo");
      return true;
    });
    vi.mocked(selectOne).mockImplementation(async () => {
      order.push("select");
      return order.filter((o) => o === "select").length === 1 ? "user" : "apply";
    });
    vi.mocked(multiSelect).mockImplementation(async () => {
      order.push("multi");
      return [];
    });

    await runConfigureWizard(ttyIO());

    expect(order[0]).toBe("sudo");
  });

  it("ABORTS without writing anything when sudo cannot be obtained", async () => {
    // Required means required. A machine that cannot install the service is
    // left exactly as it was found rather than carrying half a config — and
    // critically, `daemonConfigured` is never set, because a machine with that
    // flag and no reachable daemon denies every tool call on it.
    vi.mocked(isDaemonSupportedPlatform).mockReturnValue(true);
    vi.mocked(primeElevation).mockReturnValue(false);
    drive(HAPPY);

    const result = await runConfigureWizard(ttyIO());

    expect(result.applied).toBe(false);
    expect(result.abort).toBe("needs_root");
    expect(installHooks).not.toHaveBeenCalled();
    expect(installDaemonService).not.toHaveBeenCalled();
    expect(readGlobalConfig().daemonConfigured).toBeUndefined();
    // Not marked seen: the next command must offer setup again, because none
    // of it happened.
    expect(hasSeenLauncher()).toBe(false);
  });

  it("ABORTS without writing anything when the service will not install", async () => {
    // The reason the daemon installs BEFORE any user config: a failure here
    // has to be undoable, and the only way to guarantee that is to have
    // written nothing yet.
    vi.mocked(isDaemonSupportedPlatform).mockReturnValue(true);
    vi.mocked(installDaemonService).mockResolvedValue({
      installed: false,
      reason: "systemctl enable failed",
    });
    drive(HAPPY);

    const result = await runConfigureWizard(ttyIO());

    expect(result.applied).toBe(false);
    expect(result.abort).toBe("daemon_failed");
    expect(installHooks).not.toHaveBeenCalled();
    expect(readGlobalConfig().daemonConfigured).toBeUndefined();
    expect(hasSeenLauncher()).toBe(false);
  });

  it("does not require a daemon, or sudo, on an unsupported platform", async () => {
    // Requiring an impossible step would lock these users out of setup
    // entirely rather than protecting anything.
    vi.mocked(isDaemonSupportedPlatform).mockReturnValue(false);
    drive(HAPPY);

    const result = await runConfigureWizard(ttyIO());

    expect(result.applied).toBe(true);
    expect(primeElevation).not.toHaveBeenCalled();
    expect(installDaemonService).not.toHaveBeenCalled();
    expect(readGlobalConfig().daemonConfigured).toBeUndefined();
  });

  it("skips the install, and the password prompt, when a daemon is already running", async () => {
    // Re-running setup on a configured machine must not demand sudo for work
    // that is already done.
    vi.mocked(isDaemonSupportedPlatform).mockReturnValue(true);
    vi.mocked(daemonServiceStatus).mockReturnValue("running");
    drive(HAPPY);

    const result = await runConfigureWizard(ttyIO());

    expect(result.applied).toBe(true);
    expect(primeElevation).not.toHaveBeenCalled();
    expect(installDaemonService).not.toHaveBeenCalled();
    // Still configured — the daemon is there, it just did not need installing.
    expect(result.daemonInstalled).toBe(true);
    expect(readGlobalConfig().daemonConfigured).toBe(true);
  });

  it("refreshes a running daemon whose unit predates FAILPROOFAI_CLI_CMD", async () => {
    // The upgrade case. Nothing else on the machine ever rewrites the unit —
    // `npm i -g failproofai@latest` does not touch /etc/systemd/system — so
    // without this the daemon has no way to spawn an audit for the rest of the
    // machine's life while config.toml says the scheduled scan is on.
    vi.mocked(isDaemonSupportedPlatform).mockReturnValue(true);
    vi.mocked(daemonServiceStatus).mockReturnValue("running");
    vi.mocked(daemonServiceNeedsUpgrade).mockReturnValue(true);
    vi.mocked(ensureDaemonServiceCurrent).mockResolvedValue({ outcome: "rewritten" });
    vi.mocked(daemonServiceFilePath).mockReturnValue("/etc/systemd/system/failproofaid@test.service");
    drive(HAPPY);

    const result = await runConfigureWizard(ttyIO());

    // The refresh rewrites a root-owned file and restarts the daemon, so the
    // confirmation screen has to say so — a review that lists everything a run
    // will touch except the privileged bit is worse than no review.
    const review = vi.mocked(selectOne).mock.calls.find((c) => c[0].message === "Ready to apply?");
    expect(String(review?.[0].body)).toContain("/etc/systemd/system/failproofaid@test.service");
    vi.mocked(daemonServiceFilePath).mockReturnValue(null);

    expect(result.applied).toBe(true);
    expect(ensureDaemonServiceCurrent).toHaveBeenCalledTimes(1);
    // A refresh, never a reinstall: the daemon is up, and reinstalling would
    // re-resolve a binary path that after a CLI upgrade is not on disk yet.
    expect(installDaemonService).not.toHaveBeenCalled();
    expect(primeElevation).toHaveBeenCalled();
    expect(readGlobalConfig().daemonConfigured).toBe(true);
  });

  it("finishes setup anyway when the unit refresh fails", async () => {
    // Only the scheduled audit is out of reach here — the daemon is up and
    // hooks are enforcing. Aborting would make upgrading the package the thing
    // that locked someone out of `failproofai config`.
    vi.mocked(isDaemonSupportedPlatform).mockReturnValue(true);
    vi.mocked(daemonServiceStatus).mockReturnValue("running");
    vi.mocked(daemonServiceNeedsUpgrade).mockReturnValue(true);
    vi.mocked(ensureDaemonServiceCurrent).mockResolvedValue({
      outcome: "failed",
      reason: "sudo: a password is required",
    });
    drive(HAPPY);

    const result = await runConfigureWizard(ttyIO());

    expect(result.applied).toBe(true);
    expect(readGlobalConfig().daemonConfigured).toBe(true);
  });

  it("stops claiming a daemon when the refresh left it stopped", async () => {
    // The refresh restarts a HEALTHY daemon, which is the one thing the
    // "already running — leaving it alone" branch never used to do. If it
    // cannot bring it back, keeping daemonConfigured set is not "no scheduled
    // audit", it is every tool call across all 12 CLIs denied against a socket
    // nothing is listening on, with no recovery short of hand-editing
    // policies-config.json.
    vi.mocked(isDaemonSupportedPlatform).mockReturnValue(true);
    vi.mocked(daemonServiceStatus).mockReturnValue("running");
    vi.mocked(daemonServiceNeedsUpgrade).mockReturnValue(true);
    vi.mocked(ensureDaemonServiceCurrent).mockResolvedValue({
      outcome: "failed",
      reason: "failproofaid did not come back",
      daemonRunning: false,
    });
    drive(HAPPY);

    const result = await runConfigureWizard(ttyIO());

    // Setup still completes — the hooks it wrote enforce in-process.
    expect(result.applied).toBe(true);
    // Without the switch-back this reads `true`: the wizard seeds
    // daemonInstalled from daemonAlreadyRunning, so a machine that was running
    // a daemon re-asserts the flag at the end of every apply.
    expect(readGlobalConfig().daemonConfigured).toBeUndefined();
    expect(readFpConfig().daemon.configured).toBe(false);
    expect(result.daemonInstalled).toBe(false);
  });

  it("rebuilds a daemon that runs but cannot evaluate anything", async () => {
    // The lockout with no route back: `ExecStart` bakes in `process.execPath`,
    // so an `nvm uninstall 20` months after setup leaves a unit systemd still
    // calls active whose worker dies on every spawn. Every existing check
    // passes that machine — the service manager says running, `Ping` is
    // answered without touching the worker — so this wizard, the documented
    // remedy, took the "already installed and running — leaving it alone"
    // branch and changed nothing, while `daemonConfigured` denied every tool
    // call including UserPromptSubmit.
    vi.mocked(isDaemonSupportedPlatform).mockReturnValue(true);
    vi.mocked(daemonServiceStatus).mockReturnValue("running");
    // False for the health check that classifies the machine as broken, then
    // true for the post-install probe — the rebuilt daemon answers.
    vi.mocked(probeDaemonEndToEnd).mockResolvedValueOnce(false).mockResolvedValue(true);
    vi.mocked(installDaemonService).mockResolvedValue({ installed: true });
    drive(HAPPY);

    const result = await runConfigureWizard(ttyIO());

    expect(result.applied).toBe(true);
    // Torn down BEFORE the reinstall: the dead unit holds the singleton flock
    // the replacement needs, so installing over the top would start a daemon
    // that loses the lock race and leave the machine exactly as broken.
    expect(uninstallDaemonService).toHaveBeenCalled();
    expect(installDaemonService).toHaveBeenCalled();
    expect(result.daemonInstalled).toBe(true);
    vi.mocked(probeDaemonEndToEnd).mockResolvedValue(true);
  });

  it("refuses to finish setup when the freshly installed daemon cannot answer", async () => {
    // The gap the probe exists for: `installDaemonService` can only report that
    // the SERVICE is running, which systemd will happily say about a unit whose
    // worker dies on every spawn. Setting `daemonConfigured` against it denies
    // every tool call on the machine, `UserPromptSubmit` included. The daemon
    // step runs before anything user-facing is written, so aborting here leaves
    // the machine exactly as it was found.
    vi.mocked(isDaemonSupportedPlatform).mockReturnValue(true);
    vi.mocked(daemonServiceStatus).mockReturnValue("not-installed");
    vi.mocked(installDaemonService).mockResolvedValue({ installed: true });
    vi.mocked(probeDaemonEndToEnd).mockResolvedValue(false);
    drive(HAPPY);

    const result = await runConfigureWizard(ttyIO());

    expect(result.applied).toBe(false);
    expect(result.abort).toBe("daemon_failed");
    // Nothing written, and above all the fail-closed flag never set.
    expect(installHooks).not.toHaveBeenCalled();
    expect(readFpConfig().daemon.configured).not.toBe(true);
  });

  it("does not touch a daemon that is running AND answering", async () => {
    // The other half of the branch above: the probe must not turn every
    // healthy re-run into an uninstall/reinstall cycle that demands a password.
    vi.mocked(isDaemonSupportedPlatform).mockReturnValue(true);
    vi.mocked(daemonServiceStatus).mockReturnValue("running");
    vi.mocked(probeDaemonEndToEnd).mockResolvedValue(true);
    drive(HAPPY);

    const result = await runConfigureWizard(ttyIO());

    expect(result.applied).toBe(true);
    expect(uninstallDaemonService).not.toHaveBeenCalled();
    expect(installDaemonService).not.toHaveBeenCalled();
  });

  it("leaves a stale unit alone, without aborting, when root is unavailable", async () => {
    vi.mocked(isDaemonSupportedPlatform).mockReturnValue(true);
    vi.mocked(daemonServiceStatus).mockReturnValue("running");
    vi.mocked(daemonServiceNeedsUpgrade).mockReturnValue(true);
    vi.mocked(primeElevation).mockReturnValue(false);
    drive(HAPPY);

    const result = await runConfigureWizard(ttyIO());

    expect(result.applied).toBe(true);
    expect(result.abort).toBeUndefined();
    // Never attempted: the privileged write would fail, and a `sudo -n`
    // failure per privileged command is noise, not information.
    expect(ensureDaemonServiceCurrent).not.toHaveBeenCalled();
    vi.mocked(primeElevation).mockReturnValue(true);
  });

  it("reinstalls a daemon that is installed but NOT running", async () => {
    // A crash-looped unit is exactly the machine that needs repair. Treating
    // "installed" as good enough would skip it and then set daemonConfigured
    // against a service that never answers — fail-closed on every tool call.
    vi.mocked(isDaemonSupportedPlatform).mockReturnValue(true);
    vi.mocked(daemonServiceStatus).mockReturnValue("stopped");
    vi.mocked(installDaemonService).mockResolvedValue({ installed: true });
    drive(HAPPY);

    await runConfigureWizard(ttyIO());

    expect(primeElevation).toHaveBeenCalled();
    expect(installDaemonService).toHaveBeenCalledTimes(1);
  });

  it("installs the daemon at project scope too — it is machine-level, not per-project", async () => {
    vi.mocked(isDaemonSupportedPlatform).mockReturnValue(true);
    vi.mocked(installDaemonService).mockResolvedValue({ installed: true });
    drive({ ...HAPPY, target: "project" });

    await runConfigureWizard(ttyIO());

    expect(installDaemonService).toHaveBeenCalledTimes(1);
  });

  it("sends a classification, never the raw reason, in the daemon-install telemetry", async () => {
    vi.mocked(isDaemonSupportedPlatform).mockReturnValue(true);
    vi.mocked(installDaemonService).mockResolvedValue({
      installed: false,
      // Carries an OS username and the local filesystem layout — exactly what
      // must not leave the machine.
      reason: "EACCES: permission denied, open '/home/alice/.config/systemd/user/x.service'",
    });
    drive(HAPPY);

    await runConfigureWizard(ttyIO());

    const call = vi
      .mocked(trackHookEvent)
      .mock.calls.find((c) => c[1] === "configure_daemon_install");
    expect(call).toBeDefined();
    const props = call![2] as Record<string, unknown>;
    expect(props.installed).toBe(false);
    expect(props.reason).not.toContain("alice");
    expect(props.reason).not.toContain("/home/");
  });

  it("mentions the daemon in the outro only when one is actually there", async () => {
    vi.mocked(isDaemonSupportedPlatform).mockReturnValue(true);
    vi.mocked(installDaemonService).mockResolvedValue({ installed: true });
    drive(HAPPY);
    await runConfigureWizard(ttyIO());
    expect(vi.mocked(outro).mock.calls[0]![0]).toContain("daemon on");

    // Unsupported platform: no daemon, so no claim of one.
    vi.mocked(outro).mockClear();
    vi.mocked(isDaemonSupportedPlatform).mockReturnValue(false);
    drive(HAPPY);
    await runConfigureWizard(ttyIO());
    expect(vi.mocked(outro).mock.calls[0]![0]).not.toContain("daemon on");
  });

  it("shows the daemon row in the review only when one will be installed", async () => {
    vi.mocked(isDaemonSupportedPlatform).mockReturnValue(true);
    const withDaemon = reviewLines({
      target: "user",
      clis: ["claude"],
      policies: ["block-sudo"],
      cwd: "/tmp/proj",
      installDaemon: true,
    }).join("\n");
    expect(withDaemon).toContain("Daemon");
    expect(withDaemon).toContain("failproofaid");

    // Promising a service the apply will not install is the failure mode here.
    const declined = reviewLines({
      target: "user",
      clis: ["claude"],
      policies: ["block-sudo"],
      cwd: "/tmp/proj",
      installDaemon: false,
    }).join("\n");
    expect(declined).not.toContain("Daemon");

    vi.mocked(isDaemonSupportedPlatform).mockReturnValue(false);
    const unsupported = reviewLines({
      target: "user",
      clis: ["claude"],
      policies: ["block-sudo"],
      cwd: "/tmp/proj",
    }).join("\n");
    expect(unsupported).not.toContain("Daemon");
  });

  it("states plainly whether anything will be reported", async () => {
    // Bundling transcripts into "connect" is only acceptable if the review
    // screen says so in as many words.
    const local = reviewLines({
      target: "user",
      clis: ["claude"],
      policies: [],
      cwd: "/tmp/proj",
      connect: false,
    }).join("\n");
    expect(local).toContain("nothing leaves this machine");

    const connected = reviewLines({
      target: "user",
      clis: ["claude"],
      policies: [],
      cwd: "/tmp/proj",
      connect: true,
    }).join("\n");
    expect(connected).toContain("transcripts");
  });
});
describe("scope targets", () => {
  beforeEach(() => {
    vi.mocked(isDaemonSupportedPlatform).mockReturnValue(false);
  });

  it("installs once per scope when Both is chosen", async () => {
    drive({ ...HAPPY, target: "both" });

    const result = await runConfigureWizard(ttyIO());

    expect(result.applied).toBe(true);
    expect(result.scopes).toEqual(["user", "project"]);
    expect(installHooks).toHaveBeenCalledTimes(2);
    expect(vi.mocked(installHooks).mock.calls.map((c) => c[1])).toEqual(["user", "project"]);
  });

  it("installs once for a single scope", async () => {
    drive(HAPPY);
    const result = await runConfigureWizard(ttyIO());
    expect(result.scopes).toEqual(["user"]);
    expect(installHooks).toHaveBeenCalledTimes(1);
  });

  it("keeps a user-scope-only gateway when Both is chosen", async () => {
    // Hermes and OpenClaw have no project config. Taking the INTERSECTION of
    // what both scopes support would silently drop them and protect less than
    // the user ticked, so the selection is the UNION across scopes.
    drive({ ...HAPPY, target: "both", clis: ["claude", "hermes"] });
    await runConfigureWizard(ttyIO());
    expect(vi.mocked(installHooks).mock.calls[0][7]).toContain("hermes");
  });

  it("does not hand a user-scope-only gateway to the project pass", async () => {
    // The union above is right, and passing it unfiltered to EVERY scope was
    // not. `installHooksImpl` validates each CLI against the scope up front and
    // throws `Scope "project" is not supported by Hermes` — it does not skip,
    // despite the comment here that said it did. With no try/catch around the
    // loop the wizard died mid-apply, after the daemon was installed,
    // `daemonConfigured` was set and user-scope hooks were written, and before
    // any project config or the pasted cloud key. Reachable from the plainest
    // possible answers: "Both" + "Everything available".
    drive({ ...HAPPY, target: "both", clis: ["claude", "hermes"] });
    await runConfigureWizard(ttyIO());

    const [userCall, projectCall] = vi.mocked(installHooks).mock.calls;
    expect(userCall[1]).toBe("user");
    expect(userCall[7]).toContain("hermes");
    expect(projectCall[1]).toBe("project");
    expect(projectCall[7]).not.toContain("hermes");
    expect(projectCall[7]).toContain("claude");
  });

  it("writes nothing when cancelled at the scope step", async () => {
    drive({ target: null });
    const result = await runConfigureWizard(ttyIO());
    expect(result.applied).toBe(false);
    expect(result.abort).toBe("cancelled");
    expect(installHooks).not.toHaveBeenCalled();
  });
});

describe("connect step", () => {
  beforeEach(() => {
    vi.mocked(isDaemonSupportedPlatform).mockReturnValue(false);
    vi.mocked(connectToCloud).mockClear();
    vi.mocked(validateIngestKey).mockClear().mockResolvedValue({ ok: true });
    vi.mocked(promptText)
      .mockReset()
      .mockResolvedValueOnce("https://cloud.example.com")
      .mockResolvedValueOnce("a-real-looking-key");
  });

  it("connects with transcripts ON, as disclosed at the question", async () => {
    // The product decision: connecting bundles decisions AND transcripts
    // behind one clear disclosure. If sessions ever silently became false,
    // the disclosure would be a lie in the other direction.
    drive({ ...HAPPY, connect: "key" });

    const result = await runConfigureWizard(ttyIO());

    expect(result.applied).toBe(true);
    expect(result.connected).toBe(true);
    expect(connectToCloud).toHaveBeenCalledTimes(1);
    expect(vi.mocked(connectToCloud).mock.calls[0][0]).toMatchObject({
      url: "https://cloud.example.com",
      token: "a-real-looking-key",
      sessions: true,
    });
  });

  it("probes the key BEFORE the review screen", async () => {
    // A typo is worth catching while the user is still thinking about
    // credentials, not three screens later after they accepted a review.
    drive({ ...HAPPY, connect: "key" });
    await runConfigureWizard(ttyIO());
    expect(validateIngestKey).toHaveBeenCalledTimes(1);
  });

  it("lets a bad key be skipped, and still applies everything else", async () => {
    vi.mocked(validateIngestKey).mockResolvedValue({ ok: false, reason: "401" });
    // connect -> key, then the retry question -> skip, then review.
    vi.mocked(selectOne)
      .mockResolvedValueOnce("user")
      .mockResolvedValueOnce("key")
      .mockResolvedValueOnce("skip")
      .mockResolvedValueOnce("apply");
    vi.mocked(multiSelect).mockResolvedValueOnce(["git"]).mockResolvedValueOnce(["claude"]);

    const result = await runConfigureWizard(ttyIO());

    expect(result.applied).toBe(true);
    expect(result.connected).toBe(false);
    expect(connectToCloud).not.toHaveBeenCalled();
    expect(installHooks).toHaveBeenCalledTimes(1);
  });

  it("survives a key revoked between the probe and the apply", async () => {
    // connectToCloud re-verifies and writes only what works, so this degrades
    // to a reported partial rather than a connection the machine lacks.
    vi.mocked(connectToCloud).mockResolvedValue({
      policy: { ok: false, reason: "403" },
      ingest: { ok: false, reason: "403" },
      anyConfigured: false,
    });
    drive({ ...HAPPY, connect: "key" });

    const result = await runConfigureWizard(ttyIO());

    // Enforcement does not depend on the dashboard: setup still succeeded.
    expect(result.applied).toBe(true);
    expect(result.connected).toBe(false);
    expect(installHooks).toHaveBeenCalledTimes(1);
  });

  it("does not fail setup when connecting throws outright", async () => {
    vi.mocked(connectToCloud).mockRejectedValue(new Error("network down"));
    drive({ ...HAPPY, connect: "key" });

    const result = await runConfigureWizard(ttyIO());

    expect(result.applied).toBe(true);
    expect(result.connected).toBe(false);
  });

  it("writes nothing when cancelled at the connect step", async () => {
    drive({ target: "user", policies: ["git"], clis: ["claude"], connect: null });
    const result = await runConfigureWizard(ttyIO());
    expect(result.applied).toBe(false);
    expect(installHooks).not.toHaveBeenCalled();
    expect(connectToCloud).not.toHaveBeenCalled();
  });
});
