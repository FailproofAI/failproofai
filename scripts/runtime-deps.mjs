#!/usr/bin/env node
/**
 * What `npm install -g failproofai` (or npx, bun, pnpm, yarn) resolves from
 * the registry, and what it runs while installing.
 *
 * Every install used to resolve failproofai's caret ranges afresh, and
 * posthog-node's own ranges under them, against whatever the registry served
 * that day, so a malicious in-range release (posthog-node was hit by
 * Shai-Hulud 2.0 in November 2025) reached every machine that installed
 * failproofai after it was published, and any install script in it ran there
 * (FailproofAI/agenteye#1798).
 *
 * Almost none of those packages were needed at run time: `bun build` compiles
 * them into dist/cli.mjs, dist/worker.mjs and dist/index.js, and `next build`
 * compiles them into the dashboard. They are devDependencies now. What is
 * left in `dependencies` is only what a bundle leaves external (`--external`
 * in the build scripts) and loads from node_modules at run time, and each such
 * package must be pinned to one exact version and have no dependencies of its
 * own, so nothing under it is resolved by range either. Today that is sql.js,
 * whose pure-JS build stays external because bun reprints its 1.4 MB of
 * minified asm.js as 8 MB, which every hook invocation would then parse.
 *
 * This check runs first in `bun run build`, which CI and both release jobs
 * run before anything is packed. It fails the build when:
 *
 *   - a runtime dependency is a range, or has dependencies of its own (or a
 *     required peer), so an install would resolve something by range;
 *   - a runtime dependency runs code at install time: a preinstall, install or
 *     postinstall script, or a binding.gyp, which npm compiles;
 *   - node_modules or bun.lock disagree with package.json about one;
 *   - a build script leaves a package external that is not a runtime
 *     dependency, so the installed CLI could not load it;
 *   - the root manifest itself would fetch or run something at install time:
 *     its own preinstall, install or postinstall script, a peer dependency
 *     (npm 7+ installs peers), or an optional dependency other than the four
 *     failproofaid platform packages pinned to this exact version (the publish
 *     job's `build-daemon-packages.mjs --pin-root` writes those before it
 *     builds).
 *
 * Node built-ins only, plus the sibling daemon-platforms.mjs.
 *
 * Usage: node scripts/runtime-deps.mjs [--root <dir>]
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DAEMON_PLATFORMS, daemonPackageName } from "./daemon-platforms.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The lifecycle events npm runs when it installs a package. */
export const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall"];

/** One exact semver version: no range operator, no wildcard, no tag. */
export const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** The only optional dependencies the root package may carry. */
export const DAEMON_PACKAGES = DAEMON_PLATFORMS.map((platform) => daemonPackageName(platform.key));

/**
 * Parses bun.lock: JSON with trailing commas. Commas that come right before a
 * closing bracket are dropped outside strings; everything else is JSON.parse.
 */
export function parseBunLock(text) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += text[++i] ?? "";
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === "}" || text[j] === "]") continue;
    }
    out += ch;
  }
  return JSON.parse(out);
}

/** The package an import specifier names: "sql.js/dist/x.js" → "sql.js". */
export function packageOf(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** Splits a shell command into words, keeping quoted strings in one word. */
export function shellWords(command) {
  const words = [];
  let word = "";
  let started = false;
  let quote = null;
  for (const ch of String(command)) {
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += ch;
      started = true;
    }
  }
  if (started) words.push(word);
  return words;
}

/**
 * Every package a `bun build` in package.json's scripts leaves external, as
 * { name, script } pairs. `--external <pkg>`, `--external=<pkg>` and `-e <pkg>`
 * name one; `--packages external` leaves every package external, reported as
 * the name "*". Only `bun build` commands are read: the same script also runs
 * `node -e "<code>"`, whose -e is not bun's.
 */
export function externalsOf(scripts = {}) {
  const found = [];
  for (const [script, command] of Object.entries(scripts)) {
    const segments = [[]];
    for (const word of shellWords(command)) {
      if (["&&", "||", ";", "|"].includes(word)) segments.push([]);
      else segments.at(-1).push(word);
    }
    for (const words of segments) {
      if (words[0] !== "bun" || words[1] !== "build") continue;
      for (let i = 2; i < words.length; i++) {
        const word = words[i];
        if (word === "--external" || word === "-e") {
          if (words[i + 1]) found.push({ name: packageOf(words[++i]), script });
        } else if (word.startsWith("--external=")) {
          found.push({ name: packageOf(word.slice("--external=".length)), script });
        } else if (word === "--packages=external" || (word === "--packages" && words[i + 1] === "external")) {
          found.push({ name: "*", script });
        }
      }
    }
  }
  return found;
}

/**
 * Checks the repository at `root` (package.json, bun.lock, node_modules).
 * Returns the runtime dependencies as { name, version }. Throws one Error
 * listing every problem found.
 */
