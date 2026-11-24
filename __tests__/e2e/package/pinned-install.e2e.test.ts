/**
 * What `npm install -g failproofai` fetches, and what it runs.
 *
 * Packs this checkout the way the release does (`npm pack --ignore-scripts`)
 * and installs it from a registry on 127.0.0.1 that serves, for every runtime
 * dependency, the version this repository pins AND a newer release in the old
 * caret range whose postinstall leaves a marker: the shape of a malicious
 * release published after ours (posthog-node was hit by Shai-Hulud 2.0 in
 * November 2025).
 *
 * Before FailproofAI/agenteye#1798 the package declared six caret ranges, so
 * npm took the newer release and ran its postinstall. Now it must install
 * exactly the pinned versions, ask the registry for nothing else, and the
 * installed CLI must run with only those, since everything else it uses is
 * compiled into dist/ at build time.
 *
 * Needs dist/ (the e2e CI job builds it) and npm on PATH.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { isBuiltin } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(__dirname, "../../..");
const PKG = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
const RUNTIME: string[] = Object.keys(PKG.dependencies ?? {});

const NPM_ENV = { npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false" };

/** Async, so the in-process registry below can answer while npm runs. */
function run(command: string, args: string[], cwd: string, env: Record<string, string> = {}) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...NPM_ENV, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
}

/** `npm pack <dir>` into `dest`; returns the tarball's path. */
async function pack(dir: string, dest: string) {
  const result = await run("npm", ["pack", dir, "--ignore-scripts", "--json", "--pack-destination", dest], dest);
  if (result.status !== 0) throw new Error(`npm pack ${dir} failed:\n${result.stderr}`);
  return join(dest, JSON.parse(result.stdout)[0].filename);
}

/** A registry that serves only these tarballs and logs every path asked for. */
async function serveRegistry(tarballs: string[]) {
  let base = "";
  const docs: Record<string, any> = {};
  const files = new Map<string, string>();
  for (const file of tarballs) {
    const manifest = JSON.parse(
      spawnSync("tar", ["-xzOf", file, "package/package.json"], { encoding: "utf8" }).stdout,
    );
    const path = `/${manifest.name}/-/${manifest.name.split("/").pop()}-${manifest.version}.tgz`;
    const bytes = readFileSync(file);
    files.set(path, file);
    const doc = (docs[manifest.name] ??= { name: manifest.name, versions: {}, "dist-tags": {} });
    doc.versions[manifest.version] = {
      ...manifest,
      dist: {
        tarball: `BASE${path}`,
        integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
        shasum: createHash("sha1").update(bytes).digest("hex"),
      },
    };
    const newest = Object.keys(doc.versions).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    doc["dist-tags"].latest = newest.at(-1);
  }

  const requests: string[] = [];
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? "/").split("?")[0]);
    requests.push(path);
    const file = files.get(path);
    if (file) {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end(readFileSync(file));
    }
    const doc = docs[path.slice(1)];
    res.writeHead(doc ? 200 : 404, { "content-type": "application/json" });
    res.end(doc ? JSON.stringify(doc).replaceAll("BASE", base) : '{"error":"not found"}');
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  return { url: `${base}/`, requests, close: () => new Promise<void>((done) => server.close(() => done())) };
}

/** Packages installed under a node_modules tree, as name@version, nested ones included. */
function installed(dir: string): string[] {
  const nm = join(dir, "node_modules");
  if (!existsSync(nm)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(nm)) {
    if (entry.startsWith(".")) continue;
    const names = entry.startsWith("@") ? readdirSync(join(nm, entry)).map((scoped) => `${entry}/${scoped}`) : [entry];
    for (const name of names) {
      const version = JSON.parse(readFileSync(join(nm, name, "package.json"), "utf8")).version;
      found.push(`${name}@${version}`, ...installed(join(nm, name)));
    }
  }
  return found.sort();
}

