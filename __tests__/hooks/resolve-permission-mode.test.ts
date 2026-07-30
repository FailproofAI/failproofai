// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../lib/codex-sessions", () => ({
  findCodexTranscript: vi.fn(),
}));

import {
  resolvePermissionMode,
  CODEX_MODE_SCAN_MAX_BYTES,
  CODEX_MODE_SCAN_MAX_LINES,
} from "../../src/hooks/resolve-permission-mode";
import { findCodexTranscript } from "../../lib/codex-sessions";
import type { IntegrationType } from "../../src/hooks/types";

const dir = mkdtempSync(join(tmpdir(), "fpai-codex-mode-"));
let fileSeq = 0;

/** Write a transcript and point findCodexTranscript at it. */
function transcript(lines: string[]): string {
  const path = join(dir, `rollout-${fileSeq++}.jsonl`);
  writeFileSync(path, lines.join("\n") + "\n");
  vi.mocked(findCodexTranscript).mockReturnValue(path);
  return path;
}

const turnContext = (approvalPolicy: string) =>
  JSON.stringify({ type: "turn_context", payload: { approval_policy: approvalPolicy } });

const sessionMeta = JSON.stringify({ type: "session_meta", payload: { cwd: "/repo" } });

/** A filler record of roughly `bytes` length that never contains "turn_context". */
function filler(bytes: number): string {
  const shell = JSON.stringify({ type: "event_msg", payload: { text: "" } });
  return JSON.stringify({
    type: "event_msg",
    payload: { text: "x".repeat(Math.max(1, bytes - shell.length)) },
  });
}

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolvePermissionMode — non-Codex CLIs", () => {
  it("claude reads permission_mode straight off stdin", () => {
    expect(resolvePermissionMode("claude", { permission_mode: "plan" }, "s")).toBe("plan");
  });

  it("claude falls back to default when stdin omits it", () => {
    expect(resolvePermissionMode("claude", {}, "s")).toBe("default");
  });

  const others: IntegrationType[] = ["copilot", "cursor", "opencode", "pi"];
  it.each(others)("%s falls back to default and never touches the disk", (cli) => {
    expect(resolvePermissionMode(cli, {}, "s")).toBe("default");
    expect(findCodexTranscript).not.toHaveBeenCalled();
  });

  it("codex without a sessionId falls back to default without discovery", () => {
    expect(resolvePermissionMode("codex", {}, undefined)).toBe("default");
    expect(findCodexTranscript).not.toHaveBeenCalled();
  });

  it("codex falls back to default when no transcript is found", () => {
    vi.mocked(findCodexTranscript).mockReturnValue(null);
    expect(resolvePermissionMode("codex", {}, "sess-codex")).toBe("default");
  });

  it("codex falls back to default when the transcript path does not exist", () => {
    vi.mocked(findCodexTranscript).mockReturnValue(join(dir, "does-not-exist.jsonl"));
    expect(resolvePermissionMode("codex", {}, "sess-codex")).toBe("default");
  });
});

describe("resolvePermissionMode — Codex turn_context mapping", () => {
  it("maps approval_policy never → full-auto", () => {
    transcript([sessionMeta, turnContext("never")]);
    expect(resolvePermissionMode("codex", {}, "sess-codex")).toBe("full-auto");
  });

  it("maps approval_policy on-request → default", () => {
    transcript([sessionMeta, turnContext("on-request")]);
    expect(resolvePermissionMode("codex", {}, "sess-codex")).toBe("default");
  });

  it("passes an unrecognized approval_policy through verbatim", () => {
    transcript([sessionMeta, turnContext("untrusted")]);
    expect(resolvePermissionMode("codex", {}, "sess-codex")).toBe("untrusted");
  });

  it("skips malformed JSON lines without crashing", () => {
    transcript(["not json but mentions turn_context", turnContext("never")]);
    expect(resolvePermissionMode("codex", {}, "sess-codex")).toBe("full-auto");
  });

  it("ignores a record that merely mentions turn_context in its text", () => {
    transcript([
      JSON.stringify({ type: "event_msg", payload: { text: "grep turn_context foo" } }),
    ]);
    expect(resolvePermissionMode("codex", {}, "sess-codex")).toBe("default");
  });

  it("returns the FIRST turn_context, ignoring later re-negotiations", () => {
    transcript([sessionMeta, turnContext("never"), turnContext("on-request")]);
    expect(resolvePermissionMode("codex", {}, "sess-codex")).toBe("full-auto");
  });
});

describe("resolvePermissionMode — the Codex scan is bounded", () => {
  it("resolves identically on a transcript far larger than the byte bound when turn_context is early", () => {
    // Real transcripts on disk reach several MB with turn_context at ~84 KB.
    const tail: string[] = [];
    let bytes = 0;
    while (bytes < CODEX_MODE_SCAN_MAX_BYTES * 2) {
      const line = filler(4096);
      tail.push(line);
      bytes += line.length + 1;
    }
    transcript([sessionMeta, turnContext("never"), ...tail]);
    expect(resolvePermissionMode("codex", {}, "sess-codex")).toBe("full-auto");
  });

  it("degrades to the not-found default (not a throw) when turn_context is past the byte bound", () => {
    const head: string[] = [];
    let bytes = 0;
    while (bytes < CODEX_MODE_SCAN_MAX_BYTES + 8192) {
      const line = filler(4096);
      head.push(line);
      bytes += line.length + 1;
    }
    transcript([...head, turnContext("never")]);
    expect(() => resolvePermissionMode("codex", {}, "sess-codex")).not.toThrow();
    expect(resolvePermissionMode("codex", {}, "sess-codex")).toBe("default");
  });

  it("does not parse the fragment of a record straddling the window edge", () => {
    // One giant record that starts inside the window and runs past its end, so
    // the head read cuts it mid-JSON. The fragment must be dropped, not parsed.
    const straddling = JSON.stringify({
      type: "turn_context",
      payload: { approval_policy: "never", pad: "x".repeat(CODEX_MODE_SCAN_MAX_BYTES) },
    });
    transcript([filler(CODEX_MODE_SCAN_MAX_BYTES - 4096), straddling]);
    expect(() => resolvePermissionMode("codex", {}, "sess-codex")).not.toThrow();
    expect(resolvePermissionMode("codex", {}, "sess-codex")).toBe("default");
  });

  it("still resolves a turn_context just inside the line bound", () => {
    const head = Array.from({ length: CODEX_MODE_SCAN_MAX_LINES - 10 }, () => filler(40));
    transcript([...head, turnContext("never")]);
    expect(resolvePermissionMode("codex", {}, "sess-codex")).toBe("full-auto");
  });

  it("degrades to default when turn_context sits past the line bound", () => {
    const head = Array.from({ length: CODEX_MODE_SCAN_MAX_LINES }, () => filler(40));
    transcript([...head, turnContext("never")]);
    expect(resolvePermissionMode("codex", {}, "sess-codex")).toBe("default");
  });

  it("reads no more than the byte bound even from a very large transcript", () => {
    // Guards the bound itself: the whole file is one long line of filler, so a
    // full read would materialize megabytes. The call must stay fast and quiet.
    const path = join(dir, "huge.jsonl");
    writeFileSync(path, filler(CODEX_MODE_SCAN_MAX_BYTES * 8) + "\n");
    vi.mocked(findCodexTranscript).mockReturnValue(path);
    expect(resolvePermissionMode("codex", {}, "sess-codex")).toBe("default");
  });
});
