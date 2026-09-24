import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { redactJsonLine, redactionEnabled, scrubString } from "../src/redact.js";
import { runtime } from "../src/runtime.js";
import { useSpool } from "./helpers.js";
import type { Spool } from "./helpers.js";

/**
 * The SDK redacts before bytes reach disk; the daemon redacts again before
 * upload. Both sides implement the same rules, so these cases are the contract
 * between them — a rule that matches here and not there means a credential
 * sitting in a spool file waiting for a collector that will not clean it.
 *
 * ## Why the fixtures are assembled rather than written out
 *
 * A credential-shaped literal in a source file is a credential-shaped literal,
 * whatever the comment beside it says. This repository scans itself for exactly
 * these prefixes (and so does every CI secret scanner worth having), so a test
 * that spelled one out would trip its own tooling and train everybody to wave
 * the alert through. `fake()` builds the same bytes at runtime from parts that
 * are individually meaningless.
 */
const fake = (...parts: string[]): string => parts.join("");

const ANTHROPIC = fake("sk-", "ant-", "api03-", "A".repeat(20));
const GITHUB = fake("ghp", "_", "A".repeat(24));
const GITHUB_OTHER = fake("ghp", "_", "B".repeat(24));
const AWS = fake("AKIA", "IOSFODNN7EXAMPLE1234");
const SLACK = fake("xoxb", "-1234567890-ABCDEFGHIJKLMNOP");

describe("scrubString", () => {
  const redacted = (value: string): string => scrubString(value)[0];

  it("redacts provider key prefixes at a token boundary", () => {
    expect(redacted(`use ${ANTHROPIC} now`)).toBe("use [redacted:anthropic-key] now");
    expect(redacted(GITHUB)).toBe("[redacted:github-token]");
    expect(redacted(AWS)).toBe("[redacted:aws-access-key-id]");
    expect(redacted(SLACK)).toBe("[redacted:slack-token]");
  });

  it("leaves a prefix that is too short to be a key", () => {
    expect(redacted(fake("sk-", "short"))).toBe("sk-short");
  });

  it("does not fire mid-token, where a match would be a coincidence", () => {
    expect(redacted(`x${ANTHROPIC}`)).toBe(`x${ANTHROPIC}`);
  });

  it("redacts a three-segment JWT", () => {
    const jwt = fake("eyJ", "hbGciOiJIUzI1NiJ9", ".", "a".repeat(30), ".", "b".repeat(20));
    expect(redacted(jwt)).toBe("[redacted:jwt]");
  });

  it("redacts a bearer token, case-insensitively on the scheme", () => {
    expect(redacted('Authorization: Bearer abcdefghijkl"')).toBe(
      'Authorization: [redacted:bearer-token]"',
    );
    expect(redacted("authorization: bearer abcdefghijkl")).toBe(
      "authorization: [redacted:bearer-token]",
    );
  });

  it("redacts a secret-shaped assignment but not an ordinary one", () => {
    expect(redacted("API_KEY=abcdefghijklmnop")).toBe("API_KEY=[redacted:secret-assignment]");
    expect(redacted('DB_PASSWORD="hunter2hunter2"')).toBe(
      'DB_PASSWORD="[redacted:secret-assignment]"',
    );
    // `key` on its own is too weak a name to be a secret; only a compound one
    // counts, or the redactor eats every ordinary `key=` in a tool output.
    expect(redacted("key=abcdefghijklmnop")).toBe("key=abcdefghijklmnop");
    expect(redacted("NAME=abcdefghijklmnop")).toBe("NAME=abcdefghijklmnop");
  });

  it("leaves an interpolated or placeholder value alone", () => {
    expect(redacted("API_KEY=${SECRET_FROM_VAULT}")).toBe("API_KEY=${SECRET_FROM_VAULT}");
    expect(redacted("API_KEY=<your-key-here>")).toBe("API_KEY=<your-key-here>");
  });

  it("returns the original string when nothing matched", () => {
    const value = "a perfectly ordinary tool output";
    const [scrubbed, hits] = scrubString(value);
    expect(hits).toBe(0);
    expect(scrubbed).toBe(value);
  });

  it("counts UTF-8 bytes, not code units, for the length thresholds", () => {
    // Two 3-byte characters is 6 bytes — under the bearer minimum of 8 — but a
    // naive code-unit count would see 2 and a naive character count would see
    // 2 as well, so only a byte count refuses this one and accepts the next.
    expect(redacted("Bearer 日本")).toBe("Bearer 日本");
    expect(redacted("Bearer 日本語日本語日本")).toBe("[redacted:bearer-token]");
  });
});

describe("redactJsonLine", () => {
  it("redacts values, and leaves an untouched line byte-identical", () => {
    const clean = JSON.stringify({ type: "tool_use", input: { q: "kites" } });
    expect(redactJsonLine(clean)).toBe(clean);

    const dirty = JSON.stringify({ type: "tool_use", input: { token: GITHUB } });
    expect(JSON.parse(redactJsonLine(dirty)).input.token).toBe("[redacted:github-token]");
  });

  it("redacts a secret-NAMED field even when the value has no recognisable shape", () => {
    const line = JSON.stringify({ type: "t", api_secret: "totally-ordinary-looking" });
    expect(JSON.parse(redactJsonLine(line)).api_secret).toBe("[redacted:secret-assignment]");
  });

  it("applies the field name to every element of an array value", () => {
    const line = JSON.stringify({ type: "t", api_secret: ["aaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbb"] });
    expect(JSON.parse(redactJsonLine(line)).api_secret).toEqual([
      "[redacted:secret-assignment]",
      "[redacted:secret-assignment]",
    ]);
  });

  it("keeps two keys distinct when redacting collapses them to the same name", () => {
    const line = JSON.stringify({ [GITHUB]: 1, [GITHUB_OTHER]: 2 });
    expect(Object.keys(JSON.parse(redactJsonLine(line)))).toEqual([
      "[redacted:github-token]",
      "[redacted:github-token]#2",
    ]);
  });
});

describe("the daemon's redaction switch", () => {
  it("defaults to ON when there is no config at all", () => {
    const home = mkdtempSync(join(tmpdir(), "fp-config-"));
    expect(redactionEnabled(join(home, "custom-agents"))).toBe(true);
  });

  it("defaults to ON when the config is unreadable or malformed", () => {
    const home = mkdtempSync(join(tmpdir(), "fp-config-"));
    writeFileSync(join(home, "config.json"), "{ not json");
    // Failing open here would mean one typo silently ships credentials.
    expect(redactionEnabled(join(home, "custom-agents"))).toBe(true);
  });

  it("honours an explicit off", () => {
    const home = mkdtempSync(join(tmpdir(), "fp-config-"));
    writeFileSync(join(home, "config.json"), JSON.stringify({ collector: { redact: "off" } }));
    expect(redactionEnabled(join(home, "custom-agents"))).toBe(false);
  });
});

describe("end to end", () => {
  let spool: Spool;
  beforeEach(() => {
    spool = useSpool();
  });
  afterEach(async () => {
    await spool.cleanup();
  });

  it("redacts before the bytes reach disk", async () => {
    runtime.event.toolUse({
      sessionId: "s",
      toolName: "shell",
      toolCallId: "c1",
      input: { command: "curl -H 'Authorization: Bearer abcdefghijklmnop'" },
    });
    await runtime.writer.flushNow();
    const raw = spool.lines().join("");
    expect(raw).not.toContain("abcdefghijklmnop");
    expect(raw).toContain("[redacted:bearer-token]");
  });
});
