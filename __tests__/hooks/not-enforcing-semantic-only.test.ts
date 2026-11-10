// @vitest-environment node
/**
 * `notEnforcingReason` and a refused Jev-checks-only pack.
 *
 * Such a pack (its regex `policies` list is empty) has nothing in the regex
 * tier to fail closed on: pack-failclosed.ts denies nothing for it, and the
 * policies listing leaves it out of its "failed to load" line. So it must not
 * make a machine read as enforcing either, or the listing and the launch screen
 * disagree about whether this machine is protected.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home: string;
let project: string;
let packRoot: string;
let saved: Record<string, string | undefined>;

function wireClaude(): void {
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: "*", hooks: [{ type: "command", command: "npx -y failproofai --hook PreToolUse", __failproofai_hook__: true }] },
        ],
      },
    }),
  );
}

/** One pack whose artifact digest does not match, so it is refused at read. */
function installRefusedPack(policies: unknown[]): void {
  writeFileSync(
    join(packRoot, "installed.json"),
    JSON.stringify({
      schemaVersion: 1,
      packs: [
        {
          id: "acme/jev-only",
          version: "1.0.0",
          source: "github:acme/jev-only@v1.0.0",
          entry: `artifacts/${"0".repeat(64)}.mjs`,
          sha256: "0".repeat(64),
          policies,
        },
      ],
    }),
  );
}

async function reason() {
  const { notEnforcingReason } = await import("@/src/hooks/manager");
  return notEnforcingReason(project);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "fpai-semantic-home-"));
  project = mkdtempSync(join(tmpdir(), "fpai-semantic-proj-"));
  packRoot = mkdtempSync(join(tmpdir(), "fpai-semantic-packs-"));
  mkdirSync(join(packRoot, "artifacts"), { recursive: true });
  saved = { FAILPROOFAI_HOME: process.env.FAILPROOFAI_HOME, FAILPROOFAI_PACK_DIR: process.env.FAILPROOFAI_PACK_DIR };
  process.env.FAILPROOFAI_HOME = home;
  process.env.FAILPROOFAI_PACK_DIR = packRoot;
  // Agent settings resolve from the OS home, not FAILPROOFAI_HOME.
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of [home, project, packRoot]) rmSync(dir, { recursive: true, force: true });
});

describe("notEnforcingReason with a refused Jev-checks-only pack", () => {
  it("does not count it as enforcing: it denies nothing", async () => {
    wireClaude();
    installRefusedPack([]);
    const { readInstalledPacks } = await import("@/src/hooks/pack-manifest");
    // The premise: the pack is refused, and refused as semantic-only.
    expect(readInstalledPacks().errors).toEqual([expect.objectContaining({ id: "acme/jev-only", semanticOnly: true })]);
    expect(await reason()).toBe("no-policies");
  });

  it("still counts a refused pack with regex policies, which fails closed", async () => {
    wireClaude();
    installRefusedPack([{ name: "block-x", description: "Block x", category: "X", defaultEnabled: true, match: {} }]);
    expect(await reason()).toBeNull();
  });
});
