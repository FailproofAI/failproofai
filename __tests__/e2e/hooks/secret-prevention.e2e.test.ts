/**
 * E2E for the PreToolUse secret policies — the real binary, real stdin/stdout,
 * no mocks.
 *
 * Deliberately a separate file. builtin-policies-extended.e2e.test.ts exists
 * because credential-shaped fixtures in the main suite trip the sanitize-*
 * family for every other policy sharing the file, and these fixtures are
 * nothing but credential-shaped strings.
 */
import { describe, it, expect } from "vitest";
import { runHook, assertAllow, assertPreToolUseDeny } from "../helpers/hook-runner";
import { createFixtureEnv } from "../helpers/fixture-env";
import { Payloads } from "../helpers/payloads";

// Built at runtime so the literal never appears in the source of a file that
// this repo's own dogfood hooks read.
const ANTHROPIC = `sk-ant-api03-${"A".repeat(32)}`;
const GITHUB = `ghp_${"b".repeat(36)}`;

describe("block-secret-in-write (e2e)", () => {
  it("blocks a credential written into file content", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["block-secret-in-write"] });
    const result = runHook(
      "PreToolUse",
      Payloads.preToolUse.write(`${env.cwd}/src/config.ts`, `export const key = "${ANTHROPIC}";`, env.cwd),
      { homeDir: env.home },
    );
    assertPreToolUseDeny(result);
  });

  it("blocks a GitHub token just the same", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["block-secret-in-write"] });
    const result = runHook(
      "PreToolUse",
      Payloads.preToolUse.write(`${env.cwd}/src/gh.ts`, `const t = "${GITHUB}";`, env.cwd),
      { homeDir: env.home },
    );
    assertPreToolUseDeny(result);
  });

  it("allows ordinary source", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["block-secret-in-write"] });
    const result = runHook(
      "PreToolUse",
      Payloads.preToolUse.write(`${env.cwd}/src/index.ts`, "export const risk_score = 1;\n", env.cwd),
      { homeDir: env.home },
    );
    assertAllow(result);
  });

  it("skips a test-fixture path by default", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["block-secret-in-write"] });
    const result = runHook(
      "PreToolUse",
      Payloads.preToolUse.write(`${env.cwd}/__tests__/keys.test.ts`, ANTHROPIC, env.cwd),
      { homeDir: env.home },
    );
    assertAllow(result);
  });

  it("scans a test-fixture path when skipTestFixtures is off", () => {
    const env = createFixtureEnv();
    env.writeConfig({
      enabledPolicies: ["block-secret-in-write"],
      policyParams: { "block-secret-in-write": { skipTestFixtures: false } },
    });
    const result = runHook(
      "PreToolUse",
      Payloads.preToolUse.write(`${env.cwd}/__tests__/keys.test.ts`, ANTHROPIC, env.cwd),
      { homeDir: env.home },
    );
    assertPreToolUseDeny(result);
  });

  it("excuses a literal listed in allowedSecretHashes", async () => {
    const { createHash } = await import("node:crypto");
    const env = createFixtureEnv();
    env.writeConfig({
      enabledPolicies: ["block-secret-in-write"],
      policyParams: {
        "block-secret-in-write": {
          allowedSecretHashes: [createHash("sha256").update(ANTHROPIC, "utf8").digest("hex")],
        },
      },
    });
    const result = runHook(
      "PreToolUse",
      Payloads.preToolUse.write(`${env.cwd}/src/config.ts`, ANTHROPIC, env.cwd),
      { homeDir: env.home },
    );
    assertAllow(result);
  });
});

describe("block-credential-files (e2e)", () => {
  it("blocks reading an SSH private key", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["block-credential-files"] });
    const result = runHook(
      "PreToolUse",
      Payloads.preToolUse.read(`${env.home}/.ssh/id_ed25519`, env.cwd),
      { homeDir: env.home },
    );
    assertPreToolUseDeny(result);
  });

  it("blocks a bash read of ~/.aws/credentials", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["block-credential-files"] });
    const result = runHook(
      "PreToolUse",
      Payloads.preToolUse.bash(`cat ${env.home}/.aws/credentials`, env.cwd),
      { homeDir: env.home },
    );
    assertPreToolUseDeny(result);
  });

  it("allows the public half of a keypair", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["block-credential-files"] });
    const result = runHook(
      "PreToolUse",
      Payloads.preToolUse.read(`${env.home}/.ssh/id_ed25519.pub`, env.cwd),
      { homeDir: env.home },
    );
    assertAllow(result);
  });

  it("leaves .npmrc alone until strict is on", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["block-credential-files"] });
    assertAllow(runHook(
      "PreToolUse",
      Payloads.preToolUse.read(`${env.cwd}/.npmrc`, env.cwd),
      { homeDir: env.home },
    ));

    const strict = createFixtureEnv();
    strict.writeConfig({
      enabledPolicies: ["block-credential-files"],
      policyParams: { "block-credential-files": { strict: true } },
    });
    assertPreToolUseDeny(runHook(
      "PreToolUse",
      Payloads.preToolUse.read(`${strict.cwd}/.npmrc`, strict.cwd),
      { homeDir: strict.home },
    ));
  });
});

describe("warn-assigned-secret (e2e)", () => {
  it("instructs rather than blocking, so the agent can proceed after explaining", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["warn-assigned-secret"] });
    const result = runHook(
      "PreToolUse",
      Payloads.preToolUse.bash("export DATABASE_PASSWORD=hunter2-prod-acme", env.cwd),
      { homeDir: env.home },
    );
    expect(result.exitCode).toBe(0);
    const output = result.parsed?.hookSpecificOutput as Record<string, unknown> | undefined;
    expect(String(output?.additionalContext ?? "")).toContain("DATABASE_PASSWORD");
  });

  it("stays quiet on a bare key= — React's prop, not a credential", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["warn-assigned-secret"] });
    const result = runHook(
      "PreToolUse",
      Payloads.preToolUse.bash("grep -r key=abcdefghijklmnop src/", env.cwd),
      { homeDir: env.home },
    );
    assertAllow(result);
  });
});
