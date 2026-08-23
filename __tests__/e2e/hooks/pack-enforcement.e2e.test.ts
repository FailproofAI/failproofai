// @vitest-environment node
/**
 * A pack, denying a real tool call through the real hook binary.
 *
 * Everything else about packs is tested at the unit level: the manifest parses,
 * the loader tags, the digest verifies. None of that answers the only question
 * that matters to a user — does an installed pack actually STOP the agent — and
 * the layers between (config merge, registration order, per-CLI response shape)
 * are exactly where a policy silently becomes decorative.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runHook, assertAllow, assertPreToolUseDeny } from "../helpers/hook-runner";
import { createFixtureEnv } from "../helpers/fixture-env";
import { Payloads } from "../helpers/payloads";

const ENTRY = `
  import { customPolicies, allow, deny } from "failproofai";
  customPolicies.add({
    name: "block-refunds",
    description: "Block refunds above the approved limit",
    match: { events: ["PreToolUse"] },
    fn: async (ctx) => (String(ctx.toolInput?.command ?? "").includes("refund")
      ? deny("refunds need a human")
      : allow()),
  });
  customPolicies.add({
    name: "block-payouts",
    description: "Block payouts",
    match: { events: ["PreToolUse"] },
    fn: async (ctx) => (String(ctx.toolInput?.command ?? "").includes("payout")
      ? deny("payouts need a human")
      : allow()),
  });
`;
const DIGEST = createHash("sha256").update(ENTRY).digest("hex");

const policy = (name: string) => ({
  name, description: `d-${name}`, category: "Finance", defaultEnabled: true,
  match: { events: ["PreToolUse"] },
});

/** Install a pack into the fixture home, the way `pack add` would leave it. */
function installPack(home: string, over: Record<string, unknown> = {}, entry = ENTRY): void {
  const digest = createHash("sha256").update(entry).digest("hex");
  const packs = join(home, ".failproofai", "policies", "packs");
  mkdirSync(join(packs, "artifacts"), { recursive: true });
  writeFileSync(join(packs, "artifacts", `${digest}.mjs`), entry, "utf8");
  writeFileSync(
    join(packs, "installed.json"),
    JSON.stringify({
      schemaVersion: 1,
      packs: [{
        id: "acme/finance", version: "1.2.0", source: "github:acme/finance@v1.2.0",
        entry: `artifacts/${digest}.mjs`, sha256: digest,
        policies: [policy("block-refunds"), policy("block-payouts")],
        ...over,
      }],
    }),
    "utf8",
  );
}

const bash = (cmd: string, cwd: string) => Payloads.preToolUse.bash(cmd, cwd);

