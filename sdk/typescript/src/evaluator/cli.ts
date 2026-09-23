#!/usr/bin/env node
/**
 * Run an evaluator declared as `module#export`.
 *
 *     npx failproofai-evaluator ./my-evals.js
 *     npx failproofai-evaluator ./my-evals.js#app
 *     FAILPROOFAI_EVALUATOR_MODULE=./my-evals.js npx failproofai-evaluator
 *
 * `#` rather than `:` as the separator, because a module specifier on Windows
 * routinely contains a colon (`C:\evals\index.js`) and a `file:` URL always
 * does. Splitting on `:` would take `C` as the module.
 */

import { pathToFileURL } from "node:url";
import { isAbsolute, resolve } from "node:path";

import { importModule } from "../node-require.js";
import { isEvaluator, type Evaluator } from "./authoring.js";

export async function loadEvaluator(spec: string): Promise<Evaluator> {
  const separator = spec.lastIndexOf("#");
  const moduleName = separator === -1 ? spec : spec.slice(0, separator);
  const exportName = separator === -1 ? "app" : spec.slice(separator + 1);
  if (!moduleName) throw new Error("evaluator module must not be empty");
  if (!exportName) throw new Error("evaluator export must not be empty");

  // A relative specifier is relative to the USER'S working directory, not to
  // this file inside `node_modules`. Bare specifiers (`my-evals`) are left
  // alone so a package can be named.
  const target =
    moduleName.startsWith(".") || isAbsolute(moduleName)
      ? pathToFileURL(resolve(process.cwd(), moduleName)).href
      : moduleName;

  const module = (await importModule(target)) as Record<string, unknown>;
  const candidate = module[exportName] ?? (module.default as Record<string, unknown> | undefined)?.[exportName];
  if (candidate === undefined) {
    throw new Error(`${JSON.stringify(spec)} does not export ${JSON.stringify(exportName)}`);
  }
  if (!isEvaluator(candidate)) {
    throw new TypeError(
      `${JSON.stringify(spec)} resolved to ${
        (candidate as object)?.constructor?.name ?? typeof candidate
      }, not an Evaluator`,
    );
  }
  return candidate;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const args = argv.filter((arg) => arg !== "--");
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(
      "Usage: failproofai-evaluator [module[#export]]\n\n" +
        "  module   Path or package to import (default: $FAILPROOFAI_EVALUATOR_MODULE)\n" +
        "  export   Named export holding the Evaluator (default: app)\n\n" +
        "Environment:\n" +
        "  FAILPROOFAI_EVALUATOR_URL      required — the API origin\n" +
        "  FAILPROOFAI_EVALUATOR_TOKEN    required — the worker credential\n" +
        "  FAILPROOFAI_EVALUATOR_WORKER_ID, _CONCURRENCY, _REQUEST_TIMEOUT_SECONDS,\n" +
        "  _DRAIN_TIMEOUT_SECONDS, _ALLOW_INSECURE_HTTP\n",
    );
    return 0;
  }

  const spec = args[0] ?? process.env.FAILPROOFAI_EVALUATOR_MODULE;
  if (!spec) {
    process.stderr.write(
      "failproofai-evaluator: a module is required (or set FAILPROOFAI_EVALUATOR_MODULE)\n",
    );
    return 2;
  }

  const evaluator = await loadEvaluator(spec);
  await evaluator.runFromEnv();
  return 0;
}

// `process.argv[1]` is the script Node was started with. Comparing it to this
// module's own resolved path is the module-system-agnostic way to ask "was I
// run, or imported" — `import.meta.main` does not exist and `require.main`
// only answers for CommonJS.
const invokedPath = process.argv[1];
if (invokedPath !== undefined && /failproofai-evaluator|evaluator[\\/]cli/.test(invokedPath)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(
        `failproofai-evaluator: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    },
  );
}
