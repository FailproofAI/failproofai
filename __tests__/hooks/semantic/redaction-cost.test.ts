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
import { buildEnvelope } from "../../../src/hooks/semantic/envelope";
import { buildSecretScrubber, redactSecrets, redactSecretsDetailed } from "../../../src/hooks/semantic/redact";
import type { Facts } from "../../../src/hooks/semantic/types";
import { prng, randomToken } from "./redaction-fixtures";

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
    // `blunt: true` — the envelope's own setting, and the only one that runs
    // the two blunt rules. Half these shapes exist to bound THEM (`cookie:a;`,
    // `--password`, `sshpass -p`, `curl -u`), and the option is opt-in, so
    // calling with the default would quietly stop measuring them.
    redactSecrets(s, { blunt: true });
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
      expect(t, `512 KB of ${JSON.stringify(unit)}`).toBeLessThan(900);
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
    //
    // 450 ms, not the 200 ms this used to assert. The three slowest shapes
    // measured 90-115 ms on an IDLE machine, which is barely 2x the old
    // budget — and this file's worker shares the box with every other test
    // file, so an ordinary parallel CI run put a shape over the line for
    // nobody's fault. A shape doubling in cost still fails, and the linearity
    // ratio next to it above is what pins the CURVE; this number only says
    // out loud that the whole redaction of an oversized command disappears
    // into a hook call.
    const worst = SHAPES.map((unit) => [unit, fastest(fixture(unit, 500 * 1024), 3)] as const).sort((a, b) => b[1] - a[1]);
    for (const [unit, t] of worst) expect(t, `500 KB of ${JSON.stringify(unit)}`).toBeLessThan(450);
  }, 60_000);
});

/**
 * The FINAL pass, which is not a redaction rule and had no budget at all.
 *
 * `scrubKnownSecrets` replaces every copy of an already-found secret. It ran
 * as a loop over the secrets — an `includes` + `split` over the whole string
 * for each one, plus a `[...known].sort()` per call — so the envelope's cost
 * was the PRODUCT of two things the agent writes: how many distinct
 * credentials the request carries, and how many bytes the state has. Both max
 * out together, and the maximum is what this measures.
 */
