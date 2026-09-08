// @vitest-environment node
import { describe, it, expect } from "vitest";
import { fingerprintSecret, fingerprintId } from "@/src/audit/leak-fingerprint";
import { SECRET_PATTERNS } from "@/src/hooks/builtin-policies";

/** Obviously-synthetic values. Shapes are real; the bytes are not. */
const SYNTHETIC = {
  githubPat: "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
  awsKeyId: "AKIA" + "IOSFODNN7SYNTHET",
  anthropic: "sk-ant-api03-" + "A".repeat(60) + "Zq4T",
  slackBot: "xoxb-" + "1111111111-2222222222-SyntheticSlackTok",
  password: "hunter2placeh",
  firstParty: "compsynthetic0000111122223333",
};

describe("fingerprintSecret — identify without disclosing", () => {
  it("shows a minted prefix and the last four, which is what a console displays", () => {
    const fp = fingerprintSecret(SYNTHETIC.githubPat);
    expect(fp.attributed).toBe(true);
    expect(fp.label).toBe("GitHub personal access token");
    expect(fp.display.startsWith("ghp_")).toBe(true);
    expect(fp.display.endsWith(SYNTHETIC.githubPat.slice(-4))).toBe(true);
    expect(fp.length).toBe(SYNTHETIC.githubPat.length);
  });

  it("picks the longest matching prefix, so `sk-ant-api03-` beats `sk-ant-`", () => {
    expect(fingerprintSecret(SYNTHETIC.anthropic).label).toBe("Anthropic API key");
  });

  it("never reveals the middle", () => {
    for (const value of Object.values(SYNTHETIC)) {
      const { display } = fingerprintSecret(value);
      // Every run of 5+ original characters that is not the prefix or the tail
      // must be absent from the rendering.
      const middle = value.slice(6, -6);
      if (middle.length >= 5) {
        expect(display, value).not.toContain(middle);
      }
    }
  });

  // The tail is the actionable half, but only when what stays hidden is
  // genuinely unguessable. The corpus's one confirmed-live password was 13
  // characters at 3.19 bits/char — last-4 there is nearly a third of the secret.
  it("withholds the tail from a short or unminted value", () => {
    const pw = fingerprintSecret(SYNTHETIC.password, "password");
    expect(pw.attributed).toBe(false);
    expect(pw.display).toBe("[13-char password]");
    expect(pw.display).not.toContain(SYNTHETIC.password.slice(-4));

    const firstParty = fingerprintSecret(SYNTHETIC.firstParty, "assigned secret");
    expect(firstParty.attributed).toBe(false);
    expect(firstParty.display).not.toContain(SYNTHETIC.firstParty.slice(-4));
  });

  it("still says how long it was, which is how an owner recognises their own value", () => {
    expect(fingerprintSecret("x".repeat(51), "API key").display).toBe("[51-char API key]");
  });

  // THE ONE THAT MATTERS. `X`, `x` and `0` all satisfy the vendor charsets, so
  // masking with them turns a redacted key back into a detectable one:
  // `AKIA` + sixteen `X`s matches `AKIA[A-Z0-9]{16}`. This product has already
  // measured its own output feeding back into its own corpus, one credential
  // becoming seven findings across four sessions. The mask glyph must appear in
  // no credential charset anywhere.
  it("produces a rendering that our OWN detector cannot mistake for a live key", () => {
    for (const [name, value] of Object.entries(SYNTHETIC)) {
      const { display } = fingerprintSecret(value);
      for (const [pattern, label] of SECRET_PATTERNS) {
        const re = new RegExp(pattern.source, pattern.flags.replace("g", ""));
        expect(re.test(display), `${name} rendered as "${display}" re-matched ${label}`).toBe(false);
      }
    }
  });

  it("proves the naive mask characters WOULD have re-matched", () => {
    // Guards the reasoning above: if this ever stops being true the mask glyph
    // choice is no longer load-bearing and this module's header is stale.
    const naive = "AKIA" + "X".repeat(16);
    const anyMatch = SECRET_PATTERNS.some(([p]) =>
      new RegExp(p.source, p.flags.replace("g", "")).test(naive),
    );
    expect(anyMatch).toBe(true);
  });
});

describe("fingerprintId — stable, and not an oracle", () => {
  it("is stable for the same value and salt, so a finding dedupes across scans", () => {
    expect(fingerprintId("value-a", "salt-1")).toBe(fingerprintId("value-a", "salt-1"));
  });

  it("differs per value and per machine salt", () => {
    expect(fingerprintId("value-a", "salt-1")).not.toBe(fingerprintId("value-b", "salt-1"));
    // The salt is what stops the id being a confirmation oracle for a guessable
    // secret — the corpus is full of dictionary passwords.
    expect(fingerprintId("value-a", "salt-1")).not.toBe(fingerprintId("value-a", "salt-2"));
  });

  it("never contains the value", () => {
    const id = fingerprintId("hunter2placeholder", "salt-1");
    expect(id).not.toContain("hunter2");
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });
});
