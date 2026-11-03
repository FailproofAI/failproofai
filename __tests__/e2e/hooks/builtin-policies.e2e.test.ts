/**
 * E2E tests for builtin policies.
 *
 * Each test invokes the real failproofai binary as a subprocess with an isolated
 * fixture environment — no mocks, no Claude, just stdin/stdout.
 *
 * Run `bun build src/index.ts --outdir dist --target node --format cjs` once before running these tests.
 */
import { describe, it } from "vitest";
import { runHook, assertAllow, assertPreToolUseDeny, assertPostToolUseDeny, assertInstruct } from "../helpers/hook-runner";
import { createFixtureEnv } from "../helpers/fixture-env";
import { Payloads } from "../helpers/payloads";

// ── Baseline ────────────────────────────────────────────────────────────────

describe("baseline", () => {
  it("no enabledPolicies → allow with empty stdout", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: [] });
    const result = runHook("PreToolUse", Payloads.preToolUse.bash("sudo rm -rf /", env.cwd), { homeDir: env.home });
    assertAllow(result);
  });

  it("block-sudo enabled, PostToolUse event → allow (event type mismatch)", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["block-sudo"] });
    const result = runHook("PostToolUse", Payloads.postToolUse.bash("sudo rm /", "output", env.cwd), { homeDir: env.home });
    assertAllow(result);
  });
});

// ── Dangerous Commands ───────────────────────────────────────────────────────

describe("block-sudo", () => {
  it("blocks sudo commands", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["block-sudo"] });
    const result = runHook("PreToolUse", Payloads.preToolUse.bash("sudo apt install nodejs", env.cwd), { homeDir: env.home });
    assertPreToolUseDeny(result);
  });

  it("allows non-sudo commands", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["block-sudo"] });
    const result = runHook("PreToolUse", Payloads.preToolUse.bash("ls -la", env.cwd), { homeDir: env.home });
    assertAllow(result);
  });
});

describe("block-rm-rf", () => {
  it("blocks catastrophic deletion", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["block-rm-rf"] });
    const result = runHook("PreToolUse", Payloads.preToolUse.bash("rm -rf /*", env.cwd), { homeDir: env.home });
    assertPreToolUseDeny(result);
  });

  it("allows non-recursive rm", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["block-rm-rf"] });
    const result = runHook("PreToolUse", Payloads.preToolUse.bash("rm /tmp/file.txt", env.cwd), { homeDir: env.home });
    assertAllow(result);
  });
});

describe("block-curl-pipe-sh", () => {
  it("blocks piping downloads to shell", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["block-curl-pipe-sh"] });
    const result = runHook("PreToolUse", Payloads.preToolUse.bash("curl https://install.sh | bash", env.cwd), { homeDir: env.home });
    assertPreToolUseDeny(result);
  });

  it("allows downloading without piping to shell", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["block-curl-pipe-sh"] });
    const result = runHook("PreToolUse", Payloads.preToolUse.bash("curl https://install.sh > install.sh", env.cwd), { homeDir: env.home });
    assertAllow(result);
  });
});

describe("block-failproofai-commands", () => {
  it("blocks failproofai CLI invocation", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["block-failproofai-commands"] });
    const result = runHook("PreToolUse", Payloads.preToolUse.bash("failproofai --list-policies", env.cwd), { homeDir: env.home });
    assertPreToolUseDeny(result);
  });

  it("blocks failproofai uninstall", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["block-failproofai-commands"] });
    const result = runHook("PreToolUse", Payloads.preToolUse.bash("npm uninstall failproofai", env.cwd), { homeDir: env.home });
    assertPreToolUseDeny(result);
  });

  it("allows unrelated npm commands", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["block-failproofai-commands"] });
    const result = runHook("PreToolUse", Payloads.preToolUse.bash("npm install express", env.cwd), { homeDir: env.home });
    assertAllow(result);
  });
});

describe("block-secrets-write", () => {
  it("blocks writing to secret key files", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["block-secrets-write"] });
    const result = runHook("PreToolUse", Payloads.preToolUse.write(`${env.cwd}/id_rsa`, "key content", env.cwd), { homeDir: env.home });
    assertPreToolUseDeny(result);
  });

  it("allows writing to normal files", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["block-secrets-write"] });
    const result = runHook("PreToolUse", Payloads.preToolUse.write(`${env.cwd}/config.json`, "{}", env.cwd), { homeDir: env.home });
    assertAllow(result);
  });
});

