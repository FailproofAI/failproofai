// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listClaudeTranscriptMetadata } from "@/src/audit/cli-adapters/claude";

const PARENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

describe("Claude audit metadata", () => {
  let root: string;
  let previous: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "fp-claude-meta-"));
    previous = process.env.CLAUDE_PROJECTS_PATH;
    process.env.CLAUDE_PROJECTS_PATH = root;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.CLAUDE_PROJECTS_PATH;
    else process.env.CLAUDE_PROJECTS_PATH = previous;
    rmSync(root, { recursive: true, force: true });
  });

  it("carries a subagent's host-authored purpose into the audit", async () => {
    const dir = join(root, "-tmp-proj", PARENT, "subagents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "agent-a.jsonl"), '{"type":"user"}\n');
    writeFileSync(join(dir, "agent-a.meta.json"), JSON.stringify({
      description: "Hunt secrets at rest in transcripts",
    }));

    const found = await listClaudeTranscriptMetadata();
    expect(found).toHaveLength(1);
    expect(found[0].sessionDescription).toBe("Hunt secrets at rest in transcripts");
  });
});
