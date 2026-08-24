// @vitest-environment node
/**
 * `failproofai policies` — the window that answers "what is enforcing here?".
 *
 * It had no test at all, which is how it came to answer that question with a
 * subset: builtins in a table, convention files and cloud policies as footer
 * sections in two other shapes, and installed PACKS not at all.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { visibleWidth } from "@/src/hooks/tui";

const ARTIFACT = "export const hooks = [];\n";
const DIGEST = createHash("sha256").update(ARTIFACT).digest("hex");

let home: string;
let project: string;
let packRoot: string;
let saved: Record<string, string | undefined>;
let out: string[];

function installPack(over: Record<string, unknown> = {}): void {
  writeFileSync(
    join(packRoot, "installed.json"),
    JSON.stringify({
      schemaVersion: 1,
      packs: [
        {
          id: "acme/finance",
          version: "1.2.0",
          source: "github:acme/finance@v1.2.0",
          entry: `artifacts/${DIGEST}.mjs`,
          sha256: DIGEST,
          policies: [
            {
              name: "block-big-refund",
              description: "Block big refunds",
              category: "Finance",
              defaultEnabled: true,
              match: {},
            },
            {
              name: "require-note",
              description: "Require a note",
              category: "Finance",
              defaultEnabled: true,
              match: {},
            },
          ],
          ...over,
        },
      ],
    }),
  );
}

async function run(): Promise<string> {
  const { listHooks } = await import("@/src/hooks/manager");
  await listHooks(project);
  return out.join("\n");
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "fpai-listing-home-"));
  project = mkdtempSync(join(tmpdir(), "fpai-listing-proj-"));
  packRoot = mkdtempSync(join(tmpdir(), "fpai-listing-packs-"));
  mkdirSync(join(packRoot, "artifacts"), { recursive: true });
  writeFileSync(join(packRoot, "artifacts", `${DIGEST}.mjs`), ARTIFACT);
  saved = {
    FAILPROOFAI_HOME: process.env.FAILPROOFAI_HOME,
    FAILPROOFAI_PACK_DIR: process.env.FAILPROOFAI_PACK_DIR,
  };
  process.env.FAILPROOFAI_HOME = home;
  process.env.FAILPROOFAI_PACK_DIR = packRoot;
  // User-scope hook settings resolve from the OS home, not FAILPROOFAI_HOME, so
  // without this the listing reads whoever-runs-it's real ~/.claude/settings.json
  // — and any other test file that writes there decides whether this one passes.
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  out = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of [home, project, packRoot]) rmSync(dir, { recursive: true, force: true });
});

describe("failproofai policies", () => {
  it("lists no policy from this build — enforcement comes from packs", async () => {
    // The builtin table is gone. Nothing is compiled in except the always-on
    // guard, and that has no row precisely because no listing can switch it off.
    const text = await run();
    expect(text).not.toMatch(/✓ LOCK/);
    expect(text).not.toMatch(/block-failproofai-commands/);
  });

  it("lists an installed pack's policies, which no listing did before", async () => {
    installPack();
    const text = await run();
    expect(text).toContain("── Pack — acme/finance@1.2.0");
    expect(text).toMatch(/block-big-refund/);
    expect(text).toMatch(/require-note/);
  });

  it("shows a pack policy the user did not take as off", async () => {
    installPack({ enabled: ["block-big-refund"] });
    const text = await run();
    expect(text).toMatch(/✓ PACK\s+block-big-refund/);
    expect(text).toMatch(/· OFF\s+require-note/);
  });

  it("shows an observe pack as observing, never as enforcing", async () => {
    // observe evaluates and discards its verdict; an ON row would claim
    // enforcement the pack deliberately is not doing.
    installPack({ effect: "observe" });
    const text = await run();
    expect(text).toMatch(/◉ OBS\s+block-big-refund/);
    expect(text).not.toMatch(/✓ PACK\s+block-big-refund/);
  });

  it("names a pack that will not load instead of quietly listing less", async () => {
    installPack({ sha256: "0".repeat(64) });
    const text = await run();
    expect(text).toMatch(/will not load/);
    expect(text).toContain("acme/finance");
  });

  it("keeps the config footer and any warning at the very end", async () => {
    // A footer printed between two sections reads as the end of the output, and
    // a warning above three more sections is one nobody scrolls back to.
    // A pack has to be installed for an unknown key to BE unknown: the names a
    // `policyParams` key may use are the policies a pack carries, and with none
    // installed there is nothing to check a typo against.
    installPack();
    writeFileSync(
      join(home, "policies-config.json"),
      JSON.stringify({ enabledPolicies: [], policyParams: { "not-a-policy": { x: 1 } } }),
    );
    const text = await run();
    const config = text.indexOf("Config:");
    const warn = text.indexOf("unknown policyParams key");
    expect(config).toBeGreaterThan(0);
    expect(warn).toBeGreaterThan(config);
  });

  it("says nothing is installed, and what to run", async () => {
    const text = await run();
    expect(text).toContain("not installed");
    expect(text).toContain("failproofai policies --install");
  });

  it("never runs past the terminal edge", async () => {
    installPack();
    const text = await run();
    for (const line of text.split("\n")) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(80);
    }
  });
});
