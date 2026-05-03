// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  KNOWN_CLI_IDS,
  getCliEntry,
  getCliLabel,
  getCliBadgeClasses,
  isKnownCli,
  listCliEntries,
  listExternalCliEntries,
} from "@/lib/cli-registry";

describe("lib/cli-registry", () => {
  it("KNOWN_CLI_IDS lists all supported CLIs in stable order", () => {
    expect(KNOWN_CLI_IDS).toEqual(["claude", "codex", "copilot", "cursor", "opencode", "pi"]);
  });

  it("getCliEntry returns the entry for known ids and undefined for unknown", () => {
    expect(getCliEntry("claude")?.label).toBe("Claude Code");
    expect(getCliEntry("codex")?.label).toBe("OpenAI Codex");
    expect(getCliEntry("copilot")?.label).toBe("GitHub Copilot");
    expect(getCliEntry("cursor")?.label).toBe("Cursor Agent");
    expect(getCliEntry("opencode")?.label).toBe("OpenCode");
    expect(getCliEntry("pi")?.label).toBe("Pi");
    expect(getCliEntry("unknown")).toBeUndefined();
  });

  it("getCliLabel falls back to the id itself for unknown", () => {
    expect(getCliLabel("claude")).toBe("Claude Code");
    expect(getCliLabel("pi")).toBe("Pi");
    expect(getCliLabel("xyz")).toBe("xyz");
  });

  it("getCliBadgeClasses returns Claude classes for unknown ids", () => {
    expect(getCliBadgeClasses("copilot")).toContain("blue");
    expect(getCliBadgeClasses("codex")).toContain("purple");
    expect(getCliBadgeClasses("claude")).toContain("orange");
    expect(getCliBadgeClasses("cursor")).toContain("emerald");
    expect(getCliBadgeClasses("opencode")).toContain("amber");
    expect(getCliBadgeClasses("pi")).toContain("pink");
    expect(getCliBadgeClasses("unknown")).toContain("orange"); // falls back to claude
  });

  it("isKnownCli is null/undefined-safe", () => {
    expect(isKnownCli("claude")).toBe(true);
    expect(isKnownCli("copilot")).toBe(true);
    expect(isKnownCli("cursor")).toBe(true);
    expect(isKnownCli("opencode")).toBe(true);
    expect(isKnownCli("pi")).toBe(true);
    expect(isKnownCli("nope")).toBe(false);
    expect(isKnownCli(null)).toBe(false);
    expect(isKnownCli(undefined)).toBe(false);
    expect(isKnownCli("")).toBe(false);
  });

  it("isKnownCli rejects inherited Object.prototype keys", () => {
    // Regression for the hasOwnProperty fix landed in #236.
    expect(isKnownCli("toString")).toBe(false);
    expect(isKnownCli("constructor")).toBe(false);
    expect(isKnownCli("hasOwnProperty")).toBe(false);
  });

  it("listCliEntries returns one entry per known id", () => {
    const ids = listCliEntries().map((c) => c.id);
    expect(ids).toEqual(KNOWN_CLI_IDS);
  });

  it("listExternalCliEntries excludes claude", () => {
    const ids = listExternalCliEntries().map((c) => c.id);
    expect(ids).toEqual(["codex", "copilot", "cursor", "opencode", "pi"]);
  });

  it("each CLI has a unique badgeClasses string", () => {
    const classes = listCliEntries().map((c) => c.badgeClasses);
    expect(new Set(classes).size).toBe(classes.length);
  });
});
