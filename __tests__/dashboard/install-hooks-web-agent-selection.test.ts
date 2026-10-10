// @vitest-environment node
/**
 * The dashboard's per-agent hook panel keeps `agents.selected` true the same
 * way the CLI does (decision D2): ticking an agent and applying traces it,
 * unticking it untraces it. Server side only — the panel shows errors and no
 * success message, so its UI is unchanged.
 *
 * The real server actions and the real manager, against a throwaway HOME,
 * FAILPROOFAI_HOME and pack directory. User scope only, which is the only scope
 * the panel uses: the actions pass no cwd, so a project-scope call here would
 * reach this repository's own dogfood configs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("@/src/hooks/integrations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/hooks/integrations")>();
  return { ...actual, detectInstalledClis: vi.fn(() => []) };
});
vi.mock("@/src/hooks/pack-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/hooks/pack-store")>();
  return { ...actual, addPack: vi.fn(async () => undefined) };
});
vi.mock("@/src/hooks/hook-telemetry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/hooks/hook-telemetry")>();
  return { ...actual, trackHookEvent: vi.fn(async () => undefined) };
});

import { installHooksWebAction, removeHooksWebAction } from "@/app/actions/install-hooks-web";
import { detectInstalledClis } from "@/src/hooks/integrations";
import { readConfig } from "@/src/hooks/fp-config";
import { INTEGRATION_TYPES } from "@/src/hooks/types";

let root: string;
let home: string;
let fpHome: string;
let saved: Record<string, string | undefined>;

const configPath = () => join(fpHome, "config.json");
const goosePlugin = () => join(home, ".agents", "plugins", "failproofai", "hooks", "hooks.json");
function writeSelection(agents: { selected: string[]; seen: string[] }): void {
  writeFileSync(configPath(), `${JSON.stringify({ agents }, null, 2)}\n`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fpai-web-agent-selection-"));
  home = join(root, "home");
  fpHome = join(root, "fp-home");
  const packs = join(root, "packs");
  for (const dir of [home, fpHome, packs]) mkdirSync(dir, { recursive: true });
  saved = {
    HOME: process.env.HOME,
    FAILPROOFAI_HOME: process.env.FAILPROOFAI_HOME,
    FAILPROOFAI_PACK_DIR: process.env.FAILPROOFAI_PACK_DIR,
    FAILPROOFAI_BINARY_OVERRIDE: process.env.FAILPROOFAI_BINARY_OVERRIDE,
  };
  process.env.HOME = home;
  process.env.FAILPROOFAI_HOME = fpHome;
  process.env.FAILPROOFAI_PACK_DIR = packs;
  process.env.FAILPROOFAI_BINARY_OVERRIDE = join(root, "failproofai");
  vi.mocked(detectInstalledClis).mockReturnValue(["claude", "goose"]);
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

describe("the dashboard's per-agent hook panel", () => {
  it("Apply with an agent ticked traces it", async () => {
    writeSelection({ selected: ["claude"], seen: ["claude"] });
    await installHooksWebAction("user", ["goose"]);
    expect(existsSync(goosePlugin())).toBe(true);
    expect(readConfig().agents).toEqual({ selected: ["claude", "goose"], seen: ["claude", "goose"] });
  });

  it("Apply with an agent unticked stops tracing it", async () => {
    writeSelection({ selected: ["claude", "goose"], seen: ["claude", "goose"] });
    await installHooksWebAction("user", ["goose"]);
    await removeHooksWebAction("user", ["goose"]);
    expect(JSON.parse(readFileSync(goosePlugin(), "utf8")).hooks).toBeUndefined();
    expect(readConfig().agents).toEqual({ selected: ["claude"], seen: ["claude", "goose"] });
  });

  it("unticking on a machine with no selection writes one without that agent", async () => {
    await installHooksWebAction("user", ["goose"]);
    expect(existsSync(configPath())).toBe(false);
    await removeHooksWebAction("user", ["goose"]);
    expect(readConfig().agents).toEqual({
      selected: INTEGRATION_TYPES.filter((id) => id !== "goose"),
      seen: ["claude", "goose"],
    });
  });
});
