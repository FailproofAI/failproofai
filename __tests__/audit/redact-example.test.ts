/**
 * The redactor is the only thing standing between a real command line and an
 * email, so these test what it REMOVES rather than what it keeps.
 */
import { describe, it, expect } from "vitest";

import {
  REDACTED_EXAMPLE_MAX_CHARS,
  maskSecrets,
  redactExample,
  shortenPaths,
} from "../../src/audit/redact-example";

const HOME = "/home/sidd";

describe("maskSecrets", () => {
  it("masks every secret shape the sanitize policies block on", () => {
    // Sharing `SECRET_PATTERNS` with the policies is the point; this asserts the
    // sharing actually reaches the redactor rather than being a comment.
    const cases: [string, string][] = [
      ["curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123'", "bearer token"],
      ["export ANTHROPIC_API_KEY=sk-ant-abcdefghijklmnopqrstuvwxyz", "Anthropic API key"],
      ["gh auth login --with-token ghp_abcdefghijklmnopqrstuvwxyz1234567890", "GitHub personal access token"],
      ["aws configure set aws_access_key_id AKIAIOSFODNN7EXAMPLE", "AWS access key ID"],
      ["psql postgresql://admin:hunter2@db.internal:5432/prod", "database credentials"],
      ["cat key.pem  -----BEGIN RSA PRIVATE KEY-----", "private key"],
    ];
    for (const [input, label] of cases) {
      const out = maskSecrets(input);
      expect(out, input).toContain(`[REDACTED: ${label}]`);
    }
  });

  it("masks EVERY occurrence, not just the first", () => {
    // The `lastIndex` trap: a shared global regex would carry position across
    // calls and skip matches depending on where it stopped last time — which
    // only shows up once a policy has more than one example, and reads as
    // flakiness rather than logic.
    const two = "AKIAIOSFODNN7EXAMPLE and AKIAJKLMNOPQRSTUVWXY";
    const out = maskSecrets(two);
    expect(out).not.toMatch(/AKIA[A-Z0-9]{16}/);
    expect(out.match(/\[REDACTED: AWS access key ID\]/g)).toHaveLength(2);
  });

  it("is stable across repeated calls", () => {
    // The same trap from the other side: calling twice must give the same
    // answer, which a stateful shared regex would not.
    const s = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
    expect(maskSecrets(s)).toBe(maskSecrets(s));
  });

  it("leaves ordinary text alone", () => {
    const s = "git commit -m 'fix the parser'";
    expect(maskSecrets(s)).toBe(s);
  });
});

describe("shortenPaths", () => {
  it("reduces a home path to ~/…/basename", () => {
    expect(shortenPaths("/home/sidd/work/acme/src/db.ts", HOME)).toBe("~/…/db.ts");
  });

  it("drops the project directory, which is the most identifying token", () => {
    // Usually a client or employer name. The basename is what makes a finding
    // recognisable; the chain above it is a map of someone's disk.
    const out = shortenPaths("/home/sidd/clients/big-bank-plc/.env.production", HOME);
    expect(out).toBe("~/…/.env.production");
    expect(out).not.toContain("big-bank-plc");
  });

  it("shortens paths OUTSIDE home too", () => {
    // "not under home" is not the same as "safe to send" — a build agent's
    // checkout lives under /build as often as anywhere.
    expect(shortenPaths("/etc/ssl/private/server.key", HOME)).toBe("/…/server.key");
    expect(shortenPaths("/var/lib/secrets/token.yml", HOME)).toBe("/…/token.yml");
  });

  it("keeps a command recognisable around the path", () => {
    expect(shortenPaths("cat /home/sidd/work/acme/.env", HOME)).toBe("cat ~/…/.env");
  });

  it("leaves relative paths and flags alone", () => {
    const s = "rm -rf ./node_modules --force";
    expect(shortenPaths(s, HOME)).toBe(s);
  });
});

describe("redactExample", () => {
  it("masks before shortening, so a secret inside a path cannot be sliced apart", () => {
    // If shortening ran first it would cut the path mid-token, and the fragment
    // would no longer match its own pattern — shipping half a credential.
    const out = redactExample("/home/sidd/ghp_abcdefghijklmnopqrstuvwxyz1234567890/x.txt", HOME);
    expect(out).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz1234567890");
    expect(out).toContain("[REDACTED: GitHub personal access token]");
  });

  it("collapses a multi-line command onto one row", () => {
    // A heredoc reaches the digest as one line; a raw newline breaks the
    // plain-text layout and says nothing the single line does not.
    expect(redactExample("cat <<EOF\nsecretless body\nEOF", HOME)).toBe(
      "cat <<EOF secretless body EOF",
    );
  });

  it("caps length with an ellipsis", () => {
    const out = redactExample("x".repeat(500), HOME);
    expect(out.length).toBe(REDACTED_EXAMPLE_MAX_CHARS);
    expect(out.endsWith("…")).toBe(true);
  });

  it("handles the realistic case end to end", () => {
    const out = redactExample(
      "cat /home/sidd/work/acme/.env.production | grep sk-ant-abcdefghijklmnopqrstuvwxyz",
      HOME,
    );
    expect(out).toContain("~/…/.env.production");
    expect(out).toContain("[REDACTED: Anthropic API key]");
    expect(out).not.toContain("acme");
    expect(out).not.toContain("sk-ant-abcdefghijklmnopqrstuvwxyz");
  });
});
