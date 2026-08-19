/**
 * The engine and the daemon hold two hand-written copies of one prefix list, in
 * two languages, with nothing generating either.
 *
 * `VENDOR_PREFIXES` (src/hooks/builtin-policies.ts) is what the hook layer will
 * DENY on. `PREFIX_RULES` (crates/fpai-collect/src/redact.rs) is what the
 * collector SCRUBS before a transcript is serialised to the spool and uploaded.
 * They were already out of step before this test existed — Rust carried
 * Supabase and the four extra GitHub token types the engine had never heard of,
 * while the engine carried Stripe and Google keys the daemon shipped verbatim.
 *
 * Each direction fails differently, so each is asserted separately:
 *   • engine-only → the hook stops the agent using a credential in-session,
 *     and the same credential still leaves the machine in telemetry.
 *   • daemon-only → the digest masks a key the agent was never stopped from
 *     using, so the two halves of the product describe the same event
 *     differently.
 *
 * Modelled on __tests__/hooks/harness-extra-paths.test.ts, which does exactly
 * this for HARNESS_KEYS against crates/failproofaid/src/main.rs.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { VENDOR_PREFIXES, BLOCKING_SECRET_PATTERNS } from "../../src/hooks/builtin-policies";

const REDACT_RS = resolve(__dirname, "../../crates/fpai-collect/src/redact.rs");

/**
 * Prefixes the daemon may carry WITHOUT a matching entry here.
 *
 * Only for a prefix already covered by a broader engine rule, where adding it
 * would be redundant rather than informative: the daemon lists `sk-ant-api`
 * ahead of `sk-ant-` purely to win the label race between two rules that share
 * a label anyway, and the engine's `sk-ant-` matches the same strings.
 *
 * This is an allowlist, not a waiver — anything else appearing in redact.rs
 * fails until someone decides which side is wrong.
 */
const DAEMON_ONLY_SUBSUMED = new Set(["sk-ant-api"]);

function rustPrefixes(): string[] {
  const src = readFileSync(REDACT_RS, "utf8");
  const block = /const PREFIX_RULES: &\[PrefixRule\] = &\[([\s\S]*?)\n\];/.exec(src);
  expect(
    block,
    "PREFIX_RULES not found in redact.rs — did it move, get renamed, or change shape?",
  ).toBeTruthy();
  const found = [...block![1].matchAll(/prefix:\s*"([^"]+)"/g)].map((m) => m[1]);
  expect(found.length, "parsed zero prefixes — the regex no longer matches the source").
    toBeGreaterThan(0);
  return found;
}

describe("secret prefix parity — engine vs daemon", () => {
  it("finds the daemon's prefix table", () => {
    expect(rustPrefixes().length).toBeGreaterThan(40);
  });

  it("scrubs on the way out everything the engine blocks in-session", () => {
    const daemon = new Set(rustPrefixes());
    const missing = VENDOR_PREFIXES.filter((p) => !daemon.has(p));
    expect(
      missing,
      `in VENDOR_PREFIXES but not PREFIX_RULES — the engine denies these, and the ` +
      `collector would upload them verbatim: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("blocks in-session everything the daemon bothers to scrub", () => {
    const engine = new Set(VENDOR_PREFIXES);
    const extra = rustPrefixes().filter(
      (p) => !engine.has(p) && !DAEMON_ONLY_SUBSUMED.has(p),
    );
    expect(
      extra,
      `in PREFIX_RULES but not VENDOR_PREFIXES — the digest masks these but no ` +
      `policy ever denied them: ${extra.join(", ")}`,
    ).toEqual([]);
  });

  it("keeps the subsumed allowlist honest — each entry starts with a real engine prefix", () => {
    for (const subsumed of DAEMON_ONLY_SUBSUMED) {
      const covering = VENDOR_PREFIXES.find(
        (p) => subsumed.startsWith(p) && p !== subsumed,
      );
      expect(
        covering,
        `${subsumed} is allowlisted as subsumed but no engine prefix covers it`,
      ).toBeTruthy();
    }
  });
});

describe("secret prefix declaration is honest about the engine's own patterns", () => {
  // VENDOR_PREFIXES is hand-written beside the regexes rather than derived from
  // them, so it can drift from the very list it claims to summarise. A prefix
  // declared here but absent from every pattern would make the parity test
  // above demand a daemon rule for something the engine does not detect.
  it("every declared prefix is actually detected by a blocking pattern", () => {
    // Behavioural, not textual: several patterns fold their prefixes into an
    // alternation (`shp(?:at|ss|ca|pa)_`, `hv[sb]\.`, `xox[baprs]-`), so the
    // literal never appears in the source even though the rule matches it.
    //
    // Formats differ in both alphabet and length — AKIA is uppercase-only,
    // Postman is hex-hyphen-hex, github_pat_ needs 82 — so rather than encode
    // each one here (which would just restate the patterns), try a spread of
    // plausible bodies and require that SOME sample is detected. A prefix no
    // sample can trip is a prefix the engine does not really cover.
    const bodies = (n: number) => [
      "a".repeat(n), "A".repeat(n), "0".repeat(n), "aB3".repeat(Math.ceil(n / 3)).slice(0, n),
    ];
    const samples = (prefix: string) => {
      const out: string[] = [];
      for (const n of [16, 20, 22, 24, 30, 32, 34, 35, 36, 40, 50, 82]) out.push(...bodies(n).map((b) => prefix + b));
      // Postman's two hex runs joined by a hyphen.
      out.push(`${prefix}${"a".repeat(24)}-${"b".repeat(34)}`);
      return out;
    };

    const orphans = VENDOR_PREFIXES.filter((prefix) =>
      !samples(prefix).some((s) => BLOCKING_SECRET_PATTERNS.some(([re]) => re.test(s))),
    );
    expect(
      orphans,
      `declared in VENDOR_PREFIXES but detected by no pattern at any length: ${orphans.join(", ")}`,
    ).toEqual([]);
  });

  it("has no duplicate declarations", () => {
    expect(new Set(VENDOR_PREFIXES).size).toBe(VENDOR_PREFIXES.length);
  });
});
