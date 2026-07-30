#!/usr/bin/env bun
/**
 * Build the sealed policy worker bundle.
 *
 *   bun scripts/build-sealed-bundle.ts            # writes crates/generated/sealed-worker.js
 *   bun scripts/build-sealed-bundle.ts --check    # verify the committed bundle is current
 *
 * The output is a single self-contained JavaScript file evaluated inside a
 * QuickJS context with no bindings registered. Because there is no module
 * resolution in that context, everything the worker needs — the 32
 * sealed-eligible builtins, the policy registry, and the per-CLI response
 * encoder — has to be in one file.
 *
 * ## The substitutions, and why they are not a cheat
 *
 * Two module specifiers are rewritten at build time:
 *
 *   node:path                      -> src/policy-runtime/pure-path.ts
 *   node:os / node:fs / node:fs/promises / node:child_process
 *                                  -> src/policy-runtime/host-stubs.ts
 *
 * `node:path` is pure string arithmetic with no syscall surface, and the
 * replacement is proven equivalent to `node:path.posix` differentially over
 * 8,000+ generated cases (`__tests__/policy-runtime/pure-path.test.ts`). It is
 * a port, not a stub.
 *
 * The host modules are genuinely stubbed, and it is worth being precise about
 * why that is honest rather than a hole. The 32 policies in the bundle reach
 * none of them — `__tests__/hooks/builtin-tier-split.test.ts` walks the real
 * transitive import graph of `payload-only.ts` and fails if any host module
 * appears in it. What *does* reach them is failproofai's own scaffolding:
 * `builtin-policies.ts` installs a `homedir()` fallback for the legacy path,
 * and `hook-logger.ts` appends to a rotating file. Those are the runtime, not
 * policy code, and in the sealed context both are supposed to be inert — the
 * worker installs an empty warn sink and an empty host-context fallback
 * explicitly. The stubs make any path that was missed throw with a named
 * capability instead of silently doing something.
 *
 * ## Determinism
 *
 * The bundle is committed and drift-gated
 * (`__tests__/policy-runtime/sealed-bundle-drift.test.ts`) for the same reason
 * `crates/generated/*.json` is: the Rust daemon embeds it, so "the bundle in
 * the tree" and "the bundle the daemon runs" must be the same bytes, and a
 * source change that silently fails to reach the worker is exactly the kind of
 * divergence that produces a wrong verdict rather than an error.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Minimal local declarations for the two Bun APIs this script uses.
 *
 * The repo does not depend on `@types/bun`, and adding it for one script would
 * pull a large ambient type surface into every `tsc --noEmit` — including the
 * Next.js app — for no benefit. `tsconfig.json`'s include list covers every
 * TypeScript file in the repo, so the alternative is an unchecked file.
 * Declaring exactly the shape used keeps the script type-checked and the
 * dependency graph unchanged; if Bun's API moves, this fails to compile, which
 * is the outcome we want.
 */
interface BunBuildArtifact {
  text(): Promise<string>;
}
interface BunBuildResult {
  success: boolean;
  outputs: BunBuildArtifact[];
  logs: Array<{ message: string }>;
}
interface BunOnResolveArgs {
  path: string;
  importer?: string;
}
interface BunPluginBuilder {
  onResolve(
    constraints: { filter: RegExp },
    callback: (args: BunOnResolveArgs) => { path: string } | undefined,
  ): void;
}
interface BunPlugin {
  name: string;
  setup(build: BunPluginBuilder): void;
}
declare const Bun: {
  build(options: {
    entrypoints: string[];
    target?: string;
    format?: string;
    minify?: boolean;
    sourcemap?: string;
    plugins?: BunPlugin[];
  }): Promise<BunBuildResult>;
};

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(ROOT, "src/policy-runtime/sealed-entry.ts");
/**
 * Emitted into `crates/generated/` rather than `dist/` for one blunt reason:
 * `dist/` is gitignored, and `crates/failproofaid` embeds this file with
 * `include_str!`. A gitignored input to a compile-time include means the daemon
 * does not build from a fresh clone — CI would fail on a missing file, and the
 * bytes the daemon runs would never be reviewable in a diff.
 *
 * `crates/generated/` already holds the canonicalization tables under exactly
 * this contract: generated, committed, drift-gated, and deliberately not a
 * crate (no `Cargo.toml`, so the workspace glob skips it).
 */
const OUT_DIR = join(ROOT, "crates", "generated");
const OUT_FILE = join(OUT_DIR, "sealed-worker.js");

/** Host modules replaced by throwing stubs. See host-stubs.ts. */
const STUBBED = new Set([
  "node:os",
  "node:fs",
  "node:fs/promises",
  "node:child_process",
  "os",
  "fs",
  "fs/promises",
  "child_process",
]);

/** Pure modules replaced by a dependency-free port. */
const PORTED: Record<string, string> = {
  "node:path": join(ROOT, "src/policy-runtime/pure-path.ts"),
  path: join(ROOT, "src/policy-runtime/pure-path.ts"),
};

const STUB_PATH = join(ROOT, "src/policy-runtime/host-stubs.ts");
const RUNTIME_STUB_PATH = join(ROOT, "src/policy-runtime/runtime-stubs.ts");

/**
 * failproofai's own diagnostic modules, replaced by inert no-ops rather than
 * throwing stubs. These are reached on the *normal* evaluation path — the
 * evaluator logs its policy count and fires telemetry when a builtin crashes —
 * so throwing would convert a diagnostic into an evaluation failure. See
 * runtime-stubs.ts for why none of the three can run in the sealed tier
 * (a rotating log file, a `fetch()` to PostHog, and an `execSync` for a machine
 * ID respectively).
 *
 * Matched by absolute path so a rename shows up as a build failure — "still
 * references a host module" below — rather than as telemetry silently
 * reappearing inside the enforcement deadline.
 */