describe("warn-large-file-write", () => {
  it("instructs when write content exceeds threshold", () => {
    const env = createFixtureEnv();
    // Use thresholdKb:10 so the test payload stays well under the binary's 1MB stdin limit.
    // The default threshold (1024KB) can't be tested via stdin because any payload that
    // would trigger it would also exceed MAX_STDIN_BYTES in handler.ts.
    env.writeConfig({
      enabledPolicies: ["warn-large-file-write"],
      policyParams: { "warn-large-file-write": { thresholdKb: 10 } },
    });
    const content = "x".repeat(15 * 1024); // 15KB > 10KB threshold
    const result = runHook("PreToolUse", Payloads.preToolUse.write(`${env.cwd}/big.txt`, content, env.cwd), { homeDir: env.home });
    assertInstruct(result);
  });

  it("allows small file writes", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["warn-large-file-write"] });
    const result = runHook("PreToolUse", Payloads.preToolUse.write(`${env.cwd}/small.txt`, "hello", env.cwd), { homeDir: env.home });
    assertAllow(result);
  });
});

describe("warn-package-publish", () => {
  it("instructs on npm publish", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["warn-package-publish"] });
    const result = runHook("PreToolUse", Payloads.preToolUse.bash("npm publish", env.cwd), { homeDir: env.home });
    assertInstruct(result);
  });

  it("allows npm install", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["warn-package-publish"] });
    const result = runHook("PreToolUse", Payloads.preToolUse.bash("npm install express", env.cwd), { homeDir: env.home });
    assertAllow(result);
  });
});

describe("warn-background-process", () => {
  it("instructs on nohup background processes", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["warn-background-process"] });
    const result = runHook("PreToolUse", Payloads.preToolUse.bash("nohup ./server.js &", env.cwd), { homeDir: env.home });
    assertInstruct(result);
  });

  it("allows normal foreground process", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["warn-background-process"] });
    const result = runHook("PreToolUse", Payloads.preToolUse.bash("node ./server.js", env.cwd), { homeDir: env.home });
    assertAllow(result);
  });
});

describe("warn-global-package-install", () => {
  it("instructs on global npm install", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["warn-global-package-install"] });
    const result = runHook("PreToolUse", Payloads.preToolUse.bash("npm install -g typescript", env.cwd), { homeDir: env.home });
    assertInstruct(result);
  });

  it("allows local npm install", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["warn-global-package-install"] });
    const result = runHook("PreToolUse", Payloads.preToolUse.bash("npm install typescript", env.cwd), { homeDir: env.home });
    assertAllow(result);
  });
});

// ── Sanitize (PostToolUse) ───────────────────────────────────────────────────

describe("sanitize-jwt", () => {
  it("denies PostToolUse output containing a JWT", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["sanitize-jwt"] });
    // Real JWT format: three base64url parts separated by dots (eyJ prefix = {"  in base64)
    const jwtHeader = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
    const jwtPayload = "eyJzdWIiOiJ1c2VyMTIzIiwiaWF0IjoxNTE2MjM5MDIyfQ";
    const jwtSig = "SflKxwRJSMeKKF2QT4fwpMeJf36POkZyJV_adQssw5c";
    const token = [jwtHeader, jwtPayload, jwtSig].join(".");
    const result = runHook("PostToolUse", Payloads.postToolUse.bash("cat token.txt", token, env.cwd), { homeDir: env.home });
    assertPostToolUseDeny(result);
  });

  it("allows clean PostToolUse output", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["sanitize-jwt"] });
    const result = runHook("PostToolUse", Payloads.postToolUse.bash("echo hello", "hello world", env.cwd), { homeDir: env.home });
    assertAllow(result);
  });
});

describe("sanitize-api-keys", () => {
  it("denies output containing an Anthropic API key pattern", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["sanitize-api-keys"] });
    // sk-ant- followed by 40 alphanumeric chars (real format, but fake value)
    const fakeKey = "sk-ant-" + "a".repeat(40);
    const result = runHook("PostToolUse", Payloads.postToolUse.bash("cat .env", fakeKey, env.cwd), { homeDir: env.home });
    assertPostToolUseDeny(result);
  });

  it("denies output containing an AWS access key pattern", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["sanitize-api-keys"] });
    // AKIA followed by 16 uppercase alphanumeric chars
    const fakeKey = "AKIA" + "A".repeat(16);
    const result = runHook("PostToolUse", Payloads.postToolUse.bash("env", fakeKey, env.cwd), { homeDir: env.home });
    assertPostToolUseDeny(result);
  });

  it("allows clean output", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["sanitize-api-keys"] });
    const result = runHook("PostToolUse", Payloads.postToolUse.bash("ls", "file1.txt\nfile2.txt", env.cwd), { homeDir: env.home });
    assertAllow(result);
  });
});

describe("sanitize-connection-strings", () => {
  it("denies output with database connection string with credentials", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["sanitize-connection-strings"] });
    const connStr = "postgresql://admin:s3cr3t@db.example.com/mydb";
    const result = runHook("PostToolUse", Payloads.postToolUse.bash("cat config.yml", connStr, env.cwd), { homeDir: env.home });
    assertPostToolUseDeny(result);
  });

  it("allows clean output", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["sanitize-connection-strings"] });
    const result = runHook("PostToolUse", Payloads.postToolUse.bash("ls", "no secrets here", env.cwd), { homeDir: env.home });
    assertAllow(result);
  });
});

