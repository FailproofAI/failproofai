// @vitest-environment node
/**
 * When a pack that was supposed to be enforcing is not.
 *
 * Every carve-out below closes a way this deny would be WRONG, and a deny that
 * is wrong is worse than the gap it was added to close: it is unattended, it
 * persists until a human intervenes, and the agent cannot fix it because
 * `block-failproofai-commands` denies every failproofai invocation from a tool
 * call by design.
 */
import { describe, it, expect } from "vitest";
import { missingGuards, packFailureReason, PERMANENT_LOAD_FAILURES } from "@/src/hooks/pack-failclosed";
import type { PackError, ResolvedPack } from "@/src/hooks/pack-manifest";

const policy = (name: string, match: object = { events: ["PreToolUse"], toolNames: ["Bash"] }) =>
  ({ name, description: "d", category: "C", defaultEnabled: true, match }) as never;

const pack = (over: Partial<ResolvedPack> = {}): ResolvedPack => ({
  id: "acme/finance", version: "1.2.0", source: "github:acme/finance@v1.2.0",
  path: "/x.mjs", sha256: "a".repeat(64), effect: "enforce",
  policies: [policy("block-refunds"), policy("require-note")],
  enabled: null,
  ...over,
});

const call = (over: Partial<Parameters<typeof missingGuards>[0]> = {}) =>
  missingGuards({ errors: [], packs: [], registered: new Map(), failed: new Map(), disabled: new Set(), ...over });

describe("what counts as a failure", () => {
  it("says nothing about a machine with no packs at all", () => {
    // A fresh machine is not a broken one. The trigger is "declared and not
    // running", never "nothing is running".
    expect(call()).toEqual([]);
  });

  it("says nothing when a pack registered everything it declared", () => {
    expect(call({
      packs: [pack()],
      registered: new Map([["acme/finance", new Set(["block-refunds", "require-note"])]]),
    })).toEqual([]);
  });

  it("flags a pack declared in the manifest that never resolved", () => {
    const errors: PackError[] = [{
      id: "acme/finance", reason: "failed integrity verification",
      effect: "enforce", declared: [policy("block-refunds")],
    }];
    const guards = call({ errors });
    expect(guards).toHaveLength(1);
    expect(guards[0].policies).toEqual(["block-refunds"]);
    expect(guards[0].reason).toContain("integrity");
  });

  it("flags a pack that registered LESS than it declared", () => {
    // Its own listing would still claim the machine is protected by the policy
    // that never registered.
    const guards = call({
      packs: [pack()],
      registered: new Map([["acme/finance", new Set(["block-refunds"])]]),
    });
    expect(guards).toHaveLength(1);
    expect(guards[0].policies).toEqual(["require-note"]);
  });

  it("flags a pack whose artifact failed before registering any hooks", () => {
    const guards = call({
      packs: [pack()],
      failed: new Map([["acme/finance", { type: "syntax_error", reason: "Unexpected token" }]]),
    });
    expect(guards).toHaveLength(1);
    expect(guards[0].packVersion).toBe("1.2.0");
    expect(guards[0].policies).toEqual(["block-refunds", "require-note"]);
    expect(guards[0].reason).toContain("Unexpected token");
  });
});

describe("the carve-outs", () => {
  it("ignores an OBSERVE pack that failed", () => {
    // An observe pack evaluates and discards by construction, so denying on its
    // behalf denies for something that would have allowed.
    expect(call({ errors: [{ id: "a/b", reason: "boom", effect: "observe" }] })).toEqual([]);
    expect(call({
      packs: [pack({ effect: "observe" })],
      registered: new Map([["acme/finance", new Set()]]),
    })).toEqual([]);
  });

  it("ignores policies the user never took", () => {
    // Denying for a guard that was never going to run is denying on nobody's
    // behalf.
    expect(call({
      packs: [pack({ enabled: ["block-refunds"] })],
      registered: new Map([["acme/finance", new Set(["block-refunds"])]]),
    })).toEqual([]);
  });

  it("ignores policies the user explicitly disabled", () => {
    expect(call({
      packs: [pack()],
      registered: new Map([["acme/finance", new Set(["block-refunds"])]]),
      disabled: new Set(["pack:acme/finance@1.2.0:require-note"]),
    })).toEqual([]);
  });

  it("ignores a pack the loader was never given", () => {
    // Absent from the map means it never reached the loader — inferring failure
    // from "no registrations" cannot tell an import error apart from a pause
    // skip or a pack that legitimately registers nothing, and a heuristic that
    // DENIES is worse than one that allows.
    expect(call({ packs: [pack()] })).toEqual([]);
  });

  it("treats a load timeout as transient, not permanent", () => {
    // A machine-wide deny from one slow disk moment persists until a human
    // intervenes — and in the warm worker the denials themselves add load.
    expect(PERMANENT_LOAD_FAILURES.has("load_timeout")).toBe(false);
    for (const c of ["module_not_found", "syntax_error", "runtime_error", "path_missing"]) {
      expect(PERMANENT_LOAD_FAILURES.has(c), c).toBe(true);
    }
    expect(call({
      packs: [pack()],
      failed: new Map([["acme/finance", { type: "load_timeout", reason: "slow disk" }]]),
    })).toEqual([]);
  });
});

describe("how narrow the deny is", () => {
  it("matches only the events and tools the missing guards declared", () => {
    const guards = call({
      packs: [pack({ policies: [policy("block-refunds"), policy("require-note")] })],
      registered: new Map([["acme/finance", new Set(["block-refunds"])]]),
    });
    expect(guards[0].match).toEqual({ events: ["PreToolUse"], toolNames: ["Bash"] });
  });

  it("KEEPS UserPromptSubmit in the match so the caller can instruct there", () => {
    // Stripping it here made the instruct branch unreachable and the user got no
    // signal at all. The matcher says WHERE the guards applied; the caller
    // decides how to answer — and there, the answer must never be a deny.
    const guards = call({
      packs: [pack({ policies: [policy("p", { events: ["PreToolUse", "UserPromptSubmit"] })] })],
      registered: new Map([["acme/finance", new Set()]]),
    });
    expect(guards[0].match.events).toContain("UserPromptSubmit");
  });

  it("widens to everything when a policy declared no scope", () => {
    const guards = call({
      packs: [pack({ policies: [policy("p", {})] })],
      registered: new Map([["acme/finance", new Set()]]),
    });
    expect(guards[0].match).toEqual({});
  });
});

describe("the message", () => {
  it("names the pack, the missing policies, and the human command", () => {
    // Recovery is a human terminal action: the agent cannot run it, because
    // block-failproofai-commands denies every failproofai invocation from a tool
    // call, deliberately.
    const reason = packFailureReason(call({
      errors: [{ id: "acme/finance", reason: "bad digest", effect: "enforce", declared: [policy("block-refunds")] }],
    }));
    expect(reason).toContain("acme/finance");
    expect(reason).toContain("block-refunds");
    expect(reason).toContain("failproofai policies");
    expect(reason).toContain("agent cannot run");
  });
});
