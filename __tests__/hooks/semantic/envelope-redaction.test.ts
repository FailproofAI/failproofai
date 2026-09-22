// @vitest-environment node
/**
 * Secrets in the WHOLE Jev request: every field buildEnvelope/prepareSemantic
 * sends, not just the strings redactSecrets is handed directly.
 *
 * Every secret-shaped fixture is built at runtime (see ./redaction-fixtures).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_STRING_CHARS, MAX_USER_MESSAGE_CHARS, buildEnvelope, capHeadTail } from "../../../src/hooks/semantic/envelope";
import { prepareSemantic } from "../../../src/hooks/semantic/evaluator";
import { computeFacts, scanCommand } from "../../../src/hooks/semantic/facts";
import { setEnvSecretSource } from "../../../src/hooks/semantic/redact";
import type { Facts } from "../../../src/hooks/semantic/types";
import { ALNUM, SK, gatewayKey, pemBegin, pemEnd, prng, randomToken, rnd } from "./redaction-fixtures";

const rand = prng(0x5ec7e7);

beforeEach(() => setEnvSecretSource({}));
afterEach(() => setEnvSecretSource(null));

const facts = (over: Partial<Facts> = {}): Facts => ({
  toolName: "Bash",
  toolClass: "shell",
  toolIsKnown: true,
  cwd: "/p",
  projectRoot: "/p",
  currentGitBranch: "feature/x",
  paths: [],
  permissionMode: "default",
  ...over,
});

/** Every run of 8+ characters of `secret` that must not survive anywhere. */
function fragments(secret: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 8 <= secret.length; i += 4) out.push(secret.slice(i, i + 8));
  return out;
}

function expectAbsent(serialized: string, secret: string): void {
  for (const f of fragments(secret)) expect(serialized, `fragment ${f.slice(0, 2)}… of a fixture secret`).not.toContain(f);
}

describe("buildEnvelope — structured tool input", () => {
  it("redacts a value by its KEY when nothing in the value gives it away", () => {
    const pw = "hunter2-" + rnd(rand, 6);
    const tok = randomToken(rand, 24);
    const env = buildEnvelope(
      { password: pw, api_key: tok, user: "alice", nested: { client_secret: tok + "x" } },
      [],
      facts({ toolName: "mcp__db__connect", toolClass: "other", toolIsKnown: false }),
      null,
    );
    const input = (env.state.agent_request as { input: Record<string, unknown> }).input;
    expect(input.password).toBe("<redacted:assigned secret>");
    expect(input.api_key).toBe("<redacted:assigned secret>");
    expect(input.user).toBe("alice");
    const s = JSON.stringify(env.state);
    expect(s).not.toContain(pw);
    expect(s).not.toContain(tok);
    expect(env.redactions).toBeGreaterThanOrEqual(3);
  });

  it("redacts every element of an array under a secret key, and a key that is itself a secret", () => {
    const a = randomToken(rand, 20);
    const b = randomToken(rand, 20);
    const key = gatewayKey(rand, 9);
    const env = buildEnvelope({ secret: [a, b], lookup: { [key]: true } }, [], facts(), null);
    const s = JSON.stringify(env.state);
    expect(s).not.toContain(a);
    expect(s).not.toContain(b);
    expect(s).not.toContain(key);
  });

  it("leaves ordinary fields untouched", () => {
    const input = { command: "git status && npm test", description: "Run the tests", timeout: 120000 };
    const env = buildEnvelope(input, ["run the tests"], facts(), scanCommand(input.command));
    expect(env.redactions).toBe(0);
    expect((env.state.agent_request as { input: Record<string, unknown> }).input).toEqual(input);
  });
});

describe("buildEnvelope — every field that is sent", () => {
  it("redacts the command, the human's messages, the agent's message and removed comments", () => {
    const key = gatewayKey(rand, 13);
    const tok = randomToken(rand, 28);
    const pat = "gh" + "p_" + rnd(rand, 36);
    const cmd = `curl -H "Authorization: Bearer ${tok}" https://x # key is ${key}`;
    const env = buildEnvelope(
      { command: cmd },
      [`here is my key ${key}`, `and GITHUB_TOKEN=${pat}`],
      facts(),
      scanCommand(cmd),
      { agentLastMessage: `I will use ${key} with the bearer ${tok}` },
    );
    const s = JSON.stringify(env.state);
    for (const secret of [key, tok, pat]) expectAbsent(s, secret);
    expect(env.redactions).toBeGreaterThanOrEqual(6);
  });

  it("scrubs a secret out of the path facts, where it arrives with no context", () => {
    // Anything with a `/` is a path to the fact extractor, so this secret is
    // lifted into facts.paths as `as_written` AND inside `resolved`.
    const secret = `${rnd(rand, 13)}/${rnd(rand, 7)}/${rnd(rand, 18)}`;
    const cmd = `aws configure set aws_secret_access_key ${secret}`;
    const scanned = scanCommand(cmd);
    const f = computeFacts("Bash", { command: cmd }, "/p", "default", scanned);
    expect(f.paths.some((p) => p.asWritten === secret)).toBe(true);
    const env = buildEnvelope({ command: cmd }, [], f, scanned);
    const s = JSON.stringify(env.state);
    expectAbsent(s, secret);
    const paths = (env.state.facts as { paths: Array<{ as_written: string; resolved: string }> }).paths;
    expect(paths.some((p) => p.as_written.includes("<redacted:"))).toBe(true);
  });

  it("scrubs a secret the human pasted bare, once it was recognised elsewhere", () => {
    const v = randomToken(rand, 20).slice(0, 12) + "+" + rnd(rand, 6);
    const env = buildEnvelope({ command: `export DB_PASSWORD='${v}'` }, [`the password is ${v}`], facts(), null);
    expectAbsent(JSON.stringify(env.state), v);
  });

  it("redacts the cwd, project root and branch facts too", () => {
    const tok = gatewayKey(rand, 5);
    const env = buildEnvelope({ command: "ls" }, [], facts({ cwd: `/work/${tok}`, projectRoot: `/work/${tok}`, currentGitBranch: `fix/${tok}` }), null);
    expect(JSON.stringify(env.state)).not.toContain(tok);
  });
});

