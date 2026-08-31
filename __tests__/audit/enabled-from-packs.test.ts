// @vitest-environment node
/**
 * "Already protected" vs "slipping through" has to reflect what is actually
 * enforcing — including policies that arrived in a PACK.
 *
 * It read `enabledPolicies` and nothing else. That key predates packs and is
 * still written by `policies add <name>`, but `pack-store` never writes it —
 * a pack records its selection in `installed.json` instead. So the split had no
 * way to learn that anything was enforcing: every finding read as slipping
 * through however many policies were installed, and the number the audit leads
 * with never moved. Measured before the fix: identical 302 hits and 17 findings
 * with nothing installed and with all 38 installed.
 *
 * NOT about what gets replayed. That stays the compiled builtins on purpose —
 * see `initReplay`: an audit is a fixed yardstick, and one that changed shape
 * with whatever pack a machine happened to have could not be compared against
 * its own history. This is only about which of its findings are already covered.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Every test here calls `vi.resetModules()` and re-imports the whole audit
// module graph, so the cost grows with each integration we ship — the graph now
// pulls a sessions parser, a projects enumerator and an adapter per CLI. At 15
// integrations the file runs ~3.4s alone and intermittently crossed the default
// 5s budget under a loaded parallel run. The assertions are unchanged; only the
// budget is, because the thing that got slower is the import, not the audit.
vi.setConfig({ testTimeout: 20_000 });
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const SESSION = "aaaaaaaa-1111-2222-3333-444444444444";

let root: string;
let home: string;
let packDir: string;
let origProjects: string | undefined;
let origHome: string | undefined;
let origCwd: string;

/** Tool calls that trip several default builtins. */
function transcript(): string {
  const cmds = ["sudo rm -rf /tmp/x", "cat .env", "env | grep SECRET", "git push --force origin main"];
  return cmds
    .map((c, i) =>
      JSON.stringify({
        type: "assistant",
        uuid: `u${i}`,
        parentUuid: i === 0 ? null : `u${i - 1}`,
        sessionId: SESSION,
        cwd: "/tmp/demo",
        timestamp: new Date(2026, 4, 1, 0, 0, i).toISOString(),
        message: { role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "Bash", input: { command: c } }] },
      }),
    )
    .join("\n") + "\n";
}

/** A manifest in the shape `pack add` really writes — `enabled` absent means
 *  the whole pack was taken. */
/**
 * `fp-home` is resolved through a DYNAMIC import, after the env is set.
 *
 * A top-level import binds the home directory when the module is first
 * evaluated — before `beforeEach` runs — so the fixture was written to one
 * place and read from another, and every count came back zero while the same
 * code worked perfectly outside the runner.
 */
async function installPack(policyNames: string[], enabled?: string[]): Promise<void> {
  // FAILPROOFAI_PACK_DIR, not the fp-home helper.
  //
  // `packsInstalledFile(home)` takes the home explicitly while the READER
  // resolves it from the environment, and the two disagreed under the runner —
  // the fixture was written where nothing looked for it, and `readInstalledPacks`
  // returned zero packs and zero errors, which is what "no manifest" looks like.
  // This variable is read by both sides and by nothing else.
  const file = join(packDir, "installed.json");
  mkdirSync(dirname(file), { recursive: true });
  // A REAL artifact with a matching digest. The manifest reader resolves the
  // entry, stats it, and verifies its SHA-256 — a pack that fails any of those
  // is dropped, and a dropped pack is indistinguishable from no pack at all,
  // which is exactly the state this test is trying to tell apart.
  const body = "// pack artifact\n";
  const SHA = createHash("sha256").update(body).digest("hex");
  const artifacts = join(dirname(file), "artifacts");
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(join(artifacts, `${SHA}.mjs`), body, "utf8");
  writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 1,
      packs: [
        {
          id: "acme/guards",
          version: "1.0.0",
          source: "github:acme/guards@1.0.0",
          // A real 64-hex digest: the manifest reader rejects anything else
          // outright, and a rejected pack looks exactly like no pack at all.
          entry: `artifacts/${SHA}.mjs`,
          sha256: SHA,
          effect: "enforce",
          ...(enabled ? { enabled } : {}),
          policies: policyNames.map((name) => ({
            name,
            description: name,
            category: "General",
            defaultEnabled: true,
            match: { events: ["PreToolUse"] },
          })),
        },
      ],
    }),
    "utf8",
  );
}

