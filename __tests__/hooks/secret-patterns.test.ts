/**
 * The secret catalogue: what it covers, what it deliberately does not, and the
 * boundary between the tier that can deny a tool call and the tier that cannot.
 *
 * Kept apart from builtin-policies.test.ts on purpose — that file's fixtures
 * are shared across ~40 policies, and every credential-shaped string added
 * there trips the sanitize-* family for every other suite in the file. The same
 * reason __tests__/e2e/hooks/builtin-policies-extended.e2e.test.ts exists.
 */
import { describe, it, expect } from "vitest";
import {
  BUILTIN_POLICIES,
  SECRET_PATTERNS,
  BLOCKING_SECRET_PATTERNS,
  REDACT_ONLY_PATTERNS,
  KNOWN_EXAMPLE_SECRETS,
} from "../../src/hooks/builtin-policies";
import type { PolicyContext } from "../../src/hooks/policy-types";

const sanitizeApiKeys = BUILTIN_POLICIES.find((p) => p.name === "sanitize-api-keys")!;

function ctxFor(output: string): PolicyContext {
  return {
    eventType: "PostToolUse",
    payload: { tool_name: "Bash", tool_response: { output } },
    toolName: "Bash",
    toolInput: {},
    params: {},
  } as unknown as PolicyContext;
}

async function decide(output: string) {
  return await sanitizeApiKeys.fn(ctxFor(output));
}

/**
 * Every format is asserted with its EXPECTED LABEL, not merely "something
 * matched". Ordering in API_KEY_PATTERNS is load-bearing — a generic rule
 * placed above a specific one reports an Anthropic key as an OpenAI one — and
 * a bare "did it match" assertion cannot see that regression at all.
 */
const VENDOR_CASES: Array<[string, string, string]> = [
  // [label, sample, why this shape]
  ["Anthropic API key", `sk-ant-api03-${"A".repeat(24)}`, "Anthropic, specific before generic sk-"],
  ["OpenAI project API key", `sk-proj-${"A".repeat(24)}`, "OpenAI project"],
  ["OpenAI service account key", `sk-svcacct-${"A".repeat(24)}`, "OpenAI service account"],
  ["OpenAI admin key", `sk-admin-${"A".repeat(24)}`, "OpenAI admin"],
  ["OpenAI API key", `sk-${"A".repeat(24)}`, "OpenAI generic"],
  ["GitHub personal access token", `ghp_${"A".repeat(36)}`, "classic PAT"],
  ["GitHub OAuth token", `gho_${"A".repeat(36)}`, "OAuth"],
  ["GitHub user-to-server token", `ghu_${"A".repeat(36)}`, "user-to-server"],
  ["GitHub server-to-server token", `ghs_${"A".repeat(36)}`, "server-to-server"],
  ["GitHub refresh token", `ghr_${"A".repeat(36)}`, "refresh"],
  ["GitHub fine-grained token", `github_pat_${"A".repeat(82)}`, "fine-grained"],
  ["GitLab personal access token", `glpat-${"A".repeat(20)}`, "GitLab PAT"],
  ["AWS access key ID", `AKIA${"B".repeat(16)}`, "long-lived AKID"],
  ["AWS temporary access key ID", `ASIA${"B".repeat(16)}`, "STS AKID"],
  ["AWS secret access key", `aws_secret_access_key = ${"a".repeat(40)}`, "name-anchored, no prefix of its own"],
  ["Google API key", `AIza${"C".repeat(35)}`, "Google API"],
  ["Google OAuth client secret", `GOCSPX-${"D".repeat(24)}`, "Google OAuth"],
  ["Azure storage account key", `AccountKey=${"e".repeat(86)}==`, "Azure storage"],
  ["Stripe live secret key", `sk_live_${"A".repeat(24)}`, "Stripe live"],
  ["Stripe test secret key", `sk_test_${"A".repeat(24)}`, "Stripe test"],
  ["Square access token", `sq0atp-${"A".repeat(22)}`, "Square"],
  ["Shopify access token", `shpat_${"a1".repeat(16)}`, "Shopify"],
  ["Slack token", `xoxb-2314-4432-${"A".repeat(24)}`, "Slack bot"],
  ["Slack webhook URL", `https://hooks.slack.com/services/T00000000/B00000000/${"X".repeat(24)}`, "webhook is itself a credential"],
  ["Telegram bot token", `123456789:AA${"H".repeat(33)}`, "Telegram bot"],
  ["npm access token", `npm_${"A".repeat(36)}`, "npm"],
  ["PyPI API token", `pypi-AgEIcHlwaS5vcmc${"A".repeat(50)}`, "PyPI"],
  ["HashiCorp Vault token", `hvs.${"A".repeat(24)}`, "Vault"],
  ["Doppler token", `dp.pt.${"A".repeat(40)}`, "Doppler"],
  ["Linear API key", `lin_api_${"A".repeat(40)}`, "Linear"],
  ["Notion integration token", `ntn_${"A".repeat(40)}`, "Notion"],
  ["Figma personal access token", `figd_${"A".repeat(40)}`, "Figma"],
  ["Postman API key", `PMAK-${"a".repeat(24)}-${"b".repeat(34)}`, "Postman"],
  ["Hugging Face token", `hf_${"A".repeat(34)}`, "Hugging Face"],
  ["SendGrid API key", `SG.${"A".repeat(22)}.${"B".repeat(43)}`, "SendGrid"],
  ["HTTP basic auth credentials", "Authorization: Basic dXNlcjpwYXNzd29yZDEyMw==", "basic auth carries a password"],
];

