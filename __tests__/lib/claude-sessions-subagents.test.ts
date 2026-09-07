// @vitest-environment node
/**
 * The subagent walk below `<sessionId>/subagents/`.
 *
 * This exists because the enumerator read only the DIRECT children of that
 * directory, which was right for the layout Claude shipped when it was written
 * and silently wrong once workflow runs began nesting their agents one level
 * further down. On the machine the miss was found on it cost 91% of the corpus:
 * 1,839 transcripts on disk, 160 enumerated. The audit reported that result as
 * though it had read everything, which is the failure mode these tests exist to
 * keep closed — a scan that finds nothing and a scan that looks nowhere are
 * indistinguishable from the outside.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { listClaudeProjects, listClaudeTranscripts } from "@/lib/claude-sessions";

const PARENT_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const PARENT_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

let root: string;
let prevEnv: string | undefined;

/** Write a transcript at `<project>/<...segments>`, creating parents. */
function transcript(project: string, ...segments: string[]): string {
  const path = join(root, project, ...segments);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, '{"type":"user"}\n');
  return path;
}

function allTranscripts() {
  return listClaudeProjects().flatMap((p) => listClaudeTranscripts(p));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fpai-subagents-"));
  prevEnv = process.env.CLAUDE_PROJECTS_PATH;
  process.env.CLAUDE_PROJECTS_PATH = root;
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.CLAUDE_PROJECTS_PATH;
  else process.env.CLAUDE_PROJECTS_PATH = prevEnv;
  rmSync(root, { recursive: true, force: true });
});

describe("listClaudeTranscripts — subagent nesting", () => {
  it("finds a transcript nested under subagents/workflows/<runId>/", () => {
    transcript("-home-u-proj", `${PARENT_A}.jsonl`);
    transcript("-home-u-proj", PARENT_A, "subagents", "agent-direct.jsonl");
    transcript("-home-u-proj", PARENT_A, "subagents", "workflows", "wf_123-abc", "agent-nested.jsonl");

    const found = allTranscripts();

    // The regression: the nested one used to be dropped entirely.
    expect(found).toHaveLength(3);
    expect(found.filter((t) => t.isSubagent)).toHaveLength(2);
    expect(found.map((t) => t.transcriptPath).some((p) => p.includes("wf_123-abc"))).toBe(true);
  });

  it("keeps the top-level session id untouched", () => {
    transcript("-home-u-proj", `${PARENT_A}.jsonl`);
    const top = allTranscripts().find((t) => !t.isSubagent);
    expect(top?.sessionId).toBe(PARENT_A);
  });

  it("qualifies a subagent id with its parent session and its path", () => {
    transcript("-home-u-proj", PARENT_A, "subagents", "agent-direct.jsonl");
    transcript("-home-u-proj", PARENT_A, "subagents", "workflows", "wf_123-abc", "agent-nested.jsonl");

    const ids = allTranscripts().map((t) => t.sessionId).sort();
    expect(ids).toEqual([
      `${PARENT_A}__agent-direct`,
      `${PARENT_A}__workflows__wf_123-abc__agent-nested`,
    ]);
  });

  it("does not collide when one workflow run id appears under two parent sessions", () => {
    // Found in the real corpus, not imagined: a resumed session reuses its run
    // id, so `wf_<id>/journal.jsonl` exists under two parents in one project.
    // Deriving the id from the path below `subagents/` alone merged them, and
    // sessionId is what example attribution and per-session detector state are
    // keyed by — so the merge would be silent rather than an error.
    transcript("-home-u-proj", PARENT_A, "subagents", "workflows", "wf_shared", "journal.jsonl");
    transcript("-home-u-proj", PARENT_B, "subagents", "workflows", "wf_shared", "journal.jsonl");

    const found = allTranscripts();
    expect(found).toHaveLength(2);
    expect(new Set(found.map((t) => t.sessionId)).size).toBe(2);
  });

  it("ignores non-transcript files and does not follow symlinks", () => {
    transcript("-home-u-proj", PARENT_A, "subagents", "agent-real.jsonl");
    writeFileSync(join(root, "-home-u-proj", PARENT_A, "subagents", "notes.txt"), "x");

    // A symlink pointing back up would make a naive walk loop forever.
    const subDir = join(root, "-home-u-proj", PARENT_A, "subagents");
    symlinkSync(join(root, "-home-u-proj"), join(subDir, "loop"), "dir");

    const found = allTranscripts();
    expect(found).toHaveLength(1);
    expect(found[0].sessionId).toBe(`${PARENT_A}__agent-real`);
  });

  it("stops descending past the depth cap instead of walking forever", () => {
    const deep = ["subagents", "a", "b", "c", "d", "e", "f", "g"];
    transcript("-home-u-proj", PARENT_A, ...deep, "agent-too-deep.jsonl");
    expect(allTranscripts()).toHaveLength(0);
  });
});
