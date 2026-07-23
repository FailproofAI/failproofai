/**
 * Tripwire for the beta-channel plumbing.
 *
 * Two lists have to agree or the pre-release leg silently stops meaning anything:
 *   - install-clis.sh declares a beta install command per CLI (5th arg to `probe`)
 *   - run.sh hardcodes which CLIs the beta leg probes
 *
 * If run.sh lists a CLI that install-clis.sh has no beta ref for, the leg probes a
 * STABLE binary and reports it as pre-release coverage — a false all-clear, the
 * worst possible failure for an early-warning system. If install-clis.sh gains a
 * beta ref that run.sh doesn't list, we pay to install it and never probe it.
 *
 * These are shell files with no importable surface, so the test parses them. That
 * is deliberate: the alternative is a third copy of the list to drift against.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SUITE = path.join(__dirname, "../../integration-suite");
const installSh = readFileSync(path.join(SUITE, "install-clis.sh"), "utf8");
const runSh = readFileSync(path.join(SUITE, "run.sh"), "utf8");

/** CLIs whose `probe` line supplies a 5th argument (the beta install command). */
function cliesWithBetaRef(): string[] {
  const out: string[] = [];
  // `probe` invocations may span lines via trailing backslashes — join them first.
  const joined = installSh.replace(/\\\n\s*/g, " ");
  for (const line of joined.split("\n")) {
    const m = /^probe\s+(\S+)\s+\S+\s+"[^"]*"\s+(.*)$/.exec(line.trim());
    if (!m) continue;
    // Count single-quoted command arguments: 1 = stable only, 2 = stable + beta.
    const cmds = m[2].match(/'(?:[^']|'\\'')*'/g) || [];
    if (cmds.length >= 2) out.push(m[1]);
  }
  return out.sort();
}

/** The beta-leg CLI list from run.sh. Doubles as the report's coverage denominator. */
function betaLegClis(): string[] {
  const m = /^BETA_CLIS=\(([^)]*)\)/m.exec(runSh);
  if (!m) throw new Error("BETA_CLIS not found in run.sh — was it renamed?");
  return m[1].trim().split(/\s+/).sort();
}

describe("beta channel refs", () => {
  it("finds beta refs in install-clis.sh", () => {
    expect(cliesWithBetaRef().length).toBeGreaterThan(0);
  });

  it("run.sh's beta leg probes exactly the CLIs that have a beta ref", () => {
    expect(betaLegClis()).toEqual(cliesWithBetaRef());
  });

  it("covers the CLIs whose pre-release channels were verified live", () => {
    // Verified 2026-07-23 against each vendor's registry/CDN. A CLI leaving this
    // list means a vendor withdrew a channel — deliberate, but worth a failing
    // test so it is a decision rather than an accident.
    expect(cliesWithBetaRef()).toEqual(["claude", "codex", "copilot", "cursor", "goose", "openclaw"]);
  });

  it("does not probe CLIs that publish no pre-release ref", () => {
    // opencode's beta/dev tags are ~31 branch snapshots a day, not release
    // candidates; the rest have nothing at all. Probing any of them on the beta
    // leg would install a stable build and report it as pre-release coverage.
    for (const cli of ["opencode", "pi", "factory", "devin", "antigravity", "hermes"]) {
      expect(cliesWithBetaRef()).not.toContain(cli);
    }
  });

  it("pins claude's stable leg to the `stable` channel, not latest", () => {
    // claude is the inverted case: `latest` is the bleeding edge and ships ~daily,
    // so an unpinned stable leg lets a same-day vendor release red-light an
    // unrelated PR. The beta leg is what tracks `latest`.
    expect(installSh).toMatch(/probe\s+claude[\s\S]{0,200}?install\.sh \| bash -s stable/);
  });

  it("keeps the beta leg advisory — it must never fail the job", () => {
    expect(runSh).toMatch(/if \[ "\$CHANNEL" != stable \]; then[\s\S]{0,300}?exit 0/);
  });

  it("passes the eligible count to report.js so coverage stays honest on targeted runs", () => {
    // Without this the beta report says "the rest publish no pre-release ref"
    // about CLIs that were merely not requested — overstating coverage, which is
    // the one thing an early-warning report must never do.
    expect(runSh).toMatch(/report\.js"[^\n]*"\$\{#BETA_CLIS\[@\]\}"/);
  });

  it("does not use a falsy-true-branch ternary for CANARY_PEER_STATE", () => {
    // GitHub Actions has no ternary: `cond && '' || fallback` short-circuits to
    // the fallback because '' is falsy, so the stable leg would get a peer path
    // pointing at its own state. Operands must be flipped instead.
    const wf = readFileSync(path.join(__dirname, "../../.github/workflows/integration-suite.yml"), "utf8");
    const line = wf.split("\n").find((l) => l.includes("CANARY_PEER_STATE:")) || "";
    expect(line).not.toMatch(/==\s*'stable'\s*&&\s*''/);
    expect(line).toMatch(/!=\s*'stable'\s*&&\s*format\(/);
  });
});