describe("secret catalogue — vendor coverage", () => {
  for (const [label, sample, why] of VENDOR_CASES) {
    it(`denies ${label} (${why})`, async () => {
      const result = await decide(`config value: ${sample}`);
      expect(result.decision, sample).toBe("deny");
      // The specific label, not just any deny — this is what catches an
      // ordering regression between a generic and a specific rule.
      expect(result.reason, sample).toContain(label);
    });
  }

  it("covers every case above with a distinct label", () => {
    const labels = VENDOR_CASES.map(([l]) => l);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("secret catalogue — tiering is structural, not advisory", () => {
  // If a redact-only pattern ever reaches the blocking array, an agent reading
  // an ordinary git SHA starts having its tool calls denied.
  it("keeps the blocking and redact-only tiers disjoint", () => {
    const blocking = new Set(BLOCKING_SECRET_PATTERNS.map(([re]) => re.source));
    for (const [re, label] of REDACT_ONLY_PATTERNS) {
      expect(blocking.has(re.source), `${label} must not be deny-eligible`).toBe(false);
    }
  });

  it("exposes both tiers through SECRET_PATTERNS, so the redactor sees everything", () => {
    const all = new Set(SECRET_PATTERNS.map(([re]) => re.source));
    for (const [re, label] of [...BLOCKING_SECRET_PATTERNS, ...REDACT_ONLY_PATTERNS]) {
      expect(all.has(re.source), `${label} must be redactable`).toBe(true);
    }
    expect(SECRET_PATTERNS.length).toBe(
      BLOCKING_SECRET_PATTERNS.length + REDACT_ONLY_PATTERNS.length,
    );
  });

  // Each of these is a real credential shape. None can carry a deny, because
  // each collides with something an agent reads constantly.
  const collisions: Array<[string, string]> = [
    [`SK${"a1".repeat(16)}`, "Twilio API key SID — 32 hex, same shape as a git SHA"],
    [`AC${"b2".repeat(16)}`, "Twilio account SID — 32 hex"],
    [`https://${"a".repeat(32)}@o123.ingest.sentry.io/456`, "Sentry DSN — semi-public by design"],
    [`s.${"A".repeat(24)}`, "Vault legacy token — a two-character prefix is not evidence"],
  ];

  for (const [sample, why] of collisions) {
    it(`does not deny: ${why}`, async () => {
      expect((await decide(`value: ${sample}`)).decision).toBe("allow");
    });
  }

  it("still redacts those shapes in an audit digest", async () => {
    const { maskSecrets } = await import("../../src/audit/redact-example");
    for (const [sample] of collisions) {
      expect(maskSecrets(sample), sample).toContain("[REDACTED:");
    }
  });
});

describe("secret catalogue — lookalikes stay allowed", () => {
  // A deny here costs the user a tool call they asked for, on a default-on
  // policy. Each row is a shape that a naive version of a rule above matches.
  const lookalikes: Array<[string, string]> = [
    ["deploy to prod-risk-assessment-service-v2", "sk- inside risk-"],
    ["git log --oneline abcdef1234567890abcdef1234567890", "40 hex, not an AWS secret"],
    [`ghp_${"A".repeat(40)}`, "ghp_ past its documented length"],
    [`AKIA${"B".repeat(20)}`, "AKIA past its documented length"],
    ["const key = { id: 1 }", "bare key= is React's prop, not a credential"],
    ["Authorization: Bearer short", "bearer value below the minimum"],
    ["-----BEGIN CERTIFICATE-----", "a certificate is not a private key"],
    ["eyJuYW1lIjoiZm9vIn0=", "base64 JSON, not a JWT"],
    ["npm install --save-dev typescript", "ordinary npm command"],
    ["export EDITOR=vim", "an assignment with no credential in it"],
  ];

  for (const [sample, why] of lookalikes) {
    it(`allows: ${why}`, async () => {
      expect((await decide(sample)).decision, sample).toBe("allow");
    });
  }
});

describe("secret catalogue — documentation keys", () => {
  it("lists the AWS docs pair", () => {
    expect(KNOWN_EXAMPLE_SECRETS.has("AKIAIOSFODNN7EXAMPLE")).toBe(true);
    expect(KNOWN_EXAMPLE_SECRETS.has("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")).toBe(true);
  });

  it("allows a payload whose only credential is a documentation key", async () => {
    expect((await decide("aws_access_key_id = AKIAIOSFODNN7EXAMPLE")).decision).toBe("allow");
  });
});
