// @vitest-environment node
/**
 * Decision D2, the parts that reach the daemon:
 *
 *  - An agent traced again through `policies --install`, `policies add` or the
 *    dashboard's agent panel starts fresh, exactly as one re-ticked in
 *    `failproofai config` does: an `added` backfill request lands BEFORE the
 *    selection that traces it, or the daemon resumes the cursors it held when
 *    the agent was untraced and ships what was written in between.
 *  - A removal on a machine with no saved list records the agents on this
 *    machine minus the removed ones — not every agent this build knows, which
 *    `failproofai config` would then restore and hook, installed or not.
 *
 * Real files throughout, under a throwaway HOME, FAILPROOFAI_HOME, HERMES_HOME
 * and pack directory. Only PATH detection, the pack fetch and telemetry are
 * stubbed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../src/hooks/integrations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hooks/integrations")>();
  return { ...actual, detectInstalledClis: vi.fn(() => []) };
});
vi.mock("../../src/hooks/pack-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hooks/pack-store")>();
  return { ...actual, addPack: vi.fn(async () => undefined) };
});
vi.mock("../../src/hooks/hook-telemetry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hooks/hook-telemetry")>();
  return { ...actual, trackHookEvent: vi.fn(async () => undefined) };
});
// Passed through, so the real file is written; wrapped, so a test can look at
// the disk at the moment the selection is written.
vi.mock("../../src/hooks/fp-config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hooks/fp-config")>();
  return { ...actual, updateConfig: vi.fn(actual.updateConfig) };
});

import { keepAgentSelectionTrue } from "../../src/hooks/agent-selection";
import { backfillRequestPath, machineCollectsSessions, requestFreshStart } from "../../src/hooks/backfill-request";
import { writeCollectorSettings, writeIngestCredential } from "../../src/hooks/collector-config";
import { readConfig, updateConfig } from "../../src/hooks/fp-config";
import { detectInstalledClis, getIntegration } from "../../src/hooks/integrations";
import { installHooks } from "../../src/hooks/manager";

let root: string;
let home: string;
let fpHome: string;
let project: string;
let saved: Record<string, string | undefined>;

const pendingRequest = (): Record<string, unknown> | null =>
  existsSync(backfillRequestPath()) ? (JSON.parse(readFileSync(backfillRequestPath(), "utf8")) as Record<string, unknown>) : null;

function connect(sessions = true): void {
  writeIngestCredential({ url: "https://app.befailproof.ai/v1/events", key: "s".repeat(20) });
  writeCollectorSettings({ sessions, hooks: true });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fpai-retrace-"));
  home = join(root, "home");
  fpHome = join(root, "fp-home");
  project = join(root, "project");
  for (const dir of [home, fpHome, project, join(home, ".hermes"), join(root, "packs")]) mkdirSync(dir, { recursive: true });
  saved = {
    HOME: process.env.HOME,
    FAILPROOFAI_HOME: process.env.FAILPROOFAI_HOME,
    FAILPROOFAI_PACK_DIR: process.env.FAILPROOFAI_PACK_DIR,
    FAILPROOFAI_BINARY_OVERRIDE: process.env.FAILPROOFAI_BINARY_OVERRIDE,
    HERMES_HOME: process.env.HERMES_HOME,
    NO_COLOR: process.env.NO_COLOR,
  };
  process.env.HOME = home;
  process.env.FAILPROOFAI_HOME = fpHome;
  process.env.FAILPROOFAI_PACK_DIR = join(root, "packs");
  process.env.FAILPROOFAI_BINARY_OVERRIDE = join(root, "failproofai");
  process.env.HERMES_HOME = join(home, ".hermes");
  process.env.NO_COLOR = "1";
  vi.mocked(detectInstalledClis).mockReturnValue([]);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("an agent traced again starts fresh", () => {
  it("writes the added request before the selection that traces it", () => {
    connect();
    updateConfig({ agents: { selected: ["claude"], seen: ["claude", "codex"] } });
    let requestAtSelection: Record<string, unknown> | null = null;
    const real = vi.mocked(updateConfig).getMockImplementation()!;
    vi.mocked(updateConfig).mockImplementationOnce((patch) => {
      requestAtSelection = pendingRequest();
      return real(patch);
    });

    expect(keepAgentSelectionTrue("installed", ["codex"])).toContain("traced again");

    expect(requestAtSelection).toMatchObject({ kind: "added", agents: ["codex"] });
    expect(requestAtSelection).not.toHaveProperty("sinceMs");
    expect(readConfig().agents?.selected).toEqual(["claude", "codex"]);
  });

  it("asks for it through `policies --install` (installHooks with syncAgentSelection)", async () => {
    connect();
    updateConfig({ agents: { selected: ["claude"], seen: ["claude"] } });
    await installHooks(undefined, "user", project, false, undefined, undefined, false, ["goose"], { syncAgentSelection: true });
    expect(pendingRequest()).toMatchObject({ kind: "added", agents: ["goose"] });
    expect(readConfig().agents?.selected).toEqual(["claude", "goose"]);
  });

  it("names only the agents actually added back", () => {
    connect();
    updateConfig({ agents: { selected: ["claude"], seen: ["claude"] } });
    keepAgentSelectionTrue("installed", ["claude", "goose"]);
    expect(pendingRequest()).toMatchObject({ kind: "added", agents: ["goose"] });
  });

  it("writes none when nothing collects: open source, or sessions off", () => {
    updateConfig({ agents: { selected: ["claude"], seen: ["claude"] } });
    keepAgentSelectionTrue("installed", ["goose"]);
    expect(pendingRequest()).toBeNull();

    connect(/* sessions */ false);
    keepAgentSelectionTrue("installed", ["codex"]);
    expect(pendingRequest()).toBeNull();
    expect(readConfig().agents?.selected).toEqual(["claude", "codex", "goose"]);
  });

  it("writes none without a saved list, or for an agent already traced: nothing was untraced", () => {
    connect();
    keepAgentSelectionTrue("installed", ["goose"]);
    expect(pendingRequest()).toBeNull();
    updateConfig({ agents: { selected: ["goose"], seen: ["goose"] } });
    keepAgentSelectionTrue("installed", ["goose"]);
    expect(pendingRequest()).toBeNull();
  });

  it("writes none for a removal", () => {
    connect();
    updateConfig({ agents: { selected: ["claude", "goose"], seen: ["claude", "goose"] } });
    keepAgentSelectionTrue("removed", ["goose"]);
    expect(pendingRequest()).toBeNull();
  });
});

