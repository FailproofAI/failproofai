import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

// The interactive prompts, the install manager, telemetry and CLI detection are
// mocked so we can drive the wizard head-lessly and assert the exact side effect
// (the installHooks call) without touching the filesystem or a real TTY.
vi.mock("../../src/hooks/tui", () => ({
  selectOne: vi.fn(),
  multiSelect: vi.fn(),
  intro: vi.fn(),
  outro: vi.fn(),
}));
vi.mock("../../src/hooks/manager", () => ({ installHooks: vi.fn(async () => {}) }));
vi.mock("../../src/hooks/install-prompt", () => ({ promptPolicySelection: vi.fn() }));
vi.mock("../../src/hooks/hook-telemetry", () => ({ trackHookEvent: vi.fn(async () => {}) }));
vi.mock("../../lib/telemetry-id", () => ({ getInstanceId: vi.fn(() => "test-id") }));
vi.mock("../../src/hooks/integrations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hooks/integrations")>();
  return { ...actual, detectInstalledClis: vi.fn(() => ["claude"]) };
});

import { selectOne, multiSelect, type TTYIn, type TTYOut } from "../../src/hooks/tui";
import { promptPolicySelection } from "../../src/hooks/install-prompt";
import { installHooks } from "../../src/hooks/manager";
import {
  buildScopeChoices,
  buildAgentChoices,
  buildPolicySourceChoices,
  resolvePolicySource,
  reviewLines,
  runConfigureWizard,
  maybeFirstRunConfigure,
  hasSeenLauncher,
  markLauncherSeen,
} from "../../src/hooks/configure-wizard";
import { resolvePreset, resolveEverything } from "../../src/hooks/policy-presets";

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
  vi.mocked(promptPolicySelection).mockReset();
  vi.mocked(installHooks).mockClear();
});

describe("configure-wizard pure builders", () => {
  it("buildScopeChoices offers global (user) and project only", () => {
    const choices = buildScopeChoices("/tmp/proj");
    expect(choices.map((c) => c.value)).toEqual(["user", "project"]);
  });

  it("buildPolicySourceChoices lists presets, then Everything, then Custom", () => {
    const values = buildPolicySourceChoices().map((c) => c.value);
    expect(values).toEqual(["secrets", "git", "ship", "infra", "__everything__", "__custom__"]);
  });

  it("resolvePolicySource maps sources to policy sets", () => {
    expect(resolvePolicySource("__custom__")).toEqual({ custom: true });
    expect(resolvePolicySource("__everything__")).toEqual({
      custom: false,
      policies: resolveEverything(),
    });
    expect(resolvePolicySource("git")).toEqual({ custom: false, policies: resolvePreset("git") });
  });

  it("buildAgentChoices pre-checks detected CLIs and sections the rest", () => {
    const choices = buildAgentChoices("user", "/tmp/proj");
    const claude = choices.find((c) => c.value === "claude");
    expect(claude?.checked).toBe(true);
    expect(claude?.section).toBe("Detected");
    const codex = choices.find((c) => c.value === "codex");
    expect(codex?.section).toBe("Not installed · set up ahead of time");
    // all 7 integrations represented
    expect(choices.length).toBe(7);
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
  it("applies a preset by REPLACING the enabled set for the chosen agents", async () => {
    vi.mocked(selectOne)
      .mockResolvedValueOnce("user") // scope
      .mockResolvedValueOnce("git") // policy source
      .mockResolvedValueOnce("apply"); // review
    vi.mocked(multiSelect).mockResolvedValueOnce(["claude"]);

    const result = await runConfigureWizard(ttyIO());

    expect(result.applied).toBe(true);
    expect(installHooks).toHaveBeenCalledTimes(1);
    const call = vi.mocked(installHooks).mock.calls[0];
    expect(call[0]).toEqual(resolvePreset("git")); // policies
    expect(call[1]).toBe("user"); // scope
    expect(call[4]).toBe("configure-wizard"); // source tag
    expect(call[7]).toEqual(["claude"]); // clis
    expect(call[8]).toBe(true); // replace === true
  });

  it("Custom opens the full picker and installs exactly its selection", async () => {
    vi.mocked(selectOne)
      .mockResolvedValueOnce("project") // scope
      .mockResolvedValueOnce("__custom__") // policy source
      .mockResolvedValueOnce("apply"); // review
    vi.mocked(multiSelect).mockResolvedValueOnce(["claude", "codex"]);
    vi.mocked(promptPolicySelection).mockResolvedValueOnce(["block-sudo"]);

    await runConfigureWizard(ttyIO());

    expect(promptPolicySelection).toHaveBeenCalledTimes(1);
    const call = vi.mocked(installHooks).mock.calls[0];
    expect(call[0]).toEqual(["block-sudo"]);
    expect(call[1]).toBe("project");
    expect(call[7]).toEqual(["claude", "codex"]);
    expect(call[8]).toBe(true);
  });

  it("cancelling at the review step makes no changes", async () => {
    vi.mocked(selectOne)
      .mockResolvedValueOnce("user") // scope
      .mockResolvedValueOnce("git") // policy source
      .mockResolvedValueOnce("cancel"); // review → cancel
    vi.mocked(multiSelect).mockResolvedValueOnce(["claude"]);
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
    expect(written).toContain("failproofai configure");
    expect(hasSeenLauncher()).toBe(false); // not marked in non-TTY
  });

  it("runs the wizard on a fresh first run but does NOT mark seen if cancelled", async () => {
    vi.mocked(selectOne).mockResolvedValueOnce(null); // wizard cancels immediately
    const handled = await maybeFirstRunConfigure(ttyIO());
    expect(handled).toBe(true); // it took over the turn (no dashboard)
    expect(hasSeenLauncher()).toBe(false); // cancelled → not marked → redirects again next time
    expect(existsSync(resolve(tmp, ".failproofai", ".launcher-configured"))).toBe(false);
    expect(installHooks).not.toHaveBeenCalled();
  });

  it("marks the launcher seen only after a completed apply", async () => {
    vi.mocked(selectOne)
      .mockResolvedValueOnce("user") // scope
      .mockResolvedValueOnce("git") // policy source
      .mockResolvedValueOnce("apply"); // review → apply
    vi.mocked(multiSelect).mockResolvedValueOnce(["claude"]);
    const handled = await maybeFirstRunConfigure(ttyIO());
    expect(handled).toBe(true);
    expect(installHooks).toHaveBeenCalledTimes(1);
    expect(hasSeenLauncher()).toBe(true);
  });

  it("does not redirect again once the launcher has been seen", async () => {
    markLauncherSeen(); // simulate a prior completed setup
    const handled = await maybeFirstRunConfigure(ttyIO());
    expect(handled).toBe(false);
    expect(selectOne).not.toHaveBeenCalled();
  });
});
