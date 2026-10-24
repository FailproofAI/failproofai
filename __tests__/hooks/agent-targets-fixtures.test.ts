// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { agentTargetsMatch, parseAgentTargets, type AgentIdentity } from "../../src/hooks/agent-targets";

interface FixtureCase {
  name: string;
  schemaVersion: number;
  targets: unknown;
  agent: AgentIdentity | null;
  valid: boolean;
  matches?: boolean;
}

const fixtures = JSON.parse(
  readFileSync(resolve(__dirname, "../fixtures/agent-targets.json"), "utf8"),
) as { cases: FixtureCase[] };

describe("shared Rust/TypeScript agent selector cases", () => {
  for (const fixture of fixtures.cases) {
    it(fixture.name, () => {
      const parse = () => parseAgentTargets(fixture.targets, fixture.schemaVersion);
      if (!fixture.valid) {
        expect(parse).toThrow();
      } else {
        expect(agentTargetsMatch(parse(), fixture.agent)).toBe(fixture.matches);
      }
    });
  }
});