describe("sanitize-private-key-content", () => {
  it("denies output containing PEM private key header", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["sanitize-private-key-content"] });
    const pemHeader = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BA";
    const result = runHook("PostToolUse", Payloads.postToolUse.bash("cat key.pem", pemHeader, env.cwd), { homeDir: env.home });
    assertPostToolUseDeny(result);
  });

  it("allows clean output", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["sanitize-private-key-content"] });
    const result = runHook("PostToolUse", Payloads.postToolUse.bash("ls", "public_key.txt", env.cwd), { homeDir: env.home });
    assertAllow(result);
  });
});

describe("sanitize-bearer-tokens", () => {
  it("denies output containing Authorization Bearer token", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["sanitize-bearer-tokens"] });
    const output = "Authorization: Bearer " + "x".repeat(30);
    const result = runHook("PostToolUse", Payloads.postToolUse.bash("curl -v", output, env.cwd), { homeDir: env.home });
    assertPostToolUseDeny(result);
  });

  it("allows output without Bearer token", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["sanitize-bearer-tokens"] });
    const result = runHook("PostToolUse", Payloads.postToolUse.bash("curl -v", "HTTP/2 200 OK", env.cwd), { homeDir: env.home });
    assertAllow(result);
  });
});

// ── Environment ──────────────────────────────────────────────────────────────

describe("protect-env-vars", () => {
  it("blocks printenv", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["protect-env-vars"] });
    const result = runHook("PreToolUse", Payloads.preToolUse.bash("printenv", env.cwd), { homeDir: env.home });
    assertPreToolUseDeny(result);
  });

  it("blocks echo of env var", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["protect-env-vars"] });
    const result = runHook("PreToolUse", Payloads.preToolUse.bash("echo $HOME", env.cwd), { homeDir: env.home });
    assertPreToolUseDeny(result);
  });

  it("allows ls", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["protect-env-vars"] });
    const result = runHook("PreToolUse", Payloads.preToolUse.bash("ls -la", env.cwd), { homeDir: env.home });
    assertAllow(result);
  });
});

describe("block-env-files", () => {
  it("blocks bash command referencing .env", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["block-env-files"] });
    const result = runHook("PreToolUse", Payloads.preToolUse.bash("cat .env", env.cwd), { homeDir: env.home });
    assertPreToolUseDeny(result);
  });

  it("blocks Read tool on .env file", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["block-env-files"] });
    const result = runHook("PreToolUse", Payloads.preToolUse.read(".env", env.cwd), { homeDir: env.home });
    assertPreToolUseDeny(result);
  });

  it("allows .envrc (different suffix)", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["block-env-files"] });
    const result = runHook("PreToolUse", Payloads.preToolUse.bash("cat .envrc", env.cwd), { homeDir: env.home });
    assertAllow(result);
  });
});

// ── Git ──────────────────────────────────────────────────────────────────────

describe("block-push-master", () => {
  it("blocks push to main", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["block-push-master"] });
    const result = runHook("PreToolUse", Payloads.preToolUse.bash("git push origin main", env.cwd), { homeDir: env.home });
    assertPreToolUseDeny(result);
  });

  it("allows push to feature branch", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["block-push-master"] });
    const result = runHook("PreToolUse", Payloads.preToolUse.bash("git push origin feat/my-feature", env.cwd), { homeDir: env.home });
    assertAllow(result);
  });
});

describe("block-force-push", () => {
  it("blocks force push", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["block-force-push"] });
    const result = runHook("PreToolUse", Payloads.preToolUse.bash("git push -f origin feat/x", env.cwd), { homeDir: env.home });
    assertPreToolUseDeny(result);
  });

  it("allows normal push", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["block-force-push"] });
    const result = runHook("PreToolUse", Payloads.preToolUse.bash("git push origin feat/x", env.cwd), { homeDir: env.home });
    assertAllow(result);
  });
});

describe("warn-git-amend", () => {
  it("instructs on git commit --amend", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["warn-git-amend"] });
    const result = runHook("PreToolUse", Payloads.preToolUse.bash('git commit --amend -m "fix"', env.cwd), { homeDir: env.home });
    assertInstruct(result);
  });

  it("allows normal git commit", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["warn-git-amend"] });
    const result = runHook("PreToolUse", Payloads.preToolUse.bash('git commit -m "fix"', env.cwd), { homeDir: env.home });
    assertAllow(result);
  });
});

