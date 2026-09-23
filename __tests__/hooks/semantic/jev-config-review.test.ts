// @vitest-environment node
//
// Review round on the config loader:
// - a FIFO in jev.json's place must not block ANY of the four readers that
//   open it — the hook path, `jev status`, and the two `jev setup` update
//   readers behind the second `openSync`. Checked in a CHILD process with a
//   timeout: a blocking open() in this test worker would hang the whole file
//   instead of failing it, which is what a regression to a plain O_RDONLY open
//   looks like. Two further checks keep that arrangement from coming undone:
//   every `openSync` in the module must carry the flags, and no test anywhere
//   may make a FIFO and then call a reader in-process;
// - a model id shaped like a credential is refused, and never quoted.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { looksLikeCredential, validateJevConfig } from "../../../src/hooks/semantic/jev-config";

const CONFIG_MODULE = resolve(__dirname, "..", "..", "..", "src", "hooks", "semantic", "jev-config.ts");
const TESTS_ROOT = resolve(__dirname, "..", "..");
const KEY = ["cfg", "review", "0123456789abcdef"].join("-");
const posix = process.platform !== "win32";

/**
 * Every exported function that OPENS the config file. `loadJevConfig` and
 * `inspectJevConfig` are the hook path and `jev status`; the two update
 * readers are `jev setup` (carry a key over a mode switch, re-save a file that
 * is too open) and `jev status` on a refused file. All four go through the
 * same `OPEN_FLAGS`, and all four are exercised against a FIFO below — a
 * regression at ONE of the two `openSync` sites would otherwise leave the CLI
 * hanging with nothing failing. A new reader belongs in this list; the count
 * pin further down is what forces that.
 */
const CONFIG_READERS = ["loadJevConfig", "inspectJevConfig", "readJevConfigForUpdate", "readJevConfigFileForUpdate"] as const;

/** Reader names spelled as a CALL, which is what a test must not do near a FIFO. */
const READER_CALL_RE = new RegExp(`\\b(?:${CONFIG_READERS.join("|")})\\s*\\(`);

/** Calls every reader in one child and reports what each returned. */
function readerProbeScript(): string {
  return [
    `import * as config from ${JSON.stringify(CONFIG_MODULE)};`,
    `const names = ${JSON.stringify(CONFIG_READERS)};`,
    `const out = {};`,
    // Two of these readers hand back the configured key. It never reaches the
    // child's stdout, so a failure message cannot leak it either.
    `const redact = (v) => {`,
    `  if (v === null || v === undefined) return null;`,
    `  if (Array.isArray(v)) return v.map(redact);`,
    `  if (typeof v !== "object") return v;`,
    `  const o = {};`,
    `  for (const [k, val] of Object.entries(v)) o[k] = /key/i.test(k) ? "<redacted>" : redact(val);`,
    `  return o;`,
    `};`,
    `for (const name of names) {`,
    `  const fn = config[name];`,
    `  if (typeof fn !== "function") { out[name] = { missing: true }; continue; }`,
    `  const v = fn();`,
    `  out[name] =`,
    `    v && typeof v === "object" && "status" in v`,
    `      ? { status: v.status, problem: v.status === "refused" ? v.problem : null }`,
    `      : { value: redact(v) };`,
    `}`,
    `console.log(JSON.stringify(out));`,
  ].join("\n");
}

