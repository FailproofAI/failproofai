// @vitest-environment node
/**
 * `policies --install <name> --cli <x>` must keep installing hooks once a pack
 * is on the machine.
 *
 * The bundled `FailproofAI/policies` pack declares every builtin BY NAME, and
 * the first install is what puts it on disk. So from the second install onward
 * an ordinary `--install block-sudo --cli codex` resolved as "the user named
 * only pack policies", took the short-circuit meant for third-party packs, and
 * returned before writing a single settings file — exit 0, a reassuring
 * `Enabled … from pack` line, `--cli`/`--scope`/`--custom` all discarded.
 *
 * The first install per machine worked, which is why it survived manual
 * testing. What found it was the integration suite: it installs for 12 CLIs in
 * a row on one container, so exactly one got hooks and the other eleven ran
 * unguarded — `hooks: NO HOOK LOG — not one hook fired for this probe`, eleven
 * times, reported as broken enforcement in the vendors rather than here.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ARTIFACT = "export const hooks = [];\n";
const DIGEST = createHash("sha256").update(ARTIFACT).digest("hex");

let home: string;
let project: string;
let packRoot: string;
let saved: Record<string, string | undefined>;

function pack(id: string, policies: string[]) {
  return {
    id,
    version: "1.2.0",
    source: `github:${id}@v1.2.0`,
    entry: `artifacts/${DIGEST}.mjs`,
    sha256: DIGEST,
    policies: policies.map((name) => ({
      name,
      description: `does ${name}`,
      category: "Security",
      defaultEnabled: true,
      match: {},
    })),
  };
}

function install(...packs: unknown[]): void {
  writeFileSync(join(packRoot, "installed.json"), JSON.stringify({ schemaVersion: 1, packs }));
}

/** installHooks' positional signature, named so the tests below stay readable. */
async function installFor(names: string[] | undefined, clis: string[]) {
  const { installHooks } = await import("@/src/hooks/manager");
  await installHooks(
    names,
    "project",
    project,
    false,
    undefined,
    undefined,
    false,
    clis as never,
  );
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "fpai-afterpack-home-"));
  project = mkdtempSync(join(tmpdir(), "fpai-afterpack-proj-"));
  packRoot = mkdtempSync(join(tmpdir(), "fpai-afterpack-packs-"));
  mkdirSync(join(packRoot, "artifacts"), { recursive: true });
  writeFileSync(join(packRoot, "artifacts", `${DIGEST}.mjs`), ARTIFACT);
  saved = {
    FAILPROOFAI_HOME: process.env.FAILPROOFAI_HOME,
    FAILPROOFAI_PACK_DIR: process.env.FAILPROOFAI_PACK_DIR,
    FAILPROOFAI_BINARY_OVERRIDE: process.env.FAILPROOFAI_BINARY_OVERRIDE,
  };
  process.env.FAILPROOFAI_HOME = home;
  process.env.FAILPROOFAI_PACK_DIR = packRoot;
  // Never resolved off PATH here: a machine without a global install must not
  // turn this into a test about `which`.
  process.env.FAILPROOFAI_BINARY_OVERRIDE = join(project, "failproofai");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const dir of [home, project, packRoot]) rmSync(dir, { recursive: true, force: true });
});

describe("installing a builtin that an installed pack also declares", () => {
  it("still writes the target CLI's settings file", async () => {
    install(pack("FailproofAI/policies", ["block-sudo", "block-read-outside-cwd"]));
    await installFor(["block-sudo"], ["codex"]);
    expect(existsSync(join(project, ".codex", "hooks.json"))).toBe(true);
  });

  it("honours --cli for a SECOND CLI after the first install seeded the pack", async () => {
    // The exact sequence the integration suite runs, and the one a user runs
    // when they add a second agent CLI weeks later.
    install(pack("FailproofAI/policies", ["block-read-outside-cwd"]));
    await installFor(["block-read-outside-cwd"], ["claude"]);
    await installFor(["block-read-outside-cwd"], ["codex"]);
    expect(existsSync(join(project, ".claude", "settings.json"))).toBe(true);
    expect(existsSync(join(project, ".codex", "hooks.json"))).toBe(true);
  });

  it("wires every CLI when they arrive one invocation at a time", async () => {
    install(pack("FailproofAI/policies", ["block-read-outside-cwd"]));
    for (const cli of ["claude", "codex", "copilot", "cursor"]) {
      await installFor(["block-read-outside-cwd"], [cli]);
    }
    for (const rel of [
      [".claude", "settings.json"],
      [".codex", "hooks.json"],
      [".github", "hooks", "failproofai.json"],
      [".cursor", "hooks.json"],
    ]) {
      expect(existsSync(join(project, ...rel)), rel.join("/")).toBe(true);
    }
  });

  it("leaves the switch in the pack rather than re-writing enabledPolicies", async () => {
    // The pack is where a policy is turned on now. Writing the name back into
    // `enabledPolicies` would resurrect the stale key that made a `remove`
    // followed by an `--install` silently re-enable what the owner switched off.
    install(pack("FailproofAI/policies", ["block-sudo"]));
    await installFor(["block-sudo"], ["codex"]);
    const packed = JSON.parse(readFileSync(join(packRoot, "installed.json"), "utf8")) as {
      packs: Array<{ enabled?: string[] }>;
    };
    expect(packed.packs[0].enabled).toContain("block-sudo");
    const configPath = join(project, ".failproofai", "policies-config.json");
    const config = existsSync(configPath)
      ? (JSON.parse(readFileSync(configPath, "utf8")) as { enabledPolicies?: string[] })
      : { enabledPolicies: [] };
    expect(config.enabledPolicies ?? []).not.toContain("block-sudo");
  });
});

describe("installing a name only a third-party pack declares", () => {
  it("still short-circuits without touching any CLI's settings", async () => {
    // Unchanged on purpose. `policies add block-big-refund` is a switch, not an
    // install: carrying on would rewrite every CLI's settings to enable a set
    // of builtins nobody asked about, and would fail outright on a machine with
    // no binary on PATH — after the pack change had already landed.
    install(pack("acme/finance", ["block-big-refund"]));
    await installFor(["block-big-refund"], ["codex"]);
    expect(existsSync(join(project, ".codex", "hooks.json"))).toBe(false);
    const packed = JSON.parse(readFileSync(join(packRoot, "installed.json"), "utf8")) as {
      packs: Array<{ enabled?: string[] }>;
    };
    expect(packed.packs[0].enabled).toContain("block-big-refund");
  });
});
