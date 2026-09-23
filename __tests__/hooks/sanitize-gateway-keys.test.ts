// @vitest-environment node
/**
 * The three `sk-` entries T6 added to SECRET_PATTERNS, seen from the blocking
 * side: sanitize-api-keys now denies tool output carrying a gateway key, and
 * nothing it allowed before that is not a key starts being denied.
 *
 * Key-shaped fixtures are built at runtime (see ./semantic/redaction-fixtures).
 */
import { describe, expect, it } from "vitest";
import { maskSecrets, redactExample } from "../../src/audit/redact-example";
import { BUILTIN_POLICIES, SECRET_PATTERNS } from "../../src/hooks/builtin-policies";
import type { PolicyContext } from "../../src/hooks/policy-types";
import { ALNUM, B64URL, HEX, SK, gatewayKey, prng, rnd } from "./semantic/redaction-fixtures";

const rand = prng(0x5a17);
const policy = BUILTIN_POLICIES.find((p) => p.name === "sanitize-api-keys")!;

async function decide(output: unknown): Promise<{ decision: string; reason?: string }> {
  const ctx = { eventType: "PostToolUse", payload: { tool_response: { output } }, toolName: "Bash", toolInput: {} } as unknown as PolicyContext;
  return (await policy.fn(ctx)) as { decision: string; reason?: string };
}

describe("SECRET_PATTERNS keeps every original pattern", () => {
  it("has the original 13 entries, unchanged and in their original order", () => {
    // Only additions are allowed: this is what "sanitize-* only catch more" rests on.
    const original: Array<[string, string]> = [
      ["-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----", "private key"],
      ["eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}", "JWT"],
      ["Authorization:\\s*Bearer\\s+[A-Za-z0-9\\-._~+/]{20,}", "bearer token"],
      ["(?:postgresql|postgres|mysql|mongodb(?:\\+srv)?|redis|amqps?|smtps?):\\/\\/[^@\\s]+@", "database credentials"],
      ["sk-ant-[A-Za-z0-9\\-_]{20,}", "Anthropic API key"],
      ["sk-proj-[A-Za-z0-9\\-_]{20,}", "OpenAI project API key"],
      ["sk-[A-Za-z0-9]{20,}", "OpenAI API key"],
      ["ghp_[A-Za-z0-9]{36}", "GitHub personal access token"],
      ["github_pat_[A-Za-z0-9_]{82}", "GitHub fine-grained token"],
      ["AKIA[A-Z0-9]{16}", "AWS access key ID"],
      ["sk_live_[A-Za-z0-9]{24,}", "Stripe live secret key"],
      ["sk_test_[A-Za-z0-9]{24,}", "Stripe test secret key"],
      ["AIza[0-9A-Za-z\\-_]{35}", "Google API key"],
    ];
    const kept = SECRET_PATTERNS.map(([re, label]) => [re.source, label] as [string, string]).filter(([, label]) =>
      original.some(([, l]) => l === label),
    );
    expect(kept).toEqual(original);
    const added = SECRET_PATTERNS.map(([, l]) => l).filter((l) => !original.some(([, o]) => o === l));
    expect(added).toEqual(["OpenRouter API key", "Langfuse secret key", "sk- API key"]);
  });
});

describe("sanitize-api-keys — gateway keys", () => {
  it("denies a 25-character gateway key wherever its separator lands", async () => {
    for (let at = 3; at < 22; at++) {
      for (const sep of ["-", "_"] as const) {
        const r = await decide(`config: ${gatewayKey(rand, at, sep)}`);
        expect(r.decision, `separator at ${at}`).toBe("deny");
      }
    }
  });

  it("denies a key at the start of a line, where JSON.stringify puts `\\n` before it", async () => {
    const r = await decide(`line one\n${gatewayKey(rand, 10)}\nline three`);
    expect(r.decision).toBe("deny");
  });

  it("labels OpenRouter, Langfuse and OpenAI service-account keys", async () => {
    const uuid = [8, 4, 4, 4, 12].map((n) => rnd(rand, n, HEX)).join("-");
    const cases: Array<[string, string]> = [
      [SK + "or-v1-" + rnd(rand, 64, HEX), "OpenRouter API key"],
      [SK + "lf-" + uuid, "Langfuse secret key"],
      [SK + "svcacct-" + "Ab3" + rnd(rand, 60, B64URL), "sk- API key"],
    ];
    for (const [key, label] of cases) {
      const r = await decide(`export KEY=${key}`);
      expect(r.decision, label).toBe("deny");
      expect(r.reason).toContain(label);
    }
  });

  it("keeps the original label for a plain OpenAI key", async () => {
    const r = await decide(`key ${SK}${rnd(rand, 48, ALNUM)}`);
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("OpenAI API key");
  });

  it("allows a TOKEN-INITIAL `sk-` name whose only key-ish trait is a digit", async () => {
    // `sanitize-api-keys` answers a match by replacing the WHOLE tool result
    // with a marker, so each of these lost a branch listing, an `ls` row, a
    // kubectl row, a CSS class or a Markdown anchor to `[REDACTED: …]`. The
    // class mix a real key has is asked of ONE segment now, not spread across
    // the whole run, where any Title-Case name with a number satisfies it.
    for (const s of [
      `* ${SK}1234-Fix-Login-Bug-Now\n  main`,
      `-rw-r--r-- 1 u u 8231 Sep 22 10:02 ${SK}Report-2024-Q3-Final-v2.xlsx`,
      `NAME                          READY\n${SK}Gateway-Prod-7d9f8b6c5x2   1/1`,
      `<div class="${SK}Spinner-Container-Large-2">`,
      `2026-09-22 03:00 ${SK}Backups-2026-09-22-full/db.sql`,
      `{"id":"${SK}Session-Token-Preview-12","ok":true}`,
      `see [the guide](#${SK}Getting-Started-Guide-v2)`,
      `${SK}Release-Candidate-3-Notes-Draft`,
    ]) {
      const r = await decide(s);
      expect(r.decision, s).toBe("allow");
    }
  });

  it("still allows hyphenated names that merely contain or start with `sk-`", async () => {
    for (const s of [
      "NAME                                READY   STATUS\nrisk-scoring-7d9f8b6c5-x2k4p   1/1     Running",
      "npm run task-runner-for-the-build-2",
      SK + "learn-tutorial-for-beginners-2024-part-one",
      SK + "Some-Title-Case-Words-Here-And-There",
      "desk-booking-service-v2-staging-deployment",
    ]) {
      const r = await decide(s);
      expect(r.decision, s).toBe("allow");
    }
  });
});