describe("pack enforcement, end to end", () => {
  it("denies a tool call a pack policy objects to", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: [] });
    installPack(env.home);

    const result = runHook("PreToolUse", bash("issue refund 500", env.cwd), { homeDir: env.home });
    assertPreToolUseDeny(result);
    expect(result.stdout + result.stderr).toContain("refunds need a human");
  });

  it("allows what the pack does not object to", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: [] });
    installPack(env.home);
    assertAllow(runHook("PreToolUse", bash("ls -la", env.cwd), { homeDir: env.home }));
  });

  it("enforces with NO builtin policies enabled — the pack is the only guard", () => {
    // The layering claim made explicit: a pack adds enforcement rather than
    // depending on any builtin being switched on.
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: [] });
    installPack(env.home);
    assertPreToolUseDeny(runHook("PreToolUse", bash("send payout now", env.cwd), { homeDir: env.home }));
  });

  it("registers ONLY the selected policies", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: [] });
    installPack(env.home, { enabled: ["block-refunds"] });

    assertPreToolUseDeny(runHook("PreToolUse", bash("issue refund 500", env.cwd), { homeDir: env.home }));
    // Taken out of the pack, so it must not fire even though the artifact
    // registers it.
    assertAllow(runHook("PreToolUse", bash("send payout now", env.cwd), { homeDir: env.home }));
  });

  it("DENIES when the artifact no longer matches its recorded digest", () => {
    // This asserted a clean allow until the fail-closed contract landed, and the
    // comment then said why: failing open was defensible only while compiled
    // builtins enforced underneath. Once a pack can be the only thing standing
    // between an agent and a machine, "the guard you were promised is not
    // running" has to refuse rather than proceed quietly.
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: [] });
    installPack(env.home);
    const packs = join(env.home, ".failproofai", "policies", "packs");
    writeFileSync(join(packs, "artifacts", `${DIGEST}.mjs`), ENTRY + "\n// tampered\n", "utf8");

    const result = runHook("PreToolUse", bash("issue refund 500", env.cwd), { homeDir: env.home });
    assertPreToolUseDeny(result);
    const out = result.stdout + result.stderr;
    expect(out).toContain("acme/finance");
    // The message must name the human command, because the agent cannot run it:
    // block-failproofai-commands denies every failproofai invocation from a tool
    // call, deliberately and unconditionally.
    expect(out).toContain("failproofai pack list");
  });

  it("still denies only where the missing guards applied", () => {
    // The deny is narrow, unlike the daemon's. An unreachable daemon means no
    // evaluation happened at all, so nothing can be known safe; an unloadable
    // pack has an ENUMERABLE set of missing guards, because every declared
    // policy must carry a match.
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: [] });
    installPack(env.home);
    const packs = join(env.home, ".failproofai", "policies", "packs");
    writeFileSync(join(packs, "artifacts", `${DIGEST}.mjs`), ENTRY + "\n// tampered\n", "utf8");

    // The pack's policies declare PreToolUse only, so a Stop event is untouched.
    assertAllow(runHook("Stop", { hook_event_name: "Stop", cwd: env.cwd, session_id: "s" } as never, { homeDir: env.home }));
  });

  it("DENIES when a digest-valid artifact cannot be imported", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: [] });
    installPack(env.home, {}, "export const broken = ;\n");

    const result = runHook("PreToolUse", bash("issue refund 500", env.cwd), { homeDir: env.home });
    assertPreToolUseDeny(result);
    expect(result.stdout + result.stderr).toContain("artifact failed to load");
  });

  it("does NOT deny for a tampered OBSERVE pack", () => {
    // An observe pack evaluates and discards by construction, so denying on its
    // behalf denies for something that would have allowed.
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: [] });
    installPack(env.home, { effect: "observe" });
    const packs = join(env.home, ".failproofai", "policies", "packs");
    writeFileSync(join(packs, "artifacts", `${DIGEST}.mjs`), ENTRY + "\n// tampered\n", "utf8");

    assertAllow(runHook("PreToolUse", bash("issue refund 500", env.cwd), { homeDir: env.home }));
  });

  it("keeps enforcing builtins when the pack manifest is corrupt", () => {
    // The layering property that makes fail-open defensible at all.
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["block-sudo"] });
    const packs = join(env.home, ".failproofai", "policies", "packs");
    mkdirSync(packs, { recursive: true });
    writeFileSync(join(packs, "installed.json"), "not json", "utf8");

    assertPreToolUseDeny(runHook("PreToolUse", bash("sudo rm -rf /", env.cwd), { homeDir: env.home }));
  });

  it("runs a pack policy in observe mode without denying, and WITHOUT crashing", () => {
    // The allow is not enough on its own, and this test proved it: the first
    // version of this passed against a real bug. The observe path read
    // `cloudManaged!.id`, which is undefined for a pack, so every non-allow
    // shadow verdict threw — the throw was swallowed by the evaluator, nothing
    // was recorded, and the net result was an allow. Exactly what this asserted.
    // A clean stderr is what separates "observed" from "crashed into an allow".
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: [] });
    installPack(env.home, { effect: "observe" });

    const result = runHook("PreToolUse", bash("issue refund 500", env.cwd), { homeDir: env.home });
    assertAllow(result);
    expect(result.stderr).not.toMatch(/threw:/);
    expect(result.stderr).not.toMatch(/cloudManaged/);
  });
});

describe("a pack policy that duplicates an enabled builtin", () => {
  // Both halves register — `failproofai/warn-git-amend` and
  // `pack/<id>@<version>/warn-git-amend` — under different keys, so nothing
  // deduped them. A DENY hides it, because the first verdict short-circuits; an
  // INSTRUCT does not, and the agent was handed the identical paragraph twice.
  const TWIN = `
    import { customPolicies, instruct } from "failproofai";
    customPolicies.add({
      name: "warn-git-amend",
      description: "the pack's copy",
      match: { events: ["PreToolUse"] },
      fn: async () => instruct("PACK COPY SPOKE"),
    });
  `;

  function installTwin(home: string): void {
    const digest = createHash("sha256").update(TWIN).digest("hex");
    const packs = join(home, ".failproofai", "policies", "packs");
    mkdirSync(join(packs, "artifacts"), { recursive: true });
    writeFileSync(join(packs, "artifacts", `${digest}.mjs`), TWIN, "utf8");
    writeFileSync(
      join(packs, "installed.json"),
      JSON.stringify({
        schemaVersion: 1,
        packs: [{
          id: "acme/finance", version: "1.2.0", source: "github:acme/finance@v1.2.0",
          entry: `artifacts/${digest}.mjs`, sha256: digest,
          policies: [{
            name: "warn-git-amend", description: "the pack's copy", category: "Git",
            defaultEnabled: true, match: { events: ["PreToolUse"] },
          }],
        }],
      }),
      "utf8",
    );
  }

  it("runs the builtin only, so the instruction is delivered once", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["warn-git-amend"] });
    installTwin(env.home);

    const result = runHook("PreToolUse", bash("git commit --amend", env.cwd), { homeDir: env.home });
    const out = result.stdout + result.stderr;
    // The builtin's own text, and NOT the pack's — a bare name means the builtin
    // everywhere else, so it means the builtin here too.
    expect(out).toMatch(/amend/i);
    expect(out).not.toContain("PACK COPY SPOKE");
  });

  it("still runs a pack policy whose name no enabled builtin holds", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: [] });
    installTwin(env.home);
    const result = runHook("PreToolUse", bash("git commit --amend", env.cwd), { homeDir: env.home });
    expect(result.stdout + result.stderr).toContain("PACK COPY SPOKE");
  });
});