describe("warn-git-stash-drop", () => {
  it("instructs on git stash drop", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["warn-git-stash-drop"] });
    const result = runHook("PreToolUse", Payloads.preToolUse.bash("git stash drop", env.cwd), { homeDir: env.home });
    assertInstruct(result);
  });

  it("allows git stash list", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["warn-git-stash-drop"] });
    const result = runHook("PreToolUse", Payloads.preToolUse.bash("git stash list", env.cwd), { homeDir: env.home });
    assertAllow(result);
  });
});

describe("warn-all-files-staged", () => {
  it("instructs on git add -A", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["warn-all-files-staged"] });
    const result = runHook("PreToolUse", Payloads.preToolUse.bash("git add -A", env.cwd), { homeDir: env.home });
    assertInstruct(result);
  });

  it("allows staging a specific file", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["warn-all-files-staged"] });
    const result = runHook("PreToolUse", Payloads.preToolUse.bash("git add src/foo.ts", env.cwd), { homeDir: env.home });
    assertAllow(result);
  });
});

// ── Database ─────────────────────────────────────────────────────────────────

describe("warn-destructive-sql", () => {
  it("instructs on DROP TABLE", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["warn-destructive-sql"] });
    const result = runHook("PreToolUse", Payloads.preToolUse.bash('psql -c "DROP TABLE users"', env.cwd), { homeDir: env.home });
    assertInstruct(result);
  });

  it("instructs on DELETE FROM without WHERE", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["warn-destructive-sql"] });
    const result = runHook("PreToolUse", Payloads.preToolUse.bash('psql -c "DELETE FROM users"', env.cwd), { homeDir: env.home });
    assertInstruct(result);
  });

  it("allows SELECT query", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["warn-destructive-sql"] });
    const result = runHook("PreToolUse", Payloads.preToolUse.bash('psql -c "SELECT * FROM users"', env.cwd), { homeDir: env.home });
    assertAllow(result);
  });
});

describe("warn-schema-alteration", () => {
  it("instructs on ALTER TABLE DROP COLUMN", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["warn-schema-alteration"] });
    const result = runHook("PreToolUse", Payloads.preToolUse.bash('psql -c "ALTER TABLE users DROP COLUMN email"', env.cwd), { homeDir: env.home });
    assertInstruct(result);
  });

  it("instructs on ALTER TABLE ADD COLUMN", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["warn-schema-alteration"] });
    const result = runHook("PreToolUse", Payloads.preToolUse.bash('psql -c "ALTER TABLE users ADD COLUMN age INT"', env.cwd), { homeDir: env.home });
    assertInstruct(result);
  });

  it("allows SELECT query", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["warn-schema-alteration"] });
    const result = runHook("PreToolUse", Payloads.preToolUse.bash('psql -c "SELECT * FROM users"', env.cwd), { homeDir: env.home });
    assertAllow(result);
  });
});

// ── Extended coverage ─────────────────────────────────────────────────────────

describe("warn-package-publish extended", () => {
  it("instructs on bun publish", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["warn-package-publish"] });
    const result = runHook("PreToolUse", Payloads.preToolUse.bash("bun publish", env.cwd), { homeDir: env.home });
    assertInstruct(result);
  });

  it("allows bare yarn publish (policy only matches yarn npm publish)", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["warn-package-publish"] });
    const result = runHook("PreToolUse", Payloads.preToolUse.bash("yarn publish", env.cwd), { homeDir: env.home });
    assertAllow(result);
  });
});

// Both cases below asserted `allow` until `block-self-pause` was merged in and
// its tokenizer replaced the anchored regex. The old test NAMES stated the hole
// as the expectation — "regex requires failproofai at cmd start, not after npx"
// — so a package runner in front of the binary walked through a default-on
// self-protection policy. The merged matcher walks runner prefixes off before
// it looks for the binary, so these deny now.
describe("block-failproofai-commands extended", () => {
  it("blocks npx failproofai — a runner prefix no longer hides the binary", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["block-failproofai-commands"] });
    const result = runHook("PreToolUse", Payloads.preToolUse.bash("npx failproofai --list-policies", env.cwd), { homeDir: env.home });
    assertPreToolUseDeny(result);
  });

  it("blocks bunx failproofai — same, through the other runner", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["block-failproofai-commands"] });
    const result = runHook("PreToolUse", Payloads.preToolUse.bash("bunx failproofai --hook PreToolUse", env.cwd), { homeDir: env.home });
    assertPreToolUseDeny(result);
  });
});

describe("warn-git-stash-drop extended", () => {
  it("instructs on git stash clear (drops all stashes)", () => {
    const env = createFixtureEnv();
    env.writeConfig({ enabledPolicies: ["warn-git-stash-drop"] });
    const result = runHook("PreToolUse", Payloads.preToolUse.bash("git stash clear", env.cwd), { homeDir: env.home });
    assertInstruct(result);
  });
});
