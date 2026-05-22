// @vitest-environment node
import { describe, it, expect } from "vitest";
import type { NormalizedToolEvent } from "../../src/audit/types";
import { redundantCdCwd } from "../../src/audit/detectors/redundant-cd-cwd";
import { preferEditOverReadCat } from "../../src/audit/detectors/prefer-edit-over-read-cat";
import { preferEditOverSedAwk } from "../../src/audit/detectors/prefer-edit-over-sed-awk";
import { preferWriteOverHeredoc } from "../../src/audit/detectors/prefer-write-over-heredoc";
import { sleepPollingLoop } from "../../src/audit/detectors/sleep-polling-loop";
import { findFromRoot } from "../../src/audit/detectors/find-from-root";
import { gitCommitNoVerify } from "../../src/audit/detectors/git-commit-no-verify";
import { rereadAfterEdit } from "../../src/audit/detectors/reread-after-edit";

function bash(cmd: string, cwd = "/home/u/proj"): NormalizedToolEvent {
  return {
    cli: "claude",
    sessionId: "sess-1",
    transcriptPath: "/tmp/t.jsonl",
    cwd,
    timestamp: "2026-05-21T00:00:00.000Z",
    toolName: "Bash",
    rawToolName: "Bash",
    toolInput: { command: cmd },
  };
}

function tool(name: string, input: Record<string, unknown>): NormalizedToolEvent {
  return {
    cli: "claude",
    sessionId: "sess-1",
    transcriptPath: "/tmp/t.jsonl",
    cwd: "/home/u/proj",
    timestamp: "2026-05-21T00:00:00.000Z",
    toolName: name,
    rawToolName: name,
    toolInput: input,
  };
}

describe("redundant-cd-cwd", () => {
  it("matches `cd <cwd> && cmd`", () => {
    const hit = redundantCdCwd.detect(bash("cd /home/u/proj && pnpm test"), {});
    expect(hit?.example).toContain("cd /home/u/proj && pnpm test");
  });
  it("does not match cd to a different path", () => {
    expect(redundantCdCwd.detect(bash("cd /tmp && ls"), {})).toBeNull();
  });
  it("does not match bare cmd without cd", () => {
    expect(redundantCdCwd.detect(bash("pnpm test"), {})).toBeNull();
  });
});

describe("prefer-edit-over-read-cat", () => {
  it("matches `cat foo.ts`", () => {
    expect(preferEditOverReadCat.detect(bash("cat src/foo.ts"), {})?.example).toBe("cat src/foo.ts");
  });
  it("matches `head -50 bar.py`", () => {
    expect(preferEditOverReadCat.detect(bash("head -50 bar.py"), {})).not.toBeNull();
  });
  it("does not match `cat .env`", () => {
    expect(preferEditOverReadCat.detect(bash("cat .env"), {})).toBeNull();
  });
  it("does not match piped `cat`", () => {
    expect(preferEditOverReadCat.detect(bash("cat foo.ts | wc -l"), {})).toBeNull();
  });
  it("does not match `cat foo.txt > out`", () => {
    expect(preferEditOverReadCat.detect(bash("cat foo.ts > /tmp/out"), {})).toBeNull();
  });
  it("does not match `cat unknownext`", () => {
    expect(preferEditOverReadCat.detect(bash("cat README"), {})).toBeNull();
  });
});

describe("prefer-edit-over-sed-awk", () => {
  it("matches `sed -i`", () => {
    expect(preferEditOverSedAwk.detect(bash("sed -i 's/foo/bar/g' file.ts"), {})).not.toBeNull();
  });
  it("matches `awk '...' file > out`", () => {
    expect(preferEditOverSedAwk.detect(bash("awk '{print $1}' file > out"), {})).not.toBeNull();
  });
  it("does not match `sed 's/x/y/'` without -i", () => {
    expect(preferEditOverSedAwk.detect(bash("echo x | sed 's/x/y/'"), {})).toBeNull();
  });
});

