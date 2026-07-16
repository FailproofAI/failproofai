import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

// The interactive prompts, the install manager, telemetry and CLI detection are
// mocked so we can drive the wizard head-lessly and assert the exact side effect
// (the installHooks call) without touching the filesystem or a real TTY.
vi.mock("../../src/hooks/tui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hooks/tui")>();
  // Keep the pure helpers (summarize, ellipsize) real; stub only the interactive prompts.
  return { ...actual, selectOne: vi.fn(), multiSelect: vi.fn(), intro: vi.fn(), outro: vi.fn() };
});
vi.mock("../../src/hooks/manager", () => ({ installHooks: vi.fn(async () => {}) }));
// The wizard kicks off the audit pipeline after a completed apply; stub it so
// tests never scan real history.
vi.mock("../../src/audit/cli", () => ({ runPostSetupAudit: vi.fn(async () => {}) }));
vi.mock("../../src/hooks/hook-telemetry", () => ({ trackHookEvent: vi.fn(async () => {}) }));
vi.mock("../../lib/telemetry-id", () => ({ getInstanceId: vi.fn(() => "test-id") }));
vi.mock("../../src/hooks/integrations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hooks/integrations")>();
  return { ...actual, detectInstalledClis: vi.fn(() => ["claude"]) };
});

import { selectOne, multiSelect, type TTYIn, type TTYOut } from "../../src/hooks/tui";
import { installHooks } from "../../src/hooks/manager";
import {
  buildScopeChoices,
  buildAgentChoices,
  buildPresetChoices,
  resolvePresetSelection,
  reviewLines,
  runConfigureWizard,
  maybeFirstRunConfigure,
  hasSeenLauncher,
  markLauncherSeen,
} from "../../src/hooks/configure-wizard";
import { resolvePreset, resolveEverything } from "../../src/hooks/policy-presets";
import { INTEGRATION_TYPES } from "../../src/hooks/types";
import { runPostSetupAudit } from "../../src/audit/cli";

const mkTtyStdin = (): TTYIn => ({ isTTY: true }) as unknown as TTYIn;
const mkTtyStdout = (): TTYOut =>
  ({ isTTY: true, write: vi.fn(() => true), columns: 80 }) as unknown as TTYOut;
const ttyIO = () => ({ stdin: mkTtyStdin(), stdout: mkTtyStdout() });

// The wizard's apply path calls markLauncherSeen(), which writes under
// homedir()/.failproofai — isolate HOME for the whole file so no test ever
// touches the developer's real config.
let fileHome: string;
let realHome: string | undefined;
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
});

beforeEach(() => {
  vi.mocked(selectOne).mockReset();
  vi.mocked(multiSelect).mockReset();
  vi.mocked(installHooks).mockClear();
  vi.mocked(runPostSetupAudit).mockClear();
});

describe("configure-wizard pure builders", () => {
  it("buildScopeChoices offers global (user) and project only", () => {
    const choices = buildScopeChoices("/tmp/proj");
    expect(choices.map((c) => c.value)).toEqual(["user", "project"]);
  });

  it("buildPresetChoices lists the presets plus Everything (no Custom)", () => {
    const values = buildPresetChoices().map((c) => c.value);
    expect(values).toEqual(["secrets", "git", "ship", "infra", "__everything__"]);
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
      scope: "user",
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
});

describe("configure-wizard orchestration", () => {
  it("applies the union of selected presets, REPLACING the enabled set", async () => {
    vi.mocked(selectOne)
      .mockResolvedValueOnce("user") // scope
      .mockResolvedValueOnce("apply"); // review
    vi.mocked(multiSelect)
      .mockResolvedValueOnce(["claude"]) // assistants
      .mockResolvedValueOnce(["secrets", "git"]); // policy sources (multi-select)

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
    vi.mocked(selectOne)
      .mockResolvedValueOnce("user") // scope
      .mockResolvedValueOnce("apply"); // review
    vi.mocked(multiSelect)
      .mockResolvedValueOnce(["__all_clis__"]) // assistants → Everything available
      .mockResolvedValueOnce(["git"]); // policy sources
    await runConfigureWizard(ttyIO());
    const call = vi.mocked(installHooks).mock.calls[0];
    expect(call[7]).toEqual([...INTEGRATION_TYPES]); // all CLIs, regardless of detection
  });

  it("cancelling at the review step makes no changes", async () => {
    vi.mocked(selectOne)
      .mockResolvedValueOnce("user") // scope
      .mockResolvedValueOnce("cancel"); // review → cancel
    vi.mocked(multiSelect)
      .mockResolvedValueOnce(["claude"]) // assistants
      .mockResolvedValueOnce(["git"]); // policy sources
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
    vi.mocked(selectOne)
      .mockResolvedValueOnce("user") // scope
      .mockResolvedValueOnce("apply"); // review → apply
    vi.mocked(multiSelect)
      .mockResolvedValueOnce(["claude"]) // assistants
      .mockResolvedValueOnce(["git"]); // policy sources
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
