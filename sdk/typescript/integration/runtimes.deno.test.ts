import { parity } from "./runtime-parity.js";

/**
 * Deno (`deno run --allow-all`), running each fixture's transpiled agent
 * straight out of the fixture's `node_modules` — Deno 2's npm compatibility,
 * with the frameworks resolved exactly as Node resolves them.
 *
 * This file found the SDK's one Deno bug: Deno answers `require.main === null`
 * (not `undefined`) for an ES-module entry, which the SDK read as "CommonJS",
 * so `instrument()` patched the CommonJS copy of LangChain, Mastra and
 * LlamaIndex while the app ran the ES-module copy — success reported, nothing
 * recorded. See `isCommonJsMain` in `src/node-require.ts`.
 */
parity(
  "deno",
  [
    ["esm", "deno-esm"],
    ["cjs", "deno-cjs"],
  ],
  {
    // Not a scenario: the pausing half of `remote-resume`, which passes it a
    // checkpoint path. Run bare, Node's `writeFileSync(undefined)` throws and
    // Deno's does not, so the exit codes differ. `remote-resume` itself — the
    // two-process run, through Deno's `process.execPath` — matches Node.
    "*:*:remote-resume-pause": { reason: "fixture helper; Deno's writeFileSync(undefined) does not throw" },
  },
);