describe("semantic/jev-config — review round", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "fp-jev-config-review-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  type ProbeResult = Record<string, { missing?: true; status?: string; problem?: string | null; value?: unknown }>;

  /** Runs the reader probe in a bounded child against `fpHome` and returns what each reader said. */
  const probe = (fpHome: string): ProbeResult => {
    const script = join(home, "probe.ts");
    writeFileSync(script, readerProbeScript());
    const env: NodeJS.ProcessEnv = { ...process.env, FAILPROOFAI_HOME: fpHome, HOME: home, FAILPROOFAI_TELEMETRY_DISABLED: "1" };
    delete env.FAILPROOFAI_JEV_API_KEY;

    const started = Date.now();
    const child = spawnSync("bun", [script], { env, encoding: "utf8", timeout: 10_000 });
    const elapsed = Date.now() - started;

    // A blocking open never returns: the child is killed at the timeout, and
    // `signal` is how that is told apart from an honest failure.
    expect(child.signal, `a config reader blocked (killed after ${elapsed} ms)`).toBeNull();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout + child.stderr).not.toContain(KEY);
    const out = JSON.parse(child.stdout.trim().split("\n").pop() as string) as ProbeResult;
    expect(Object.keys(out).sort()).toEqual([...CONFIG_READERS].sort());
    for (const name of CONFIG_READERS) expect(out[name].missing, `${name} is no longer exported`).toBeUndefined();
    return out;
  };

  it.skipIf(!posix)("a FIFO in the file's place is refused by every reader without blocking (child process, bounded)", () => {
    const fpHome = join(home, ".failproofai");
    mkdirSync(fpHome, { recursive: true, mode: 0o700 });
    const made = spawnSync("mkfifo", [join(fpHome, "jev.json")]);
    if (made.status !== 0) return; // no mkfifo here; nothing to check

    const out = probe(fpHome);
    expect(out.loadJevConfig.value).toBeNull();
    expect(out.inspectJevConfig.status).toBe("refused");
    expect(out.inspectJevConfig.problem).toContain("not a regular file");
    // `jev setup` and `jev status` read the file again through these two; a
    // blocking open at THAT site hangs the CLI and nothing else would catch it.
    expect(out.readJevConfigForUpdate.value).toBeNull();
    expect(out.readJevConfigFileForUpdate.value).toBeNull();
  }, 20_000);

  it.skipIf(!posix)("the child-process harness does load a real file (so the FIFO check is not vacuous)", () => {
    const fpHome = join(home, ".failproofai");
    mkdirSync(fpHome, { recursive: true, mode: 0o700 });
    const file = join(fpHome, "jev.json");
    writeFileSync(file, JSON.stringify({ provider: "typesafe", apiKey: KEY }), { mode: 0o600 });
    chmodSync(file, 0o600);

    const out = probe(fpHome);
    expect((out.loadJevConfig.value as { provider?: string } | null)?.provider).toBe("typesafe");
    expect(out.inspectJevConfig.status).toBe("ok");
    expect((out.readJevConfigForUpdate.value as { provider?: string } | null)?.provider).toBe("typesafe");
    expect((out.readJevConfigFileForUpdate.value as { tooOpen?: boolean } | null)?.tooOpen).toBe(false);
  }, 20_000);

  // ── The rule that keeps this class closed ──────────────────────────────────
  //
  // The two checks above are the ONLY sound way to test the FIFO behaviour:
  // vitest's per-test timeout cannot interrupt a synchronous syscall, so the
  // same test written in-process would hang the worker (and the whole run)
  // rather than fail. An earlier copy of it did exactly that. These two pin
  // that neither half of the arrangement can quietly come undone.

  it("every openSync in the config module uses the non-blocking flags", () => {
    const src = readFileSync(CONFIG_MODULE, "utf8");
    const sites = [...src.matchAll(/openSync\(([^)]*)\)/g)].map((m) => m[1]);
    // A count pin: a third reader must be added to CONFIG_READERS above, or
    // the FIFO check silently stops covering the whole file.
    expect(sites.length, "a new openSync appeared; add its reader to CONFIG_READERS").toBe(2);
    for (const args of sites) expect(args, `openSync(${args}) must pass OPEN_FLAGS`).toMatch(/,\s*OPEN_FLAGS\s*$/);
    expect(src).toMatch(/const OPEN_FLAGS = fsConstants\.O_RDONLY \| \(fsConstants\.O_NONBLOCK \?\? 0\);/);
  });

  it("no test puts a FIFO in the config file's place and then calls a reader in-process", () => {
    const offenders: string[] = [];
    for (const rel of readdirSync(TESTS_ROOT, { recursive: true }) as string[]) {
      if (!rel.endsWith(".test.ts")) continue;
      const src = readFileSync(join(TESTS_ROOT, rel), "utf8");
      if (!src.includes("mkfifo")) continue;
      if (READER_CALL_RE.test(src)) offenders.push(`${rel}: calls a config reader in this process`);
      if (!/timeout:\s*\d/.test(src)) offenders.push(`${rel}: spawns no child with a timeout`);
    }
    expect(
      offenders,
      "a FIFO test must run the reader in a CHILD process with a spawn timeout — in-process it hangs the run instead of failing it",
    ).toEqual([]);
  });

  describe("a model id shaped like a credential", () => {
    // Built at runtime: this repo's own hooks refuse secret-shaped literals.
    const shaped = [
      ["s", "k-or-v1-", "ab12".repeat(16)].join(""),
      ["s", "k-", "proj-", "Ab3".repeat(12)].join(""),
      ["s", "k-", "ant-api03-", "Xy9".repeat(10)].join(""),
      ["gh", "p_", "A1b2C3d4".repeat(5)].join(""),
      ["vc", "k_", "0123abcd".repeat(4)].join(""),
      ["AK", "IA", "ABCDEFGHIJKLMNOP"].join(""),
      "Zq3xT9vB7mK2pL8wR4nY6cH1dF5gJ0sA3eU7iO9k",
    ];

    it("is recognised", () => {
      for (const s of shaped) expect(looksLikeCredential(s)).toBe(true);
    });

    it("is refused by validation without being quoted", () => {
      for (const model of shaped) {
        const r = validateJevConfig({ provider: "openrouter", apiKey: KEY, model });
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.problem).toContain("looks like an API key");
          expect(r.problem).not.toContain(model);
        }
      }
    });

    it("the key itself as the model is refused whatever its shape, file key or env key", () => {
      const inFile = validateJevConfig({ provider: "custom", baseUrl: "https://gw.example.com/v1", apiKey: KEY, model: KEY });
      expect(inFile.ok).toBe(false);
      if (!inFile.ok) expect(inFile.problem).not.toContain(KEY);
      const fromEnv = validateJevConfig({ provider: "custom", baseUrl: "https://gw.example.com/v1", model: KEY }, KEY);
      expect(fromEnv.ok).toBe(false);
    });

    it("real model ids are not mistaken for one", () => {
      for (const id of [
        "jev-1.13.0",
        "jev-1.13",
        "typesafe/jev-1.13",
        "typesafe/jev-1.13-20260917",
        "typesafe-ai/jev",
        "typesafe/jev",
        "~typesafe/jev-latest",
        "@cf/typesafe/jev",
        "house-jev",
        "guardrail-model-2026",
        "skipper",
        "risk-model",
      ]) {
        expect(looksLikeCredential(id)).toBe(false);
        expect(validateJevConfig({ provider: "custom", baseUrl: "https://gw.example.com/v1", apiKey: KEY, model: id }).ok).toBe(true);
      }
    });
  });
});
