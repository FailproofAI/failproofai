// @vitest-environment node
/**
 * The gateway-key shapes, from BOTH sides of the line T6 must not cross.
 *
 * `sanitize-api-keys` is DEFAULT-ON and answers a match by replacing the whole
 * tool result with a marker. So a pattern that catches gateway keys belongs on
 * the Jev redactor's own list (`VENDOR_RULES` in src/hooks/semantic/redact.ts,
 * which runs on the envelope path and nowhere else), never on
 * `SECRET_PATTERNS`, which the blocking policies read.
 *
 * A generic `sk-…` entry WAS added to `SECRET_PATTERNS`, and it denied ordinary
 * developer output: a branch listing, a pod name, an `ls` row, a CSS class, a
 * Markdown anchor. This file is the pin that it stays off that list and stays
 * on the redactor's, with the same key shapes exercised on both.
 *
 * Key-shaped fixtures are built at runtime (see ./semantic/redaction-fixtures).
 */
import { describe, expect, it } from "vitest";
import { maskSecrets } from "../../src/audit/redact-example";
import { BUILTIN_POLICIES, SECRET_PATTERNS } from "../../src/hooks/builtin-policies";
import type { PolicyContext } from "../../src/hooks/policy-types";
import { redactSecrets } from "../../src/hooks/semantic/redact";
import { ALNUM, B64URL, HEX, SK, gatewayKey, prng, rnd } from "./semantic/redaction-fixtures";

const rand = prng(0x5a17);
const policy = BUILTIN_POLICIES.find((p) => p.name === "sanitize-api-keys")!;

async function decide(output: unknown): Promise<{ decision: string; reason?: string }> {
  const ctx = { eventType: "PostToolUse", payload: { tool_response: { output } }, toolName: "Bash", toolInput: {} } as unknown as PolicyContext;
  return (await policy.fn(ctx)) as { decision: string; reason?: string };
}

const uuid = (): string => [8, 4, 4, 4, 12].map((n) => rnd(rand, n, HEX)).join("-");

/** Every gateway shape the plain `sk-[A-Za-z0-9]{20,}` entry walks past. */
const GATEWAY_KEYS: Array<[label: string, key: string]> = [
  ["LiteLLM, separator at 3", gatewayKey(rand, 3)],
  ["LiteLLM, separator at 12", gatewayKey(rand, 12)],
  ["LiteLLM, separator at 21", gatewayKey(rand, 21)],
  ["LiteLLM, underscore separator", gatewayKey(rand, 9, "_")],
  ["OpenRouter", SK + "or-v1-" + rnd(rand, 64, HEX)],
  ["Langfuse", SK + "lf-" + uuid()],
  ["OpenAI service account", SK + "svcacct-Ab3" + rnd(rand, 60, B64URL)],
  ["OpenAI admin", SK + "admin-Ab3" + rnd(rand, 40, B64URL)],
  ["OpenAI None", SK + "None-Ab3" + rnd(rand, 40, B64URL)],
];

/**
 * Ordinary developer output that contains `sk-` and nothing else notable.
 *
 * Every one of these was DENIED by the generic entry while it sat on
 * `SECRET_PATTERNS` — the whole tool result replaced by `[REDACTED: …]` for
 * every user of the default-on policy, whether or not they run Jev.
 *
 * The digit and the mixed case sit INSIDE one hyphen-separated segment
 * (`Release2024`, `Sprint12`, `Gateway7d9`), which is what the entry's
 * class-mix guard asked for and what an ordinary Title-Case name with a
 * version or a year in it has. The earlier fixtures here put the digit in its
 * own segment (`Release-Candidate-3`, `Report-2024-Q3`) — which the guard
 * rejects — so the suite stayed green over the regression it was written to
 * catch.
 */
const ORDINARY: Array<[label: string, output: string]> = [
  ["a release note", `${SK}Release2024-Notes-Final-Draft`],
  ["a branch listing", `* ${SK}Sprint12-login-fixes\n  main`],
  ["an ls row", `-rw-r--r-- 1 u u 8231 Sep 22 10:02 ${SK}Report2024-Q3-Final.xlsx`],
  ["a kubectl row", `NAME                     READY\n${SK}Gateway7d9-prod-canary   1/1`],
  ["a CSS class", `<div class="${SK}Spinner2-Container-Large">`],
  ["a backup path", `2026-09-22 03:00 ${SK}Backups2026-full-nightly/db.sql`],
  ["a JSON id", `{"id":"${SK}Session4-token-preview","ok":true}`],
  ["a Markdown anchor", `see [the guide](#${SK}Guide2-getting-started-here)`],
  ["a docker tag", `docker tag api ${SK}App2-backend-prod-latest-build`],
  ["a Jira branch", `Switched to a new branch '${SK}PROJ1234-add-login-page'`],
  ["a pod name", "NAME                                READY   STATUS\nrisk-scoring-7d9f8b6c5-x2k4p   1/1     Running"],
  ["an npm script", "npm run task-runner-for-the-build-2"],
  ["a tutorial slug", SK + "learn-tutorial-for-beginners-2024-part-one"],
  ["a Title-Case name", SK + "Some-Title-Case-Words-Here-And-There"],
  ["a service name", "desk-booking-service-v2-staging-deployment"],
  ["a mid-word match", `git checkout -b feature/ta${SK}ABC-123-UpdateDashboardWidget`],
  ["a mid-word file", `ls: dist/assets/Ta${SK}DetailPanel-a1B2c3D4.js`],
  ["a mid-word report", `open Di${SK}Usage-Report-2024-Q3.xlsx`],
];

