// @vitest-environment node
/**
 * `writeHookEntries` reaches for its container with `??=`, which accepts
 * whatever is already there. When a vendor changes the container TYPE that is
 * silently catastrophic — and, worse, permanent: copilot's
 * `settings.hooks ??= {}` keeps a pre-existing ARRAY, the following
 * `hooks["PreToolUse"] = …` sets a non-index property, `JSON.stringify` drops
 * it, and INSTALLING AGAIN does exactly the same thing. A user whose vendor
 * changed format could reinstall forever, stay completely unenforced, and see
 * every command report success.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getIntegration, resetMistypedContainers } from "../../src/hooks/integrations";
import { INTEGRATION_TYPES } from "../../src/hooks/types";

const BINARY = "/usr/bin/failproofai";
let sandbox: string;
let prevCwd: string;
let prevHome: string | undefined;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "fpai-coerce-"));
  prevCwd = process.cwd();
  prevHome = process.env.HOME;
  // OpenCode derives its generated shim path from cwd/HOME, so both must point
  // somewhere disposable or probing it writes into the real repo.
  process.chdir(sandbox);
  process.env.HOME = sandbox;
});

afterEach(() => {
  process.chdir(prevCwd);
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  rmSync(sandbox, { recursive: true, force: true });
});

describe("resetMistypedContainers", () => {
  it("recovers a copilot config stuck in the pre-1.0.71 array shape", () => {
    const copilot = getIntegration("copilot");
    const settings: Record<string, unknown> = {
      version: 1,
      hooks: [
        {
          event: "PreToolUse",
          type: "command",
          bash: "npx -y failproofai --hook PreToolUse --cli copilot",
          __failproofai_hook__: true,
        },
      ],
    };

    // The templated writer now recovers this on its own — it coerces a
    // wrongly-typed container instead of accepting it, so the catastrophic
    // version of this bug cannot happen for the eight CLIs it drives.
    //
    // It used to be able to: `settings.hooks ??= {}` KEPT the array, the
    // following `hooks["PreToolUse"] = …` set a non-index property,
    // `JSON.stringify` dropped it, and the file written back was byte-identical
    // to the broken one — so a user could reinstall forever, stay completely
    // unenforced, and see success reported every time.
    const written = structuredClone(settings);
    copilot.writeHookEntries(written, BINARY, "project");
    const roundTripped = JSON.parse(JSON.stringify(written)) as { hooks: Record<string, unknown> };
    expect(Array.isArray(roundTripped.hooks)).toBe(false);
    expect(Object.keys(roundTripped.hooks).length).toBeGreaterThan(0);

    // And the helper still reports it, which is what covers the integrations
    // the template engine does not drive.
    expect(resetMistypedContainers(copilot, structuredClone(settings), BINARY, "project")).toEqual([
      "hooks",
    ]);
  });

  it("leaves a correctly-typed container alone", () => {
    const copilot = getIntegration("copilot");
    const settings: Record<string, unknown> = {};
    copilot.writeHookEntries(settings, BINARY, "project");
    expect(resetMistypedContainers(copilot, settings, BINARY, "project")).toEqual([]);
  });

  it("never touches keys the writer does not own", () => {
    const claude = getIntegration("claude");
    const settings: Record<string, unknown> = {
      permissions: { allow: ["WebSearch"] },
      model: "opus",
      // A user's own list that happens to be an array — not ours, not in scope.
      somebodyElsesArray: [1, 2, 3],
      hooks: ["wrong shape"],
    };
    const reset = resetMistypedContainers(claude, settings, BINARY, "project");
    expect(reset).toEqual(["hooks"]);
    expect(settings.permissions).toEqual({ allow: ["WebSearch"] });
    expect(settings.model).toBe("opus");
    expect(settings.somebodyElsesArray).toEqual([1, 2, 3]);
  });

  it("is a no-op for every integration on a config it just wrote", () => {
    // The invariant that keeps this safe to run on every install: a healthy
    // config is never "reset", so the only files it can touch are ones already
    // in a shape their vendor rejects.
    for (const cli of INTEGRATION_TYPES) {
      let integration: ReturnType<typeof getIntegration>;
      try {
        integration = getIntegration(cli);
      } catch {
        continue;
      }
      const scope = integration.scopes.includes("project") ? "project" : integration.scopes[0];
      const settings: Record<string, unknown> = {};
      try {
        integration.writeHookEntries(settings, BINARY, scope);
      } catch {
        continue;
      }
      expect({ cli, reset: resetMistypedContainers(integration, settings, BINARY, scope) }).toEqual({
        cli,
        reset: [],
      });
    }
  });

  it("returns nothing rather than guessing when the writer will not probe", () => {
    const broken = {
      ...getIntegration("claude"),
      writeHookEntries: () => {
        throw new Error("cannot run against an empty object");
      },
    } as ReturnType<typeof getIntegration>;
    const settings: Record<string, unknown> = { hooks: ["wrong shape"] };
    expect(resetMistypedContainers(broken, settings, BINARY, "project")).toEqual([]);
    expect(settings.hooks).toEqual(["wrong shape"]);
  });
});
