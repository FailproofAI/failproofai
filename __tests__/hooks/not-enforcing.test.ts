// @vitest-environment node
/**
 * `notEnforcingReason` — the one answer to "are the policies on this machine
 * actually enforcing?", shared by the policies listing and the launch screen so
 * the two can never disagree.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ARTIFACT = "export const hooks = [];\n";
const DIGEST = createHash("sha256").update(ARTIFACT).digest("hex");

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
            { name: "block-big-refund", description: "Block big refunds", category: "Finance", defaultEnabled: true, match: {} },
            { name: "require-note", description: "Require a note", category: "Finance", defaultEnabled: true, match: {} },
          ],
          ...over,
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
  home = mkdtempSync(join(tmpdir(), "fpai-enforcing-home-"));
  project = mkdtempSync(join(tmpdir(), "fpai-enforcing-proj-"));
  packRoot = mkdtempSync(join(tmpdir(), "fpai-enforcing-packs-"));
  mkdirSync(join(packRoot, "artifacts"), { recursive: true });
  writeFileSync(join(packRoot, "artifacts", `${DIGEST}.mjs`), ARTIFACT);
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

describe("notEnforcingReason", () => {
  it("says no agent calls failproofai when nothing is wired, whatever is installed", async () => {
    installPack();
    expect(await reason()).toBe("no-hooks");
  });

  it("says no policies when an agent is wired but nothing is switched on", async () => {
    wireClaude();
    expect(await reason()).toBe("no-policies");
  });

  it("is null once a wired machine has a pack policy on", async () => {
    wireClaude();
    installPack();
    expect(await reason()).toBeNull();
  });

  it("calls an observe-only pack observe-only, never enforcing", async () => {
    wireClaude();
    installPack({ effect: "observe" });
    expect(await reason()).toBe("observe-only");
  });

  it("counts a policy the user switched off after install as off", async () => {
    wireClaude();
    installPack({ enabled: ["block-big-refund"] });
    writeFileSync(
      join(home, "policies-config.json"),
      JSON.stringify({ enabledPolicies: [], disabledCustomPolicies: ["pack:acme/finance@1.2.0:block-big-refund"] }),
    );
    expect(await reason()).toBe("no-policies");
  });

  it("counts convention policy files on disk without importing them", async () => {
    wireClaude();
    mkdirSync(join(project, ".failproofai", "policies"), { recursive: true });
    writeFileSync(join(project, ".failproofai", "policies", "team-policies.mjs"), "throw new Error('must not be imported');\n");
    expect(await reason()).toBeNull();
  });
});