describe("requestFreshStart and machineCollectsSessions", () => {
  it("collects only with an ingest key and sessions on", () => {
    expect(machineCollectsSessions()).toBe(false);
    connect(false);
    expect(machineCollectsSessions()).toBe(false);
    connect(true);
    expect(machineCollectsSessions()).toBe(true);
  });

  it("writes nothing for no agents or when nothing collects, and never throws", () => {
    expect(requestFreshStart([], true)).toBe(false);
    expect(requestFreshStart(["goose"], false)).toBe(false);
    expect(pendingRequest()).toBeNull();
    expect(requestFreshStart(["goose"], true, 1_000)).toBe(true);
    expect(pendingRequest()).toEqual({ kind: "added", agents: ["goose"], requestedAtMs: 1_000 });
    // A home that cannot hold the file: logged, not thrown.
    rmSync(fpHome, { recursive: true, force: true });
    mkdirSync(join(root, "blocked"));
    process.env.FAILPROOFAI_HOME = join(root, "blocked", "file-not-dir");
    writeFileSync(join(root, "blocked", "file-not-dir"), "x");
    expect(requestFreshStart(["goose"], true)).toBe(false);
  });
});

describe("a removal with no saved list", () => {
  it("records the agents on this machine but the removed one, not every agent", () => {
    vi.mocked(detectInstalledClis).mockReturnValue(["claude", "goose"]);
    // Codex is not on PATH but is still hooked at user scope: still traced.
    vi.spyOn(getIntegration("codex"), "hooksInstalledInSettings").mockImplementation((scope) => scope === "user");

    expect(keepAgentSelectionTrue("removed", ["goose"])).toBe(
      "✓ Goose is no longer traced, so failproofai config won't add its hooks back.",
    );
    expect(readConfig().agents).toEqual({ selected: ["claude", "codex"], seen: ["claude", "goose"] });
  });

  it("records an empty list when the removed agent was the only one", () => {
    vi.mocked(detectInstalledClis).mockReturnValue(["claude"]);
    keepAgentSelectionTrue("removed", ["claude"]);
    expect(readConfig().agents).toEqual({ selected: [], seen: ["claude"] });
  });
});
