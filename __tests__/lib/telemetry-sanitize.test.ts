// @vitest-environment node
import { describe, it, expect, vi, afterEach } from "vitest";
import os from "node:os";
import { sanitizeErrorMessage } from "../../lib/telemetry-sanitize";

describe("sanitizeErrorMessage", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns the message for a plain Error", () => {
    expect(sanitizeErrorMessage(new Error("disk exploded"))).toBe("disk exploded");
  });

  it("stringifies a non-Error throw", () => {
    expect(sanitizeErrorMessage("raw string failure")).toBe("raw string failure");
  });

  it("collapses the user's home directory to ~", () => {
    vi.spyOn(os, "homedir").mockReturnValue("/home/alice");
    expect(sanitizeErrorMessage(new Error("cannot read /home/alice/.codex/x.jsonl"))).toBe(
      "cannot read ~/.codex/x.jsonl",
    );
  });

  it("replaces every occurrence of the home path", () => {
    vi.spyOn(os, "homedir").mockReturnValue("/home/alice");
    expect(
      sanitizeErrorMessage(new Error("/home/alice/a vs /home/alice/b")),
    ).toBe("~/a vs ~/b");
  });

  it("does not mangle messages when homedir is root", () => {
    vi.spyOn(os, "homedir").mockReturnValue("/");
    expect(sanitizeErrorMessage(new Error("/etc/passwd missing"))).toBe("/etc/passwd missing");
  });

  it("truncates long messages to 300 chars + ellipsis", () => {
    const long = "x".repeat(500);
    const out = sanitizeErrorMessage(new Error(long));
    expect(out.length).toBe(301); // 300 + the "…" marker
    expect(out.endsWith("…")).toBe(true);
  });

  it("returns empty string for an empty message", () => {
    expect(sanitizeErrorMessage(new Error(""))).toBe("");
  });
});
