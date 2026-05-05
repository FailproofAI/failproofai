// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/codex-sessions", () => ({
  findCodexTranscript: vi.fn(),
}));
vi.mock("../../lib/copilot-sessions", () => ({
  findCopilotTranscript: vi.fn(),
}));
vi.mock("../../lib/cursor-sessions", () => ({
  findCursorTranscript: vi.fn(),
}));
vi.mock("../../lib/pi-sessions", () => ({
  findPiTranscript: vi.fn(),
}));
vi.mock("../../lib/gemini-sessions", () => ({
  findGeminiTranscript: vi.fn(),
}));

import { resolveTranscriptPath } from "../../src/hooks/resolve-transcript-path";
import { findCodexTranscript } from "../../lib/codex-sessions";
import { findCopilotTranscript } from "../../lib/copilot-sessions";
import { findCursorTranscript } from "../../lib/cursor-sessions";
import { findPiTranscript } from "../../lib/pi-sessions";
import { findGeminiTranscript } from "../../lib/gemini-sessions";
import type { IntegrationType } from "../../src/hooks/types";

describe("resolveTranscriptPath", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("stdin passthrough (every CLI)", () => {
    const cases: IntegrationType[] = [
      "claude",
      "codex",
      "copilot",
      "cursor",
      "pi",
      "gemini",
      "opencode",
    ];
    it.each(cases)(
      "returns parsed.transcript_path verbatim when set (%s)",
      (cli) => {
        const out = resolveTranscriptPath(
          cli,
          { transcript_path: "/explicit/path.jsonl" },
          "sess-1",
        );
        expect(out).toBe("/explicit/path.jsonl");
      },
    );
  });

  describe("missing sessionId", () => {
    const cases: IntegrationType[] = [
      "claude",
      "codex",
      "copilot",
      "cursor",
      "pi",
      "gemini",
      "opencode",
    ];
    it.each(cases)("returns undefined when no stdin path AND no sessionId (%s)", (cli) => {
      const out = resolveTranscriptPath(cli, {}, undefined);
      expect(out).toBeUndefined();
    });
  });

  describe("per-CLI fallback discovery (no stdin transcript_path)", () => {
    it("claude → undefined (Claude already provides it on stdin; no disk fallback)", () => {
      const out = resolveTranscriptPath("claude", {}, "sess-claude");
      expect(out).toBeUndefined();
    });

    it("codex → findCodexTranscript(sessionId)", () => {
      vi.mocked(findCodexTranscript).mockReturnValue("/home/u/.codex/sessions/2026/05/05/x.jsonl");
      const out = resolveTranscriptPath("codex", {}, "sess-codex");
      expect(findCodexTranscript).toHaveBeenCalledWith("sess-codex");
      expect(out).toBe("/home/u/.codex/sessions/2026/05/05/x.jsonl");
    });

    it("codex → undefined when helper returns null", () => {
      vi.mocked(findCodexTranscript).mockReturnValue(null);
      const out = resolveTranscriptPath("codex", {}, "sess-codex");
      expect(out).toBeUndefined();
    });

    it("copilot → findCopilotTranscript(sessionId)", () => {
      vi.mocked(findCopilotTranscript).mockReturnValue("/home/u/.copilot/session-state/sess-copilot/events.jsonl");
      const out = resolveTranscriptPath("copilot", {}, "sess-copilot");
      expect(findCopilotTranscript).toHaveBeenCalledWith("sess-copilot");
      expect(out).toBe("/home/u/.copilot/session-state/sess-copilot/events.jsonl");
    });

    it("cursor → findCursorTranscript(sessionId)", () => {
      vi.mocked(findCursorTranscript).mockReturnValue("/home/u/.cursor/projects/x/agent-transcripts/sess-cursor/sess-cursor.jsonl");
      const out = resolveTranscriptPath("cursor", {}, "sess-cursor");
      expect(findCursorTranscript).toHaveBeenCalledWith("sess-cursor");
      expect(out).toBe("/home/u/.cursor/projects/x/agent-transcripts/sess-cursor/sess-cursor.jsonl");
    });

    it("pi → findPiTranscript(sessionId)", () => {
      vi.mocked(findPiTranscript).mockReturnValue("/home/u/.pi/agent/sessions/encoded/2026-05-05_sess-pi.jsonl");
      const out = resolveTranscriptPath("pi", {}, "sess-pi");
      expect(findPiTranscript).toHaveBeenCalledWith("sess-pi");
      expect(out).toBe("/home/u/.pi/agent/sessions/encoded/2026-05-05_sess-pi.jsonl");
    });

    it("gemini → findGeminiTranscript(sessionId)", () => {
      vi.mocked(findGeminiTranscript).mockReturnValue("/home/u/.gemini/tmp/projhash/chats/sess-gemini.json");
      const out = resolveTranscriptPath("gemini", {}, "sess-gemini");
      expect(findGeminiTranscript).toHaveBeenCalledWith("sess-gemini");
      expect(out).toBe("/home/u/.gemini/tmp/projhash/chats/sess-gemini.json");
    });

    it("opencode → synthetic opencode-db://<sessionId> marker (transcripts live in SQLite)", () => {
      const out = resolveTranscriptPath("opencode", {}, "ses_test_opencode001");
      expect(out).toBe("opencode-db://ses_test_opencode001");
    });
  });

  describe("stdin precedence beats fallback", () => {
    it("trusts stdin even when discovery would have returned a different path", () => {
      vi.mocked(findCopilotTranscript).mockReturnValue("/from/disk.jsonl");
      const out = resolveTranscriptPath(
        "copilot",
        { transcript_path: "/from/stdin.jsonl" },
        "sess-x",
      );
      expect(out).toBe("/from/stdin.jsonl");
      expect(findCopilotTranscript).not.toHaveBeenCalled();
    });
  });
});
