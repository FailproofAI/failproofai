/**
 * The AI SDK report tool picks its schema key from the `ai` version this
 * package resolves only when it builds with that copy. A module passed in may
 * be another major (an application resolving v6 can hand over a v4 copy), so
 * its definition carries both keys.
 */
import { describe, expect, it, vi } from "vitest";

const resolved = vi.hoisted(() => ({ major: 6 }));
vi.mock("../src/integrations/compat.js", async (orig) => {
  const real = await orig<typeof import("../src/integrations/compat.js")>();
  return {
    ...real,
    versionTuple: (pkg: string) => (pkg === "ai" ? [resolved.major, 0, 0] : real.versionTuple(pkg)),
  };
});

import { selfReportTool as aiTool } from "../src/integrations/ai.js";

type Def = { inputSchema?: unknown; parameters?: unknown };

describe("the AI SDK report tool's schema key", () => {
  it("follows the resolved major when it builds with the resolved copy", () => {
    resolved.major = 6;
    const v6 = aiTool<Def>();
    expect(v6.inputSchema).toBeDefined();
    expect(v6.parameters).toBeUndefined();
    resolved.major = 4;
    const v4 = aiTool<Def>();
    expect(v4.parameters).toBeDefined();
    expect(v4.inputSchema).toBeUndefined();
  });

  it("carries both keys for a module passed in, whatever major resolves here", () => {
    for (const major of [4, 6]) {
      resolved.major = major;
      // An AI SDK 4 `tool()` returns the definition unchanged.
      const v4Module = { tool: (d: unknown) => d, jsonSchema: (s: unknown) => ({ schemaOf: s }) };
      const built = aiTool<Def>({ module: v4Module });
      expect(built.parameters, `resolved v${major}`).toBeDefined();
      expect(built.inputSchema).toBe(built.parameters);
    }
  });
});
