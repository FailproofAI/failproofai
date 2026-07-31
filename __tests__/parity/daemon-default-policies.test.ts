/**
 * The daemon must never enforce a policy set the user did not configure.
 *
 * This started as a drift tripwire over a `DEFAULT_SEALED_POLICIES` constant
 * hardcoded in `crates/failproofaid/src/server.rs`. That constant is gone, and
 * this file now asserts the property that made it necessary — which is the
 * better outcome: the duplication was removed rather than tested.
 *
 * ## The defect this exists to prevent
 *
 * The daemon used to supply its own enabled set (the 11 `defaultEnabled`
 * builtins) and evaluate that, ignoring what the client had resolved from the
 * user's merged configuration. Reproduced against this repo's own
 * `.failproofai/policies-config.json`, which enables 30 policies:
 *
 * ```
 * rm -rf /          daemon: allow   legacy: deny (failproofai/block-rm-rf)
 * cat /etc/passwd   daemon: allow   legacy: deny (failproofai/block-read-outside-cwd)
 * ```
 *
 * 19 of 30 enabled builtins, plus 100% of custom and convention policies,
 * stopped enforcing the moment the daemon answered. The documented safety net
 * could not fire: the sealed worker computes `needsUserContext` by partitioning
 * the list *it was handed*, and a daemon-supplied list is all-sealed by
 * construction, so it was always empty and the client never fell back.
 *
 * ## What is asserted now
 *
 * Three independent things, because the fix has three moving parts and any one
 * of them regressing restores the silent drop:
 *
 * 1. The Rust side no longer carries its own policy list at all.
 * 2. The client sends its resolved set, and refuses to call the daemon with an
 *    empty one — a caller that forgot would otherwise get a confident `allow`
 *    built from evaluating nothing.
 * 3. The handler skips the daemon outright when custom policies are configured,
 *    since those can never be sealed-eligible.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { BUILTIN_POLICIES } from "../../src/hooks/builtin-policies";
import { PAYLOAD_ONLY_POLICIES } from "../../src/hooks/builtin/payload-only";

const REPO_ROOT = resolvePath(__dirname, "..", "..");
const SERVER_RS = resolvePath(REPO_ROOT, "crates/failproofaid/src/server.rs");
const DAEMON_CLIENT = resolvePath(REPO_ROOT, "src/hooks/daemon-client.ts");
const HANDLER = resolvePath(REPO_ROOT, "src/hooks/handler.ts");

describe("the daemon evaluates the client's policy set, not its own", () => {
  const available = existsSync(SERVER_RS);

  it("server.rs exists (otherwise everything below is vacuous)", () => {
    expect(available, `${SERVER_RS} is missing`).toBe(true);
  });

  it("the daemon carries no policy list of its own", () => {
    if (!available) return;
    const source = readFileSync(SERVER_RS, "utf8");
    // A reintroduced hardcoded list is the exact regression. If one is ever
    // genuinely needed, it must come from generated data with a drift gate —
    // not from a literal that silently diverges from `BUILTIN_POLICIES`.
    expect(source).not.toMatch(/DEFAULT_SEALED_POLICIES/);
    expect(source).toContain('"config": { "enabledPolicies": hook.enabled_policies }');
  });

  it("the daemon refuses a request that carries no enabled policies", () => {
    if (!available) return;
    // Backfilling defaults here would re-create the defect in one line, and
    // treating it as "enforce nothing" would turn a client bug into a silent
    // allow. Refusal is the only safe reading.
    expect(readFileSync(SERVER_RS, "utf8")).toContain("hook.enabled_policies.is_empty()");
  });

  it("the client sends its resolved set and will not call the daemon without one", () => {
    const source = readFileSync(DAEMON_CLIENT, "utf8");
    expect(source).toContain("enabled_policies: [...enabledPolicies]");
    expect(source).toContain("if (enabledPolicies.length === 0) return null;");
  });

  it("the handler reads config before the daemon call, not after", () => {
    // Ordering is the fix. If `readMergedHooksConfig` moves back below
    // `tryDaemonEvaluate`, the client has nothing to send and the daemon is
    // back to inventing a set.
    const source = readFileSync(HANDLER, "utf8");
    const configAt = source.indexOf("readMergedHooksConfig(session.cwd)");
    const daemonAt = source.indexOf("tryDaemonEvaluate(");
    expect(configAt).toBeGreaterThan(-1);
    expect(daemonAt).toBeGreaterThan(-1);
    expect(configAt).toBeLessThan(daemonAt);
  });

  it("the handler consults the gate before deciding the daemon can answer", () => {
    // Deliberately NOT a grep for the gate's variable names. The previous
    // version of this test asserted `source.toContain("hasCustomPolicies")`
    // and a regex on the ternary — which told us a symbol existed and nothing
    // about what it covered. It passed while the gate checked configuration
    // keys only, so a convention policy in `.failproofai/policies/` silently
    // stopped enforcing the moment the daemon answered. The file's own header
    // says it exists to prevent exactly that.
    //
    // The behavioural coverage lives in `handler-gate.test.ts`, which drives
    // the real filesystem. What is left here is the structural half that a
    // behavioural test cannot see: that the handler asks the gate at all.
    const source = readFileSync(HANDLER, "utf8");
    expect(source).toContain("hasConventionPolicyFiles(session.cwd)");
    expect(source).toMatch(/daemonCanAnswer\s*$|daemonCanAnswer\s*\n?\s*\?/m);
  });

  it("the gate covers every policy source the sealed tier cannot run", () => {
    // The three that must send an event down the legacy path, each learned the
    // hard way:
    //   • explicit custom policy files  — never sealed-eligible
    //   • convention policy files       — invisible to any config-key check
    //   • policyParams                  — not on the wire, so the daemon would
    //                                     evaluate with schema defaults and
    //                                     both under- and over-block
    const source = readFileSync(HANDLER, "utf8");
    for (const clause of ["explicitCustomPolicies", "conventionPolicies", "hasPolicyParams"]) {
      expect(source, `the daemon gate no longer accounts for ${clause}`).toContain(clause);
    }
    expect(source).toMatch(
      /daemonCanAnswer\s*=\s*!explicitCustomPolicies\s*&&\s*!conventionPolicies\s*&&\s*!hasPolicyParams/,
    );
  });
});

describe("sealed eligibility is still a strict subset", () => {
  it("every default-enabled builtin the sealed tier claims is genuinely payload-only", () => {
    // Not a statement about the daemon's list (there isn't one) but about the
    // tier itself: if a host-access policy ever became default-enabled AND
    // sealed-eligible, the sealed worker would try to spawn `git`.
    const sealed = new Set(PAYLOAD_ONLY_POLICIES.map((p) => p.name));
    const defaultEnabled = BUILTIN_POLICIES.filter((p) => p.defaultEnabled).map((p) => p.name);

    // Every default-enabled policy is currently payload-only; if that changes,
    // the daemon will correctly report it in `needs_user_context` and the
    // client will fall back — so this is documentation of today's state, not a
    // requirement. Asserted so the change is deliberate.
    const hostAccessDefaults = defaultEnabled.filter((n) => !sealed.has(n));
    expect(hostAccessDefaults).toEqual([]);
  });

  it("names a non-empty sealed set (guards against a vacuous subset check)", () => {
    expect(PAYLOAD_ONLY_POLICIES.length).toBe(32);
  });
});
