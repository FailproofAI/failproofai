// @vitest-environment node
//
// `failproofai jev` through the real entry point, the way a person or a
// provisioning script runs it: the key piped on stdin, an isolated HOME, no
// terminal. What this covers that the in-process tests cannot: the dispatch in
// bin/failproofai.mjs, the help routing, the first-run exemption (a wizard in
// front of `jev setup` would read the piped key as its first answer), and that
// nothing the process prints — stdout or stderr — contains the key.
import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { shouldOfferFirstRun } from "../../src/hooks/first-run-gate";

const BINARY = resolve(__dirname, "..", "..", "bin", "failproofai.mjs");
const HOME = mkdtempSync(join(tmpdir(), "fpai-jev-bin-"));
const FP_HOME = join(HOME, ".failproofai");
const CONFIG = join(FP_HOME, "jev.json");
const KEY = ["bin", "test", "9f8e7d6c5b4a3210"].join("-");

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

function cli(args: string[], input?: string) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME,
    USERPROFILE: HOME,
    FAILPROOFAI_HOME: FP_HOME,
    FAILPROOFAI_TELEMETRY_DISABLED: "1",
  };
  delete env.FAILPROOFAI_JEV_API_KEY;
  delete env.FAILPROOFAI_EVALUATOR;
  const result = spawnSync("bun", [BINARY, ...args], { env, input: input ?? "", encoding: "utf8", timeout: 20_000 });
  if (result.error) throw result.error;
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("failproofai jev (real binary)", () => {
  it("is never interrupted by the first-run wizard", () => {
    expect(shouldOfferFirstRun(["jev", "setup", "--provider", "typesafe", "--key-stdin"])).toBe(false);
    expect(shouldOfferFirstRun(["jev", "status"])).toBe(false);
  });

  it("`jev --help`, `help jev` and a bare `jev` are one screen", () => {
    const direct = cli(["jev", "--help"]);
    const routed = cli(["help", "jev"]);
    const bare = cli(["jev"]);
    expect(direct.exitCode).toBe(0);
    expect(direct.stdout).toContain("failproofai jev setup");
    expect(direct.stdout).toContain("--key-stdin");
    expect(routed.stdout).toBe(direct.stdout);
    expect(bare.stdout).toBe(direct.stdout);
  });

  it("setup → status → remove, with the key piped on stdin and never printed", () => {
    const setup = cli(["jev", "setup", "--provider", "typesafe", "--mode", "observe", "--key-stdin"], `${KEY}\n`);
    expect(setup.exitCode).toBe(0);
    expect(setup.stdout + setup.stderr).not.toContain(KEY);
    expect(setup.stdout).toContain("jev.json");
    expect(existsSync(CONFIG)).toBe(true);
    if (process.platform !== "win32") expect(statSync(CONFIG).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(CONFIG, "utf8"))).toEqual({ provider: "typesafe", apiKey: KEY, mode: "observe" });

    const status = cli(["jev", "status"]);
    expect(status.exitCode).toBe(0);
    expect(status.stdout + status.stderr).not.toContain(KEY);
    expect(status.stdout).toContain("typesafe");
    expect(status.stdout).toContain("observe");

    const json = cli(["jev", "status", "--json"]);
    expect(json.exitCode).toBe(0);
    expect(json.stdout).not.toContain(KEY);
    expect(JSON.parse(json.stdout)).toMatchObject({ status: "ok", provider: "typesafe", mode: "observe", keySource: "file" });

    const removed = cli(["jev", "remove"]);
    expect(removed.exitCode).toBe(0);
    expect(existsSync(CONFIG)).toBe(false);

    const off = cli(["jev", "status", "--json"]);
    expect(JSON.parse(off.stdout)).toMatchObject({ status: "absent" });
  });

  it("fails cleanly, writing nothing, when there is no key and no terminal", () => {
    const r = cli(["jev", "setup", "--provider", "vercel"]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("--key-stdin");
    expect(existsSync(CONFIG)).toBe(false);
  });

  it("rejects an unknown subcommand with the usage, not a stack trace", () => {
    const r = cli(["jev", "enable"]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("Unknown subcommand: enable");
    expect(r.stderr).not.toContain("node:internal");
  });

  it("does not repeat a subcommand shaped like a key — `failproofai jev <key>` is the paste-in-the-wrong-place case", () => {
    const r = cli(["jev", KEY]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).not.toContain(KEY);
    expect(r.stdout + r.stderr).toContain("Unknown subcommand");
    expect(r.stdout + r.stderr).toContain("--key-stdin");
  });
});

// Every Jev remedy says `failproofai config --token <key>`; that command put the
// key in argv without a word, while `jev setup --token` warns.
describe("failproofai config --token (real binary)", () => {
  it("--connect with --token warns about shell history even when the connect fails, and never prints the key", () => {
    const r = cli(["config", "--connect", "http://127.0.0.1:9", "--token", KEY]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("shell history");
    expect(r.stderr).toContain("FAILPROOFAI_CLOUD_TOKEN");
    expect(r.stdout + r.stderr).not.toContain(KEY);
    // One `▲` line and one fix line, the command plain in a pipe.
    expect(r.stderr).toContain(
      "▲ --token put the key in your shell history and, while this ran, the process list. Rotate it if that matters.\n" +
        "  Next time, set FAILPROOFAI_CLOUD_TOKEN instead:  read -rs FAILPROOFAI_CLOUD_TOKEN && export FAILPROOFAI_CLOUD_TOKEN",
    );
  });
});

describe("failproofai config --connect (real binary)", () => {
  it("takes the key from FAILPROOFAI_CLOUD_TOKEN, as `config --help` says it can", () => {
    // It read only --token, so the documented env var — the one that keeps a key
    // out of shell history — was refused as "needs a machine token".
    const env: NodeJS.ProcessEnv = {
      ...process.env, HOME, USERPROFILE: HOME, FAILPROOFAI_HOME: FP_HOME,
      FAILPROOFAI_TELEMETRY_DISABLED: "1", FAILPROOFAI_CLOUD_TOKEN: KEY,
    };
    const r = spawnSync("bun", [BINARY, "config", "--connect", "http://127.0.0.1:1"], {
      env, input: "", encoding: "utf8", timeout: 20_000,
    });
    const out = (r.stdout ?? "") + (r.stderr ?? "");
    expect(out).not.toContain("needs a machine token");
    expect(out).not.toContain(KEY);
  });
});
