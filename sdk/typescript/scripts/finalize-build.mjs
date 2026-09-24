/**
 * Post-process the two `tsc` outputs into something Node can actually load.
 *
 * Three things `tsc` will not do on its own:
 *
 * 1. **Tell Node which half is which.** The package is `"type": "module"`, so
 *    every `.js` under `dist/` is treated as ESM — including the CommonJS build,
 *    whose `require()` calls would then be a syntax error. A `package.json`
 *    carrying `"type": "commonjs"` inside `dist/cjs/` is the supported way to
 *    say otherwise, and it applies to that directory only.
 *
 * 2. **Make the CLI executable.** A `bin` entry that is not executable fails
 *    with a permission error on every platform where the installer links rather
 *    than copies, and the shebang in the source is not enough on its own.
 *
 * 3. **Check the promise this package makes.** Zero runtime dependencies is a
 *    contract, not an aspiration: this package installs into other people's
 *    agent processes, so any dependency we declare is a version constraint they
 *    inherit. Asserting it here means a `npm install --save` somebody forgot to
 *    revert fails the build rather than shipping.
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const problems = [];

for (const field of ["dependencies", "optionalDependencies"]) {
  const declared = Object.keys(manifest[field] ?? {});
  if (declared.length > 0) {
    problems.push(
      `package.json declares ${field}: ${declared.join(", ")}. ` +
        "This package is contractually zero-dependency — see README.md.",
    );
  }
}

writeFileSync(
  join(root, "dist/cjs/package.json"),
  `${JSON.stringify({ type: "commonjs" }, null, 2)}\n`,
);
writeFileSync(
  join(root, "dist/esm/package.json"),
  `${JSON.stringify({ type: "module" }, null, 2)}\n`,
);

const cli = join(root, "dist/esm/evaluator/cli.js");
if (existsSync(cli)) {
  chmodSync(cli, 0o755);
} else {
  problems.push("dist/esm/evaluator/cli.js is missing; the `bin` entry would not resolve.");
}

// Every path the `exports` map promises must exist, or the failure lands on a
// consumer's `import` rather than on this build. Conditions nest
// (`require.types`), so walk them.
//
// And every declaration must sit in the same half as the JavaScript it
// describes: `.d.ts` files take their module format from the nearest
// package.json exactly like `.js` files do, so ESM declarations under a
// `require` condition tell TypeScript a CommonJS file is an ES module.
const walkConditions = (path, value, visit) => {
  if (typeof value === "string") {
    visit(path, value);
    return;
  }
  for (const [condition, next] of Object.entries(value)) walkConditions([...path, condition], next, visit);
};
for (const [entry, conditions] of Object.entries(manifest.exports)) {
  if (typeof conditions === "string") continue;
  const targets = [];
  walkConditions([], conditions, (path, target) => {
    targets.push({ path, target });
    if (!existsSync(join(root, target))) {
      problems.push(`exports["${entry}"].${path.join(".")} points at ${target}, which was not built.`);
    }
  });
  for (const half of ["import", "require"]) {
    const dirs = new Set(
      targets
        .filter(({ path }) => path[0] === half)
        .map(({ target }) => target.split("/").slice(0, 3).join("/")),
    );
    if (dirs.size > 1) {
      problems.push(`exports["${entry}"].${half} mixes ${[...dirs].join(" and ")}; types and JavaScript must match.`);
    }
  }
}

// `moduleResolution: node` (node10) ignores `exports`, so each subpath reaches
// it only through `typesVersions` — and must land on the CommonJS declarations,
// which is what a node10 project compiles to.
for (const [range, mapping] of Object.entries(manifest.typesVersions ?? {})) {
  for (const [subpath, targets] of Object.entries(mapping)) {
    for (const target of targets) {
      if (!existsSync(join(root, target))) {
        problems.push(`typesVersions["${range}"]["${subpath}"] points at ${target}, which was not built.`);
      }
      if (!target.startsWith("./dist/cjs/")) {
        problems.push(`typesVersions["${range}"]["${subpath}"] points at ${target}, not at dist/cjs.`);
      }
    }
  }
}
for (const [field, prefix] of [
  ["types", "./dist/cjs/"],
  ["main", "./dist/cjs/"],
]) {
  if (!String(manifest[field]).startsWith(prefix) || !existsSync(join(root, manifest[field]))) {
    problems.push(`package.json "${field}" is ${manifest[field]}; it must be a built file under ${prefix}.`);
  }
}

if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`finalize-build: ${problem}\n`);
  process.exit(1);
}

process.stdout.write("finalize-build: dist/esm and dist/cjs are complete\n");
