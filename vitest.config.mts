import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

/**
 * Two projects, split by what a test actually needs.
 *
 * This suite is 208 files, of which 16 render React and two more reach for a
 * DOM API directly. The other 190 are Node-side: hook handlers, policy
 * evaluation, session parsers, workflow assertions. Running the whole thing
 * under a single global `environment: "jsdom"` built a fresh jsdom for every
 * one of those 190 files, and the `test` job runs the suite three times over
 * (once per env-config matrix leg), so the waste was paid three times per CI
 * run to serve nothing.
 *
 * Splitting on the extension keeps it automatic: a new `.test.tsx` gets jsdom
 * without anyone having to remember to ask for it, and a new `.test.ts` gets
 * the fast path by default. The escape hatch for the exceptions is per-file and
 * already in use — `__tests__/lib/share-card.test.ts` and
 * `__tests__/lib/fetch-with-timeout.test.ts` both open with
 * `// @vitest-environment jsdom`, which overrides the project's environment for
 * that file alone. Prefer that docblock over widening the globs below.
 *
 * `extends: true` pulls the root config — plugins, alias, globals, setupFiles,
 * env — into both projects, so there is exactly one place to change any of it.
 * `__tests__/setup.ts` is safe on the node side: its Web Storage polyfill
 * installs only when the runtime has not supplied a working one, so under
 * `node` it simply provides the Storage the DOM tests would have got from
 * jsdom, and under jsdom it stays out of the way.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "."),
    },
  },
  test: {
    globals: true,
    setupFiles: ["__tests__/setup.ts"],
    css: false,
    env: {
      FAILPROOFAI_TELEMETRY_DISABLED: "1",
    },
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["__tests__/**/*.test.ts"],
          exclude: ["__tests__/e2e/**"],
        },
      },
      {
        extends: true,
        test: {
          name: "dom",
          environment: "jsdom",
          include: ["__tests__/**/*.test.tsx"],
          exclude: ["__tests__/e2e/**"],
        },
      },
    ],
  },
});