export function checkRuntimeDependencies(root = REPO_ROOT) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const lock = parseBunLock(readFileSync(join(root, "bun.lock"), "utf8"));
  const packages = lock.packages ?? {};
  const locked = lock.workspaces?.[""]?.dependencies ?? {};
  const dependencies = pkg.dependencies ?? {};
  const problems = [];

  // The root package itself.
  for (const event of INSTALL_SCRIPTS) {
    if (pkg.scripts?.[event]) {
      problems.push(`package.json has a ${event} script, which would run on every machine that installs failproofai`);
    }
  }
  for (const peer of Object.keys(pkg.peerDependencies ?? {})) {
    problems.push(`package.json declares the peer "${peer}"; npm installs peers from the registry by range`);
  }
  for (const [name, spec] of Object.entries(pkg.optionalDependencies ?? {})) {
    if (!DAEMON_PACKAGES.includes(name)) {
      problems.push(
        `optional dependency "${name}" would be resolved from the registry on every install; only the ` +
          `failproofaid platform packages may be optional dependencies`,
      );
    } else if (spec !== pkg.version) {
      problems.push(`optional dependency "${name}" is pinned to ${JSON.stringify(spec)}, not to this version (${pkg.version})`);
    }
  }

  // What the bundles load from node_modules has to be installed with them.
  for (const { name, script } of externalsOf(pkg.scripts)) {
    if (name === "*") {
      problems.push(
        `the ${script} script leaves every package external (--packages external), so the installed CLI ` +
          `would load its whole dependency tree from node_modules`,
      );
    } else if (!Object.hasOwn(dependencies, name)) {
      problems.push(
        `"${name}" is left external by the ${script} script but is not a runtime dependency, so the ` +
          `installed CLI could not load it — drop --external so bun compiles it in, or pin it in dependencies`,
      );
    }
  }

  for (const [name, spec] of Object.entries(dependencies)) {
    // Versions are compared below only against an exact pin; a range has
    // already said everything there is to say about it.
    const exact = EXACT_VERSION.test(spec);
    if (!exact) {
      problems.push(
        `runtime dependency "${name}" is ${JSON.stringify(spec)}, a range: every install would resolve it ` +
          `afresh — pin one exact version`,
      );
    }
    if (locked[name] !== spec) {
      problems.push(
        `bun.lock records "${name}" as ${JSON.stringify(locked[name] ?? null)} but package.json asks for ` +
          `${JSON.stringify(spec)} — run \`bun install\``,
      );
    }

    const entry = packages[name];
    if (!Array.isArray(entry)) {
      problems.push(`runtime dependency "${name}" is not in bun.lock — run \`bun install\``);
      continue;
    }
    const [lockSpec, registry, meta = {}, integrity] = entry;
    const label = String(lockSpec);
    if (exact && lockSpec !== `${name}@${spec}`) {
      problems.push(`bun.lock resolves "${name}" to ${label}, not ${name}@${spec}`);
    }
    if (registry !== "" || typeof integrity !== "string" || !integrity.startsWith("sha512-")) {
      problems.push(`${label} is not a registry package with a sha512 integrity in bun.lock`);
    }
    const own = [
      ...Object.keys(meta.dependencies ?? {}),
      ...Object.keys(meta.optionalDependencies ?? {}),
      ...Object.keys(meta.peerDependencies ?? {}).filter((peer) => !(meta.optionalPeers ?? []).includes(peer)),
    ];
    if (own.length) {
      problems.push(
        `${label} depends on ${own.join(", ")}, which every install would resolve by range — compile it ` +
          `into the bundles instead (drop it from --external and move it to devDependencies)`,
      );
    }

    const dir = join(root, "node_modules", name);
    const manifestPath = join(dir, "package.json");
    if (!existsSync(manifestPath)) {
      problems.push(`${label} is not installed — run \`bun install --frozen-lockfile\``);
      continue;
    }
    const installed = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (exact && `${installed.name}@${installed.version}` !== `${name}@${spec}`) {
      problems.push(
        `node_modules holds ${installed.name}@${installed.version}, but package.json pins ${name}@${spec} — ` +
          `run \`bun install --frozen-lockfile\``,
      );
    }
    const scripts = INSTALL_SCRIPTS.filter((event) => installed.scripts?.[event]);
    if (scripts.length) {
      problems.push(
        `${label} has an install-time script (${scripts.join(", ")}), which would run on every machine that ` +
          `installs failproofai`,
      );
    }
    if (installed.gypfile !== false && existsSync(join(dir, "binding.gyp"))) {
      problems.push(`${label} ships a binding.gyp, which npm compiles on install`);
    }
  }

  if (problems.length) {
    throw new Error(`failproofai's install would not be pinned:\n  - ${problems.join("\n  - ")}`);
  }
  return Object.entries(dependencies).map(([name, version]) => ({ name, version }));
}

export function main(argv = process.argv.slice(2)) {
  const index = argv.indexOf("--root");
  const root = index !== -1 && argv[index + 1] ? resolve(argv[index + 1]) : REPO_ROOT;
  try {
    const runtime = checkRuntimeDependencies(root);
    console.log(
      `Runtime dependencies (exact, no dependencies of their own, no install scripts): ` +
        (runtime.map((dep) => `${dep.name}@${dep.version}`).join(", ") || "none"),
    );
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

// realpath on both sides: run through a symlink, a plain URL comparison never
// matches, and the check would exit 0 without checking anything.
function invokedDirectly() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main();
}

