// @vitest-environment node
/**
 * Secrets in the WHOLE Jev request: every field buildEnvelope/prepareSemantic
 * sends, not just the strings redactSecrets is handed directly.
 *
 * Every secret-shaped fixture is built at runtime (see ./redaction-fixtures).
 */
import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_STRING_CHARS, MAX_USER_MESSAGE_CHARS, buildEnvelope, capHeadTail, redactSecrets } from "../../../src/hooks/semantic/envelope";
import { prepareSemantic } from "../../../src/hooks/semantic/evaluator";
import { computeFacts, scanCommand } from "../../../src/hooks/semantic/facts";
import { setEnvSecretSource } from "../../../src/hooks/semantic/redact";
import type { Facts } from "../../../src/hooks/semantic/types";
import { ALNUM, B64URL, HEX, SK, gatewayKey, pemBegin, pemEnd, prng, randomToken, rnd } from "./redaction-fixtures";

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

  it("redacts the credential of an Authorization field and keeps its scheme", () => {
    const http = facts({ toolName: "mcp__http__request", toolClass: "other", toolIsKnown: false });
    const basic = Buffer.from(`admin:${randomToken(rand, 12)}`).toString("base64");
    const hex = rnd(rand, 40, HEX);
    const tok = randomToken(rand, 30);
    const cases: Array<[Record<string, unknown>, string, (input: Record<string, unknown>) => unknown, string]> = [
      [{ url: "https://api.example.com", headers: { Authorization: `Basic ${basic}` } }, basic, (i) => (i.headers as Record<string, unknown>).Authorization, "Basic <redacted:authorization header>"],
      [{ url: "https://api.example.com", headers: { Authorization: hex } }, hex, (i) => (i.headers as Record<string, unknown>).Authorization, "<redacted:authorization header>"],
      [{ url: "https://api.example.com", headers: { Authorization: `Token ${hex}` } }, hex, (i) => (i.headers as Record<string, unknown>).Authorization, "Token <redacted:authorization header>"],
      [{ url: "https://api.example.com", headers: { authorization: `Bearer ${tok}` } }, tok, (i) => (i.headers as Record<string, unknown>).authorization, "Bearer <redacted:bearer token>"],
      [{ authorization: `Basic ${basic}` }, basic, (i) => i.authorization, "Basic <redacted:authorization header>"],
      [{ headers: { "Proxy-Authorization": `Basic ${basic}` } }, basic, (i) => (i.headers as Record<string, unknown>)["Proxy-Authorization"], "Basic <redacted:authorization header>"],
    ];
    for (const [toolInput, secret, pick, want] of cases) {
      const env = buildEnvelope(toolInput, [], http, null);
      const input = (env.state.agent_request as { input: Record<string, unknown> }).input;
      expect(pick(input), want).toBe(want);
      expect(JSON.stringify(env.state)).not.toContain(secret);
      expect(env.redactions, want).toBe(1);
    }
  });

  it("redacts a whole Authorization value whose first word is not a known scheme", () => {
    // `cleanValue` returns this value without running it through
    // `redactSecrets`, so a "scheme" it keeps is sent verbatim. A 25-character
    // gateway key is 26 characters of [A-Za-z0-9-] and fitted the old
    // scheme class exactly: the live key was sent while `redactions` said 1.
    const http = facts({ toolName: "mcp__http__request", toolClass: "other", toolIsKnown: false });
    const key = gatewayKey(rand, 5);
    for (const value of [`${key} signature=abc`, `${key} ${rnd(rand, 8)}`, `${SK}ant-api03-${rnd(rand, 40)} v=1`]) {
      const env = buildEnvelope({ url: "https://x.test", headers: { Authorization: value } }, [], http, null);
      const input = (env.state.agent_request as { input: Record<string, unknown> }).input;
      expect((input.headers as Record<string, unknown>).Authorization, value.slice(0, 8)).toBe("<redacted:authorization header>");
      const serialized = JSON.stringify(env.state);
      expectAbsent(serialized, value.split(" ")[0]);
      expect(env.redactions).toBeGreaterThanOrEqual(1);
    }
  });

  it("redacts an Authorization value behind a word-like UNKNOWN scheme", () => {
    // The round-2 rule asked whether the first word looked like a token, and
    // an alphabetic word never does — so `Hawk`, `NTLM`, `Splunk` and a bare
    // session credential collapsed into the "prose" case and were sent to Jev
    // verbatim, with the envelope reporting `redactions: 0`.
    const http = facts({ toolName: "mcp__http__request", toolClass: "other", toolIsKnown: false });
    const mac = rnd(rand, 26, B64URL);
    for (const value of [
      `Hawk id="${rnd(rand, 12)}", ts="1353832234", mac="${mac}"`,
      `NTLM ${rnd(rand, 44, B64URL)}=`,
      `sessionid ${rnd(rand, 16)}`,
      `Splunk ${rnd(rand, 32, HEX)}`,
      "hmac dev-admin-key",
      "sso devadminkey",
    ]) {
      const env = buildEnvelope({ url: "https://x.test", headers: { Authorization: value } }, [], http, null);
      const input = (env.state.agent_request as { input: Record<string, unknown> }).input;
      expect((input.headers as Record<string, unknown>).Authorization, value.slice(0, 10)).toBe("<redacted:authorization header>");
      const serialized = JSON.stringify(env.state);
      expect(serialized, value.slice(0, 10)).not.toContain(value.split(" ").slice(1).join(" "));
      expect(env.redactions, value.slice(0, 10)).toBeGreaterThanOrEqual(1);
    }
  });

  it("leaves Authorization references, bare schemes and other headers alone", () => {
    const http = facts({ toolName: "mcp__http__request", toolClass: "other", toolIsKnown: false });
    for (const auth of ["Bearer ${API_TOKEN}", "Bearer $TOKEN", "Bearer <token>", "Bearer", ""]) {
      const toolInput = { headers: { Authorization: auth, "Content-Type": "application/json" } };
      const env = buildEnvelope(toolInput, [], http, null);
      expect((env.state.agent_request as { input: Record<string, unknown> }).input, auth).toEqual(toolInput);
      expect(env.redactions, auth).toBe(0);
    }
  });

  it("caps a huge object key before redacting it, and says so", () => {
    for (const key of ["a.".repeat(40_000), `${SK}`.repeat(20_000), "x=".repeat(40_000)]) {
      const t0 = performance.now();
      const env = buildEnvelope({ [key]: true }, [], facts({ toolName: "mcp__x__y", toolClass: "other", toolIsKnown: false }), null);
      expect(performance.now() - t0, key.slice(0, 4)).toBeLessThan(250);
      expect(env.truncated).toBe(true);
      const sent = Object.keys((env.state.agent_request as { input: Record<string, unknown> }).input)[0];
      expect(sent.length).toBeLessThan(MAX_STRING_CHARS);
    }
  });

  it("redacts a full-sized object of token-shaped fields in well under the Jev timeout", () => {
    // `cleanValue` caps each string at MAX_STRING_CHARS and redacts it, and a
    // two-level object of MAX_KEYS x MAX_KEYS fields means 576 of them. With a
    // quadratic assignment scan this took 2-7 SECONDS on the PreToolUse path,
    // before the 1 500 ms Jev request even started; base64url is what a batch
    // of tokens, JWT parts or digests looks like, so no crafting is needed.
    //
    // Step 5, not 7: `(i * 7) % 63` emitted nine distinct characters and never
    // the `_` the second case was written for. And the last two cases are here
    // because the two URL rules stayed quadratic on a lowercase/hyphen run
    // after the assignment rules were fixed — 1 701 ms for this envelope, well
    // past the budget, while the base64url shape had come down to 94 ms. The
    // `x://` one is the realistic half: a command carrying a URL and a long
    // hyphenated run is all it takes, and with a scheme in the string the
    // rules cannot be skipped.
    const field = (alphabet: string, prefix = ""): string => {
      let s = prefix;
      for (let i = 0; s.length < MAX_STRING_CHARS; i++) s += alphabet[(i * 5) % alphabet.length];
      return s;
    };
    for (const [alphabet, prefix] of [[B64URL, ""], [ALNUM + "_", ""], [ALNUM + "-", ""], ["a-", ""], ["a-", "x://"]] as Array<[string, string]>) {
      expect(new Set(field(alphabet).slice(0, alphabet.length * 3)).size, alphabet.slice(-3)).toBe(alphabet.length);
      const value = field(alphabet, prefix);
      const toolInput: Record<string, Record<string, string>> = {};
      for (let i = 0; i < 24; i++) {
        const inner: Record<string, string> = {};
        for (let j = 0; j < 24; j++) inner[`f${i}_${j}`] = value;
        toolInput[`k${i}`] = inner;
      }
      const t0 = performance.now();
      buildEnvelope(toolInput, [], facts({ toolName: "mcp__x__y", toolClass: "other", toolIsKnown: false }), null);
      expect(performance.now() - t0, alphabet.slice(-4)).toBeLessThan(600);
    }
  });

  it("finds a token at the start of a line inside input nested two levels deep", () => {
    // Depth 2 is JSON-stringified, so the token follows the characters \ n.
    const tok = "gl" + "pat-" + rnd(rand, 20, B64URL);
    const env = buildEnvelope({ args: { opts: { note: `first line\n${tok} rest` } } }, [], facts({ toolName: "mcp__x__y", toolClass: "other", toolIsKnown: false }), null);
    const s = JSON.stringify(env.state);
    expect(s).not.toContain(tok);
    expect(s).toContain("<redacted:GitLab token> rest");
    expect(env.redactions).toBe(1);
  });

  it("scrubs a recognised secret out of later strings and object keys, counting each", () => {
    // Recognised once, by its field name; its other two copies have no context.
    const pw = "hunter2-" + rnd(rand, 8, "abcdefghijklmnop");
    const env = buildEnvelope(
      { password: pw, lookup: { [pw]: 1 } },
      [`the password is ${pw}`],
      facts({ toolName: "mcp__db__connect", toolClass: "other", toolIsKnown: false }),
      null,
    );
    const s = JSON.stringify(env.state);
    expect(s).not.toContain(pw);
    const input = (env.state.agent_request as { input: { lookup: Record<string, unknown> } }).input;
    expect(Object.keys(input.lookup)).toEqual(["<redacted:repeated secret>"]);
    expect(env.state.user_said).toEqual(["the password is <redacted:repeated secret>"]);
    expect(env.redactions).toBe(3);
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

  it("scrubs the bare copy of a credential the command passed QUOTED", () => {
    // The CLI rules dropped the quoted value whole, so the secret they handed
    // the scrub pass was `'hunter2'` — never found anywhere — and the bare
    // copy the agent put in its own description went out with the request.
    const pw = `${randomToken(rand, 12)}!x`;
    for (const command of [
      `sshpass -p '${pw}' ssh deploy@host`,
      `mysql -u root -p'${pw}' prod`,
      `docker login -u me -p "${pw}" registry.example.com`,
      `gh secret set DEPLOY_TOKEN --body '${pw}'`,
      `redis-cli -h cache -a "${pw}" ping`,
      `aws configure set aws_secret_access_key '${pw}'`,
    ]) {
      const env = buildEnvelope(
        { command, description: `log in with ${pw} then run uptime` },
        [`use ${pw} for the deploy`],
        facts(),
        null,
      );
      const s = JSON.stringify(env.state);
      expect(s, command.slice(0, 12)).not.toContain(pw);
      expect(env.redactions, command.slice(0, 12)).toBeGreaterThanOrEqual(3);
    }
  });

  it("scrubs a secret the human pasted bare, once it was recognised elsewhere", () => {
    const v = randomToken(rand, 20).slice(0, 12) + "+" + rnd(rand, 6);
    const env = buildEnvelope({ command: `export DB_PASSWORD='${v}'` }, [`the password is ${v}`], facts(), null);
    expectAbsent(JSON.stringify(env.state), v);
  });

  it("leaves a branch name alone that only contains `sk-` mid-word", () => {
    const branch = `ta${SK}PROJ-1234-add-login-page`;
    const env = buildEnvelope({ command: "git status" }, [], facts({ currentGitBranch: branch }), null);
    expect((env.state.facts as { current_git_branch: string }).current_git_branch).toBe(branch);
    expect(env.redactions).toBe(0);
  });

  it("scrubs a secret whose shorter prefix is also a secret, leaving no tail", () => {
    const short = randomToken(rand, 16);
    const long = short + rnd(rand, 10);
    const env = buildEnvelope({ command: `export API_TOKEN=${short} OTHER_TOKEN=${long}` }, [`please use ${long} for the deploy`], facts(), null);
    expect(env.state.user_said).toEqual(["please use <redacted:repeated secret> for the deploy"]);
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

describe("private keys longer than the caps", () => {
  /** A PKCS#8-shaped block: 64-character base64 lines and a short last one. */
  function fakePem(lines: number): { pem: string; body: string[] } {
    const body = Array.from({ length: lines }, () => rnd(rand, 64, ALNUM + "+/"));
    body.push(rnd(rand, 30, ALNUM + "+/") + "==");
    return { pem: `${pemBegin()}\n${body.join("\n")}\n${pemEnd()}\n`, body };
  }

  /** Every 16-character window of every body line: none may reach Jev. */
  function expectNoKeyMaterial(sent: string, body: string[]): void {
    for (const line of body) {
      for (let i = 0; i + 16 <= line.length; i += 8) expect(sent, `key line fragment ${line.slice(i, i + 2)}…`).not.toContain(line.slice(i, i + 16));
    }
  }

  const write = facts({ toolName: "Write", toolClass: "write" });

  it("sends none of a 3072- or 4096-bit-sized key written with the Write tool", () => {
    // 38 and 50 body lines: past MAX_STRING_CHARS, so the header is in the head,
    // the footer in the tail, and the middle is omitted.
    for (const lines of [38, 50]) {
      const { pem, body } = fakePem(lines);
      expect(pem.length).toBeGreaterThan(MAX_STRING_CHARS);
      const env = buildEnvelope({ file_path: "/p/deploy_key", content: pem }, [], write, null);
      expect(env.truncated).toBe(true);
      expectNoKeyMaterial(JSON.stringify(env.state), body);
      expect((env.state.agent_request as { input: { content: string } }).input.content).toContain("<redacted:private key>");
    }
  });

  it("sends none of a real generated key, cut by the cap", () => {
    // Throwaway, generated in memory and never written anywhere.
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const body = pem.split("\n").filter((l) => l && !l.startsWith("-----"));
    const env = buildEnvelope({ file_path: "/p/deploy_key", content: pem }, [], write, null);
    expectNoKeyMaterial(JSON.stringify(env.state), body);
  });

  it("sends none of a key nested two levels deep, where it is JSON-escaped and cut at half the cap", () => {
    const { pem, body } = fakePem(26);
    const env = buildEnvelope({ entry: { tls: { private_key: pem } } }, [], facts({ toolName: "mcp__vault__put", toolClass: "other", toolIsKnown: false }), null);
    expect(env.truncated).toBe(true);
    expectNoKeyMaterial(JSON.stringify(env.state), body);
  });

  it("sends none of a key pasted into a prompt, in user_said or in the recorded intent", () => {
    const { pem, body } = fakePem(26);
    const prompt = `here is the deploy key, install it:\n${pem}`;
    const env = buildEnvelope({ command: "ls" }, [prompt], facts(), null);
    expectNoKeyMaterial(JSON.stringify(env.state), body);
    // What intent.ts's recordUserPrompt stores: the same cap, then the redactor.
    expectNoKeyMaterial(redactSecrets(capHeadTail(prompt, MAX_USER_MESSAGE_CHARS).text).text, body);
  });

  it("cuts JSON-escaped text at an escaped newline, not inside a line", () => {
    const lines = Array.from({ length: 40 }, () => rnd(rand, 60, ALNUM));
    const c = capHeadTail(lines.join("\\n"), 1000);
    const [head, tail] = c.text.split(/\n…\[\d+ characters omitted\]…\n/);
    expect(head.endsWith("\\n")).toBe(true);
    expect(tail.startsWith("\\n")).toBe(true);
    for (const piece of [...head.split("\\n"), ...tail.split("\\n")]) {
      if (piece) expect(lines, piece.slice(0, 4)).toContain(piece);
    }
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