/**
 * Words that END in `sk`, followed by a hyphen and a Title-Case or mixed name
 * with a digit: every class a random key has, but mid-token. Each was denied by
 * the first version of the generic entry, which had no token boundary.
 */
const MID_WORD: string[] = [
  `Switched to a new branch 'ta${SK}PROJ-1234-add-login-page'`,
  `git checkout -b feature/ta${SK}ABC-123-UpdateDashboardWidget`,
  `* ri${SK}Model2-scoring-service-v2`,
  `remote: Create a pull request for 'de${SK}JIRA-42-fix-seat-map' on GitHub`,
  `docker tag api fla${SK}App2-backend-prod-latest`,
  `ls: dist/assets/Ta${SK}DetailPanel-a1B2c3D4.js`,
  `drwxr-xr-x  Ta${SK}Management-System-v2`,
  `-rw-r--r--  Ri${SK}Assessment-2024-Final.pdf`,
  `De${SK}Booking-App-2023-Redesign`,
  `Kio${SK}Mode-Configuration-v3`,
  `open Di${SK}Usage-Report-2024-Q3.xlsx`,
  `git checkout feature/Ta${SK}Runner-Refactor-v2-Final`,
  `Kio${SK}Mode-Setup-Guide-v10`,
  `De${SK}Booking-Service-V2-Prod`,
];

describe("sanitize-api-keys — the generic sk- entry starts a token", () => {
  it("allows Title-Case and mixed names with a digit that merely contain `sk-` mid-word", async () => {
    for (const s of MID_WORD) {
      const r = await decide(s);
      expect(r.decision, s).toBe("allow");
    }
  });

  it("the audit redactor, which shares the list, leaves them whole too", () => {
    for (const s of MID_WORD) expect(maskSecrets(s), s).toBe(s);
  });

  it("still denies a key after any character that cannot be part of a token", async () => {
    const key = gatewayKey(rand, 5);
    for (const before of ["", " ", "=", ":", '"', "'", "`", "/", "(", "[", "{", ",", ";", "|", "\t", "@"]) {
      const r = await decide(`${before}${key}`);
      expect(r.decision, JSON.stringify(before)).toBe("deny");
      expect(r.reason).toContain("sk- API key");
    }
  });

  it("does not treat a key glued to a word, a hyphen or an underscore as a key", async () => {
    const key = gatewayKey(rand, 5);
    for (const before of ["a", "Z", "9", "-", "_"]) {
      const r = await decide(`${before}${key}`);
      expect(r.decision, before).toBe("allow");
    }
  });

  it("the audit redactor still masks a hyphenated gateway key, and only the key", () => {
    // Whole-string equality, not "the body is gone and a marker is there":
    // the weaker assertion passed over a real defect. The entry's token
    // boundary is a CONSUMING capture group (a lookbehind would cost the
    // blocking policy its regex JIT), so a plain `.replace(pattern, label)`
    // deleted the character in front of every key it masked.
    const key = gatewayKey(rand, 5);
    expect(maskSecrets(`export OPENAI_API_KEY=${key}`)).toBe("export OPENAI_API_KEY=[REDACTED: sk- API key]");
    expect(maskSecrets(`{"k":"${key}"}`)).toBe(`{"k":"[REDACTED: sk- API key]"}`);
    expect(maskSecrets(`a\n${key}\nb`)).toBe("a\n[REDACTED: sk- API key]\nb");
    expect(maskSecrets(`x,${key},y`)).toBe("x,[REDACTED: sk- API key],y");
    expect(maskSecrets(key)).toBe("[REDACTED: sk- API key]");
  });

  it("keeps the assignment visible to the pass that names the credential", () => {
    // `maskAssignedSecrets` runs after `maskSecrets` and looks for `NAME=value`.
    // With the `=` eaten it could no longer see the assignment at all, and the
    // rendered harm-report example said `export OPENAI_API_KEY[REDACTED: …]`.
    const key = gatewayKey(rand, 5);
    expect(redactExample(`export OPENAI_API_KEY=${key}`)).toBe("export OPENAI_API_KEY=[REDACTED: sk- API key]");
    expect(redactExample(`curl -H "x-api-key: ${key}" https://api.example.com/v1/chat`)).toBe(
      `curl -H "x-api-key: [REDACTED: sk- API key]" https://api.example.com/…/chat`,
    );
  });

  it("stays linear on a long run of `sk-` (every token start, not every `sk-`, runs the class checks)", async () => {
    // The unanchored version rescanned the rest of the run at each `sk-`:
    // 120 KB took ~3.5 s. The whole PostToolUse payload is scanned, uncapped.
    for (const unit of [SK, `${SK}a`, `${SK}aB`, `x${SK}`]) {
      const output = unit.repeat(Math.ceil(120_000 / unit.length));
      const t0 = performance.now();
      await decide(output);
      expect(performance.now() - t0, JSON.stringify(unit)).toBeLessThan(250);
    }
  });
});
