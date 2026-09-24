import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Point the evaluator sandbox at this checkout's built worker.
 *
 * The tests run against `src/` through Vitest's TypeScript loader, but a
 * `worker_threads` Worker is a real Node process entry and cannot load a `.ts`
 * file. In an installed package `source.ts` resolves `@failproofai/sdk/sandbox-worker`
 * through the exports map; here there is no installed package, so the env
 * override — the same one the code documents for bundled consumers — points at
 * `dist/`. `npm test` builds first, which is why this can assert rather than
 * skip: a sandbox test that silently did not run is worse than no sandbox test.
 */
export default function setup(): void {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const worker = resolve(root, "dist/cjs/evaluator/sandbox-worker.js");
  if (!existsSync(worker)) {
    throw new Error(
      `the evaluator sandbox worker is not built at ${worker}. Run \`npm run build\` first ` +
        "(`npm test` does it for you).",
    );
  }
  process.env.FAILPROOFAI_SDK_SANDBOX_WORKER = worker;
}
