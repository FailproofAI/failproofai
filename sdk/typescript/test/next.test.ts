import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { nextExternalsGap, resetNextWarnings } from "../src/integrations/index.js";
import { NEXT_EXTERNALS_ENV, NEXT_EXTERNAL_PACKAGES, withFailproofai } from "../src/next.js";

/**
 * `withFailproofai(nextConfig)` and the warning `instrument()` gives a Next.js
 * server that bundles what an adapter attaches to.
 *
 * The failure these guard is silent: `next build` bundles LangChain, Mastra
 * and LlamaIndex by default, `instrument()` patches the node_modules copy the
 * app never runs, reports success, and records nothing.
 */

const ENV_KEYS = [NEXT_EXTERNALS_ENV, "__NEXT_PRIVATE_STANDALONE_CONFIG", "NEXT_RUNTIME"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  resetNextWarnings();
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("withFailproofai", () => {
  it("adds the packages instrument() needs, keeping the app's own list and the rest of its config", () => {
    const config = withFailproofai({ reactStrictMode: true, serverExternalPackages: ["sharp", "@mastra/core"] });
    expect(config.reactStrictMode).toBe(true);
    expect(config.serverExternalPackages[0]).toBe("sharp");
    for (const pkg of NEXT_EXTERNAL_PACKAGES) expect(config.serverExternalPackages).toContain(pkg);
    // No duplicates, even for one the app already listed.
    expect(new Set(config.serverExternalPackages).size).toBe(config.serverExternalPackages.length);
  });

  it("works with no config at all", () => {
    expect(withFailproofai()).toEqual({
      serverExternalPackages: [...NEXT_EXTERNAL_PACKAGES],
    });
  });

  it("wraps a config function, sync and async, without calling it early", async () => {
    let calls = 0;
    const sync = withFailproofai((phase: string) => {
      calls += 1;
      return { env: { PHASE: phase } };
    });
    expect(calls).toBe(0);
    const out = sync("phase-production-build");
    expect(out.env).toEqual({ PHASE: "phase-production-build" });
    expect(out.serverExternalPackages).toContain("@langchain/core");

    const asyncConfig = withFailproofai(async () => ({ poweredByHeader: false }));
    const resolved = await asyncConfig();
    expect(resolved.poweredByHeader).toBe(false);
    expect(resolved.serverExternalPackages).toContain("@mastra/core");
  });

  it("leaves out a package the app transpiles, which Next rejects in both lists", () => {
    const config = withFailproofai({ transpilePackages: ["@mastra/core"] });
    expect(config.serverExternalPackages).not.toContain("@mastra/core");
    expect(config.serverExternalPackages).toContain("@langchain/core");
  });

  it("records what it externalized, for instrument() in the same server process", () => {
    withFailproofai({});
    expect(process.env[NEXT_EXTERNALS_ENV]!.split(",")).toEqual([...NEXT_EXTERNAL_PACKAGES]);
  });
});

describe("nextExternalsGap", () => {
  it("is unknown (null) with no wrapper marker and no standalone config", () => {
    expect(nextExternalsGap("langchain")).toBeNull();
  });

  it("is empty once withFailproofai has run", () => {
    withFailproofai({});
    expect(nextExternalsGap("langchain")).toEqual([]);
    expect(nextExternalsGap("mastra")).toEqual([]);
    expect(nextExternalsGap("llamaindex")).toEqual([]);
  });

  it("names what is missing when the app transpiles a framework the adapter needs external", () => {
    withFailproofai({ transpilePackages: ["@mastra/core"] });
    expect(nextExternalsGap("mastra")).toEqual(["@mastra/core"]);
    expect(nextExternalsGap("langchain")).toEqual([]);
  });

  it("reads a standalone server's resolved config, where next.config is not evaluated", () => {
    process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify({
      serverExternalPackages: ["@failproofai/sdk", "@langchain/core"],
    });
    expect(nextExternalsGap("langchain")).toEqual([]);
    expect(nextExternalsGap("mastra")).toEqual(["@mastra/core"]);
  });

  it("trusts a hand-set FAILPROOFAI_NEXT_EXTERNALS=1", () => {
    process.env[NEXT_EXTERNALS_ENV] = "1";
    expect(nextExternalsGap("llamaindex")).toEqual([]);
  });

  it("never applies to the Vercel AI SDK, which reaches a bundled copy", () => {
    expect(nextExternalsGap("ai")).toEqual([]);
  });
});