describe("installing the packed failproofai package", () => {
  let work: string;
  let prefix: string;
  let marker: string;
  let registry: Awaited<ReturnType<typeof serveRegistry>>;
  let install: Awaited<ReturnType<typeof run>>;
  const pinned: string[] = [];

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), "fp-pinned-install-"));
    marker = join(work, "postinstall-ran");
    const tarballs: string[] = [];

    for (const name of RUNTIME) {
      // The version this repository ships: the copy bun installed from bun.lock.
      const tarball = await pack(join(REPO, "node_modules", name), work);
      const version = JSON.parse(readFileSync(join(REPO, "node_modules", name, "package.json"), "utf8")).version;
      pinned.push(`${name}@${version}`);
      tarballs.push(tarball);

      // A newer release in the old caret range, carrying a postinstall.
      const fake = join(work, "fake", name);
      mkdirSync(fake, { recursive: true });
      writeFileSync(join(fake, "index.js"), "module.exports = 'malicious';\n");
      writeFileSync(
        join(fake, "package.json"),
        JSON.stringify({
          name,
          version: `${version.split(".")[0]}.99.0`,
          main: "index.js",
          scripts: { postinstall: "node -e \"require('fs').writeFileSync(process.env.FP_PINNED_MARKER, 'ran')\"" },
        }),
      );
      tarballs.push(await pack(fake, work));
    }

    registry = await serveRegistry(tarballs);
    const failproofai = await pack(REPO, work);
    prefix = join(work, "global");
    install = await run(
      "npm",
      ["install", "-g", failproofai, "--prefix", prefix, "--registry", registry.url, "--cache", join(work, "cache")],
      work,
      { FP_PINNED_MARKER: marker },
    );
  }, 240_000);

  afterAll(async () => {
    await registry?.close();
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it("installs", () => {
    expect(install.status, `npm install -g failed:\n${install.stdout}\n${install.stderr}`).toBe(0);
  });

  it("lands exactly the pinned runtime dependencies, never the newer release", () => {
    expect(installed(join(prefix, "lib", "node_modules", "failproofai"))).toEqual([...pinned].sort());
  });

  it("runs no install script from the registry", () => {
    expect(existsSync(marker)).toBe(false);
  });

  it("asks the registry for the pinned runtime dependencies and nothing else", () => {
    const tarballs = pinned.map((spec) => {
      const at = spec.lastIndexOf("@");
      const name = spec.slice(0, at);
      return `/${name}/-/${name.split("/").pop()}-${spec.slice(at + 1)}.tgz`;
    });
    const allowed = new Set([...RUNTIME.map((name) => `/${name}`), ...tarballs]);
    expect(registry.requests.filter((path) => !allowed.has(path))).toEqual([]);
    for (const name of RUNTIME) expect(registry.requests).toContain(`/${name}`);
  });

  it("ships bundles that load nothing from node_modules but the pinned runtime dependencies", () => {
    // Whatever bundler flag leaves a package external (--external, -e,
    // --packages external), its specifier stays in the bundle as an import,
    // so the shipped bundles are where to look.
    const dist = join(prefix, "lib", "node_modules", "failproofai", "dist");
    const specifier = /(?:\bimport\s*\(\s*|\bfrom\s*|\bimport\s+|\b__require\s*\(\s*|\brequire\s*\(\s*)(["'])([^"'\n]+)\1/g;
    const packageName = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
    const strays: string[] = [];
    for (const file of readdirSync(dist).filter((name) => /\.(?:m?js|cjs)$/.test(name))) {
      for (const match of readFileSync(join(dist, file), "utf8").matchAll(specifier)) {
        const spec = match[2];
        if (spec.startsWith(".") || spec.startsWith("/") || isBuiltin(spec)) continue;
        const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
        // Text the CLI writes into policy scaffolds and loader shims, not
        // imports of its own: `from "failproofai"`, template URLs (`${distUrl}`).
        if (!packageName.test(name) || name === PKG.name) continue;
        if (!RUNTIME.includes(name)) strays.push(`${file}: ${spec}`);
      }
    }
    expect(strays).toEqual([]);
  });

  it("runs the installed CLI with nothing else installed", async () => {
    const home = join(work, "home");
    mkdirSync(home, { recursive: true });
    const result = await run(join(prefix, "bin", "failproofai"), ["--version"], work, { HOME: home });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(PKG.version);
  });
});