describe("prefer-write-over-heredoc", () => {
  it("matches `cat <<EOF > file`", () => {
    expect(preferWriteOverHeredoc.detect(bash("cat <<'EOF' > out.md\nhello\nEOF"), {})).not.toBeNull();
  });
  it("does not match `cat <<EOF` inside `$()`", () => {
    expect(
      preferWriteOverHeredoc.detect(bash(`git commit -m "$(cat <<'EOF'\nfeat\nEOF\n)"`), {}),
    ).toBeNull();
  });
  it("matches `echo \"multi\\nline\" > file`", () => {
    expect(preferWriteOverHeredoc.detect(bash('echo "a\nb" > out'), {})).not.toBeNull();
  });
});

describe("sleep-polling-loop", () => {
  it("matches `sleep 60`", () => {
    expect(sleepPollingLoop.detect(bash("sleep 60"), {})).not.toBeNull();
  });
  it("matches `sleep 5m`", () => {
    expect(sleepPollingLoop.detect(bash("sleep 5m"), {})).not.toBeNull();
  });
  it("matches while-sleep loop", () => {
    expect(
      sleepPollingLoop.detect(bash("while true; do echo x; sleep 5; done"), {}),
    ).not.toBeNull();
  });
  it("does not match `sleep 1`", () => {
    expect(sleepPollingLoop.detect(bash("sleep 1"), {})).toBeNull();
  });
});

describe("find-from-root", () => {
  it("matches `find /`", () => {
    expect(findFromRoot.detect(bash("find / -name '*.ts'"), {})).not.toBeNull();
  });
  it("matches `find /home`", () => {
    expect(findFromRoot.detect(bash("find /home -name foo"), {})).not.toBeNull();
  });
  it("does not match `find . -name foo`", () => {
    expect(findFromRoot.detect(bash("find . -name foo"), {})).toBeNull();
  });
  it("does not match `find src`", () => {
    expect(findFromRoot.detect(bash("find src -name foo"), {})).toBeNull();
  });
});

describe("git-commit-no-verify", () => {
  it("matches `git commit --no-verify`", () => {
    expect(gitCommitNoVerify.detect(bash("git commit --no-verify -m foo"), {})).not.toBeNull();
  });
  it("matches short `git commit -n`", () => {
    expect(gitCommitNoVerify.detect(bash("git commit -n -m foo"), {})).not.toBeNull();
  });
  it("does not match plain `git commit -m`", () => {
    expect(gitCommitNoVerify.detect(bash("git commit -m foo"), {})).toBeNull();
  });
});

describe("reread-after-edit", () => {
  it("matches Read of file just Edited", () => {
    const state = {};
    expect(rereadAfterEdit.detect(tool("Edit", { file_path: "/a/b.ts" }), state)).toBeNull();
    const hit = rereadAfterEdit.detect(tool("Read", { file_path: "/a/b.ts" }), state);
    expect(hit?.example).toContain("/a/b.ts");
  });
  it("matches Read after Write", () => {
    const state = {};
    rereadAfterEdit.detect(tool("Write", { file_path: "/a/b.ts" }), state);
    expect(rereadAfterEdit.detect(tool("Read", { file_path: "/a/b.ts" }), state)).not.toBeNull();
  });
  it("does not match Read of a different file", () => {
    const state = {};
    rereadAfterEdit.detect(tool("Edit", { file_path: "/a/b.ts" }), state);
    expect(rereadAfterEdit.detect(tool("Read", { file_path: "/a/other.ts" }), state)).toBeNull();
  });
  it("decays after window of 5 tool calls", () => {
    const state = {};
    rereadAfterEdit.detect(tool("Edit", { file_path: "/a/b.ts" }), state);
    for (let i = 0; i < 6; i++) rereadAfterEdit.detect(tool("Bash", { command: "x" }), state);
    expect(rereadAfterEdit.detect(tool("Read", { file_path: "/a/b.ts" }), state)).toBeNull();
  });
});
