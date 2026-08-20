// @vitest-environment node
/**
 * A pack, loaded the way a real one is: real bytes on disk, a real sha256, and
 * a real dynamic import through `loadAllCustomHooks`.
 *
 * The pack lane is deliberately the CUSTOM lane with a different tag, not a
 * fourth loader. Everything below exists to prove the tag is applied where it
 * has to be and — the part that matters — that a pack cannot reach the builtin
 * namespace or skip its digest.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/src/hooks/hook-logger", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  hookLogWarn: vi.fn(),
}));
import { hookLogWarn } from "@/src/hooks/hook-logger";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadAllCustomHooks } from "@/src/hooks/custom-hooks-loader";
import { clearCustomHooks } from "@/src/hooks/custom-hooks-registry";
import type { ResolvedPack } from "@/src/hooks/pack-manifest";

const SRC = `
  import { customPolicies, deny } from "failproofai";
  customPolicies.add({
    name: "block-refunds-over-limit",
    description: "from a pack",
    match: { events: ["PreToolUse"] },
    fn: async () => deny("refund exceeds the approved limit"),
  });
`;
const SHA = createHash("sha256").update(SRC).digest("hex");

let root: string;
let artifact: string;

function packRecord(over: Partial<ResolvedPack> = {}): ResolvedPack {
  return {
    id: "acme/finance",
    version: "1.2.0",
    source: "github:acme/finance@v1.2.0",
    path: artifact,
    sha256: SHA,
    effect: "enforce",
    policies: [],
    ...over,
  };
}

type Tagged = { __pack?: ResolvedPack; __policyId?: string; __cloudManaged?: unknown; name: string };

async function loadWith(packs: ResolvedPack[], paths: string[] = [artifact]) {
  const result = await loadAllCustomHooks(paths, { sessionCwd: root, packs });
  return result.hooks as unknown as Tagged[];
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fpai-pack-load-"));
  const artifacts = join(root, "artifacts");
  mkdirSync(artifacts, { recursive: true });
  artifact = join(artifacts, `${SHA}.mjs`);
  writeFileSync(artifact, SRC, "utf8");
  clearCustomHooks();
});

afterEach(() => {
  clearCustomHooks();
  rmSync(root, { recursive: true, force: true });
});

describe("pack loading", () => {
  it("loads a pack's policy and tags it with the pack's identity", async () => {
    const hooks = await loadWith([packRecord()]);
    expect(hooks).toHaveLength(1);
    expect(hooks[0].name).toBe("block-refunds-over-limit");
    expect(hooks[0].__pack?.id).toBe("acme/finance");
    expect(hooks[0].__pack?.version).toBe("1.2.0");
    // The id is what `disabledCustomPolicies` matches on, so it must carry the
    // version: disabling a policy in 1.2.0 should not silently keep it disabled
    // when the publisher ships 1.3.0 with different behaviour.
    expect(hooks[0].__policyId).toBe("pack:acme/finance@1.2.0:block-refunds-over-limit");
  });

  it("refuses to import an artifact whose bytes no longer match the manifest", async () => {
    // The manifest read and the import are two moments. This is the one that
    // binds the bytes actually EXECUTED to what was promised.
    writeFileSync(artifact, SRC.replace("deny(", "allow("), "utf8");
    const hooks = await loadWith([packRecord()]);
    expect(hooks).toHaveLength(0);
  });

  it("is not tagged as cloud-managed", async () => {
    // Cloud policies are exempt from local disable and from session pause. A
    // pack the user installed by typing a command is LOCAL policy, and picking
    // up that exemption by mistake would make it undisableable.
    const hooks = await loadWith([packRecord()]);
    expect(hooks[0].__cloudManaged).toBeUndefined();
  });

  it("merges byte-identical packs toward enforcement, and says so", async () => {
    // Artifacts are content-addressed, so two packs with identical source share
    // ONE file, and `loadedPaths` imports it exactly once. Whichever record wins
    // decides enforcement — the same collision that silently downgraded a cloud
    // policy to observe-only once already.
    const hooks = await loadWith([
      packRecord({ id: "acme/finance", effect: "observe" }),
      packRecord({ id: "other/dupe", effect: "enforce" }),
    ]);
    expect(hooks).toHaveLength(1);
    expect(hooks[0].__pack?.effect).toBe("enforce");
  });

  it("registers a pack policy exactly once even if its path is listed twice", async () => {
    // `customPolicies.add` is an unconditional push, so a second import would
    // register every hook again and fire it twice per event — which silently
    // halves the ceiling of any counting policy.
    const hooks = await loadWith([packRecord()], [artifact, artifact]);
    expect(hooks).toHaveLength(1);
  });

  describe("manifest vs artifact", () => {
    // Digest-pinning proves the bytes are the publisher's. It proves nothing
    // about the manifest AGREEING with them, and a listing built from a manifest
    // that disagrees is a listing that lies.
    it("warns when the manifest declares a policy the artifact never registers", async () => {
      const warn = vi.mocked(hookLogWarn);
      warn.mockClear();
      await loadWith([
        packRecord({
          policies: [
            { name: "block-refunds-over-limit", description: "d", category: "c", defaultEnabled: true, match: {} },
            { name: "ghost-policy", description: "d", category: "c", defaultEnabled: true, match: {} },
          ] as ResolvedPack["policies"],
        }),
      ]);
      const msg = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(msg).toContain("ghost-policy");
      expect(msg).toContain("never runs");
    });

    it("warns when the artifact registers a policy the manifest omits", async () => {
      const warn = vi.mocked(hookLogWarn);
      warn.mockClear();
      await loadWith([
        packRecord({
          policies: [
            { name: "something-else", description: "d", category: "c", defaultEnabled: true, match: {} },
          ] as ResolvedPack["policies"],
        }),
      ]);
      const msg = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(msg).toContain("block-refunds-over-limit");
      expect(msg).toContain("will not appear in listings");
    });

    it("says nothing when they agree", async () => {
      const warn = vi.mocked(hookLogWarn);
      warn.mockClear();
      await loadWith([
        packRecord({
          policies: [
            { name: "block-refunds-over-limit", description: "d", category: "c", defaultEnabled: true, match: {} },
          ] as ResolvedPack["policies"],
        }),
      ]);
      const msg = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(msg).not.toContain("block-refunds-over-limit");
    });
  });

  it("loads an ordinary custom policy from the same call without pack tagging", async () => {
    const plain = join(root, "my-policies.mjs");
    writeFileSync(
      plain,
      `import { customPolicies, allow } from "failproofai";
       customPolicies.add({ name: "mine", description: "d", match: { events: ["PreToolUse"] }, fn: async () => allow() });`,
      "utf8",
    );
    const hooks = await loadWith([packRecord()], [artifact, plain]);
    const byName = Object.fromEntries(hooks.map((h) => [h.name, h]));
    expect(byName["block-refunds-over-limit"].__pack?.id).toBe("acme/finance");
    expect(byName["mine"].__pack).toBeUndefined();
    expect(byName["mine"].__policyId).toContain("custom:");
  });
});
