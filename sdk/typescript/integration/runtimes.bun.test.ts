import { parity } from "./runtime-parity.js";

/**
 * Bun: every scenario of every framework fixture, as an ES module and as
 * CommonJS, against Node's trace for the same agent.
 *
 * Bun implements `node:module`'s `createRequire`, `require.cache`,
 * `require.main`, `AsyncLocalStorage` and `process.on("exit")`, which is
 * everything the SDK's copy resolution and exit flush rely on — this proves it
 * on real frameworks instead of assuming it.
 */
parity("bun", [
  ["esm", "bun-esm"],
  ["cjs", "bun-cjs"],
]);
