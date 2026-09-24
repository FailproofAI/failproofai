import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { withFailproofai } from "@failproofai/sdk/next";
import type { NextConfig } from "next";

const root = dirname(fileURLToPath(import.meta.url));

/**
 * One app, built several ways by `nextjs.test.ts`, each into its own distDir:
 *
 *   FAILPROOFAI_IT_NEXT_EXTERNAL=1  the frameworks (and the SDK) are listed in
 *                                   `serverExternalPackages`, so the server
 *                                   loads them from node_modules at run time
 *                                   (with `import()`, under both bundlers). Unset: Next's DEFAULT, which bundles
 *                                   all four — none of them is on Next's
 *                                   built-in external list.
 *
 * Every build includes `app/api/edge/route.ts`, an Edge-runtime route that
 * imports the SDK: an SDK whose import broke the Edge runtime fails the build.
 */
const external = process.env.FAILPROOFAI_IT_NEXT_EXTERNAL === "1";
/**
 * FAILPROOFAI_IT_NEXT_WRAP=1  the documented setup: the app lists nothing
 *                             itself and exports `withFailproofai(config)`.
 */
const wrap = process.env.FAILPROOFAI_IT_NEXT_WRAP === "1";

const config: NextConfig = {
  distDir: process.env.FAILPROOFAI_IT_NEXT_DIST ?? ".next",
  serverExternalPackages: external
    ? [
        "@failproofai/sdk",
        "@langchain/core",
        "@langchain/langgraph",
        "ai",
        "@mastra/core",
        "llamaindex",
        "@llamaindex/core",
        "@llamaindex/workflow",
      ]
    : [],
  // The build is about what runs, not about the fixtures' types (which the
  // framework fixtures typecheck on their own).
  typescript: { ignoreBuildErrors: true },
  // This fixture sits inside a repo with other lockfiles; without these, Next
  // guesses the workspace root from them and traces files from the wrong one.
  outputFileTracingRoot: root,
  turbopack: { root },
};

export default wrap ? withFailproofai(config) : config;
