import { defineConfig } from "vitest/config";

/**
 * The real-framework suite (`integration/`). Separate from `vitest.config.ts`
 * because it installs real frameworks from the registry and spawns real Node
 * processes against the PACKED artifact — minutes, not seconds, and it needs
 * the network the unit suite deliberately does not.
 */
export default defineConfig({
  // Same reason as vitest.config.ts: stop Vite finding the monorepo root's
  // PostCSS config, which needs a package this isolated install does not have.
  css: { postcss: {} },
  test: {
    include: ["integration/**/*.test.ts"],
    environment: "node",
    globalSetup: ["./integration/global-setup.ts"],
    // Every case is its own child process with its own spool, so files are
    // independent and can run side by side.
    fileParallelism: true,
    testTimeout: 120_000,
    hookTimeout: 900_000,
  },
});
