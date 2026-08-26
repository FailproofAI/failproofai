import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { summarize } from "../../src/hooks/tui";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";

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
    canElevate: vi.fn(() => true),
    // The end-to-end health probe opens the real daemon socket. Default true —
    // "the service manager says running" and "it can actually answer" agree on
    // a healthy machine, which is what every pre-existing test here means by
    // running. The tests that drive the broken-worker branch override it.
    probeDaemonEndToEnd: vi.fn(async () => true),
    // Richer form the wizard uses so it can name WHICH fault it hit — an
    // unreachable socket and a worker that will not run need different words.
    probeDaemon: vi.fn(async () => ({ ok: true })),
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
  canElevate,
  probeDaemon,
  probeDaemonEndToEnd,
  uninstallDaemonService,
} from "../../src/hooks/daemon-service";
import {
  buildAgentChoices,
  buildCompletionSummary,
  clisSupportingScope,
  reviewLines,
  policyNamesLine,
  runConfigureWizard,
  maybeFirstRunConfigure,
  hasSeenLauncher,
  markLauncherSeen,
} from "../../src/hooks/configure-wizard";
import { INTEGRATION_TYPES, type IntegrationType } from "../../src/hooks/types";
import { getIntegration } from "../../src/hooks/integrations";
import { runPostSetupAudit } from "../../src/audit/cli";
import { trackHookEvent } from "../../src/hooks/hook-telemetry";
import { configFile as fpConfigFile, launcherMarker } from "../../src/hooks/fp-home";
import { readConfig as readFpConfig } from "../../src/hooks/fp-config";

const mkTtyStdin = (): TTYIn => ({ isTTY: true }) as unknown as TTYIn;
const mkTtyStdout = (): TTYOut =>
  ({ isTTY: true, write: vi.fn(() => true), columns: 80 }) as unknown as TTYOut;
const ttyIO = () => ({ stdin: mkTtyStdin(), stdout: mkTtyStdout() });

/** A pipe, a CI job, or an agent driving the CLI — anything without a terminal. */
const headlessIO = () => ({
  stdin: { isTTY: false } as unknown as TTYIn,
  stdout: { isTTY: false, write: vi.fn(() => true), columns: 80 } as unknown as TTYOut,
});

/**
 * Queue answers for a wizard run BY NAME rather than by position.
 *
 * The wizard's step order is a product decision that has already changed twice
 * (policies moved ahead of assistants and then left entirely; the
 * Recommended/Customize fork and the scope question both went). Positional
 * `mockResolvedValueOnce` chains meant every such change broke every test at
 * once and each had to be re-counted by hand — which is exactly the kind of
 * churn that tempts someone to "fix" a test by loosening it. Naming the steps
 * keeps a reorder to a one-line change here.
 *
 * Current order — selectOne: connect, review.
 *                 multiSelect: assistants.
 * `undefined` means "this step is not reached in this test".
 *
 * There is no policy step and no scope step. Setup asks nothing about what to
 * enforce, and scope is GLOBAL always — a project-scoped install guards the one
 * directory it was run from and silently leaves every other repo unguarded. So
 * `multiSelect` is asked exactly once, for the harnesses, and `selectOne` twice.
 */
function drive(answers: {
  connect?: "key" | "local" | null;
  review?: "apply" | "cancel" | null;
}) {
  const one = vi.mocked(selectOne);
  if ("connect" in answers) one.mockResolvedValueOnce(answers.connect as never);
  if ("review" in answers) one.mockResolvedValueOnce(answers.review as never);
}

/** The happy path: global scope, Claude, stay local, apply. */
/** The happy path: stay local, apply. Setup asks nothing else. */
const HAPPY = {
  connect: "local" as const,
  review: "apply" as const,
};

/**
 * A realistic enabled set for the review-screen tests below.
 *
 * These were written against `RECOMMENDED_POLICIES`, which left with the preset
 * module — the wizard has no policy list of its own any more. The names are kept
 * verbatim rather than replaced with `policy-1 … policy-14` because what these
 * tests measure is COLUMN WIDTH, and a slug of the wrong length measures the
 * wrong thing. Membership is not the subject: `reviewLines`' truncation is.
 */
