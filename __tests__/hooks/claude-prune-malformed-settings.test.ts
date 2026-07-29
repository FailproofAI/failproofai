/**
 * `claudeCode.writeHookEntries` prunes our own stale entries from events we no
 * longer install. That loop walks EVERY key in `settings.hooks`, including keys
 * failproofai never wrote — a newer Claude event, another tool's entry, a typo —
 * so their values are unvalidated input.
 *
 * A non-array value there used to throw (`{} is not iterable`), and the throw
 * propagates out of `installHooks` AFTER the selected policies have already been
 * written to policies-config.json. The user is told their policies are enabled
 * while settings.json received no hook at all: silent non-enforcement, the exact
 * failure mode the pruning was added to fix.
 *
 * Foreign entries must also survive the pass intact — pruning is for our own
 * marked hooks, not a cleanup of the user's file.
 */
import { describe, it, expect } from "vitest";
import { claudeCode } from "../../src/hooks/integrations";
import { FAILPROOFAI_HOOK_MARKER } from "../../src/hooks/types";

type Settings = Record<string, unknown>;

const ourHook = (event: string) => ({
  type: "command",
  command: `npx -y failproofai --hook ${event}`,
  timeout: 60,
  [FAILPROOFAI_HOOK_MARKER]: true,
});

function countOurHooks(settings: Settings): number {
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  let n = 0;
  for (const v of Object.values(hooks)) {
    if (!Array.isArray(v)) continue;
    for (const m of v) {
      if (!m || !Array.isArray((m as { hooks?: unknown[] }).hooks)) continue;
      n += (m as { hooks: Record<string, unknown>[] }).hooks.filter(
        (h) => h?.[FAILPROOFAI_HOOK_MARKER] === true,
      ).length;
    }
  }
  return n;
}

describe("claudeCode.writeHookEntries with hand-edited settings", () => {
  it("does not throw on a non-array value under a key we never manage", () => {
    const settings: Settings = {
      hooks: {
        SomeToolsOwnKey: { not: "an array" },
        AnotherKey: "oops",
        PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "THEIRS" }] }],
      },
    };

    expect(() => claudeCode.writeHookEntries(settings, "npx -y failproofai", "project")).not.toThrow();
    expect(countOurHooks(settings)).toBeGreaterThan(0);
  });

  it("leaves malformed and foreign entries exactly as found", () => {
    const settings: Settings = {
      hooks: {
        SomeToolsOwnKey: { not: "an array" },
        NoHooksKey: [{ matcher: "*" }],
        ForeignEvent: [{ hooks: [{ type: "command", command: "THIRD-PARTY-ONLY" }] }],
      },
    };

    claudeCode.writeHookEntries(settings, "npx -y failproofai", "project");

    const hooks = settings.hooks as Record<string, unknown>;
    expect(hooks.SomeToolsOwnKey).toEqual({ not: "an array" });
    expect(hooks.NoHooksKey).toEqual([{ matcher: "*" }]);
    expect(hooks.ForeignEvent).toEqual([
      { hooks: [{ type: "command", command: "THIRD-PARTY-ONLY" }] },
    ]);
  });

  it("still prunes our own stale entry, keeping a co-located foreign hook", () => {
    const settings: Settings = {
      hooks: {
        // WorktreeCreate is deliberately not installed any more.
        WorktreeCreate: [
          { hooks: [ourHook("WorktreeCreate"), { type: "command", command: "THEIRS" }] },
        ],
        StaleFailproofaiOnly: [{ hooks: [ourHook("StaleFailproofaiOnly")] }],
      },
    };

    claudeCode.writeHookEntries(settings, "npx -y failproofai", "project");

    const hooks = settings.hooks as Record<string, unknown>;
    expect(hooks.WorktreeCreate).toEqual([
      { hooks: [{ type: "command", command: "THEIRS" }] },
    ]);
    // Nothing left but ours -> the key goes away entirely.
    expect("StaleFailproofaiOnly" in hooks).toBe(false);
  });
});
