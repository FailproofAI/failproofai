// @vitest-environment node
/**
 * Enforcement comes from PACKS. What this build still contributes is the
 * always-on self-protection guard, and nothing else.
 *
 * The migration shim is the delicate part: a machine that upgrades into this
 * version has `enabledPolicies` in its config and no pack installed yet, and it
 * must not spend that gap unguarded. So the compiled implementations still fire
 * for exactly that machine — and stop the moment a pack arrives.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ARTIFACT = `
  import { customPolicies, deny } from "failproofai";
  customPolicies.add({ name: "block-refunds", description: "d",
    match: { events: ["PreToolUse"] },
    fn: async (ctx) => String(ctx.toolInput?.command ?? "").includes("refund")
      ? deny("refunds need a human") : ({ decision: "allow" }) });
`;
const DIGEST = createHash("sha256").update(ARTIFACT).digest("hex");

let home: string;
let packRoot: string;
let saved: Record<string, string | undefined>;

function installPack(): void {
  mkdirSync(join(packRoot, "artifacts"), { recursive: true });
  writeFileSync(join(packRoot, "artifacts", `${DIGEST}.mjs`), ARTIFACT);
  writeFileSync(
    join(packRoot, "installed.json"),
    JSON.stringify({
      schemaVersion: 1,
      packs: [{
        id: "acme/ops", version: "1.0.0", source: "github:acme/ops@v1.0.0",
        entry: `artifacts/${DIGEST}.mjs`, sha256: DIGEST,
        policies: [{
          name: "block-refunds", description: "d", category: "Ops",
          defaultEnabled: true, match: { events: ["PreToolUse"] },
        }],
      }],
    }),
  );
}

async function evaluate(command: string) {
  const { evaluateHookEvent } = await import("@/src/hooks/handler");
  return evaluateHookEvent(
    "PreToolUse",
    "claude",
    JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command },
      session_id: "s1",
      cwd: home,
    }),
  );
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "fpai-enf-home-"));
  packRoot = mkdtempSync(join(tmpdir(), "fpai-enf-packs-"));
  saved = {
    FAILPROOFAI_HOME: process.env.FAILPROOFAI_HOME,
    FAILPROOFAI_PACK_DIR: process.env.FAILPROOFAI_PACK_DIR,
  };
  process.env.FAILPROOFAI_HOME = home;
  process.env.FAILPROOFAI_PACK_DIR = packRoot;
  vi.resetModules();
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const dir of [home, packRoot]) rmSync(dir, { recursive: true, force: true });
});

describe("what this build enforces on its own", () => {
  it("still blocks an agent from switching failproofai off — the one guard that cannot be a pack", async () => {
    // `alwaysOn` is refused by the pack loader by design, so this policy cannot
    // travel the pack lane and has to ship compiled in.
    writeFileSync(join(home, "policies-config.json"), JSON.stringify({ enabledPolicies: [] }));
    installPack();
    const result = await evaluate("failproofai policies --uninstall block-sudo");
    expect(JSON.stringify(result)).toMatch(/deny/);
  });

  it("enforces a pack's policy with no builtins enabled at all", async () => {
    writeFileSync(join(home, "policies-config.json"), JSON.stringify({ enabledPolicies: [] }));
    installPack();
    const result = await evaluate("issue refund 500");
    expect(JSON.stringify(result)).toContain("refunds need a human");
  });

  it("does NOT enforce a former builtin once a pack is installed", async () => {
    // `block-sudo` is in the config, but this build no longer registers it: the
    // pack is the source now, and this pack does not carry it.
    writeFileSync(
      join(home, "policies-config.json"),
      JSON.stringify({ enabledPolicies: ["block-sudo"] }),
    );
    installPack();
    const result = await evaluate("sudo rm -rf /tmp/x");
    expect(JSON.stringify(result)).not.toMatch(/sudo commands are blocked/);
  });
});

describe("the migration shim", () => {
  it("keeps a machine that has not migrated yet guarded", async () => {
    // Upgraded into this build: config full of policy names, no pack installed.
    // Losing enforcement in that gap is the failure this product exists to
    // prevent, so the compiled implementations still fire.
    writeFileSync(
      join(home, "policies-config.json"),
      JSON.stringify({ enabledPolicies: ["block-sudo"] }),
    );
    const result = await evaluate("sudo rm -rf /tmp/x");
    expect(JSON.stringify(result)).toMatch(/sudo commands are blocked/);
  });

  it("stops the moment a pack arrives, so it cannot double up", async () => {
    writeFileSync(
      join(home, "policies-config.json"),
      JSON.stringify({ enabledPolicies: ["block-sudo"] }),
    );
    installPack();
    const result = await evaluate("sudo rm -rf /tmp/x");
    expect(JSON.stringify(result)).not.toMatch(/sudo commands are blocked/);
  });
});
