// @vitest-environment node
/**
 * Decision D2: commands that install or remove hooks keep `agents.selected`
 * true — so `failproofai config` neither undoes an install nor resurrects a
 * removal, and the daemon stops collecting an agent somebody unhooked.
 *
 * Real files throughout: a throwaway HOME (user-scope agent settings resolve
 * through homedir()), FAILPROOFAI_HOME (config.json) and pack directory. Only
 * what would reach outside the machine is stubbed: PATH detection, the pack
 * fetch and telemetry.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
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

import { keepAgentSelectionTrue } from "../../src/hooks/agent-selection";
import { detectInstalledClis } from "../../src/hooks/integrations";
import { installHooks, removeHooks } from "../../src/hooks/manager";
import { isAgentTraced, readConfig } from "../../src/hooks/fp-config";
import { INTEGRATION_TYPES } from "../../src/hooks/types";

const ARTIFACT = "export const hooks = [];\n";
const DIGEST = createHash("sha256").update(ARTIFACT).digest("hex");

let root: string;
let home: string;
let fpHome: string;
let project: string;
let packRoot: string;
let saved: Record<string, string | undefined>;
let logs: MockInstance<typeof console.log>;

const configPath = () => join(fpHome, "config.json");
const goosePlugin = (base: string) => join(base, ".agents", "plugins", "failproofai", "hooks", "hooks.json");

function writeSelection(agents?: { selected: string[]; seen: string[] }, extra: Record<string, unknown> = {}): void {
  writeFileSync(configPath(), `${JSON.stringify({ ...extra, ...(agents ? { agents } : {}) }, null, 2)}\n`);
}
const selectionOnDisk = () => readConfig().agents;
const printed = (): string[] => logs.mock.calls.map((call) => String(call[0]));
const lastPrinted = (): string | undefined => printed().at(-1);

/** A pack on disk declaring `names`, so a name can resolve to a pack policy. */
function installPack(id: string, names: string[]): void {
  mkdirSync(join(packRoot, "artifacts"), { recursive: true });
  writeFileSync(join(packRoot, "artifacts", `${DIGEST}.mjs`), ARTIFACT);
  const pack = {
    id,
    version: "1.2.0",
    source: `github:${id}@v1.2.0`,
    entry: `artifacts/${DIGEST}.mjs`,
    sha256: DIGEST,
    policies: names.map((name) => ({ name, description: `does ${name}`, category: "Finance", defaultEnabled: true, match: {} })),
  };
  writeFileSync(join(packRoot, "installed.json"), JSON.stringify({ schemaVersion: 1, packs: [pack] }));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fpai-agent-selection-"));
  home = join(root, "home");
  fpHome = join(root, "fp-home");
  project = join(root, "project");
  packRoot = join(root, "packs");
  for (const dir of [home, fpHome, project, packRoot]) mkdirSync(dir, { recursive: true });
  saved = {
    HOME: process.env.HOME,
    FAILPROOFAI_HOME: process.env.FAILPROOFAI_HOME,
    FAILPROOFAI_PACK_DIR: process.env.FAILPROOFAI_PACK_DIR,
    FAILPROOFAI_BINARY_OVERRIDE: process.env.FAILPROOFAI_BINARY_OVERRIDE,
    NO_COLOR: process.env.NO_COLOR,
  };
  process.env.HOME = home;
  process.env.FAILPROOFAI_HOME = fpHome;
  process.env.FAILPROOFAI_PACK_DIR = packRoot;
  process.env.FAILPROOFAI_BINARY_OVERRIDE = join(root, "failproofai");
  // Plain text whatever the runner's stdout is, so a note compares as words.
  process.env.NO_COLOR = "1";
  vi.mocked(detectInstalledClis).mockReturnValue([]);
  logs = vi.spyOn(console, "log").mockImplementation(() => {});
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

describe("keepAgentSelectionTrue — an install", () => {
  it("changes nothing without a selection: every agent is traced already", () => {
    expect(keepAgentSelectionTrue("installed", ["goose"])).toBeNull();
    expect(existsSync(configPath())).toBe(false);
  });

  it("traces the agent in INTEGRATION_TYPES order, and records it as seen when it is detected", () => {
    writeSelection({ selected: ["goose", "claude"], seen: ["claude"] });
    vi.mocked(detectInstalledClis).mockReturnValue(["claude", "codex"]);
    expect(keepAgentSelectionTrue("installed", ["codex"])).toBe(
      "✓ OpenAI Codex is traced again, so failproofai config keeps its hooks.",
    );
    expect(selectionOnDisk()).toEqual({ selected: ["claude", "codex", "goose"], seen: ["claude", "codex"] });
  });

  it("leaves seen alone for an agent that is not detected", () => {
    writeSelection({ selected: ["claude"], seen: ["claude"] });
    keepAgentSelectionTrue("installed", ["goose"]);
    expect(selectionOnDisk()).toEqual({ selected: ["claude", "goose"], seen: ["claude"] });
  });

  it("names several agents as one sentence, with plural verbs", () => {
    writeSelection({ selected: ["claude"], seen: [] });
    expect(keepAgentSelectionTrue("installed", ["goose", "codex"])).toBe(
      "✓ OpenAI Codex and Goose are traced again, so failproofai config keeps their hooks.",
    );
    writeSelection({ selected: ["claude"], seen: [] });
    expect(keepAgentSelectionTrue("installed", ["goose", "cursor", "codex"])).toBe(
      "✓ OpenAI Codex, Cursor Agent and Goose are traced again, so failproofai config keeps their hooks.",
    );
  });

  it("names only the agents it actually added", () => {
    writeSelection({ selected: ["claude"], seen: ["claude"] });
    expect(keepAgentSelectionTrue("installed", ["claude", "goose"])).toBe(
      "✓ Goose is traced again, so failproofai config keeps its hooks.",
    );
  });

  it("changes nothing, and says nothing, for an agent already traced", () => {
    writeSelection({ selected: ["claude", "goose"], seen: ["claude"] });
    const before = readFileSync(configPath(), "utf8");
    expect(keepAgentSelectionTrue("installed", ["goose"])).toBeNull();
    expect(readFileSync(configPath(), "utf8")).toBe(before);
  });

  it("keeps an agent id this build does not know, and every other key in the file", () => {
    writeSelection({ selected: ["future-agent", "claude"], seen: ["future-agent"] }, {
      collector: { sessions: true },
      fromANewerBuild: { keep: "me" },
    });
    keepAgentSelectionTrue("installed", ["goose"]);
    const raw = JSON.parse(readFileSync(configPath(), "utf8")) as Record<string, unknown>;
    expect(raw.agents).toEqual({ selected: ["claude", "goose", "future-agent"], seen: ["future-agent"] });
    expect(raw.fromANewerBuild).toEqual({ keep: "me" });
    expect(readConfig().collector.sessions).toBe(true);
  });
});

describe("keepAgentSelectionTrue — a removal", () => {
  it("stops tracing the agent and keeps seen as it was", () => {
    writeSelection({ selected: ["claude", "goose"], seen: ["claude", "goose"] });
    expect(keepAgentSelectionTrue("removed", ["goose"])).toBe(
      "✓ Goose is no longer traced, so failproofai config won't add its hooks back.",
    );
    expect(selectionOnDisk()).toEqual({ selected: ["claude"], seen: ["claude", "goose"] });
  });

  it("without a selection, writes every agent but the removed ones, and seen as detected now", () => {
    vi.mocked(detectInstalledClis).mockReturnValue(["claude", "goose"]);
    expect(keepAgentSelectionTrue("removed", ["goose"])).toBe(
      "✓ Goose is no longer traced, so failproofai config won't add its hooks back.",
    );
    expect(selectionOnDisk()).toEqual({
      selected: INTEGRATION_TYPES.filter((id) => id !== "goose"),
      seen: ["claude", "goose"],
    });
    expect(isAgentTraced("goose")).toBe(false);
    expect(isAgentTraced("claude")).toBe(true);
  });

  it("allows an empty selection once every agent's hooks are out", () => {
    writeSelection({ selected: ["claude"], seen: ["claude"] });
    keepAgentSelectionTrue("removed", ["claude"]);
    expect(selectionOnDisk()).toEqual({ selected: [], seen: ["claude"] });
    expect(isAgentTraced("claude")).toBe(false);

    // And from no selection at all, removing every agent.
    rmSync(configPath());
    expect(keepAgentSelectionTrue("removed", [...INTEGRATION_TYPES])).toMatch(/^✓ .* are no longer traced/);
    expect(selectionOnDisk()?.selected).toEqual([]);
  });

  it("names several agents as one sentence, with plural verbs", () => {
    writeSelection({ selected: ["claude", "codex", "goose"], seen: [] });
    expect(keepAgentSelectionTrue("removed", ["goose", "claude"])).toBe(
      "✓ Claude Code and Goose are no longer traced, so failproofai config won't add their hooks back.",
    );
    expect(selectionOnDisk()?.selected).toEqual(["codex"]);
  });

  it("changes nothing, and says nothing, for an agent not traced", () => {
    writeSelection({ selected: ["claude"], seen: ["claude"] });
    const before = readFileSync(configPath(), "utf8");
    expect(keepAgentSelectionTrue("removed", ["goose"])).toBeNull();
    expect(readFileSync(configPath(), "utf8")).toBe(before);
  });

  it("says when the selection could not be written, instead of throwing", () => {
    // A home under a regular file: nothing can be created inside it.
    writeFileSync(join(root, "a-file"), "");
    process.env.FAILPROOFAI_HOME = join(root, "a-file", "fp-home");
    const line = keepAgentSelectionTrue("removed", ["goose"]);
    expect(line).toMatch(/^▲ Couldn't record Goose as no longer traced \(.+\), so failproofai config may add its hooks back\.$/);
  });
});

describe("policies --install / policies add / the agent picker", () => {
  // bin/failproofai.mjs resolves the agents (from --cli or the picker in
  // install-prompt.ts) and hands them to installHooks with syncAgentSelection;
  // these are those calls.
  it("`policies --install --cli goose` traces Goose and says so after everything else", async () => {
    writeSelection({ selected: ["claude"], seen: ["claude"] });
    await installHooks(undefined, "user", project, false, undefined, undefined, false, ["goose"], { syncAgentSelection: true });
    expect(existsSync(goosePlugin(home))).toBe(true);
    expect(selectionOnDisk()?.selected).toEqual(["claude", "goose"]);
    expect(lastPrinted()).toBe("✓ Goose is traced again, so failproofai config keeps its hooks.");
    expect(printed().filter((line) => line.includes("traced"))).toHaveLength(1);
  });

  it("counts a project-scope install too", async () => {
    writeSelection({ selected: ["claude"], seen: ["claude"] });
    await installHooks(undefined, "project", project, false, undefined, undefined, false, ["goose"], { syncAgentSelection: true });
    expect(existsSync(goosePlugin(project))).toBe(true);
    expect(selectionOnDisk()?.selected).toEqual(["claude", "goose"]);
  });

  it("several agents from the picker get one line", async () => {
    writeSelection({ selected: ["claude"], seen: ["claude"] });
    await installHooks(undefined, "user", project, false, undefined, undefined, false, ["goose", "codex"], { syncAgentSelection: true });
    expect(selectionOnDisk()?.selected).toEqual(["claude", "codex", "goose"]);
    expect(lastPrinted()).toBe("✓ OpenAI Codex and Goose are traced again, so failproofai config keeps their hooks.");
  });

  it("`policies add <builtin> --cli goose` traces Goose", async () => {
    writeSelection({ selected: ["claude"], seen: ["claude"] });
    await installHooks(["block-sudo"], "user", project, false, undefined, undefined, false, ["goose"], { syncAgentSelection: true });
    expect(selectionOnDisk()?.selected).toEqual(["claude", "goose"]);
    expect(lastPrinted()).toBe("✓ Goose is traced again, so failproofai config keeps its hooks.");
  });

  it("a third-party pack policy wires no hooks, so it traces nothing", async () => {
    installPack("acme/finance", ["block-big-refund"]);
    writeSelection({ selected: ["claude"], seen: ["claude"] });
    const before = readFileSync(configPath(), "utf8");
    await installHooks(["block-big-refund"], "user", project, false, undefined, undefined, false, ["goose"], { syncAgentSelection: true });
    expect(existsSync(goosePlugin(home))).toBe(false);
    expect(readFileSync(configPath(), "utf8")).toBe(before);
    expect(printed().some((line) => line.includes("traced"))).toBe(false);
  });

  it("without a selection there is nothing to add, and nothing is printed about it", async () => {
    await installHooks(undefined, "user", project, false, undefined, undefined, false, ["goose"], { syncAgentSelection: true });
    expect(existsSync(configPath())).toBe(false);
    expect(printed().some((line) => line.includes("traced"))).toBe(false);
  });

  it("a quiet install still keeps the selection true, and prints nothing", async () => {
    writeSelection({ selected: ["claude"], seen: ["claude"] });
    await installHooks(undefined, "user", project, false, undefined, undefined, false, ["goose"], {
      quiet: true,
      syncAgentSelection: true,
    });
    expect(selectionOnDisk()?.selected).toEqual(["claude", "goose"]);
    expect(logs).not.toHaveBeenCalled();
  });

  it("a caller that does not ask leaves the selection alone", async () => {
    writeSelection({ selected: ["claude"], seen: ["claude"] });
    const before = readFileSync(configPath(), "utf8");
    await installHooks(undefined, "user", project, false, undefined, undefined, false, ["goose"]);
    expect(existsSync(goosePlugin(home))).toBe(true);
    expect(readFileSync(configPath(), "utf8")).toBe(before);
  });
});

describe("policies --uninstall / policies remove all", () => {
  async function hookGoose(scope: "user" | "project"): Promise<void> {
    await installHooks(undefined, scope, project, false, undefined, undefined, false, ["goose"]);
    logs.mockClear();
  }

  it("`policies --uninstall --cli goose` stops tracing Goose and says so after everything else", async () => {
    writeSelection({ selected: ["claude", "goose"], seen: ["claude", "goose"] });
    await hookGoose("user");
    await removeHooks(undefined, "user", project, { cli: ["goose"], syncAgentSelection: true });
    expect(selectionOnDisk()).toEqual({ selected: ["claude"], seen: ["claude", "goose"] });
    expect(printed()[0]).toContain("Removed");
    expect(lastPrinted()).toBe("✓ Goose is no longer traced, so failproofai config won't add its hooks back.");
  });

  it("`--scope all` counts", async () => {
    writeSelection({ selected: ["claude", "goose"], seen: [] });
    await hookGoose("user");
    await removeHooks(undefined, "all", project, { cli: ["goose"], syncAgentSelection: true });
    expect(selectionOnDisk()?.selected).toEqual(["claude"]);
    expect(lastPrinted()).toBe("✓ Goose is no longer traced, so failproofai config won't add its hooks back.");
  });

  it("without a selection, writes one that traces every agent but the one removed", async () => {
    vi.mocked(detectInstalledClis).mockReturnValue(["goose"]);
    await hookGoose("user");
    await removeHooks(undefined, "user", project, { cli: ["goose"], syncAgentSelection: true });
    expect(selectionOnDisk()).toEqual({ selected: INTEGRATION_TYPES.filter((id) => id !== "goose"), seen: ["goose"] });
  });

  it("`policies remove all --cli goose` takes the hooks out, so it stops tracing too", async () => {
    writeSelection({ selected: ["claude", "goose"], seen: [] });
    await hookGoose("user");
    await removeHooks(["all"], "user", project, { cli: ["goose"], syncAgentSelection: true });
    expect(selectionOnDisk()?.selected).toEqual(["claude"]);
  });

  it("an agent with nothing to remove still stops being traced: the command said so", async () => {
    writeSelection({ selected: ["claude", "goose"], seen: [] });
    await removeHooks(undefined, "user", project, { cli: ["goose"], syncAgentSelection: true });
    expect(printed()).toEqual([
      "No settings file found. Nothing to remove.",
      "✓ Goose is no longer traced, so failproofai config won't add its hooks back.",
    ]);
    expect(selectionOnDisk()?.selected).toEqual(["claude"]);
  });

  it("a project-scope-only removal leaves the selection alone", async () => {
    writeSelection({ selected: ["claude", "goose"], seen: ["goose"] });
    await hookGoose("project");
    const before = readFileSync(configPath(), "utf8");
    await removeHooks(undefined, "project", project, { cli: ["goose"], syncAgentSelection: true });
    expect(existsSync(goosePlugin(project)) && JSON.parse(readFileSync(goosePlugin(project), "utf8")).hooks).toBeFalsy();
    expect(readFileSync(configPath(), "utf8")).toBe(before);
    expect(printed().some((line) => line.includes("traced"))).toBe(false);
  });

  it("a project-scope-only removal writes no selection where there was none", async () => {
    await hookGoose("project");
    await removeHooks(undefined, "project", project, { cli: ["goose"], syncAgentSelection: true });
    expect(existsSync(configPath())).toBe(false);
  });

  it("a local-scope removal leaves the selection alone", async () => {
    writeSelection({ selected: ["claude"], seen: [] });
    const before = readFileSync(configPath(), "utf8");
    await removeHooks(undefined, "local", project, { cli: ["claude"], syncAgentSelection: true });
    expect(readFileSync(configPath(), "utf8")).toBe(before);
  });

  it("turning a policy off removes no hooks, so it leaves the selection alone", async () => {
    writeSelection({ selected: ["claude", "goose"], seen: [] });
    const before = readFileSync(configPath(), "utf8");
    await removeHooks(["block-sudo"], "user", project, { cli: ["goose"], syncAgentSelection: true });
    expect(readFileSync(configPath(), "utf8")).toBe(before);
  });
});

describe("the commands that own or ignore the selection", () => {
  it("`failproofai config`'s own installHooks call writes no selection and prints no note", async () => {
    // Exactly the wizard's call (configure-wizard.ts): it writes the selection
    // itself, after this, from the answer it just collected.
    writeSelection({ selected: ["claude"], seen: ["claude"] });
    const before = readFileSync(configPath(), "utf8");
    await installHooks([], "user", project, false, "configure-wizard", undefined, false, ["goose"], { replace: true, quiet: true });
    expect(existsSync(goosePlugin(home))).toBe(true);
    expect(readFileSync(configPath(), "utf8")).toBe(before);
    expect(logs).not.toHaveBeenCalled();
  });

  it("`failproofai uninstall` leaves the selection alone", async () => {
    writeSelection({ selected: ["claude", "goose"], seen: ["goose"] });
    await installHooks(undefined, "user", project, false, undefined, undefined, false, ["goose"]);
    const before = readFileSync(configPath(), "utf8");
    // Exactly uninstall-cli.ts's call.
    await removeHooks(undefined, "all", project, { cli: ["goose"], removeCustomHooks: true, source: "uninstall_command" });
    expect(JSON.parse(readFileSync(goosePlugin(home), "utf8")).hooks).toBeUndefined();
    expect(readFileSync(configPath(), "utf8")).toBe(before);
  });
});
