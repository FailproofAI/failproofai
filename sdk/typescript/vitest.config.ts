import { defineConfig } from "vitest/config";

export default defineConfig({
  // Vite searches UPWARD from the project root for a PostCSS config, and this
  // package sits inside a monorepo whose root has one — which requires
  // `@tailwindcss/postcss`, a root devDependency that is deliberately not in
  // this package's isolated `node_modules`. Vite then dies before a single test
  // runs.
  //
  // It only fails where the isolation is real: locally the root's
  // `node_modules` is present and Node's resolution walks up into it, so the
  // search succeeds and nothing looks wrong. In CI, where this package is
  // installed on its own, it is fatal.
  //
  // An inline (empty) config turns the search off. This package has no CSS at
  // all, so there is nothing to configure — the only thing that search can do
  // here is find somebody else's tooling.
  css: { postcss: {} },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    globalSetup: ["./test/global-setup.ts"],
    setupFiles: ["./test/setup.ts"],
    // The writer, the sandbox and the adapters all reach for process-wide state
    // (an exit hook, a patched prototype, a spool directory). Running files one
    // at a time keeps a test from observing another file's patch, and keeps the
    // sandbox suite from competing with itself for the concurrency semaphore.
    pool: "forks",
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
