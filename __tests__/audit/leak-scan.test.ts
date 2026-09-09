// @vitest-environment node
import { describe, it, expect } from "vitest";
import { findSecrets, flattenToolInput } from "@/src/audit/leak-scan";
import { redactExample } from "@/src/audit/redact-example";

/** Obviously synthetic. Real shapes, invented bytes. */
const GH = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const FIRST_PARTY = "compsynthetic0000111122223333";

describe("findSecrets — vendor shapes", () => {
  it("finds a vendor-shaped key with no name anywhere near it", () => {
    // 55.9% of real vendor-shaped credentials in the corpus have no secret-ish
    // word within 60 characters, so the shape layer has to stand alone.
    const found = findSecrets(`curl -H "Authorization: Bearer ${GH}" https://api.example.com`);
    expect(found.some((f) => f.value === GH && f.shaped)).toBe(true);
  });

  it("reports one finding per distinct value, not per matching rule", () => {
    const found = findSecrets(`${GH} ${GH} ${GH}`);
    expect(found.filter((f) => f.value === GH)).toHaveLength(1);
  });
});

describe("findSecrets — named assignments", () => {
  it("does not turn a secret-looking variable name into a finding", () => {
    for (const line of [
      `MY_API_KEY=${FIRST_PARTY}`,
      `MY_API_KEY = "${FIRST_PARTY}"`,
      `MY_API_KEY: "${FIRST_PARTY}"`,
      `{"my_api_key": "${FIRST_PARTY}"}`,
    ]) {
      expect(findSecrets(line), line).toEqual([]);
    }
  });

  it("keeps the vendor label when a value is both shaped and named", () => {
    // The vendor rule can name a console; the identifier says which of the
    // user's own variables to change. Both are wanted, on one finding.
    const found = findSecrets(`GITHUB_TOKEN=${GH}`);
    expect(found).toHaveLength(1);
    expect(found[0].shaped).toBe(true);
    expect(found[0].name).toBe("GITHUB_TOKEN");
  });
});

describe("findSecrets — what is structurally not a credential", () => {
  // Never entropy: the corpus's confirmed-live password measures 3.19 bits per
  // character while 1.3M UUIDs in the same corpus sit at 3.72. Any threshold
  // that catches the password catches every UUID.
  it("ignores indirection, which is the CORRECT secure form", () => {
    for (const line of [
      "API_KEY=$OPENAI_API_KEY",
      "API_KEY=${OPENAI_API_KEY}",
      "TOKEN = process.env.DISCORD_BOT_TOKEN",
      "api_key: <your-key-here>",
      "API_KEY={{ secrets.THING }}",
    ]) {
      expect(findSecrets(line), line).toEqual([]);
    }
  });

  it("ignores placeholders, booleans, numbers and paths", () => {
    for (const line of [
      "API_KEY=xxxxxxxxxxxx",
      "API_KEY=000000000000",
      "AUTH_ENABLED=true",
      "SESSION_KEY=1234567890",
      "KEY_PATH=/etc/ssl/private/key.pem",
      "API_KEY=short",
    ]) {
      expect(findSecrets(line), line).toEqual([]);
    }
  });

  it("ignores an already-masked value, so our own output is not re-detected", () => {
    // Measured: one leaked credential became seven reported findings across
    // four sessions, because the audit's own output re-entered the corpus.
    expect(findSecrets("API_KEY=[REDACTED: assigned secret]")).toEqual([]);
    expect(findSecrets("API_KEY=ghp_••••••••4f2a")).toEqual([]);
  });

  it("does not treat a publishable key as a secret", () => {
    expect(findSecrets(`NEXT_PUBLIC_POSTHOG_KEY=${FIRST_PARTY}`)).toEqual([]);
  });
});

// THE ONE-DIRECTIONAL PROPERTY. The detector may be narrower than the redactor;
// it must never be wider. A value the report can NAME but the redactor cannot
// MASK is a leak inside the leak report.
describe("everything the detector finds, the redactor can mask", () => {
  it("holds for every recognized credential shape", () => {
    for (const line of [
      `GITHUB_TOKEN=${GH}`,
      `ANTHROPIC_API_KEY=sk-ant-api03-${"A".repeat(40)}`,
      `AWS_ACCESS_KEY_ID=AKIA${"3QXZ7YTNBVCD2WLM"}`,
    ]) {
      const found = findSecrets(line);
      expect(found.length, line).toBeGreaterThan(0);
      const masked = redactExample(line);
      for (const f of found) {
        expect(masked, `detector reported ${f.rule} in "${line}" that the redactor left intact`)
          .not.toContain(f.value);
      }
    }
  });
});

describe("flattenToolInput", () => {
  it("reaches every string leaf, not just `command`", () => {
    const flat = flattenToolInput({
      file_path: "/tmp/deploy.sh",
      content: `export GITHUB_TOKEN=${GH}`,
      nested: { deeper: [{ more: "x" }] },
    });
    expect(findSecrets(flat).some((f) => f.value === GH)).toBe(true);
  });

  it("keeps a key adjacent to a shaped value so its name can be attached", () => {
    const flat = flattenToolInput({ api_key: GH });
    expect(findSecrets(flat).map((f) => f.name)).toContain("api_key");
  });

  it("is bounded, so a pathological payload cannot recurse forever", () => {
    let deep: unknown = "x";
    for (let i = 0; i < 50; i++) deep = { n: deep };
    expect(() => flattenToolInput(deep)).not.toThrow();
  });
});

