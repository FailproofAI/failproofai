// @vitest-environment node
import { describe, expect, it } from "vitest";

import { isCredentialResearchSession, mergeIncremental } from "@/src/audit";
import type { NormalizedToolEvent, TranscriptAuditResult, TranscriptLeak } from "@/src/audit/types";

function event(command: string): NormalizedToolEvent {
  return {
    cli: "claude",
    sessionId: "session-1",
    transcriptPath: "/tmp/session.jsonl",
    cwd: "/repo",
    timestamp: "2026-09-09T00:00:00.000Z",
    toolName: "Bash",
    rawToolName: "Bash",
    toolInput: { command },
  };
}

function result(over: Partial<TranscriptAuditResult> = {}): TranscriptAuditResult {
  return {
    transcriptPath: "/tmp/session.jsonl",
    cli: "claude",
    projectName: "repo",
    sessionId: "session-1",
    mtimeMs: 1,
    sizeBytes: 10,
    cwd: "/repo",
    eventsScanned: 1,
    hitsByName: {},
    examplesByName: {},
    rangeByName: {},
    ...over,
  };
}

const LEAK: TranscriptLeak = {
  id: "1111111111111111",
  fingerprint: { display: "ghp_••••••••4f2a", label: "GitHub token", length: 40, attributed: true },
  name: "GITHUB_TOKEN",
  rule: "GitHub personal access token",
  shaped: true,
  timestamp: "2026-09-09T00:00:00.000Z",
  cwd: "/repo",
  toolName: "Bash",
  direction: "input",
  path: null,
};

describe("credential research session suppression", () => {
  it("requires multiple independent signs of deliberate detector work", () => {
    expect(isCredentialResearchSession([
      event("rg SECRET_PATTERNS src/audit/leak-scan.ts"),
      event("bun test secret scanner with synthetic credential fixtures"),
    ])).toBe(true);
  });

  it("recognizes repeated command-line hunting even without scanner source names", () => {
    expect(isCredentialResearchSession([
      event("grep -lF token *.json"),
      event("rg 'secret|credential' corpus/"),
      event("python scan.py --search-token-shapes"),
    ])).toBe(true);
  });

  it("uses a host-authored subagent purpose when the tool commands are opaque", () => {
    expect(isCredentialResearchSession(
      [event("python3 /tmp/job.py")],
      "Hunt secrets at rest in transcripts",
    )).toBe(true);
  });

  it("does not suppress ordinary sessions that merely mention credentials", () => {
    expect(isCredentialResearchSession([
      event("rotate the leaked credential in production"),
      event("git status --short"),
    ])).toBe(false);
  });

  it("clears cached leaks when a resumed tail proves the session is research", () => {
    const merged = mergeIncremental(
      result({ leaks: [LEAK] }),
      result({ leakScanSuppressed: "credential-research", leaks: [] }),
    );
    expect(merged.leakScanSuppressed).toBe("credential-research");
    expect(merged.leaks).toEqual([]);
  });

  it("retains leaks from both halves of an ordinary resumed session", () => {
    const second = { ...LEAK, id: "2222222222222222" };
    expect(mergeIncremental(result({ leaks: [LEAK] }), result({ leaks: [second] })).leaks)
      .toEqual([LEAK, second]);
  });
});
