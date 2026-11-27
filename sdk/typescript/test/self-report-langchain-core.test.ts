/**
 * The LangChain report tool needs `@langchain/core` 0.3.44 or later: older 0.3
 * releases read a tool's schema only as zod and would offer the model the tool
 * with no arguments. The peer range keeps its 0.3.0 floor for the tracer, so the
 * tool refuses an older core itself, with a message that says so.
 */
import { describe, expect, it, vi } from "vitest";

const installed = vi.hoisted(() => ({ core: null as string | null }));
vi.mock("../src/integrations/compat.js", async (orig) => {
  const real = await orig<typeof import("../src/integrations/compat.js")>();
  return {
    ...real,
    versionString: (pkg: string) => (pkg === "@langchain/core" ? installed.core : real.versionString(pkg)),
  };
});

import { FailproofAICompatError } from "../src/integrations/compat.js";
import { selfReportTool as langchainTool } from "../src/integrations/langchain.js";

describe("the LangChain report tool's @langchain/core floor", () => {
  it("refuses a core older than 0.3.44 by name, version and fix", () => {
    for (const core of ["0.3.0", "0.3.43", "0.2.36"]) {
      installed.core = core;
      let thrown: unknown;
      try {
        langchainTool();
      } catch (error) {
        thrown = error;
      }
      expect(thrown, core).toBeInstanceOf(FailproofAICompatError);
      const message = (thrown as Error).message;
      expect(message).toContain(`needs @langchain/core 0.3.44 or later, and this application has ${core}`);
      expect(message).toContain("npm install @langchain/core@^0.3.44");
      expect(message).toContain("LangChain tracer");
    }
  });

  it("passes 0.3.44 and later on to the usual resolution", () => {
    // `@langchain/core` is not installed in this package, so a supported
    // version gets past the floor and then reports the missing module.
    for (const core of ["0.3.44", "0.3.80", "1.3.0", "0.4.0-rc.1"]) {
      installed.core = core;
      expect(() => langchainTool(), core).toThrow(/npm install @langchain\/core`/);
      expect(() => langchainTool(), core).not.toThrow(FailproofAICompatError);
    }
  });

  it("takes a module passed in as it is, whatever version resolves here", () => {
    installed.core = "0.3.0";
    const tool = vi.fn((func: unknown, fields: unknown) => ({ func, fields }));
    const built = langchainTool<{ fields: { name: string } }>({ module: { tool } });
    expect(built.fields.name).toBe("failproofai_report");
  });

  it("does not guess when the version cannot be read", () => {
    installed.core = null;
    expect(() => langchainTool()).not.toThrow(FailproofAICompatError);
  });
});
