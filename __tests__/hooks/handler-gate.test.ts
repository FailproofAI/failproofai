/**
 * The daemon gate, tested against a real filesystem.
 *
 * This exists because the previous guard was a source grep. It asserted that
 * `handler.ts` contained the string `hasCustomPolicies` and matched a ternary —
 * which is true of a gate that covers everything and equally true of one that
 * covers nothing. It was green while this bug was live:
 *
 *   a project with `.failproofai/policies/zz-policies.mjs` denying a command
 *     FAILPROOFAI_DAEMON_MODE unset   -> deny   (the convention policy fired)
 *     FAILPROOFAI_DAEMON_MODE=enforce -> allow  (silently dropped)
 *
 * The gate read `customPoliciesPaths` and `customPoliciesPath` only. Convention
 * policies are discovered from the filesystem and appear in neither key, so the
 * gate saw nothing and let the daemon answer with the builtins alone. The
 * `needs_user_context` safety net could not fire either: the sealed worker
 * partitions the `enabled_policies` list it was handed, and a convention policy
 * is never in that list because it self-registers at load.
 *
 * So the assertions below are about *behaviour on disk*, not about the shape of
 * the source. A grep cannot see a directory.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { hasConventionPolicyFiles } from "../../src/hooks/handler-gate";

const SCRATCH = resolve(__dirname, "..", "..", "target", "handler-gate-test");

/** A project root with a `.failproofai/` marker, as `findProjectConfigDir` expects. */
function makeProject(name: string): string {
  const root = resolve(SCRATCH, name);
  mkdirSync(resolve(root, ".failproofai"), { recursive: true });
  return root;
}

function writePolicyFile(root: string, filename: string): void {
  const dir = resolve(root, ".failproofai", "policies");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    resolve(dir, filename),
    "import { customPolicies, deny } from 'failproofai';\n" +
      "customPolicies.add({ name: 'x', description: '', match: { events: ['PreToolUse'] },\n" +
      "  fn: async () => deny('no') });\n",
    "utf8",
  );
}

beforeEach(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
});

afterEach(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

describe("hasConventionPolicyFiles", () => {
  it("finds a project convention policy file", () => {
    const root = makeProject("with-policy");
    writePolicyFile(root, "team-policies.mjs");
    expect(hasConventionPolicyFiles(root)).toBe(true);
  });

  it("returns false for a project with no policies directory at all", () => {
    // The common case, and the one that must stay cheap and quiet.
    expect(hasConventionPolicyFiles(makeProject("bare"))).toBe(false);
  });

  it("returns false when the policies directory exists but is empty", () => {
    const root = makeProject("empty-dir");
    mkdirSync(resolve(root, ".failproofai", "policies"), { recursive: true });
    expect(hasConventionPolicyFiles(root)).toBe(false);
  });

  it("ignores a file that does not match the convention suffix", () => {
    // The convention is `*policies.{js,mjs,ts}`. A README or a helper module in
    // that directory is not a policy file, and treating it as one would send
    // every event down the legacy path for no reason.
    const root = makeProject("non-policy");
    const dir = resolve(root, ".failproofai", "policies");
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "README.md"), "notes\n", "utf8");
    writeFileSync(resolve(dir, "helpers.mjs"), "export const x = 1;\n", "utf8");
    expect(hasConventionPolicyFiles(root)).toBe(false);
  });

  it("accepts every spelling the convention allows", () => {
    for (const [i, name] of ["a-policies.js", "b-policies.mjs", "c-policies.ts"].entries()) {
      const root = makeProject(`spelling-${i}`);
      writePolicyFile(root, name);
      expect(hasConventionPolicyFiles(root), `${name} should count`).toBe(true);
    }
  });

  it("finds a policy file in a parent project root, not just the exact cwd", () => {
    // `findProjectConfigDir` walks upward, so an agent that has `cd`-ed into a
    // subdirectory must still be governed by the project's policies. A gate
    // that only looked at the literal cwd would let the daemon answer from any
    // subdirectory.
    const root = makeProject("nested");
    writePolicyFile(root, "team-policies.mjs");
    const deep = resolve(root, "src", "a", "b");
    mkdirSync(deep, { recursive: true });
    expect(hasConventionPolicyFiles(deep)).toBe(true);
  });

  it("does not throw on a cwd that does not exist", () => {
    // The gate runs before anything has validated the session's cwd. Throwing
    // here would take down the hook rather than the daemon path.
    expect(() => hasConventionPolicyFiles(resolve(SCRATCH, "no-such-dir"))).not.toThrow();
  });

  it("does not throw on an undefined cwd", () => {
    expect(() => hasConventionPolicyFiles(undefined)).not.toThrow();
  });
});
