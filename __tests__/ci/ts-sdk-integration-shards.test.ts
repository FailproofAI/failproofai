import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * The TypeScript SDK's real-framework suite runs in CI as SHARDS, each listing
 * the integration files it runs and the fixtures it installs. Those lists are
 * hand-maintained, so a new `integration/*.test.ts` that nobody adds to a shard
 * would simply never run in CI — green forever, testing nothing. This is the
 * tripwire for that, and for a shard naming a fixture that does not exist
 * (which `npm ci` would never reach, because the fixture installs by name).
 */

const root = join(__dirname, "..", "..");
const sdk = join(root, "sdk", "typescript");

interface Shard {
  shard: string;
  fixtures: string;
  files: string;
}

const workflow = parse(readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8")) as {
  jobs: Record<string, { strategy?: { matrix?: { include?: Shard[] } } }>;
};
const shards = workflow.jobs["failproofai-ts-sdk-integrations"]?.strategy?.matrix?.include ?? [];

describe("failproofai-ts-sdk-integrations shards", () => {
  it("has shards", () => {
    expect(shards.length).toBeGreaterThan(0);
  });

  it("runs every integration test file in at least one shard", () => {
    const files = readdirSync(join(sdk, "integration"))
      .filter((name) => name.endsWith(".test.ts"))
      .map((name) => `integration/${name}`);
    const covered = new Set(shards.flatMap((s) => s.files.split(/\s+/).filter(Boolean)));
    expect(files.filter((file) => !covered.has(file))).toEqual([]);
  });

  it("names only files and fixtures that exist", () => {
    const fixtures = new Set(readdirSync(join(sdk, "integration", "fixtures")));
    for (const s of shards) {
      for (const file of s.files.split(/\s+/).filter(Boolean)) {
        expect(() => readFileSync(join(sdk, file)), `${s.shard}: ${file}`).not.toThrow();
      }
      for (const fixture of s.fixtures.split(",").filter(Boolean)) {
        expect(fixtures.has(fixture), `${s.shard}: fixture ${fixture}`).toBe(true);
      }
    }
  });
});