describe("capHeadTail — cuts never split a token", () => {
  it("drops a key that straddles the head cut instead of keeping its first half", () => {
    const max = MAX_STRING_CHARS;
    const head = Math.ceil(max * 0.6);
    const key = SK + "ant-api03-" + rnd(rand, 93, ALNUM) + "AA";
    // Put the cut 30 characters into the key.
    const text = "x ".repeat((head - 30) / 2) + key + " " + "y ".repeat(max);
    const c = capHeadTail(text, max);
    expect(c.truncated).toBe(true);
    expect(c.text).not.toContain(key.slice(0, 20));
    expect(c.text).not.toContain(key.slice(10, 30));
  });

  it("drops a key that straddles the tail cut instead of keeping its second half", () => {
    const max = MAX_STRING_CHARS;
    const tail = max - Math.ceil(max * 0.6);
    const key = SK + "proj-" + rnd(rand, 120, ALNUM);
    const text = "x ".repeat(max) + key + " " + "y ".repeat((tail - 40) / 2);
    const c = capHeadTail(text, max);
    expect(c.text).not.toContain(key.slice(-30));
  });

  it("still keeps the dangerous tail, and counts what it omitted", () => {
    const long = "echo safe ".repeat(1000) + "&& sudo rm -rf /";
    const c = capHeadTail(long, MAX_STRING_CHARS);
    expect(c.text).toContain("sudo rm -rf /");
    const omitted = Number(/\[(\d+) characters omitted\]/.exec(c.text)![1]);
    const kept = c.text.replace(/\n…\[\d+ characters omitted\]…\n/, "");
    expect(kept.length + omitted).toBe(long.length);
  });

  it("does not move a cut that falls between tokens, or chase a token past its limit", () => {
    const text = "a ".repeat(3000);
    expect(capHeadTail(text, 1000).text.length).toBeLessThanOrEqual(1000 + 40);
    const blob = rnd(rand, 5000, ALNUM);
    expect(capHeadTail(blob, 1000).text.length).toBeLessThanOrEqual(1000 + 40);
  });

  it("protects a pasted key in a long prompt end to end", () => {
    const key = gatewayKey(rand, 11);
    const pre = Math.ceil(MAX_USER_MESSAGE_CHARS * 0.6) - 12;
    const prompt = "p".repeat(pre - 1) + " " + key + " " + "q ".repeat(MAX_USER_MESSAGE_CHARS);
    const env = buildEnvelope({ command: "ls" }, [prompt], facts(), null);
    expectAbsent(JSON.stringify(env.state), key.slice(3));
  });
});

describe("the request that is actually sent", () => {
  it("carries no fixture secret in any field of the Jev request body", () => {
    // A request-capture check: every secret family, spread across the fields
    // prepareSemantic fills, then the serialised request is searched.
    const secrets = {
      gateway: gatewayKey(rand, 8, "_"),
      anthropic: SK + "ant-api03-" + rnd(rand, 93, ALNUM) + "AA",
      openrouter: SK + "or-v1-" + rnd(rand, 64, "0123456789abcdef"),
      bearer: randomToken(rand, 32),
      assigned: randomToken(rand, 22),
      password: "hunter2-" + rnd(rand, 8),
      pem: Array.from({ length: 3 }, () => rnd(rand, 64, ALNUM + "+/")).join("\n"),
    };
    const command =
      `export OPENROUTER_API_KEY=${secrets.openrouter}; ` +
      `curl -H "Authorization: Bearer ${secrets.bearer}" -H "x-api-key: ${secrets.gateway}" https://api.example.com && ` +
      `DATABASE_PASSWORD=${secrets.password} ./migrate.sh && echo '${JSON.stringify({ client_secret: secrets.assigned })}'`;
    const p = prepareSemantic(
      {
        eventType: "PreToolUse",
        toolName: "Bash",
        toolInput: { command, description: `deploy with ${secrets.anthropic}` },
        cwd: "/p",
        userSaid: [`use ${secrets.anthropic}`, `${pemBegin()}\n${secrets.pem}\n${pemEnd()}`],
        agentLastMessage: `Shall I export ANTHROPIC_API_KEY=${secrets.anthropic}?`,
      },
      { intent: "v1" },
    );
    const body = JSON.stringify(p.compiled.request);
    for (const [name, secret] of Object.entries(secrets)) {
      for (const line of secret.split("\n")) {
        for (const f of fragments(line)) expect(body, `${name} leaked`).not.toContain(f);
      }
    }
    expect(p.envelope.redactions).toBeGreaterThanOrEqual(Object.keys(secrets).length);
    // Still judgeable: the action itself survives redaction.
    expect(body).toContain("./migrate.sh");
    expect(body).toContain("curl -H");
  });
});
