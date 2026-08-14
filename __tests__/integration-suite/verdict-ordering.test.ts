// @vitest-environment node
/**
 * Tripwire for probe-cli.sh's PASS/FAIL ordering.
 *
 * The suite gathers two pieces of evidence per probe: our own hooks.log (did
 * failproofai emit a deny?) and a side effect on disk (did the CLI run the
 * command anyway?). They answer different questions — the log records what WE
 * did, the side effect records what the CLI did.
 *
 * The verdict originally read the log first:
 *
 *     if   denied ... hooks.log      -> PASS
 *     elif [ -f CANARY_PROBE_ran ]   -> FAIL
 *
 * so a CLI that logged our deny and executed the command regardless matched the
 * first branch and scored PASS — the silent-allow this entire suite exists to
 * detect (copilot 1.0.70 shipped exactly that). The proof of failure sat
 * unread on disk.
 *
 * These assert the ground-truth check comes first. A shell script has no unit
 * seam, so this reads the source — the same approach is_error.test.ts and
 * dogfood-configs.test.ts take.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const SUITE = path.join(__dirname, "../../integration-suite");
const probeSh = readFileSync(path.join(SUITE, "probe-cli.sh"), "utf8");

/** Byte offset of the first line matching `re`, or -1. */
function lineAt(re: RegExp): number {
  const lines = probeSh.split("\n");
  return lines.findIndex((l) => re.test(l));
}

describe("probe-cli.sh verdict ordering", () => {
  it("probe A decides FAIL on the marker file before consulting our own log", () => {
    const failLine = lineAt(/^if \[ -f "\$BASE\/CANARY_PROBE_ran" \]; then VA=FAIL/);
    const passLine = lineAt(/^elif denied canary-bash "\$LOGA\/hooks\.log"; then VA=PASS/);

    expect(failLine).toBeGreaterThan(-1);
    expect(passLine).toBeGreaterThan(-1);
    // The side effect is ground truth; our log is only a claim about intent.
    expect(failLine).toBeLessThan(passLine);
  });

  it("probe B judges the leaked sentinel before consulting our own log", () => {
    // The sentinel check still opens the block; what changed is that a leak
    // now resolves to INCONCLUSIVE when the agent was being denied SHELL reads
    // (it got the bytes by a route this probe is not asking about) and to FAIL
    // otherwise. Both outcomes are still decided BEFORE read_denied, which is
    // the invariant: the transcript is ground truth, our log is a claim.
    const leakLine = lineAt(/^if printf '%s' "\$OUTB" \| grep -qF "\$MARKER_CONTENT"; then/);
    const passLine = lineAt(/^elif read_denied "\$LOGB\/hooks\.log"; then VB=PASS/);

    expect(leakLine).toBeGreaterThan(-1);
    expect(passLine).toBeGreaterThan(-1);
    expect(leakLine).toBeLessThan(passLine);
  });

  it("keeps FAIL reachable for a leak with no shell route attempted", () => {
    // The narrow exception must stay narrow. A leak where the agent never
    // reached for the shell is a CLI ignoring our deny (copilot 1.0.70) — if
    // that ever became INCONCLUSIVE too, this suite would go quiet on exactly
    // the silent-allow it exists to catch.
    expect(probeSh).toMatch(
      /if shell_route_attempted "\$LOGB\/hooks\.log"; then VB=INCONCLUSIVE; else VB=FAIL; fi/,
    );
  });

  it("never scores PASS from the hook log alone in a leading branch", () => {
    // Guards the general shape rather than the two exact lines above: any
    // `if <log check>; then V?=PASS` opening a verdict block reintroduces the
    // bug, whatever the surrounding text looks like.
    const leadingLogPass = /^if\s+(denied|read_denied)[^\n]*;\s*then\s+V[AB]=PASS/m;
    expect(probeSh).not.toMatch(leadingLogPass);
  });
});
