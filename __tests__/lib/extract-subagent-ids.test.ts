import { describe, it, expect } from "vitest";
import { extractSubagentIds } from "@/lib/extract-subagent-ids";

describe("extractSubagentIds", () => {
  it("returns deduped ids from valid user entries", () => {
    const fileContent = [
      JSON.stringify({ type: "user", toolUseResult: { agentId: "abc123" } }),
      JSON.stringify({ type: "user", toolUseResult: { agentId: "def456" } }),
      JSON.stringify({ type: "user", toolUseResult: { agentId: "abc123" } }),
    ].join("\n");

    expect(extractSubagentIds(fileContent)).toEqual(["abc123", "def456"]);
  });

  it("skips malformed JSON lines silently", () => {
    const fileContent = [
      JSON.stringify({ type: "user", toolUseResult: { agentId: "abc123" } }),
      "{bad json",
      JSON.stringify({ type: "user", toolUseResult: { agentId: "def456" } }),
    ].join("\n");

    expect(extractSubagentIds(fileContent)).toEqual(["abc123", "def456"]);
  });

  it("ignores entries where type is not user", () => {
    const fileContent = [
      JSON.stringify({ type: "assistant", toolUseResult: { agentId: "abc123" } }),
      JSON.stringify({ type: "system", toolUseResult: { agentId: "def456" } }),
    ].join("\n");

    expect(extractSubagentIds(fileContent)).toEqual([]);
  });

  it("rejects non-hex agent ids", () => {
    const fileContent = [
      JSON.stringify({ type: "user", toolUseResult: { agentId: "abc123" } }),
      JSON.stringify({ type: "user", toolUseResult: { agentId: "abc123g" } }),
      JSON.stringify({ type: "user", toolUseResult: { agentId: "ABC123" } }),
    ].join("\n");

    expect(extractSubagentIds(fileContent)).toEqual(["abc123"]);
  });

  it("ignores entries missing toolUseResult", () => {
    const fileContent = [
      JSON.stringify({ type: "user" }),
      JSON.stringify({ type: "user", toolUseResult: null }),
    ].join("\n");

    expect(extractSubagentIds(fileContent)).toEqual([]);
  });

  it("returns an empty array for empty input", () => {
    expect(extractSubagentIds("")).toEqual([]);
  });
});