describe("the final scrub pass", () => {
  const rand = prng(0x5c12);
  const facts: Facts = {
    toolName: "Bash",
    toolIsKnown: true,
    cwd: "/home/dev/app",
    projectRoot: "/home/dev/app",
    currentGitBranch: "main",
    permissionMode: "default",
    paths: [],
  } as unknown as Facts;

  /** `chars` of distinct `--password <token>` arguments. */
  const credentialRun = (chars: number): string => {
    let s = "deploy";
    while (s.length < chars) s += ` --password ${randomToken(rand, 24)}`;
    return s.slice(0, chars);
  };

  /**
   * The largest input `cleanValue` takes whole: it keeps 24 keys at each of
   * two levels and stringifies at depth 2, so 24 objects of 24 strings is 576
   * strings of ~1 000 characters — every one of them a list of credentials.
   */
  const maxInput = (outer: number, inner: number): Record<string, unknown> => {
    const input: Record<string, unknown> = {};
    for (let i = 0; i < outer; i++) {
      const sub: Record<string, unknown> = {};
      for (let j = 0; j < inner; j++) sub[`s${j}`] = credentialRun(1_100);
      input[`arg${i}`] = sub;
    }
    return input;
  };

  /**
   * The 576 strings of a maximal input, and every credential in them.
   *
   * The scrub pass is measured on the UNREDACTED copies: this is the state the
   * rules did not recognise — a bare token `facts.paths` lifted out of the
   * command, the same value pasted into a message — which is the only text
   * where the pass has work to do, and therefore its worst case.
   */
  const maximalStrings = (): { strings: string[]; found: Set<string> } => {
    const strings: string[] = [];
    const found = new Set<string>();
    for (let i = 0; i < 576; i++) {
      const s = credentialRun(1_100);
      strings.push(s);
      for (const f of redactSecretsDetailed(s, { blunt: true }).found) found.add(f);
    }
    return { strings, found };
  };

  it("scrubs a maximal envelope's worth of distinct secrets in one pass", () => {
    // 17 280 distinct credentials over 634 KB of state, every one of them
    // present in the text. Measured 87-90 ms here (62 ms of that compiling the
    // automaton, 25 ms scanning), against the 200 ms a PreToolUse hook can
    // afford to spend on redaction. The budget is 300 and not 200 because this
    // file's worker shares the machine with every other test file, and a
    // number with 2x margin is what made the budgets below flake; 3x on a
    // best-of-three is a real regression, not a busy neighbour.
    const { strings, found } = maximalStrings();
    // The fixture's own pin: a change that stops FINDING the credentials would
    // otherwise pass this budget by having nothing to scrub.
    expect(found.size).toBeGreaterThan(10_000);
    let best = Infinity;
    let markers = 0;
    for (let pass = 0; pass < 3; pass++) {
      const t0 = performance.now();
      const scrubber = buildSecretScrubber(found);
      markers = 0;
      for (const s of strings) markers += scrubber.scrub(s).count;
      best = Math.min(best, performance.now() - t0);
    }
    expect(markers).toBeGreaterThan(10_000);
    expect(best, `${found.size} secrets, ${markers} markers`).toBeLessThan(300);
  }, 60_000);

  it("costs the same per string whether there are 500 secrets or 15 000", () => {
    // THE regression pin. The old pass was a loop over the secrets, each one an
    // `includes` + `split` over the whole string, so the cost of scrubbing one
    // string was proportional to how many credentials the request carried
    // ANYWHERE — the product this rewrite exists to remove. Scanning is one
    // walk of the text against one automaton, so 30x the secrets is the same
    // scan. A ratio, so a busy machine moves both numbers together.
    const text = credentialRun(1_100);
    const scanCost = (count: number): number => {
      const known = new Set<string>();
      while (known.size < count) known.add(randomToken(rand, 24));
      const scrubber = buildSecretScrubber(known);
      let best = Infinity;
      for (let pass = 0; pass < 5; pass++) {
        const t0 = performance.now();
        for (let i = 0; i < 200; i++) scrubber.scrub(text);
        best = Math.min(best, performance.now() - t0);
      }
      return best;
    };
    const few = scanCost(500);
    const many = scanCost(15_000);
    expect(many / Math.max(few, 0.5), `500 secrets ${few.toFixed(1)}ms -> 15 000 secrets ${many.toFixed(1)}ms`).toBeLessThan(4);
  }, 60_000);

  it("builds the whole envelope inside the hook's budget", () => {
    // The pass above in place: ~17 800 redactions over 634 KB of tool input,
    // every rule and the scrub. Measured 141-187 ms; the budget is 600 for the
    // same reason as above, and the ratio next to it is what pins the curve.
    const input = maxInput(24, 24);
    let best = Infinity;
    let redactions = 0;
    for (let pass = 0; pass < 3; pass++) {
      const t0 = performance.now();
      const env = buildEnvelope(input, ["ship it"], facts, null, {});
      best = Math.min(best, performance.now() - t0);
      redactions = env.redactions;
    }
    expect(redactions).toBeGreaterThan(10_000);
    expect(best, `${redactions} redactions`).toBeLessThan(600);
  }, 60_000);

  it("stays linear in the number of strings, not quadratic", () => {
    // 6x the strings and 6x the secrets at once. The old loop cost 23x.
    const cost = (outer: number): number => {
      const input = maxInput(outer, 24);
      let best = Infinity;
      for (let pass = 0; pass < 3; pass++) {
        const t0 = performance.now();
        buildEnvelope(input, ["ship it"], facts, null, {});
        best = Math.min(best, performance.now() - t0);
      }
      return best;
    };
    const a = cost(4);
    const b = cost(24);
    expect(b / Math.max(a, 1), `${a.toFixed(0)}ms -> ${b.toFixed(0)}ms`).toBeLessThan(12);
  }, 60_000);

  it("stays linear on the shape that is worst for a substring search", () => {
    // Every secret is a long run of one character with a distinguishing tail,
    // and the text is that run repeated: the case where `includes` re-compares
    // almost the whole needle at almost every position. 16 000 of them over
    // 576 strings cost the old loop ~1.2 s; the automaton does not care.
    const known = Array.from({ length: 16_000 }, (_, i) => "a".repeat(29) + "Z9" + String(i).padStart(5, "0"));
    const text = ("a".repeat(29) + "Z9" + "  ").repeat(31).slice(0, 1_000);
    const t0 = performance.now();
    const scrubber = buildSecretScrubber(known);
    const built = performance.now() - t0;
    const t1 = performance.now();
    for (let i = 0; i < 576; i++) scrubber.scrub(text);
    const scanned = performance.now() - t1;
    expect(built, "build").toBeLessThan(200);
    expect(scanned, "576 scans").toBeLessThan(200);
  }, 60_000);
});
