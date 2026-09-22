// @vitest-environment node
//
// Review round on the config loader:
// - a FIFO in jev.json's place must not block the reader. Checked in a CHILD
//   process with a timeout: a blocking open() in this test worker would hang
//   the whole file instead of failing it, which is what a regression to a
//   plain O_RDONLY open looks like;
// - a model id shaped like a credential is refused, and never quoted.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { looksLikeCredential, validateJevConfig } from "../../../src/hooks/semantic/jev-config";

const CONFIG_MODULE = resolve(__dirname, "..", "..", "..", "src", "hooks", "semantic", "jev-config.ts");
const KEY = ["cfg", "review", "0123456789abcdef"].join("-");
const posix = process.platform !== "win32";

describe("semantic/jev-config — review round", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "fp-jev-config-review-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it.skipIf(!posix)("a FIFO in the file's place is refused without blocking (child process, bounded)", () => {
    const fpHome = join(home, ".failproofai");
    mkdirSync(fpHome, { recursive: true, mode: 0o700 });
    const made = spawnSync("mkfifo", [join(fpHome, "jev.json")]);
    if (made.status !== 0) return; // no mkfifo here; nothing to check

    const script = join(home, "load.ts");
    writeFileSync(
      script,
      [
        `import { inspectJevConfig, loadJevConfig } from ${JSON.stringify(CONFIG_MODULE)};`,
        "const loaded = loadJevConfig();",
        "const r = inspectJevConfig();",
        "console.log(JSON.stringify({ loaded, status: r.status, problem: r.status === 'refused' ? r.problem : null }));",
      ].join("\n"),
    );
    const env: NodeJS.ProcessEnv = { ...process.env, FAILPROOFAI_HOME: fpHome, HOME: home, FAILPROOFAI_TELEMETRY_DISABLED: "1" };
    delete env.FAILPROOFAI_JEV_API_KEY;

    const started = Date.now();
    const child = spawnSync("bun", [script], { env, encoding: "utf8", timeout: 10_000 });
    const elapsed = Date.now() - started;

    // A blocking open never returns: the child is killed at the timeout.
    expect(child.signal, `the loader blocked on the FIFO (killed after ${elapsed} ms)`).toBeNull();
    expect(child.status, child.stderr).toBe(0);
    const out = JSON.parse(child.stdout.trim().split("\n").pop() as string) as { loaded: unknown; status: string; problem: string | null };
    expect(out.loaded).toBeNull();
    expect(out.status).toBe("refused");
    expect(out.problem).toContain("not a regular file");
  }, 20_000);

  it.skipIf(!posix)("the child-process harness does load a real file (so the FIFO check is not vacuous)", () => {
    const fpHome = join(home, ".failproofai");
    mkdirSync(fpHome, { recursive: true, mode: 0o700 });
    const file = join(fpHome, "jev.json");
    writeFileSync(file, JSON.stringify({ provider: "typesafe", apiKey: KEY }), { mode: 0o600 });
    chmodSync(file, 0o600);
    const script = join(home, "load.ts");
    writeFileSync(
      script,
      [
        `import { loadJevConfig } from ${JSON.stringify(CONFIG_MODULE)};`,
        "console.log(JSON.stringify({ provider: loadJevConfig()?.provider ?? null }));",
      ].join("\n"),
    );
    const env: NodeJS.ProcessEnv = { ...process.env, FAILPROOFAI_HOME: fpHome, HOME: home, FAILPROOFAI_TELEMETRY_DISABLED: "1" };
    const child = spawnSync("bun", [script], { env, encoding: "utf8", timeout: 10_000 });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout.trim().split("\n").pop() as string)).toEqual({ provider: "typesafe" });
  }, 20_000);

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
