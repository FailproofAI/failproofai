import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "."),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["__tests__/e2e/**/*.e2e.test.ts"],
    exclude: [],
    testTimeout: 20_000,
    hookTimeout: 10_000,
    // forks pool: true process isolation — tests spawn subprocesses,
    // thread workers share globalThis which can interfere.
    pool: "forks",
    env: {
      FAILPROOFAI_TELEMETRY_DISABLED: "1",
      // Never Codex's real system config (/etc/codex/config.toml): a machine
      // with passwordless sudo and codex on PATH would have it rewritten by any
      // test that installs Codex hooks. Tests that exercise it set a temp path.
      FAILPROOFAI_CODEX_SYSTEM_CONFIG: "off",
    },
  },
});