async function split(): Promise<{ protectedCount: number; slipping: number }> {
  // Imported HERE, not at the top of the file. `fp-home` resolves the home
  // directory when its module is first evaluated, so a top-level import binds
  // it before `beforeEach` sets FAILPROOFAI_HOME — and every lookup then goes
  // to the developer's real home, where there is no fixture pack and the
  // answer is always zero.
  vi.resetModules();
  const { runAudit } = await import("../../src/audit");
  const { resetReplay } = await import("../../src/audit/replay");
  resetReplay();
  const r = await runAudit({ clis: ["claude"], noCache: true });
  const isProtected = (x: { source: string; enabledInConfig?: boolean }) =>
    x.source === "builtin" && !!x.enabledInConfig;
  return {
    protectedCount: r.results.filter(isProtected).length,
    slipping: r.results.filter((x) => !isProtected(x)).length,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fpai-enabled-"));
  home = join(root, "home");
  mkdirSync(home, { recursive: true });
  packDir = join(home, "packs");
  const projects = join(root, "projects", "-tmp-demo");
  mkdirSync(projects, { recursive: true });
  writeFileSync(join(projects, `${SESSION}.jsonl`), transcript(), "utf8");
  origProjects = process.env.CLAUDE_PROJECTS_PATH;
  origHome = process.env.FAILPROOFAI_HOME;
  origCwd = process.cwd();
  process.env.CLAUDE_PROJECTS_PATH = join(root, "projects");
  process.env.FAILPROOFAI_HOME = home;
  process.env.FAILPROOFAI_PACK_DIR = packDir;
  // Out of the repo: its own .failproofai/policies-config.json enables 30
  // policies, and `readMergedHooksConfig` merges the PROJECT config — which
  // silently supplies an "already protected" set that has nothing to do with
  // the test. It read 13 protected on a machine with nothing installed.
  process.chdir(root);
});

afterEach(() => {
  process.chdir(origCwd);
  if (origProjects === undefined) delete process.env.CLAUDE_PROJECTS_PATH;
  else process.env.CLAUDE_PROJECTS_PATH = origProjects;
  if (origHome === undefined) delete process.env.FAILPROOFAI_HOME;
  else process.env.FAILPROOFAI_HOME = origHome;
  delete process.env.FAILPROOFAI_PACK_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe("what the audit calls already protected", () => {
  it("is nothing, on a machine with nothing installed", async () => {
    const s = await split();
    expect(s.protectedCount).toBe(0);
    expect(s.slipping).toBeGreaterThan(0);
  });

  it("counts a policy that arrived in a pack", async () => {
    // The whole bug: this stayed 0 however much was installed.
    await installPack(["block-sudo", "block-env-files"]);
    const s = await split();
    expect(s.protectedCount).toBeGreaterThan(0);
  });

  it("moves the split rather than just adding rows", async () => {
    const before = await split();
    await installPack(["block-sudo", "block-env-files"]);
    const after = await split();
    expect(after.protectedCount).toBeGreaterThan(before.protectedCount);
    expect(after.slipping).toBeLessThan(before.slipping);
  });

  it("takes the WHOLE catalog when no selection was recorded", async () => {
    // `enabled: null` means the user took the whole pack. The field records a
    // SELECTION, and its absence is not an empty one — reading it as empty
    // would report a fully-installed pack as protecting nothing.
    await installPack(["block-sudo", "block-env-files"]);
    const whole = await split();
    await installPack(["block-sudo", "block-env-files"], ["block-sudo"]);
    const partial = await split();
    expect(whole.protectedCount).toBeGreaterThan(partial.protectedCount);
  });

  it("still honours the pre-packs key, for a machine on the shim", async () => {
    // `policies add <name>` writes `enabledPolicies` to this day, and a machine
    // running the migration shim has only that. Reading packs must not replace
    // it.
    writeFileSync(
      join(home, "policies-config.json"),
      JSON.stringify({ enabledPolicies: ["block-sudo"] }),
      "utf8",
    );
    const s = await split();
    expect(s.protectedCount).toBeGreaterThan(0);
  });
});