const FOURTEEN_ENABLED = [
  "sanitize-jwt",
  "sanitize-api-keys",
  "sanitize-connection-strings",
  "sanitize-private-key-content",
  "sanitize-bearer-tokens",
  "protect-env-vars",
  "block-env-files",
  "block-secrets-write",
  "block-failproofai-commands",
  "block-sudo",
  "block-curl-pipe-sh",
  "block-rm-rf",
  "block-push-master",
  "block-force-push",
];

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
  // Supported-and-already-healthy is the safe default for every test that
  // isn't specifically about the daemon step: it makes step 0 a one-line
  // no-op ("already installed and running — leaving it alone") without
  // demanding sudo — and, now that an unsupported platform hard-fails setup
  // before a single prompt is drawn, without aborting every other test in
  // this file. Tests that actually exercise the daemon step override these.
  vi.mocked(isDaemonSupportedPlatform).mockReset().mockReturnValue(true);
  vi.mocked(daemonServiceStatus).mockReset().mockReturnValue("running");
  vi.mocked(daemonServiceNeedsUpgrade).mockReset().mockReturnValue(false);
  vi.mocked(installDaemonService).mockReset().mockResolvedValue({ installed: true });
  // Reset too, or call counts leak across tests and "was never asked for sudo"
  // silently passes on history from an earlier one.
  vi.mocked(primeElevation).mockReset().mockReturnValue(true);
  // Same reason: "a healthy daemon was left alone" asserts a call count of
  // zero, which the broken-worker test above would otherwise satisfy for it.
  vi.mocked(probeDaemonEndToEnd).mockReset().mockResolvedValue(true);
  vi.mocked(probeDaemon).mockReset().mockResolvedValue({ ok: true });
  vi.mocked(uninstallDaemonService).mockReset().mockResolvedValue(undefined);
});

describe("configure-wizard pure builders", () => {
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
      clis: ["claude"],
      target: "user",
      policies: ["block-sudo", "block-rm-rf"],
      cwd: "/tmp/proj",
    }).join("\n");
    expect(lines).toContain("Everywhere (global)");
    expect(lines).toContain("Claude Code");
    expect(lines).toContain("2 enabled");
    expect(lines).toContain("policies-config.json");
    expect(lines).toContain("settings.json");
  });

  it("reviewLines gives a taste of the policies without listing them all", () => {
    // Two names say what KIND of thing these are; naming all fourteen turned a
    // four-line review into a thirteen-line one, and a screen nobody reads to
    // the bottom conveys less than a short one.
    const lines = reviewLines({
      clis: ["claude"],
      target: "user",
      policies: [...FOURTEEN_ENABLED],
      cwd: "/tmp/proj",
    });
    const joined = lines.join("\n");
    expect(joined).toContain("14 enabled");
    expect(joined).toContain("block-curl-pipe-sh, block-env-files +12");
    // The other thirteen are NOT on screen.
    expect(joined).not.toContain("sanitize-private-key-content");
    // One line for the count, one for the taste — never a paragraph.
    expect(lines.filter((l) => l.includes("block-curl-pipe-sh"))).toHaveLength(1);
  });

  it("reviewLines keeps every line inside the 80-column budget", () => {
    // `writeLines` truncates with a hard cut and no ellipsis, so an over-long
    // line does not visibly lose its tail — it ends mid-slug and reads as a
    // policy name that does not exist.
    for (const line of reviewLines({
      clis: ["claude"],
      target: "user",
      policies: [...FOURTEEN_ENABLED],
      cwd: "/tmp/proj",
    })) {
      expect(line.length, `too wide: ${line}`).toBeLessThanOrEqual(80);
    }
  });

  it("the taste stays two names however large the enabled set gets", () => {
    // A pack can enable an unbounded number of policies, so the taste has to be
    // bounded by the LINE, not by the set. Generated rather than taken from a
    // fixed list: the point is that the count grows and the line does not.
    const many = Array.from({ length: 60 }, (_, i) => `block-thing-${i}`);
    const lines = reviewLines({
      clis: ["claude"],
      target: "user",
      policies: many,
      cwd: "/tmp/proj",
    }).join("\n");
    expect(lines).toContain(`${many.length} enabled`);
    expect(lines).toContain(`+${many.length - 2}`);
  });

  it("policyNamesLine drops names rather than overflowing the budget", () => {
    // Degrading by dropping a name is recoverable; overflowing is not, because
    // the hard cut makes the tail look like a policy name that does not exist.
    const long = [
      "sanitize-private-key-content",
      "sanitize-connection-strings",
      "block-failproofai-commands",
    ];
    for (const line of policyNamesLine(long)) {
      expect(line.startsWith(" ".repeat(15))).toBe(true);
      expect(line.length).toBeLessThanOrEqual(77);
    }
    expect(policyNamesLine([])).toEqual([]);
    // A single policy needs no "+N" at all.
    expect(policyNamesLine(["block-sudo"])[0].trim()).toBe("block-sudo");
  });

  it("reviewLines reports an empty policy set as a choice, not a count of zero", () => {
    const lines = reviewLines({
      clis: ["claude"],
      target: "user",
      policies: [],
      cwd: "/tmp/proj",
    }).join("\n");
    expect(lines).toContain("none enabled");
    expect(lines).not.toContain("0 enabled");
    // Tell the user where to change their mind, so an intentional "none" does
    // not read like the wizard dropped the selection.
    expect(lines).toContain("failproofai policies --install");
  });

  // The 3-column gutter ("└  ") that outro() prepends when rendered.
  const GUTTER = 3;

  it("keeps the completion summary within 80 columns for the longest real combination", () => {
    // Every builtin policy, every supported CLI, and every optional note
    // present at once — the worst case now that an unsupported platform
    // aborts before this line is ever reached (so "no daemon" can no longer
    // shrink it).
    const message = buildCompletionSummary(
      99, // headroom above today's real policy count
      INTEGRATION_TYPES.length,
      true, // custom enabled
      true, // daemon installed
      true, // connected
    );
    expect(message.length + GUTTER).toBeLessThanOrEqual(80);
    expect(message).toContain("custom");
    expect(message).toContain("daemon");
    expect(message).toContain("reporting");
  });

  it("keeps the completion summary within 80 columns with custom policies explicitly off", () => {
    // "off" is the longer of the two custom-policies tags, and stacks with
    // the other two notes the same way "custom" does above.
    const message = buildCompletionSummary(99, INTEGRATION_TYPES.length, false, true, true);
    expect(message.length + GUTTER).toBeLessThanOrEqual(80);
    expect(message).toContain("custom off");
  });

  it("counts the enabled policies rather than naming a bundle it did not pick", () => {
    // The summary used to name the bundles the user had just ticked. There are no
    // bundles and no policy step any more, so a count is the only thing this line
    // can honestly say — and it must say it in the right number, since "1 policies"
    // on the last screen of setup reads as a bug in everything above it.
    expect(buildCompletionSummary(1, 1, undefined, false, false)).toBe(
      "Setup complete — 1 policy · 1 harness",
    );
    expect(buildCompletionSummary(3, 1, undefined, false, false)).toBe(
      "Setup complete — 3 policies · 1 harness",
    );
  });

  it("omits every optional note when nothing is present", () => {
    const message = buildCompletionSummary(2, 1, undefined, false, false);
    expect(message).toBe("Setup complete — 2 policies · 1 harness");
  });
});