describe("SECRET_PATTERNS is the list the blocking policies had", () => {
  it("has the original 13 entries, unchanged and in their original order", () => {
    // The `sanitize-*` builtins read this list and DENY on a match, so an
    // addition here is a new denial for every existing user. T6 adds nothing.
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
    expect(SECRET_PATTERNS.map(([re, label]) => [re.source, label] as [string, string])).toEqual(original);
  });
});

describe("sanitize-api-keys allows ordinary output that merely contains `sk-`", () => {
  it("allows every ordinary shape, including a digit and mixed case in ONE segment", async () => {
    for (const [label, output] of ORDINARY) {
      const r = await decide(output);
      expect(r.decision, `${label}: ${output}`).toBe("allow");
    }
  });

  it("the audit redactor, which shares the list, leaves them whole too", () => {
    for (const [label, output] of ORDINARY) expect(maskSecrets(output), label).toBe(output);
  });

  it("still denies the key shapes it always denied", async () => {
    // The floor the revert must not lower: a key with no separator in its
    // first twenty characters is the original `sk-[A-Za-z0-9]{20,}` entry's.
    const r = await decide(`key ${SK}${rnd(rand, 48, ALNUM)}`);
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("OpenAI API key");
    for (const [prefix, label] of [
      ["ant-api03-", "Anthropic API key"],
      ["proj-", "OpenAI project API key"],
    ] as Array<[string, string]>) {
      const d = await decide(`export KEY=${SK}${prefix}${rnd(rand, 40)}`);
      expect(d.decision, label).toBe("deny");
      expect(d.reason, label).toContain(label);
    }
  });

  it("does NOT deny a hyphenated gateway key — that is the redactor's job, not the blocker's", async () => {
    // Stated out loud because it is the cost of the revert, and the next
    // person to "fix" it by adding a pattern here re-ships the regression
    // above. The envelope still removes every one of these; see below.
    for (const [label, key] of GATEWAY_KEYS) {
      if (/^sk-[A-Za-z0-9]{20,}/.test(key)) continue; // no separator: the original entry's
      const r = await decide(`config: ${key}`);
      expect(r.decision, label).toBe("allow");
    }
  });
});

describe("the ENVELOPE path removes every gateway key", () => {
  it("redacts each shape whole, wherever its separator lands", () => {
    for (const [label, key] of GATEWAY_KEYS) {
      const r = redactSecrets(`config: ${key}`, { blunt: false });
      expect(r.text, label).not.toContain(key);
      expect(r.count, label).toBeGreaterThanOrEqual(1);
      // Not a partial redaction: nothing of the key's tail survives either.
      expect(r.text, label).not.toContain(key.slice(-12));
    }
  });

  it("redacts a 25-character key wherever its separator lands", () => {
    for (let at = 3; at < 22; at++) {
      for (const sep of ["-", "_"] as const) {
        const key = gatewayKey(rand, at, sep);
        const r = redactSecrets(`config: ${key}`, { blunt: false });
        // A separator at 20 or later leaves twenty alphanumerics in front of
        // it, so the shared floor's own `sk-[A-Za-z0-9]{20,}` claims the key
        // first and labels it "OpenAI API key" — extended to the end of the
        // token, so the tail past the separator goes with it either way.
        const label = at >= 20 ? "OpenAI API key" : "sk- API key";
        expect(r.text, `separator at ${at}${sep}`).toBe(`config: <redacted:${label}>`);
      }
    }
  });

  it("names OpenRouter and Langfuse keys rather than calling them generic", () => {
    // The two vendor entries sit ahead of the catch-all in VENDOR_RULES for
    // this and only this: the catch-all already matched them.
    expect(redactSecrets(`k ${SK}or-v1-${rnd(rand, 64, HEX)}`, { blunt: false }).text).toBe("k <redacted:OpenRouter API key>");
    expect(redactSecrets(`k ${SK}lf-${uuid()}`, { blunt: false }).text).toBe("k <redacted:Langfuse secret key>");
  });

  it("redacts a key at a JSON-escaped line start, where a nested payload puts it", () => {
    const key = gatewayKey(rand, 10);
    expect(redactSecrets(JSON.stringify({ o: `line\n${key}` }), { blunt: false }).text).toBe(`{"o":"line\\n<redacted:sk- API key>"}`);
  });

  it("leaves every ordinary shape alone on the envelope path too", () => {
    // The redactor may be blunter than the blocker, but not on these: each is
    // context Jev needs, and `sk-…{16,}` still has to start a token.
    for (const [label, output] of ORDINARY) {
      if (/(?:^|[^A-Za-z0-9_-])sk-[A-Za-z0-9_-]{16,}/.test(output)) continue; // genuinely key-shaped to the redactor
      expect(redactSecrets(output, { blunt: false }).text, label).toBe(output);
    }
  });
});
