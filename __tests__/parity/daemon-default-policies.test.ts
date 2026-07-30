/**
 * The daemon's default policy set must equal the TypeScript one.
 *
 * `crates/failproofaid/src/server.rs` hardcodes `DEFAULT_SEALED_POLICIES` — the
 * set the daemon enables in Stage 1. It is hardcoded deliberately: reading the
 * user's `policies-config.json` would make the sealed tier's enabled set come
 * from a user-writable file, so an agent could delete `block-sudo` from a JSON
 * array and the unforgeable verdict would simply never run. That is the exact
 * hole the plan's third settled decision (root-owned `machine.json`) exists to
 * close, and until it lands the safe placeholder is a compiled-in list.
 *
 * But a compiled-in list is a second copy, and a second copy drifts. The drift
 * would be invisible in the worst way: the cross-implementation test
 * (`__tests__/e2e/daemon/cross-implementation.e2e.test.ts`) feeds *the same*
 * policy list to both the daemon and the legacy evaluator, so it compares
 * encoders, not enabled sets. If someone adds a default-enabled builtin in
 * TypeScript and does not touch `server.rs`, every existing test still passes
 * and the daemon quietly enforces one policy fewer than the legacy path — which
 * is a silent allow, on the exact upgrade path this project exists to protect.
 *
 * So: assert it here, by reading the Rust source. Same tripwire philosophy as
 * `__tests__/hooks/dogfood-configs.test.ts`, which reads the committed hook
 * configs rather than trusting that they were regenerated.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { BUILTIN_POLICIES } from "../../src/hooks/builtin-policies";
import { PAYLOAD_ONLY_POLICIES } from "../../src/hooks/builtin/payload-only";

const SERVER_RS = resolvePath(__dirname, "..", "..", "crates/failproofaid/src/server.rs");

/**
 * Pull the string literals out of the `DEFAULT_SEALED_POLICIES` slice.
 *
 * Parsed rather than imported because there is no way to import a Rust `const`
 * from vitest, and shelling out to `cargo` for one list would make this suite
 * depend on a Rust toolchain being installed. The parse is narrow — it anchors
 * on the exact declaration and stops at the closing bracket — so a
 * restructuring that breaks it fails loudly rather than matching nothing.
 */
function parseDefaultSealedPolicies(source: string): string[] {
  const marker = "const DEFAULT_SEALED_POLICIES: &[&str] = &[";
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error(
      `could not find '${marker}' in server.rs. If the declaration was renamed or ` +
        `restructured, update this test — do not delete it.`,
    );
  }
  const end = source.indexOf("];", start);
  if (end === -1) throw new Error("DEFAULT_SEALED_POLICIES is not terminated by '];'");

  const body = source.slice(start + marker.length, end);
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("daemon default policy set", () => {
  // Skipped rather than failed when the crate is absent, so a checkout without
  // the Rust tree (or a future move of the file) is a visible skip and not a
  // red suite for the wrong reason.
  const available = existsSync(SERVER_RS);

  it("server.rs exists (otherwise everything below is vacuous)", () => {
    expect(available, `${SERVER_RS} is missing`).toBe(true);
  });

  it("matches the TypeScript default-enabled builtins, in the same order", () => {
    if (!available) return;
    const fromRust = parseDefaultSealedPolicies(readFileSync(SERVER_RS, "utf8"));
    const fromTypeScript = BUILTIN_POLICIES.filter((p) => p.defaultEnabled).map((p) => p.name);

    // Order matters as well as membership: evaluation is ordered, and a deny
    // short-circuits, so `policyName` on a payload matching two policies
    // depends on which one is registered first.
    expect(fromRust).toEqual(fromTypeScript);
  });

  it("parses a non-empty list (guards against the regex matching nothing)", () => {
    if (!available) return;
    expect(parseDefaultSealedPolicies(readFileSync(SERVER_RS, "utf8")).length).toBeGreaterThan(0);
  });

  it("enables only policies the sealed tier can actually run", () => {
    if (!available) return;
    // A host-access policy in this list would be routed straight back out as
    // `needs_user_context` on every single event, which the Stage-1 client
    // treats as "fall back to legacy" — so the daemon would silently never
    // answer anything.
    const fromRust = parseDefaultSealedPolicies(readFileSync(SERVER_RS, "utf8"));
    const sealedEligible = new Set(PAYLOAD_ONLY_POLICIES.map((p) => p.name));
    const notEligible = fromRust.filter((name) => !sealedEligible.has(name));
    expect(notEligible).toEqual([]);
  });

  it("names only policies that exist", () => {
    if (!available) return;
    const known = new Set(BUILTIN_POLICIES.map((p) => p.name));
    const unknown = parseDefaultSealedPolicies(readFileSync(SERVER_RS, "utf8")).filter(
      (name) => !known.has(name),
    );
    expect(unknown).toEqual([]);
  });
});