describe("configure-wizard orchestration", () => {
  it("installs at the chosen scope, tagged as the wizard, REPLACING the enabled set", async () => {
    drive({ connect: "local", review: "apply" });

    const result = await runConfigureWizard(ttyIO());

    expect(result.applied).toBe(true);
    expect(installHooks).toHaveBeenCalledTimes(1);
    const call = vi.mocked(installHooks).mock.calls[0];
    expect(call[1]).toBe("user"); // scope
    expect(call[4]).toBe("configure-wizard"); // source tag
    expect(call[7]).toEqual([...INTEGRATION_TYPES]); // every supported agent
    expect(call[8]).toEqual({ replace: true, quiet: true }); // options
  });

  // ── Setup enables nothing of its own ─────────────────────────────────────
  //
  // failproofai ships no policies now: they arrive as packs. A wizard that
  // pre-ticks a list makes a product decision for somebody who has not seen the
  // list, so the only honest value to write is whatever the scope already had.
  //
  // `replace: true` makes this load-bearing in BOTH directions. Write more than
  // was there and setup silently enables policies nobody chose; write less and
  // re-running setup silently switches off policies they did.
  it("writes back exactly the policies the scope already had, adding none of its own", async () => {
    // Seeded as a real file rather than a mock: `readScopedHooksConfig` is the
    // genuine implementation in this suite, and it reads user scope out of the
    // HOME this file isolates.
    const cfgPath = resolve(fileHome, ".failproofai", "policies-config.json");
    mkdirSync(dirname(cfgPath), { recursive: true });
    const theirs = ["block-kubectl", "some-pack-policy"];
    writeFileSync(cfgPath, JSON.stringify({ enabledPolicies: theirs }));
    try {
      drive(HAPPY);

      await runConfigureWizard(ttyIO());

      // Equality, not `toContain`: a single name of ours slipping in is exactly
      // the regression this exists for, and `toContain` cannot see it.
      expect(vi.mocked(installHooks).mock.calls[0][0]).toEqual(theirs);
    } finally {
      rmSync(cfgPath, { force: true });
    }
  });

  it("writes an empty policy list when the scope has nothing enabled", async () => {
    // No config file at all — the state every brand-new machine is in. Setup
    // still completes and still wires the hooks, so a pack added later enforces
    // without re-running the wizard.
    rmSync(resolve(fileHome, ".failproofai", "policies-config.json"), { force: true });
    drive(HAPPY);

    const result = await runConfigureWizard(ttyIO());

    expect(result.applied).toBe(true);
    expect(installHooks).toHaveBeenCalledTimes(1);
    const call = vi.mocked(installHooks).mock.calls[0];
    expect(call[0]).toEqual([]); // nothing enabled, and nothing invented
    expect(call[7]).toEqual([...INTEGRATION_TYPES]); // every agent, regardless
    expect(call[8]).toEqual({ replace: true, quiet: true }); // empty set REPLACES
  });

  it("applies globally, always — scope is not a question any more", async () => {
    // Scope was a fork, and it is gone: a project-scoped install guards the one
    // directory the command was run from and silently leaves every other repo
    // on the machine unguarded. `policies --install --scope project` is still
    // there for somebody who genuinely wants that and knows they do.
    drive({ connect: "local", review: "apply" });

    const result = await runConfigureWizard(ttyIO());

    expect(result.applied).toBe(true);
    const call = vi.mocked(installHooks).mock.calls[0];
    expect(call[1]).toBe("user"); // global, never the cwd's project
    expect(call[8]).toEqual({ replace: true, quiet: true });
  });

  it("asks NOTHING about agents, and wires every supported one", async () => {
    // Hooks alone enforce nothing now that no policy ships, so wiring them
    // everywhere costs a config entry and changes no behaviour until a pack
    // arrives — while an agent installed next week is guarded from its first
    // tool call instead of running unguarded until somebody re-runs setup.
    // Which agents a PACK guards is chosen at `policies add`, against a real list.
    drive({ connect: "local", review: "apply" });

    const result = await runConfigureWizard(ttyIO());

    expect(result.applied).toBe(true);
    expect(vi.mocked(multiSelect)).not.toHaveBeenCalled();
    const clis = vi.mocked(installHooks).mock.calls[0]![7] as IntegrationType[];
    expect(clis.length).toBe(clisSupportingScope("user").length);
  });

  it("'Everything available' protects every supported CLI", async () => {
    drive({ connect: "local", review: "apply" });
    await runConfigureWizard(ttyIO());
    const call = vi.mocked(installHooks).mock.calls[0];
    // Every supported CLI, detected or not — there is no row to tick any more.
    expect(call[7]).toEqual([...INTEGRATION_TYPES]);
  });

  it("asks no multi-select at all — neither policies nor agents", async () => {
    drive({ connect: "local", review: "apply" });

    await runConfigureWizard(ttyIO());

    // Both multi-selects setup used to run are gone. A call here means one of
    // them came back.
    expect(vi.mocked(multiSelect).mock.calls).toHaveLength(0);
  });

  it("never writes into the repository's own config when applying at project scope", async () => {
    // The defect this pins: project scope resolves its config from
    // process.cwd(), which under test is this repo, so an applied run wrote
    // `customPoliciesEnabled: false` into the tracked dogfood config — and the
    // next `git add -A` committed custom policies switched off for everyone.
    // Isolating HOME did not help, because project scope never reads HOME.
    const repoConfig = resolve(process.cwd(), ".failproofai", "policies-config.json");
    const before = existsSync(repoConfig) ? readFileSync(repoConfig, "utf8") : null;

    drive({ connect: "local", review: "apply" });
    await runConfigureWizard(ttyIO());

    const after = existsSync(repoConfig) ? readFileSync(repoConfig, "utf8") : null;
    expect(after).toBe(before);
  });

  it("cancelling at the review step makes no changes", async () => {
    drive({ connect: "local", review: "cancel" });
    const result = await runConfigureWizard(ttyIO());
    expect(result.applied).toBe(false);
    expect(installHooks).not.toHaveBeenCalled();
  });

  it("cancelling at the first question makes no changes", async () => {
    // That question is the HARNESS step now — the scope and mode forks that used
    // to precede it are gone, so a ctrl-c lands on `multiSelect`, not `selectOne`.
    vi.mocked(multiSelect).mockResolvedValueOnce(null as never); // harnesses → quit
    const result = await runConfigureWizard(ttyIO());
    expect(result.applied).toBe(false);
    expect(installHooks).not.toHaveBeenCalled();
  });

  it("applies in a non-TTY context instead of returning guidance", async () => {
    // It used to print "needs an interactive terminal" and do nothing, so no
    // CI job, container or agent could configure a machine at all. There is
    // nothing to confirm when nobody is watching, and `failproofai config` is
    // itself the authorisation — somebody typed the command whose entire job
    // is to configure this machine. Requiring a flag on top of that asked the
    // same question twice.
    //
    // Safe because the IMPLICIT path is guarded separately:
    // `maybeFirstRunConfigure` has its own TTY check and returns before ever
    // reaching the wizard, so this never fires off the back of another command.
    vi.mocked(isDaemonSupportedPlatform).mockReturnValue(true);
    const stdout = mkTtyStdout();
    const result = await runConfigureWizard({
      stdin: { isTTY: false } as unknown as TTYIn,
      stdout,
    });
    expect(result.applied).toBe(true);
    expect(installHooks).toHaveBeenCalled();
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
    vi.mocked(multiSelect).mockResolvedValueOnce(null as never); // wizard cancels immediately
    const handled = await maybeFirstRunConfigure(ttyIO());
    expect(handled).toBe(true); // it took over the turn (no dashboard)
    expect(hasSeenLauncher()).toBe(false); // cancelled → not marked → redirects again next time
    expect(existsSync(resolve(tmp, ".failproofai", ".launcher-configured"))).toBe(false);
    expect(installHooks).not.toHaveBeenCalled();
    expect(runPostSetupAudit).not.toHaveBeenCalled(); // no apply → no auto-audit
  });

  it("marks the launcher seen only after a completed apply", async () => {
    drive({ connect: "local", review: "apply" });
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

  it("hard-fails cleanly on an unsupported platform, and does not nag again next command", async () => {
    vi.mocked(isDaemonSupportedPlatform).mockReturnValue(false);

    const first = await maybeFirstRunConfigure(ttyIO());
    expect(first).toBe(true); // took over the turn
    expect(hasSeenLauncher()).toBe(false); // never completed
    expect(installHooks).not.toHaveBeenCalled();

    // The next command must not relaunch the wizard and hard-fail again.
    const second = await maybeFirstRunConfigure(ttyIO());
    expect(second).toBe(false); // a one-line hint instead of a relaunch
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
    // The widest line this can produce: user scope, which every CLI supports,
    // and a policy count wide enough to be worth measuring. The count is no
    // longer bounded by a builtin list — a pack can enable any number — so it is
    // seeded rather than assumed. User scope, not project, because project reads
    // its config from `process.cwd()`, which under test is this repo: the count
    // would then be whatever the dogfood config happens to hold that week.
    const userConfig = resolve(fileHome, ".failproofai", "policies-config.json");
    mkdirSync(dirname(userConfig), { recursive: true });
    writeFileSync(
      userConfig,
      JSON.stringify({
        enabledPolicies: Array.from({ length: 999 }, (_, i) => `block-thing-${i}`),
      }),
    );
    try {
      drive({ connect: "local", review: "apply" });

      await runConfigureWizard({ stdin: mkTtyStdin(), stdout });

      const message = vi.mocked(outro).mock.calls[0]![0];
      expect(message).toContain("Setup complete");
      expect(message).toContain("999 policies");
      // 3 columns of gutter ("└  ") sit in front of it when rendered.
      expect(message.length + 3).toBeLessThanOrEqual(80);
      expect(message).toContain("harnesses"); // the tail survived
    } finally {
      rmSync(userConfig, { force: true });
    }
  });

  it("applies to only the scope-supported CLIs when Everything available is ticked", async () => {
    // Measured against USER scope now, because that is the only scope setup
    // writes. Under the old project/both options this had to exclude the
    // gateways with no project config; at user scope every integration
    // qualifies, and the assertion is that none is silently dropped.
    drive({ connect: "local", review: "apply" });

    await runConfigureWizard(ttyIO());

    const clis = vi.mocked(installHooks).mock.calls[0]![7] as IntegrationType[];
    expect(clis.length).toBe(clisSupportingScope("user").length);
    for (const id of clis) expect(getIntegration(id).scopes).toContain("user");
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

  it("runs with no terminal at all when the answers were supplied", async () => {
    // The whole point of headless setup: `--yes` answers the one question that
    // is left, so the terminal requirement no longer applies. Before this there
    // was NO non-interactive path to a configured machine at all —
    // `installDaemonService` had exactly one caller, the wizard, and the wizard
    // refused without a TTY.
    vi.mocked(isDaemonSupportedPlatform).mockReturnValue(true);
    const result = await runConfigureWizard(headlessIO());

    expect(result.applied).toBe(true);
    expect(installHooks).toHaveBeenCalled();
  });

  it("draws no prompt of any kind when answered", async () => {
    // Not "the prompts default sensibly" — they must not RUN. A prompt that
    // degrades to its default on a non-TTY is how a script silently gets a
    // decision nobody made.
    vi.mocked(isDaemonSupportedPlatform).mockReturnValue(true);
    await runConfigureWizard(headlessIO());

    expect(vi.mocked(selectOne)).not.toHaveBeenCalled();
    expect(vi.mocked(multiSelect)).not.toHaveBeenCalled();
    expect(vi.mocked(promptText)).not.toHaveBeenCalled();
  });

  it("asks sudo for nothing it cannot be answered for", async () => {
    // `primeElevation` runs `sudo -v`, which PROMPTS — the one gate that would
    // hang an unattended run. It goes straight to the non-interactive check
    // instead, which is what `failproofai update` already does.
    vi.mocked(isDaemonSupportedPlatform).mockReturnValue(true);
    await runConfigureWizard(headlessIO());

    expect(vi.mocked(primeElevation)).not.toHaveBeenCalled();
    expect(vi.mocked(canElevate)).toHaveBeenCalled();
  });

  it("stays local when no key was given, and connects when one was", async () => {
    // Supplying a key IS the request to connect; there is no other reason to
    // pass one, so there is no second flag to remember.
    vi.mocked(isDaemonSupportedPlatform).mockReturnValue(true);
    const local = await runConfigureWizard(headlessIO());
    expect(local.connected).toBeFalsy();

    const connected = await runConfigureWizard(headlessIO(), { token: "k".repeat(20) });
    expect(connected.connected).toBe(true);
  });

  it("fails rather than saving a key the server refused", async () => {
    // The interactive path offers "save it anyway", because a person can weigh
    // an outage against their own impatience. A script cannot, and one that
    // exited 0 here would leave a fleet believing it was reporting.
    vi.mocked(isDaemonSupportedPlatform).mockReturnValue(true);
    vi.mocked(validateIngestKey).mockResolvedValueOnce({ ok: false, reason: "401" } as never);

    const result = await runConfigureWizard(headlessIO(), { token: "k".repeat(20) });

    expect(result.applied).toBe(false);
    expect(result.abort).toBe("cloud_unverified");
    expect(installHooks).not.toHaveBeenCalled();
  });

  it("sets the machine up when there is no terminal, rather than refusing", async () => {
    // It used to print "needs an interactive terminal" and decline — so a CI
    // job, a container or an agent could not configure a machine at all. There
    // is nothing to confirm when nobody is watching, and `failproofai config`
    // is itself the authorisation: somebody typed the command whose whole job
    // is to configure this machine.
    vi.mocked(isDaemonSupportedPlatform).mockReturnValue(true);
    const result = await runConfigureWizard(headlessIO());

    expect(result.applied).toBe(true);
    expect(installHooks).toHaveBeenCalled();
  });

  it("reports WHY it configured nothing when run under sudo", async () => {
    // Same class: it configured nothing and it was not a cancellation, so it
    // must not read as success. `running_as_sudo` was likewise declared and
    // never assigned.
    const getuid = process.getuid;
    Object.defineProperty(process, "getuid", { value: () => 0, configurable: true });
    vi.stubEnv("SUDO_USER", "chetan");
    try {
      const result = await runConfigureWizard(ttyIO());
      expect(result.applied).toBe(false);
      expect(result.abort).toBe("running_as_sudo");
      expect(installHooks).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "getuid", { value: getuid, configurable: true });
      vi.unstubAllEnvs();
    }
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

  it("hard-fails on an unsupported platform, before drawing a single prompt", async () => {
    // A Windows machine (or any non-linux/darwin platform) has nothing
    // running failproofaid — completing setup anyway used to leave it
    // reading as configured while enforcing in-process, with no fail-closed
    // guarantee. Refusing outright is the honest failure.
    vi.mocked(isDaemonSupportedPlatform).mockReturnValue(false);
    drive(HAPPY);

    const result = await runConfigureWizard(ttyIO());

    expect(result.applied).toBe(false);
    expect(result.abort).toBe("unsupported_platform");
    expect(selectOne).not.toHaveBeenCalled();
    expect(multiSelect).not.toHaveBeenCalled();
    expect(primeElevation).not.toHaveBeenCalled();
    expect(installDaemonService).not.toHaveBeenCalled();
    expect(installHooks).not.toHaveBeenCalled();
    expect(readGlobalConfig().daemonConfigured).toBeUndefined();
  });

  it("explains why, naming the platform, when it hard-fails on an unsupported platform", async () => {
    vi.mocked(isDaemonSupportedPlatform).mockReturnValue(false);
    const stdout = mkTtyStdout();

    await runConfigureWizard({ stdin: mkTtyStdin(), stdout });

    const written = vi.mocked(stdout.write).mock.calls.map((c) => String(c[0])).join("");
    expect(written).toContain("Linux");
    expect(written).toContain("macOS");
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
    // Two different call sites: the boolean form DETECTS the broken daemon
    // (first call, false), and the richer form VERIFIES the rebuild afterwards
    // (must be ok, or the wizard aborts and nothing is applied).
    vi.mocked(probeDaemonEndToEnd).mockResolvedValueOnce(false).mockResolvedValue(true);
    vi.mocked(probeDaemon).mockResolvedValue({ ok: true });
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
    vi.mocked(probeDaemon).mockResolvedValue({ ok: true });
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
    vi.mocked(probeDaemon).mockResolvedValue({ ok: false, reason: "worker" });
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
    vi.mocked(probeDaemon).mockResolvedValue({ ok: true });
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

  it("installs the daemon before anything else, because it is the only step needing a password", async () => {
    vi.mocked(isDaemonSupportedPlatform).mockReturnValue(true);
    vi.mocked(installDaemonService).mockResolvedValue({ installed: true });
    drive(HAPPY);

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

  it("mentions the daemon in the outro when one is actually there", async () => {
    vi.mocked(isDaemonSupportedPlatform).mockReturnValue(true);
    vi.mocked(installDaemonService).mockResolvedValue({ installed: true });
    drive(HAPPY);
    await runConfigureWizard(ttyIO());
    expect(vi.mocked(outro).mock.calls[0]![0]).toContain("daemon");
  });

  it("shows the daemon row in the review only when one will be installed", async () => {
    vi.mocked(isDaemonSupportedPlatform).mockReturnValue(true);
    const withDaemon = reviewLines({
      clis: ["claude"],
      target: "user",
      policies: ["block-sudo"],
      cwd: "/tmp/proj",
      installDaemon: true,
    }).join("\n");
    expect(withDaemon).toContain("Daemon");
    expect(withDaemon).toContain("failproofaid");

    // Promising a service the apply will not install is the failure mode here.
    const declined = reviewLines({
      clis: ["claude"],
      target: "user",
      policies: ["block-sudo"],
      cwd: "/tmp/proj",
      installDaemon: false,
    }).join("\n");
    expect(declined).not.toContain("Daemon");

    vi.mocked(isDaemonSupportedPlatform).mockReturnValue(false);
    const unsupported = reviewLines({
      clis: ["claude"],
      target: "user",
      policies: ["block-sudo"],
      cwd: "/tmp/proj",
    }).join("\n");
    expect(unsupported).not.toContain("Daemon");
  });

  it("states plainly whether anything will be reported", async () => {
    // Bundling transcripts into "connect" is only acceptable if the review
    // screen says so in as many words.
    const local = reviewLines({
      clis: ["claude"],
      target: "user",
      policies: [],
      cwd: "/tmp/proj",
      connect: false,
    }).join("\n");
    expect(local).toContain("nothing leaves this machine");

    const connected = reviewLines({
      clis: ["claude"],
      target: "user",
      policies: [],
      cwd: "/tmp/proj",
      connect: true,
    }).join("\n");
    expect(connected).toContain("transcripts");
  });
});
describe("scope", () => {
  // The wizard can no longer produce "project" or "both": scope was a fork, and
  // the fork is gone. What used to be tested here — the union across scopes, the
  // per-scope filtering of a user-scope-only gateway like Hermes — is still real
  // in `installHooks`, but it is no longer REACHABLE from setup, so asserting
  // the wizard does it would be asserting a path nobody can take. Those live on
  // in `manager`'s own tests, against the function that still has them.
  it("installs exactly once, at user scope", async () => {
    drive(HAPPY);
    const result = await runConfigureWizard(ttyIO());
    expect(result.scopes).toEqual(["user"]);
    expect(installHooks).toHaveBeenCalledTimes(1);
    expect(vi.mocked(installHooks).mock.calls[0][1]).toBe("user");
  });

  it("writes nothing when cancelled at the harness step, the first question asked", async () => {
    // The scope step was the old first cancellation point. With it gone, the
    // harness step is where a ctrl-c lands, and it must still leave the machine
    // untouched — the daemon is installed BEFORE this, so "nothing was changed"
    // has to mean nothing about hooks or config.
    drive({ connect: null });
    const result = await runConfigureWizard(ttyIO());
    expect(result.applied).toBe(false);
    expect(result.abort).toBe("cancelled");
    expect(installHooks).not.toHaveBeenCalled();
  });
});

describe("connect step", () => {
  beforeEach(() => {
    vi.mocked(connectToCloud).mockClear();
    vi.mocked(validateIngestKey).mockClear().mockResolvedValue({ ok: true });
    // ONE prompt now, not two. The endpoint is no longer asked for: there is
    // one right answer for the hosted product, and asking made it look like a
    // decision — which is how a key gets pasted into the URL field and how the
    // dashboard's own address gets typed at a prompt that wants the API server.
    vi.mocked(promptText).mockReset().mockResolvedValueOnce("a-real-looking-key");
    delete process.env.FAILPROOFAI_CLOUD_URL;
  });

  afterEach(() => {
    delete process.env.FAILPROOFAI_CLOUD_URL;
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
      url: "https://app.befailproof.ai",
      token: "a-real-looking-key",
      sessions: true,
    });
  });

  it("never asks for the endpoint — only the key", async () => {
    // The regression this guards: re-introducing the URL prompt silently makes
    // the key the SECOND answer again, so every scripted or muscle-memory
    // paste lands in the wrong field.
    drive({ ...HAPPY, connect: "key" });

    await runConfigureWizard(ttyIO());

    expect(vi.mocked(promptText)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(promptText).mock.calls[0][0].message).toMatch(/API key/);
  });

  it("takes the endpoint from FAILPROOFAI_CLOUD_URL when it is set", async () => {
    // The local-development and self-hosting path. Deliberately the SAME
    // variable the daemon already reads for cloud-managed policy, so one export
    // points the whole machine at one place rather than leaving the wizard and
    // the daemon disagreeing about where this machine reports.
    process.env.FAILPROOFAI_CLOUD_URL = "http://localhost:8080";
    drive({ ...HAPPY, connect: "key" });

    const result = await runConfigureWizard(ttyIO());

    expect(result.connected).toBe(true);
    expect(vi.mocked(connectToCloud).mock.calls[0][0]).toMatchObject({
      url: "http://localhost:8080",
      token: "a-real-looking-key",
    });
  });

  it("refuses an unusable FAILPROOFAI_CLOUD_URL instead of falling back to hosted", async () => {
    // Falling back would report the machine to the hosted service — the one
    // outcome someone who exported this variable did not ask for, and one they
    // would only discover by going looking for data that never arrived.
    // `http://` to a NON-loopback host is refused for the original reason: it
    // puts the machine's bearer token on the wire in clear.
    process.env.FAILPROOFAI_CLOUD_URL = "http://cloud.example.com";
    drive({ ...HAPPY, connect: "key" });

    const result = await runConfigureWizard(ttyIO());

    expect(result.applied).toBe(false);
    expect(connectToCloud).not.toHaveBeenCalled();
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
    // connect -> key, then the retry question -> skip, then review. Queued
    // positionally rather than through `drive()` because the retry prompt is
    // conditional and has no name there. Two answers shorter than it was: the
    // mode fork and the scope question are both gone.
    vi.mocked(selectOne)
      .mockResolvedValueOnce("key")
      .mockResolvedValueOnce("skip")
      .mockResolvedValueOnce("apply");
    vi.mocked(multiSelect).mockResolvedValueOnce(["claude"]);

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
    drive({ connect: null });
    const result = await runConfigureWizard(ttyIO());
    expect(result.applied).toBe(false);
    expect(installHooks).not.toHaveBeenCalled();
    expect(connectToCloud).not.toHaveBeenCalled();
  });
});

describe("wizard back-navigation", () => {
  // The three tests that stood here drove a ← from the harness step back to the
  // policy step, and pinned that both answers survived the round trip. Both the
  // step and the ← are gone: with nothing before the harness step inside setup
  // — the scope question is frequently stated rather than asked — a ← would
  // sometimes go nowhere, which is worse than not offering one.
  it("has no step to go back from — every remaining question is a single choice", async () => {
    // Back-navigation existed for the policy and harness multi-selects, both of
    // which are gone. What is left is the daemon, connect, and the review.
    drive({ connect: "local", review: "apply" });

    await runConfigureWizard(ttyIO());

    expect(vi.mocked(multiSelect)).not.toHaveBeenCalled();
    for (const [opts] of vi.mocked(selectOne).mock.calls) {
      expect(opts.allowBack).toBeFalsy();
    }
  });
});
