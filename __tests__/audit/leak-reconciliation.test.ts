// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { persistLeaks } from "@/src/audit";
import { readLeakRecord, writeLeakRecord } from "@/src/audit/leak-store";
import { describeMechanism, upsertFinding } from "@/src/audit/leak-record";

const GHOST_ID = "0000000000000bad";

describe("full-scan leak reconciliation", () => {
  let root: string;
  let oldFpHome: string | undefined;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "fp-leak-reconcile-"));
    oldFpHome = process.env.FAILPROOFAI_HOME;
    process.env.FAILPROOFAI_HOME = join(root, "fp-home");
  });

  beforeEach(() => {
    const record = readLeakRecord();
    record.findings = [];
    upsertFinding(record, {
      id: GHOST_ID,
      fingerprint: { display: "ghp_••••••••1234", label: "GitHub token", length: 40, attributed: true },
      name: "GITHUB_TOKEN",
      rule: "GitHub personal access token",
      confidence: "doc-verified",
      sighting: {
        cli: "claude",
        sessionId: "old",
        cwd: "~/…/old",
        at: "2026-09-08T00:00:00.000Z",
        mechanism: describeMechanism("Read", "result", "~/…/.env"),
      },
    });
    writeLeakRecord(record);
  });

  afterAll(() => {
    if (oldFpHome === undefined) delete process.env.FAILPROOFAI_HOME;
    else process.env.FAILPROOFAI_HOME = oldFpHome;
    rmSync(root, { recursive: true, force: true });
  });

  it("removes findings the current detector no longer sees after a complete scan", () => {
    persistLeaks([], true);
    expect(readLeakRecord().findings).toEqual([]);
  });

  it("preserves unseen findings when the scan is explicitly scoped", () => {
    persistLeaks([], false);
    expect(readLeakRecord().findings.map((f) => f.id)).toContain(GHOST_ID);
  });
});