const RUNTIME_STUBBED = [
  join(ROOT, "src/hooks/hook-logger.ts"),
  join(ROOT, "src/hooks/hook-telemetry.ts"),
  join(ROOT, "lib/telemetry-id.ts"),
];

const sealedRuntimePlugin: BunPlugin = {
  name: "failproofai-sealed-runtime",
  setup(build) {
    build.onResolve({ filter: /^(node:)?(os|fs|fs\/promises|child_process|path)$/ }, (args) => {
      if (PORTED[args.path]) return { path: PORTED[args.path] };
      if (STUBBED.has(args.path)) return { path: STUB_PATH };
      return undefined;
    });

    // Relative specifiers, resolved against the importer, then compared as
    // absolute paths so `../../lib/telemetry-id` and `./hook-logger` both hit.
    build.onResolve({ filter: /^\.{1,2}\// }, (args) => {
      const abs = resolvePath(args.importer ? dirname(args.importer) : ROOT, args.path);
      for (const candidate of RUNTIME_STUBBED) {
        if (abs === candidate || `${abs}.ts` === candidate) {
          return { path: RUNTIME_STUB_PATH };
        }
      }
      return undefined;
    });
  },
};

/**
 * Specifiers that must NOT survive into the bundle. A `node:` import reaching
 * QuickJS is an immediate `ReferenceError` at load, which would present as
 * "the sealed tier is broken" rather than "this import should have been
 * substituted" — so it is worth failing the build with the actual reason.
 */
const FORBIDDEN_IN_OUTPUT = [
  /\brequire\s*\(\s*["']node:/,
  /\bfrom\s*["']node:/,
  /\bimport\s*\(\s*["']node:/,
];

async function buildBundle(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [ENTRY],
    target: "browser", // no Node globals injected; the sealed context has none
    format: "iife",
    minify: false, // readable output — this is security-relevant code someone will audit
    sourcemap: "none",
    plugins: [sealedRuntimePlugin],
  });

  if (!result.success) {
    const messages = result.logs.map((l) => `  ${l.message}`).join("\n");
    throw new Error(`sealed bundle build failed:\n${messages}`);
  }
  if (result.outputs.length !== 1) {
    throw new Error(
      `expected exactly one output chunk, got ${result.outputs.length}. ` +
        `The sealed context has no module loader, so the bundle must be a single file.`,
    );
  }

  const code = await result.outputs[0].text();

  for (const pattern of FORBIDDEN_IN_OUTPUT) {
    const match = code.match(pattern);
    if (match) {
      throw new Error(
        `sealed bundle still references a host module (${match[0]}). ` +
          `QuickJS has no module resolution, so this would fail at load. ` +
          `Add the specifier to STUBBED or PORTED in scripts/build-sealed-bundle.ts.`,
      );
    }
  }

  // A banner rather than a footer: whoever opens this file should learn in the
  // first line that editing it is pointless.
  return (
    "// GENERATED — do not edit. Built from src/policy-runtime/sealed-entry.ts\n" +
    "// by scripts/build-sealed-bundle.ts. Regenerate: bun scripts/build-sealed-bundle.ts\n" +
    SEALED_PRELUDE +
    code
  );
}

/**
 * The one host global the bundle still names, neutralised.
 *
 * `builtin-policies.ts` installs the legacy host-context fallback at module
 * scope, and its `projectDir` arm reads `process.env.CLAUDE_PROJECT_DIR`. The
 * read is inside a lambda that the sealed worker overwrites on every
 * `evaluate()` before anything can call it, so today it is unreachable. But
 * "unreachable given the current call order" is a weak property to rest a
 * `ReferenceError` on, and in QuickJS — which has no `process` at all — that
 * error would surface as "the sealed tier is broken" with no obvious cause.
 *
 * So: define `process.env` as a frozen empty object. Two things follow, and the
 * second is the interesting one. The lambda cannot throw. And a policy that
 * tries to read the daemon's environment gets nothing — not the service
 * account's `PATH`, not a delivery key, not `NODE_OPTIONS`. The daemon
 * constructs worker environments rather than inheriting them, and this is that
 * rule expressed inside the worker instead of only around it.
 * `__tests__/policy-runtime/sealed-bundle.test.ts` asserts the emptiness
 * directly, so a future prelude change that starts leaking real environment
 * fails loudly.
 */
const SEALED_PRELUDE = `// --- sealed prelude (see scripts/build-sealed-bundle.ts) ---
var process = Object.freeze({ env: Object.freeze(Object.create(null)) });
// --- end sealed prelude ---
`;

const isCheck = process.argv.includes("--check");

const bundle = await buildBundle();

if (isCheck) {
  if (!existsSync(OUT_FILE)) {
    console.error(`missing ${OUT_FILE}. Regenerate: bun scripts/build-sealed-bundle.ts`);
    process.exit(1);
  }
  const committed = readFileSync(OUT_FILE, "utf8");
  if (committed !== bundle) {
    console.error(
      `dist/sealed-worker.js is out of date with src/policy-runtime/.\n` +
        `Regenerate: bun scripts/build-sealed-bundle.ts`,
    );
    process.exit(1);
  }
  console.log(`sealed bundle is current (${bundle.length} bytes)`);
  process.exit(0);
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FILE, bundle, "utf8");
console.log(`wrote ${OUT_FILE} (${bundle.length} bytes)`);
