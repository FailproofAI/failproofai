// @vitest-environment node
/**
 * The linearity floor under `redactSecrets`, at a size no rule may treat as
 * the square of anything.
 *
 * Its own file on purpose: half a megabyte per shape allocates enough to
 * perturb the millisecond budgets in `redaction.test.ts`, which measure single
 * rules at 2-100 KB. Vitest gives each file its own worker, so the two do not
 * disturb each other.
 */
import { describe, expect, it } from "vitest";
import { redactSecrets } from "../../../src/hooks/semantic/redact";

/**
 * Every shape that made a rule do more than linear work, or that exercises one
 * of the scans this file exists to bound.
 */
const SHAPES = [
  // The two name-and-value scans, over a run with no delimiter in it.
  "key=a",
  "a=key=",
  "key:a",
  'key="a',
  "--token a ",
  // The credential header, its separator rule and its continuation walk.
  "cookie:a;",
  "authorization: a ",
  "authorization:\n  a\n",
  // The credential-flag scan, with and without a gating command in front.
  "sshpass -p a ",
  "curl -u a:b ",
  // JSON-escaped input, the shape every nested tool argument arrives in.
  "\\nkey=a",
  // The quote-delimiter walk: a run of backslashes in front of every quote is
  // what a payload JSON-encoded two or three times looks like, and the walk
  // that reads it must charge each run to its own characters.
  '\\\\\\"a --password \\\\\\"b',
  'x --password "a',
  "--password '",
  "-p ",
  '{"Authorization": "Bearer x"}, ',
  // The generic `sk-` entry hops over leading segments to reach the random
  // part of a key; the hop is bounded so a run of tiny segments cannot make
  // it quadratic.
  "sk-a-b-c-d-e-f-g-h-i-j-",
  "sk-aB1-",
];

const SMALL = 64 * 1024;
const LARGE = 512 * 1024;

/** `unit` repeated to exactly `chars` characters. */
const fixture = (unit: string, chars: number): string => unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);

/**
 * The best of `passes` runs. A cold worker's first pass through a rule pays
 * for its JIT, which is not the cost these budgets are about — so the small
 * tier runs twice, and by the time the large one runs everything is warm and
 * one pass is enough. (Two passes of half a megabyte each is a second of CPU
 * this suite spends on nothing, and it lands on every other file's timing
 * budget when vitest runs them side by side.)
 */
function fastest(s: string, passes: number): number {
  let best = Infinity;
  for (let pass = 0; pass < passes; pass++) {
    const t0 = performance.now();
    redactSecrets(s);
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

describe("cost at half a megabyte", () => {
  it("stays linear on every adversarial shape", () => {
    // Three assertions per shape, and the SMALL one comes first for every
    // shape: a quadratic rule is synchronous, so at half a megabyte it does
    // not fail a budget — it blocks the worker for minutes and vitest cannot
    // even time it out. At 64 KB the same defect costs half a second, fails in
    // seconds, and names the shape that did it.
    //
    // The rule that made this file necessary is the assignment scan: it
    // matched the VALUE, and an unquoted value may hold `=`, so on
    // `a=key=a=key=…` every match ran to the end of the run — 20 ms at 16 KB,
    // 87 at 32 KB, 467 at 64 KB, 910 ms for one envelope of it, and ~30 s at
    // half a megabyte. The name and its separator are matched now and the
    // value is walked in code, behind a cursor that visits each character
    // once.
    const small = new Map<string, number>();
    for (const unit of SHAPES) {
      // 2.6-18 ms each here; the quadratic was 467 ms.
      const t = fastest(fixture(unit, SMALL), 2);
      small.set(unit, t);
      expect(t, `64 KB of ${JSON.stringify(unit)}`).toBeLessThan(100);
    }

    // `buildEnvelope` caps each string at 2 000 characters, so half a megabyte
    // is ~250 of them in ONE call. Measured at 12-130 ms per shape on an idle
    // machine; the budget is ~3x that, because this file's worker shares the
    // box with every other test file and a loaded machine is not a regression.
    // The RATIO next to it is what actually pins the shape of the curve, and
    // it does not care how fast the machine is: 8x the data costs about 8x the
    // time (10-13x measured, since the large tier gets one pass to the small
    // tier's best of two and pays more for its allocations), where a quadratic
    // would cost 64x. The line is drawn between those two, not near either.
    for (const unit of SHAPES) {
      const t = fastest(fixture(unit, LARGE), 1);
      expect(t, `512 KB of ${JSON.stringify(unit)}`).toBeLessThan(400);
      expect(t / Math.max(small.get(unit) ?? 1, 1), `512 KB / 64 KB of ${JSON.stringify(unit)}`).toBeLessThan(24);
    }
  }, 60_000);

  it("evaluates half a megabyte of the WORST shape well inside the hook's budget", () => {
    // The hook runs on every tool call, before Jev is even asked, so the whole
    // redaction of an oversized command has to disappear into the call. This
    // pins the absolute number the shape-by-shape budgets above only bound
    // relatively: a rule that went quadratic here read 910 ms for one
    // envelope, and this is the assertion that says out loud what "fast" is.
    //
    // Best of three, because one pass of half a megabyte allocates enough to
    // catch a GC that is nobody's regression.
    const worst = SHAPES.map((unit) => [unit, fastest(fixture(unit, 500 * 1024), 3)] as const).sort((a, b) => b[1] - a[1]);
    for (const [unit, t] of worst) expect(t, `500 KB of ${JSON.stringify(unit)}`).toBeLessThan(200);
  }, 60_000);
});