// The single highest-value refuter, and the only decisive one. Measured on the
// real corpus: 456 of 457 `AKIA` matches were AWS's own documentation literal —
// 99.8% of that pattern's entire output, 232 findings collapsing to zero.
describe("the docs-literal denylist", () => {
  it("drops a credential the vendor published on purpose", () => {
    // Assembled from parts so this test file does not itself contain the
    // literal — a denylist written in plaintext is a file our scanner flags.
    const awsDocsKey = "AKIA" + "IOSFODNN7EXAMPLE";
    expect(findSecrets(`AWS_ACCESS_KEY_ID=${awsDocsKey}`)).toEqual([]);
    expect(findSecrets(`export ${awsDocsKey}`)).toEqual([]);
  });

  it("still reports a real key of the same shape", () => {
    const realShape = "AKIA" + "3QXZ7YTNBVCD2WLM";
    expect(findSecrets(`AWS_ACCESS_KEY_ID=${realShape}`).length).toBeGreaterThan(0);
  });

  it("cannot false-positive — it is a hash comparison, not a heuristic", () => {
    const almost = "AKIA" + "IOSFODNN7EXAMPLF"; // one byte different
    expect(findSecrets(`AWS_ACCESS_KEY_ID=${almost}`).length).toBeGreaterThan(0);
  });
});

// Auditing for secrets writes secrets into the corpus the next audit reads.
// The largest organic cluster in 1.6GB of transcripts was one file: a previous
// audit quoting back what it had found. 108 of 161 firing patterns fired ONLY
// inside the investigation's own transcripts.
describe("self-exclusion", () => {
  it("ignores our own report replayed back into a transcript", () => {
    expect(findSecrets(`GITHUB_TOKEN=[REDACTED: assigned secret]`)).toEqual([]);
    expect(
      findSecrets(`failproofai audit found: GITHUB_TOKEN=${GH}`),
      "our own report quoting a key back is not a new leak",
    ).toEqual([]);
  });

  it("does not mistake ordinary work for our output", () => {
    expect(findSecrets(`GITHUB_TOKEN=${GH}`).length).toBeGreaterThan(0);
  });
});

// The prefilter is what makes the pattern set shippable: cost is LINEAR in
// pattern count (~0.095s per pattern per 6MB), so 288 patterns over 1.6GB is
// about two hours while the few that ever match take five seconds. It must buy
// that speed without changing a single answer.
describe("the literal prefilter", () => {
  it("finds exactly what an ungated scan would", () => {
    // Every shape in this file's battery, run through the gated path. If the
    // gate ever drops a pattern's prefix these go quiet — which is the failure
    // mode that looks identical to "no secrets here".
    const cases: [string, boolean][] = [
      [`GITHUB_TOKEN=${GH}`, true],
      [`export ANTHROPIC_API_KEY=sk-ant-api03-${"A".repeat(40)}`, true],
      [`AWS_ACCESS_KEY_ID=AKIA${"3QXZ7YTNBVCD2WLM"}`, true],
      [`SLACK=xoxb-${"1111111111-2222222222-abcdefghijklmnopqrstuvwx"}`, true],
      [`TELEGRAM_BOT_TOKEN=1234567890:${"A".repeat(35)}`, true],
      [`COMPOSIO_API_KEY=${FIRST_PARTY}`, false],
      ["git commit -m 'nothing to see'", false],
      ["const x = 1; // ordinary source", false],
    ];
    for (const [text, shouldFind] of cases) {
      expect(findSecrets(text).length > 0, text).toBe(shouldFind);
    }
  });

  it("still matches a pattern that has no literal prefix to gate on", () => {
    // A connection string starts with a scheme alternation, so it yields no
    // gate token and must always be run rather than silently skipped.
    const found = findSecrets("psql postgresql://admin:hunter2placeholder@db.internal:5432/prod");
    expect(found.length).toBeGreaterThan(0);
  });

  it("is cheap on text that contains no credential at all", () => {
    // The common case by an enormous margin: most transcript bytes are prose
    // and source. 1MB of it must not cost 33 full regex passes.
    const haystack = "lorem ipsum dolor sit amet ".repeat(40_000);
    const started = Date.now();
    findSecrets(haystack);
    expect(Date.now() - started).toBeLessThan(200);
  });
});

// Name-only matching produced hundreds of ordinary code literals and synthetic
// scanner fixtures on the measured machine. Names now annotate only values a
// recognizable credential shape already established.
describe("names never create findings", () => {
  const found = (text: string) => findSecrets(text).length > 0;

  it("drops both explicit secret names and ambiguous programming vocabulary", () => {
    for (const text of [
      "DB_PASSWORD=hunter2secret",
      'apiKey: "Zk7Qw2Lm9Xr4Tp8Vb1Nc6Hs3"',
      'authToken="Zq7Kp2Lm9Xr4Tv8Nb1Hc6Ws3Ee5"',
      "keyType=primary",
      "tokenLimitCancelled=false",
      "max_output_tokens=4096",
      "resultKey=someLongCamelCaseFieldName",
      "configDirKey=user-config-directory-path",
      "sig=abcdefgh",
      "tokens=1024",
      "keyType=standardIssueValueHere",
    ]) {
      expect(found(text), text).toBe(false);
    }
  });

  it("still attaches a name to a recognizable vendor key", () => {
    expect(found("token=ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8")).toBe(true);
    expect(found("keyType=" + "sk-ant-api03-" + "Zq7".repeat(30))).toBe(true);
  });
});
