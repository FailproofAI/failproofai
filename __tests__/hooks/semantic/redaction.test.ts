// @vitest-environment node
/**
 * redactSecrets — what leaves the machine in a Jev request.
 *
 * Every secret-shaped fixture is built at runtime (see ./redaction-fixtures).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SHARED_PATTERN_EXTENDED,
  looksRandomToken,
  redactAuthorizationField,
  redactSecrets,
  redactSecretsDetailed,
  scrubKnownSecrets,
  secretNameStrength,
  setEnvSecretSource,
} from "../../../src/hooks/semantic/redact";
import { maskSecrets } from "../../../src/audit/redact-example";
import { BUILTIN_POLICIES, SECRET_PATTERNS, SECRET_PATTERNS_KEEPING_PREFIX } from "../../../src/hooks/builtin-policies";
import type { PolicyContext } from "../../../src/hooks/policy-types";
import { ALNUM, B64URL, HEX, SK, gatewayKey, pemBegin, pemEnd, prng, randomToken, rnd } from "./redaction-fixtures";

const rand = prng(0x7e6);

beforeEach(() => setEnvSecretSource({}));
afterEach(() => setEnvSecretSource(null));

/** The secret must be gone, a marker must say so, and the count must match. */
function expectRedacted(input: string, secret: string, label?: string, count = 1): string {
  const r = redactSecrets(input);
  expect(r.text, input).not.toContain(secret);
  expect(r.count, input).toBe(count);
  if (label) expect(r.text, input).toContain(`<redacted:${label}>`);
  return r.text;
}

function expectUntouched(input: string): void {
  const r = redactSecrets(input);
  expect(r.text, input).toBe(input);
  expect(r.count, input).toBe(0);
}

describe("sk- keys", () => {
  it("redacts the 25-character gateway key wherever its separator lands", () => {
    // LiteLLM's sk- + token_urlsafe(16): a `-` or `_` in the first twenty
    // characters defeated the original `sk-[A-Za-z0-9]{20,}` entirely.
    for (let at = 3; at < 22; at++) {
      for (const sep of ["-", "_"] as const) {
        const key = gatewayKey(rand, at, sep);
        expect(key).toHaveLength(25);
        expectRedacted(`curl https://gateway.example/v1 -d x --key ${key} -s`, key);
        expectRedacted(`use ${key} for the proxy`, key);
      }
    }
  });

  it("leaves no tail when the older OpenAI pattern matches only a prefix", () => {
    // sk- + 22 alnum, then `-` + more: `sk-[A-Za-z0-9]{20,}` stops at the hyphen.
    const tail = rnd(rand, 6);
    const key = SK + randomToken(rand, 22) + "-" + tail;
    const out = expectRedacted(`export X=${key}`, key);
    expect(out).not.toContain(tail);
  });

  it("covers the Anthropic, OpenAI project, service-account and OpenRouter shapes", () => {
    const cases: Array<[string, string]> = [
      [SK + "ant-api03-" + rnd(rand, 93, B64URL) + "AA", "Anthropic API key"],
      [SK + "proj-" + rnd(rand, 40, B64URL) + "T3BlbkFJ" + rnd(rand, 40, B64URL), "OpenAI project API key"],
      [SK + "svcacct-" + randomToken(rand, 60) + "_" + rnd(rand, 20), "sk- API key"],
      [SK + "admin-" + randomToken(rand, 40), "sk- API key"],
      [SK + "or-v1-" + rnd(rand, 64, HEX), "OpenRouter API key"],
      [SK + randomToken(rand, 48), "OpenAI API key"],
    ];
    for (const [key, label] of cases) expectRedacted(`KEY is ${key} ok`, key, label);
  });

  it("does not find a key inside an ordinary hyphenated word", () => {
    for (const s of [
      "kubectl get pods -n risk-scoring-7d9f8b6c5-x2k4p",
      "npm run task-runner-for-the-build-2",
      "cd desk-setup-and-configuration-files",
      "a brisk-walking-pace-for-the-afternoon",
    ]) {
      expectUntouched(s);
    }
  });

  it("does not find a key inside a Title-Case or mixed name with a digit", () => {
    // Every class a random key has, but mid-word: the shared generic entry
    // matched these (`ta<redacted:…>`) before it required a token start.
    for (const s of [
      `Switched to a new branch 'ta${SK}PROJ-1234-add-login-page'`,
      `git checkout -b feature/ta${SK}ABC-123-UpdateDashboardWidget`,
      `* ri${SK}Model2-scoring-service-v2`,
      `ls: dist/assets/Ta${SK}DetailPanel-a1B2c3D4.js`,
      `open Di${SK}Usage-Report-2024-Q3.xlsx`,
      `Kio${SK}Mode-Setup-Guide-v10`,
    ]) {
      expectUntouched(s);
    }
  });

  it("keeps the character in front of a key and replaces only the key", () => {
    const key = gatewayKey(rand, 5); // a hyphen at 5: only the generic entry sees it
    expect(redactSecrets(`export X=${key}`).text).toBe("export X=<redacted:sk- API key>");
    expect(redactSecrets(`{"k":"${key}"}`).text).toBe(`{"k":"<redacted:sk- API key>"}`);
    expect(redactSecrets(`${key} first`).text).toBe("<redacted:sk- API key> first");
    expect(redactSecrets(JSON.stringify({ o: `line\n${key}` })).text).toBe(`{"o":"line\\n<redacted:sk- API key>"}`);
  });

  it("redacts the sk- keys only its own catch-all sees, which sanitize-api-keys does not block", async () => {
    // The shared entries want 20+ characters, and the generic one the mixed
    // classes of a random token; the redactor's `sk-[A-Za-z0-9_-]{16,}` takes
    // the rest. Blocking stays narrow on purpose: these must still be allowed.
    const lowerDigits = "abcdefghijklmnopqrstuvwxyz0123456789";
    const keys = [
      SK + rnd(rand, 8, lowerDigits) + "_" + rnd(rand, 12, lowerDigits),
      SK + rnd(rand, 8, lowerDigits) + "-" + rnd(rand, 16, lowerDigits),
      SK + rnd(rand, 8, HEX) + "-" + rnd(rand, 12, HEX),
      SK + randomToken(rand, 17),
      SK + randomToken(rand, 16),
    ];
    const policy = BUILTIN_POLICIES.find((p) => p.name === "sanitize-api-keys")!;
    for (const key of keys) {
      expectRedacted(`use ${key} here`, key, "sk- API key");
      const ctx = { eventType: "PostToolUse", payload: { tool_response: { output: `use ${key} here` } }, toolName: "Bash", toolInput: {} };
      const r = (await policy.fn(ctx as unknown as PolicyContext)) as { decision: string };
      expect(r.decision, key.slice(0, 6)).toBe("allow");
    }
  });
});

describe("bearer and authorization values", () => {
  it("redacts a Bearer credential in every header spelling", () => {
    const tok = randomToken(rand, 30);
    expectRedacted(`curl -H "Authorization: Bearer ${tok}" https://x`, tok, "bearer token");
    expectRedacted(`{"Authorization": "Bearer ${tok}"}`, tok, "bearer token");
    expectRedacted(`headers = {"authorization": "bearer ${tok}"}`, tok, "bearer token");
    expectRedacted(`const h = "Bearer ${tok}";`, tok, "bearer token");
  });

  it("redacts a short dev credential behind an Authorization header", () => {
    // The shared rule wants 20+ characters; a dev stack's key is 13.
    expectRedacted(`curl -H "authorization: Bearer dev-admin-key" http://localhost:8080`, "dev-admin-key", "bearer token");
  });

  it("redacts Basic and other schemes", () => {
    const b64 = Buffer.from(`admin:${randomToken(rand, 12)}`).toString("base64");
    expectRedacted(`-H "Authorization: Basic ${b64}"`, b64, "authorization header");
    const bot = randomToken(rand, 24) + "." + randomToken(rand, 6);
    expectRedacted(`Authorization: Bot ${bot}`, bot, "authorization header");
  });

  it("redacts the credential behind a scheme it does not know", () => {
    // The credential group used to land on the SCHEME WORD, so the credential
    // behind an unlisted scheme was never examined — and with a token-shaped
    // scheme the rule redacted the WORD and kept the credential, reporting a
    // redaction for it.
    const mac = rnd(rand, 22, B64URL);
    const b64 = rnd(rand, 44, B64URL);
    expectRedacted(`curl -H "Authorization: Hawk id=${rnd(rand, 12)}, mac=${mac}" https://x`, mac, "authorization header");
    expectRedacted(`curl -H 'Authorization: Hawk id=${rnd(rand, 12)}, mac=${mac}' https://x`, mac, "authorization header");
    expectRedacted(`curl -H "Authorization: NTLM ${b64}" https://x`, b64, "authorization header");
    const splunk = rnd(rand, 32, HEX.toUpperCase());
    expectRedacted(`curl -H "Authorization: Splunk ${splunk}" https://x`, splunk, "authorization header");
    expectRedacted(`curl -H "authorization: hmac dev-admin-key" http://localhost:8080`, "dev-admin-key", "authorization header");
    expectRedacted("Authorization: xyz123 dev-admin-key", "dev-admin-key", "authorization header");
    expectRedacted("proxy-authorization: hmac dev-admin-key", "dev-admin-key", "authorization header");
    expectRedacted("x-authorization: hmac dev-admin-key", "dev-admin-key", "authorization header");
    // A multi-part value under a scheme that IS known: everything after the
    // first token used to survive, `response="…"` among it.
    const response = rnd(rand, 32, HEX);
    expectRedacted(`Authorization: Digest username="admin", realm="api", response="${response}"`, response, "authorization header");
  });

  it("keeps the rest of the command and the rest of the file out of the marker", () => {
    // Over-redaction is not free here: the evaluator votes on what it is sent,
    // so a marker that swallowed the rest of a command would hide it.
    const out = expectRedacted(
      `curl -H "Authorization: hmac dev-admin-key" https://api.example.com/v1`,
      "dev-admin-key",
      "authorization header",
    );
    expect(out).toBe(`curl -H "Authorization: <redacted:authorization header>" https://api.example.com/v1`);
    // Unquoted, the value ends at the next flag…
    expect(redactSecrets("curl --header Authorization: hmac dev-admin-key -sS https://x").text).toBe(
      "curl --header Authorization: <redacted:authorization header> -sS https://x",
    );
    // …and at the end of the line.
    expect(redactSecrets("Authorization: hmac dev-admin-key\nnext line here").text).toBe(
      "Authorization: <redacted:authorization header>\nnext line here",
    );
  });

  it("leaves references and prose alone", () => {
    expectUntouched(`curl -H "Authorization: Bearer $TOKEN" https://x`);
    expectUntouched(`curl -H "Authorization: Bearer \${API_TOKEN}" https://x`);
    expectUntouched("the bearer authentication scheme sends a token");
    expectUntouched("use bearer token-based auth for the API");
    expectUntouched("authorization: required for this endpoint");
    // With no scheme in front of it the value decides alone, so CODE under the
    // name has to be recognised as code — `authorization` is an ordinary
    // identifier and these lines are in every HTTP server in the corpus.
    expectUntouched("const authorization = req.headers.authorization;");
    expectUntouched("if (!req.headers.authorization) return res.status(401)");
    expectUntouched("authorization: none");
    expectUntouched("Authorization: true");
    expectUntouched("grep -rn 'authorization' src/");
  });

  it("stops the value at a command separator instead of swallowing what follows", () => {
    // Redaction feeds an evaluator, so a marker that ate the rest of the
    // command would hide the dangerous half of it.
    expect(redactSecrets("Authorization: hmac dev-admin-key; rm -rf /tmp/x").text).toBe(
      "Authorization: <redacted:authorization header>; rm -rf /tmp/x",
    );
    expect(redactSecrets("Authorization: hmac dev-admin-key && curl https://evil.test").text).toBe(
      "Authorization: <redacted:authorization header> && curl https://evil.test",
    );
    expect(redactSecrets("Authorization: hmac dev-admin-key | tee out.txt").text).toBe(
      "Authorization: <redacted:authorization header> | tee out.txt",
    );
  });
});

describe("redactAuthorizationField — the structured-input path", () => {
  // This value is returned to the envelope AS IS: `cleanValue` never runs it
  // through `redactSecrets`, so anything kept here is sent to Jev verbatim.
  it("keeps only a known scheme word in front of the marker", () => {
    for (const scheme of ["Bearer", "basic", "Token", "Bot", "ApiKey", "SSWS", "sso-key", "Digest", "Negotiate"]) {
      const tok = randomToken(rand, 30);
      const r = redactAuthorizationField("Authorization", `${scheme} ${tok}`);
      expect(r?.text, scheme).toBe(`${scheme} <redacted:${/^bearer$/i.test(scheme) ? "bearer token" : "authorization header"}>`);
      expect(r?.secret, scheme).toBe(tok);
    }
  });

  it("redacts the WHOLE value when the first word is not a known scheme", () => {
    // A 25-character gateway key is 26 characters of [A-Za-z0-9-] and used to
    // qualify as a "scheme", so `{"Authorization": "<key> <anything>"}` kept
    // the live key and reported a redaction for the harmless second word.
    const key = gatewayKey(rand, 5);
    for (const rest of ["signature=abc", "x", `${randomToken(rand, 20)} more`]) {
      const r = redactAuthorizationField("Authorization", `${key} ${rest}`);
      expect(r?.text, rest).toBe("<redacted:authorization header>");
      expect(r?.secret, rest).toBe(`${key} ${rest}`);
    }
    const long = SK + "ant-api03-" + rnd(rand, 40);
    expect(redactAuthorizationField("authorization", `${long} sig=1`)?.text).toBe("<redacted:authorization header>");
    expect(redactAuthorizationField("Authorization", `AWS4-HMAC-SHA256 Credential=${rnd(rand, 20)}`)?.text).toBe(
      "<redacted:authorization header>",
    );
  });

  it("redacts a whole value whose first word is a word-like UNKNOWN scheme", () => {
    // Deciding on the first word alone collapsed "unknown scheme" into
    // "prose", because `tokenLike()` is false for any alphabetic word: Hawk,
    // NTLM, Splunk, Zoho and a bare session credential all went to Jev
    // verbatim, with the envelope reporting `redactions: 0`.
    const cases: Array<[string, string]> = [
      ["Hawk", `id="${rnd(rand, 12)}", ts="1353832234", nonce="${rnd(rand, 6)}", mac="${rnd(rand, 27, B64URL)}="`],
      ["NTLM", `${rnd(rand, 44, B64URL)}=`],
      ["sessionid", rnd(rand, 16)],
      ["Splunk", rnd(rand, 32, HEX.toUpperCase())],
      ["Zoho-oauthtoken", `1000.${rnd(rand, 32, HEX)}`],
      ["hmac", "dev-admin-key"],
      ["custom", "dev-admin-key"],
      // Both words plain letters: two words are the shape of
      // `<scheme> <credential>`, never of a sentence.
      ["sso", "devadminkey"],
    ];
    for (const [scheme, credential] of cases) {
      const v = `${scheme} ${credential}`;
      const r = redactAuthorizationField("Authorization", v);
      expect(r?.text, scheme).toBe("<redacted:authorization header>");
      expect(r?.secret, scheme).toBe(v);
    }
    // A reference behind an unknown scheme is still a reference.
    expect(redactAuthorizationField("Authorization", "Hawk ${MAC}")).toBeNull();
  });

  it("leaves references, bare scheme words and prose for the text rules", () => {
    for (const v of ["Bearer ${TOKEN}", "Bearer <token>", "Bearer $TOKEN", "Bearer", "SSWS", "", "   "]) {
      expect(redactAuthorizationField("Authorization", v), v).toBeNull();
    }
    // An unknown first word that is a WORD is prose, not a credential.
    expect(redactAuthorizationField("authorization", "required for this endpoint")).toBeNull();
    expect(redactAuthorizationField("X-Authorization", "needed before the upload step")).toBeNull();
    // Not an authorization field at all.
    expect(redactAuthorizationField("Content-Type", `Bearer ${randomToken(rand, 30)}`)).toBeNull();
  });
});

describe("assignments named like a secret", () => {
  it("redacts the value and keeps the name", () => {
    const v = randomToken(rand, 24);
    // [input, what must survive around the marker]
    const cases: Array<[string, string]> = [
      [`export GITHUB_TOKEN=${v}`, "export GITHUB_TOKEN=<redacted:assigned secret>"],
      [`export FOO_TOKEN="${v}"`, `export FOO_TOKEN="<redacted:assigned secret>"`],
      [`FOO_SECRET='${v}' ./run.sh`, `FOO_SECRET='<redacted:assigned secret>' ./run.sh`],
      [`DATABASE_PASSWORD=${v} psql`, "DATABASE_PASSWORD=<redacted:assigned secret> psql"],
      [`PGPASSWORD=${v} psql -h prod`, "PGPASSWORD=<redacted:assigned secret> psql -h prod"],
      [`{"api_key": "${v}", "user": "alice"}`, `{"api_key": "<redacted:assigned secret>", "user": "alice"}`],
      [`{\\"api_key\\":\\"${v}\\"}`, `{\\"api_key\\":\\"<redacted:assigned secret>\\"}`],
      [`client_secret: ${v}`, "client_secret: <redacted:assigned secret>"],
      [`api_key = "${v}"`, `api_key = "<redacted:assigned secret>"`],
      [`const apiKey = '${v}';`, `const apiKey = '<redacted:assigned secret>';`],
      [`aws_secret_access_key = ${v}`, "aws_secret_access_key = <redacted:assigned secret>"],
      [`--password ${v}`, "--password <redacted:assigned secret>"],
      [`--api-key=${v}`, "--api-key=<redacted:assigned secret>"],
      [`--client-secret "${v}"`, `--client-secret "<redacted:assigned secret>"`],
      [`curl "https://api.example.com/v1?access_token=${v}&q=1"`, "?access_token=<redacted:assigned secret>&q=1"],
      [`curl "https://maps.example.com/api?key=${v}"`, "?key=<redacted:assigned secret>"],
      [`x-api-key: ${v}`, "x-api-key: <redacted:assigned secret>"],
      [`SECRET_KEY_BASE=${v}`, "SECRET_KEY_BASE=<redacted:assigned secret>"],
      [`ORGKEY="${v}"`, `ORGKEY="<redacted:assigned secret>"`],
      // The bare names themselves.
      [`KEY=${v} ./deploy.sh`, "KEY=<redacted:assigned secret> ./deploy.sh"],
      [`export KEY=${v}`, "export KEY=<redacted:assigned secret>"],
      [`TOKEN=${v} ./deploy.sh`, "TOKEN=<redacted:assigned secret> ./deploy.sh"],
      [`export TOKEN=${v}`, "export TOKEN=<redacted:assigned secret>"],
      [`SECRET=${v} ./deploy.sh`, "SECRET=<redacted:assigned secret> ./deploy.sh"],
      [`export SECRET=${v}`, "export SECRET=<redacted:assigned secret>"],
    ];
    for (const [input, survives] of cases) {
      const out = expectRedacted(input, v, "assigned secret");
      expect(out, input).toContain(survives);
    }
  });

  it("redacts a plain password under a strong name, whatever it looks like", () => {
    expectRedacted("export DATABASE_PASSWORD=hunter2", "hunter2", "assigned secret");
    expectRedacted("PGPASSWORD=letmein psql", "letmein", "assigned secret");
    expectRedacted("password: hunter2", "hunter2", "assigned secret");
    expectRedacted(`ADMIN_KEY="dev-admin-key"`, "dev-admin-key", "assigned secret");
  });

  it("redacts a letters-only literal in YAML and in a --flag=value", () => {
    // docker-compose `environment:` blocks and `mysql --password=…` carry
    // plain passwords that look like identifiers; neither syntax has variables.
    expectRedacted("services:\n  db:\n    environment:\n      POSTGRES_PASSWORD: supersecretpassword", "supersecretpassword", "assigned secret");
    expectRedacted("DB_PASSWORD: changeme", "changeme", "assigned secret");
    expectRedacted("mysql -u root --password=letmein prod", "letmein", "assigned secret");
  });

  it("still leaves type annotations, variables, member access and paths alone", () => {
    for (const s of [
      "DB_PASSWORD: string;",
      "SECRET_KEY: str",
      "API_TOKEN: Optional[str] = None",
      "{ DB_PASSWORD: dbPassword }",
      "API_TOKEN: config.apiToken",
      "PASSWORD: required",
      // psql's --password takes no value: it forces a prompt, and the next word is the database.
      "psql --password letmein",
      // A path names where a secret is kept, not the secret.
      "API_TOKEN=/run/secrets/api",
      "password: ~/.pgpass",
      "export DB_PASSWORD=./secrets/db.txt",
    ]) {
      expectUntouched(s);
    }
  });

  it("redacts the literal default of a parameter expansion, not a reference", () => {
    const v = randomToken(rand, 20);
    expectRedacted(`T="\${API_TOKEN:-${v}}"`, v);
    expectUntouched(`T="\${API_TOKEN:-$FALLBACK_TOKEN}"`);
  });

  it("does not consume a secret that sits inside a declined match", () => {
    // `raw = '…'` is an assignment whose NAME is no secret; the secret-named
    // assignment inside its value used to be skipped along with it.
    const v = randomToken(rand, 40);
    expectRedacted(`const raw = 'AWS_SECRET_ACCESS_KEY=${v}';`, v, "assigned secret");
  });

  it("does not consume the boundary the NEXT assignment needs", () => {
    // The scan requires a token boundary in front of a name (that is what keeps
    // it linear), so a match that swallowed a quoted value's closing quote left
    // an assignment glued behind it with no boundary of its own — and unseen.
    const a = randomToken(rand, 20);
    const b = randomToken(rand, 20);
    const r = redactSecrets(`TOKEN="${a}"PASSWORD=${b}`);
    expect(r.text).toBe(`TOKEN="<redacted:assigned secret>"PASSWORD=<redacted:assigned secret>`);
    expect(r.count).toBe(2);
    const f = redactSecrets(`--token "${a}"--password ${b}`);
    expect(f.text).toBe(`--token "<redacted:assigned secret>"--password <redacted:assigned secret>`);
    expect(f.count).toBe(2);
  });

  it("leaves code, references and descriptive names alone", () => {
    for (const s of [
      `const STORAGE_KEY = "app-settings";`,
      "const token = await getToken();",
      "password: z.string().min(8)",
      "token: string;",
      "secret: Uint8Array",
      "apiKey: process.env.OPENAI_API_KEY",
      `api_key = os.getenv("API_KEY")`,
      "f(api_key=api_key)",
      "token=self.token",
      "export API_KEY=$OPENAI_API_KEY",
      "max_tokens: 4096",
      `"max_tokens": 4096, "sort_key": "created_at"`,
      "SECRETS_DIR=/etc/secrets PASSWORD_MIN_LENGTH=12",
      "export NEXT_PUBLIC_API_KEY=pk_live_abc123",
      "key={item.id}",
      "secrets: inherit",
      "token: ${{ secrets.GITHUB_TOKEN }}",
      "KEY_FILE=~/.ssh/id_ed25519",
      `print('has_key=', bool(cfg.get("k")))`,
      "use --token to authenticate and --password followed by the value",
      "Enter password: ",
      "authToken=userAuthTokenValue",
    ]) {
      expectUntouched(s);
    }
  });
});

describe("credentials in URLs and command arguments", () => {
  it("redacts userinfo passwords on any scheme and keeps the host", () => {
    const pw = randomToken(rand, 16);
    const out = expectRedacted(`git clone https://oauth2:${pw}@gitlab.example.com/x.git`, pw, "URL credentials");
    expect(out).toContain("@gitlab.example.com/x.git");
    const tok = randomToken(rand, 32);
    expectRedacted(`git clone https://${tok}@github.com/org/repo`, tok, "URL credentials");
  });

  it("redacts positional passwords for the tools that take them that way", () => {
    const pw = randomToken(rand, 12);
    expectRedacted(`mysql -u root -p${pw} prod`, pw, "credential argument");
    expectRedacted(`docker login -u me -p ${pw} registry.example.com`, pw, "credential argument");
    expectRedacted(`sshpass -p ${pw} ssh deploy@host`, pw, "credential argument");
    expectRedacted(`redis-cli -h cache -a ${pw} ping`, pw, "credential argument");
    expectRedacted(`gh secret set DEPLOY_TOKEN --body "${pw}"`, pw, "credential argument");
    expectRedacted(`curl -u admin:${pw} https://x`, pw, "basic auth");
  });

  it("hands the scrub pass the BARE value of a QUOTED credential argument", () => {
    // These rules dropped the quoted value whole, so the secret recorded for
    // `scrubKnownSecrets` was `'hunter2'` — a string that appears nowhere else
    // — and the bare copy in the agent's own description, or lifted into the
    // path facts, survived into the request. Quoting is the ordinary way to
    // write a password with shell metacharacters in it.
    const pw = randomToken(rand, 14);
    for (const [cmd, marked] of [
      [`sshpass -p '${pw}' ssh deploy@host`, `sshpass -p '<redacted:credential argument>' ssh deploy@host`],
      [`mysql -u root -p'${pw}' prod`, `mysql -u root -p'<redacted:credential argument>' prod`],
      [`docker login -u me -p "${pw}" registry.example.com`, `docker login -u me -p "<redacted:credential argument>" registry.example.com`],
      [`gh secret set DEPLOY_TOKEN --body '${pw}'`, `gh secret set DEPLOY_TOKEN --body '<redacted:credential argument>'`],
      [`redis-cli -h cache -a "${pw}" ping`, `redis-cli -h cache -a "<redacted:credential argument>" ping`],
      [`aws configure set aws_secret_access_key '${pw}'`, `aws configure set aws_secret_access_key '<redacted:assigned secret>'`],
    ] as Array<[string, string]>) {
      const d = redactSecretsDetailed(cmd);
      // The quotes stay where they were written, around the marker.
      expect(d.text, cmd).toBe(marked);
      expect(d.found, cmd).toContain(pw);
      // Which is the only thing that lets the same value be found elsewhere.
      expect(scrubKnownSecrets(`log in with ${pw} then run uptime`, d.found), cmd).toEqual({
        text: "log in with <redacted:repeated secret> then run uptime",
        count: 1,
      });
    }
  });

  it("never records a secret with a delimiter still attached to it", () => {
    // The floor under the case above, for every rule at once: whatever a rule
    // reports as the secret is what `scrubKnownSecrets` searches the rest of
    // the envelope for, so a rule that keeps a quote in it silently loses the
    // whole scrub pass. A rule must put back everything around the value that
    // was not the value.
    const pw = randomToken(rand, 14);
    const quotings = (s: string): string[] => [s, s.replace("@@", `'${pw}'`), s.replace("@@", `"${pw}"`)];
    const shapes = [
      ...quotings(`sshpass -p @@ ssh deploy@host`),
      ...quotings(`mysql -u root -p@@ prod`),
      ...quotings(`docker login -u me -p @@ registry.example.com`),
      ...quotings(`podman login -p @@ registry.example.com`),
      ...quotings(`helm registry login -p @@ registry.example.com`),
      ...quotings(`redis-cli -h cache -a @@ ping`),
      ...quotings(`gh secret set DEPLOY_TOKEN --body @@`),
      ...quotings(`gh secret set DEPLOY_TOKEN -b @@`),
      ...quotings(`aws configure set aws_secret_access_key @@`),
      ...quotings(`npm config set //registry.npmjs.org/:_authToken @@`),
      ...quotings(`git config --global user.password @@`),
      ...quotings(`curl -u admin:@@ https://x`),
      ...quotings(`export DATABASE_PASSWORD=@@ ./run.sh`),
      ...quotings(`--client-secret @@`),
      ...quotings(`{"api_key": @@}`),
      ...quotings(`curl -H "Authorization: hmac @@" https://x`),
    ].map((s) => s.replace("@@", pw));
    for (const cmd of shapes) {
      const d = redactSecretsDetailed(cmd);
      for (const secret of d.found) {
        // A MATCHED pair around the whole value is a delimiter the rule was
        // supposed to put back. (A quote inside a value is not: an
        // `Authorization` value can be `hmac 'tok'`, and that whole string is
        // the credential.)
        expect(secret, cmd).not.toMatch(/^(["'])[\s\S]*\1$/);
        expect(cmd, `${cmd} :: ${secret}`).toContain(secret);
      }
    }
  });

  it("redacts `config set <secret-name> <value>`", () => {
    const v = randomToken(rand, 30);
    expectRedacted(`aws configure set aws_secret_access_key ${v}`, v, "assigned secret");
    expectRedacted(`npm config set //registry.npmjs.org/:_authToken ${v}`, v, "assigned secret");
    expectRedacted(`git config --global user.password ${v}`, v, "assigned secret");
    expectUntouched("aws configure set region us-east-1");
    expectUntouched("run `failproofai config --token <token>` and paste it");
  });

  it("leaves ordinary URLs and uid:gid pairs alone", () => {
    expectUntouched("http://localhost:3000/api");
    expectUntouched("ssh://git@github.com:org/repo");
    expectUntouched("docker run -u 1000:1000 image");
  });
});

describe("vendor tokens and webhook URLs", () => {
  it("redacts prefixes the shared list does not carry", () => {
    const cases: Array<[string, string]> = [
      ["gh" + "o_" + rnd(rand, 36), "GitHub token"],
      ["xo" + "xb-" + rnd(rand, 12, "0123456789") + "-" + rnd(rand, 24), "Slack token"],
      ["hf" + "_" + rnd(rand, 34), "Hugging Face token"],
      ["gl" + "pat-" + rnd(rand, 20, B64URL), "GitLab token"],
      ["AS" + "IA" + rnd(rand, 16, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"), "AWS temporary access key ID"],
      ["gs" + "k_" + rnd(rand, 52), "Groq API key"],
    ];
    for (const [tok, label] of cases) expectRedacted(`value ${tok} end`, tok, label);
  });

  it("finds a vendor token at the start of a JSON-escaped line", () => {
    // Serialised input puts a backslash and an `n` in front of a token that
    // started a line; together they are a boundary, not the end of a word.
    const tok = "gl" + "pat-" + rnd(rand, 20, B64URL);
    const out = expectRedacted(JSON.stringify({ note: `first line\n${tok} rest` }), tok, "GitLab token");
    expect(out).toBe(`{"note":"first line\\n<redacted:GitLab token> rest"}`);
    // A plain `n` with no backslash is still the end of a word.
    expectUntouched(`plain n${tok}`);
  });

  it("redacts the credential path of a webhook URL and keeps the host", () => {
    const path = `T${rnd(rand, 8, "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")}/B${rnd(rand, 8, "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")}/${rnd(rand, 24)}`;
    const out = expectRedacted(`curl -X POST https://hooks.slack.com/services/${path}`, path, "Slack webhook");
    expect(out).toContain("hooks.slack.com/services/");
  });
});

describe("private keys", () => {
  const body = () => Array.from({ length: 4 }, () => rnd(rand, 64, ALNUM + "+/")).join("\n");

  it("redacts the whole PEM block, not just its header", () => {
    const b = body();
    const pem = `${pemBegin("RSA")}\n${b}\n${pemEnd("RSA")}`;
    const out = expectRedacted(`cat > deploy.pem <<'EOF'\n${pem}\nEOF\necho done`, b.slice(0, 64), "private key");
    for (const line of b.split("\n")) expect(out).not.toContain(line);
    expect(out).toContain("echo done");
  });

  it("redacts a JSON-escaped block (a service-account file) and a block cut short", () => {
    const b = body();
    const escaped = `{"private_key": "${pemBegin()}\\n${b.split("\n").join("\\n")}\\n${pemEnd()}\\n", "client_email": "x@y"}`;
    const out = expectRedacted(escaped, b.slice(0, 64), "private key");
    expect(out).toContain(`"client_email": "x@y"`);
    const cut = `${pemBegin("OPENSSH")}\n${b}`;
    const out2 = redactSecrets(cut).text;
    for (const line of b.split("\n")) expect(out2).not.toContain(line);
  });

  it("takes nothing after a lone header", () => {
    const out = redactSecrets(`grep -l "${pemBegin()}" *.pem && echo done`).text;
    expect(out).toContain(`*.pem && echo done`);
  });

  it("redacts the key lines in front of a footer whose header was cut away", () => {
    // What the envelope's head/tail cap leaves in the tail of a long key.
    const lines = body().split("\n");
    const last = rnd(rand, 22, ALNUM + "+/") + "==";
    const tail = `…[1234 characters omitted]…\n${lines.join("\n")}\n${last}\n${pemEnd()}\n`;
    const out = expectRedacted(tail, lines[0], "private key");
    for (const line of [...lines, last]) expect(out).not.toContain(line);
    expect(out).toBe("…[1234 characters omitted]…\n<redacted:private key>\n");
  });

  it("redacts an orphan footer's lines when they are JSON-escaped, and a first line the cut split", () => {
    const lines = body().split("\n");
    const escaped = `…[99 characters omitted]…\n${lines[0].slice(50)}\\n${lines.slice(1).join("\\n")}\\n${pemEnd()}\\n"}`;
    const out = expectRedacted(escaped, lines[1], "private key");
    expect(out).not.toContain(lines[0].slice(50));
    expect(out.endsWith(`<redacted:private key>\\n"}`)).toBe(true);
  });

  it("redacts a block escaped twice (a JSON string inside JSON)", () => {
    const lines = body().split("\n");
    const twice = `${pemBegin()}\\\\n${lines.join("\\\\n")}\\\\n${pemEnd()}\\\\n`;
    const out = expectRedacted(`{"sa": "{\\"private_key\\": \\"${twice}\\"}"}`, lines[0], "private key");
    for (const line of lines) expect(out).not.toContain(line);
    // One block, header to footer — not a header-only match and a stray footer.
    expect(out).not.toContain(pemEnd());
  });

  it("takes the short tail of a line that a slice cut, after a header-only block", () => {
    const lines = body().split("\n");
    const cut = `${pemBegin()}\n${lines[0]}\n${lines[1].slice(0, 10)}`;
    const out = expectRedacted(cut, lines[0], "private key");
    expect(out).toBe("<redacted:private key>");
  });

  it("leaves a footer alone when no key material is in front of it", () => {
    expectUntouched(`The file ends with\n${pemEnd()}`);
    expectUntouched(`and it ends with \`${pemEnd()}\`, one line`);
    expectUntouched(`grep -c "${pemEnd()}" keys/*.pem`);
    expectUntouched(`see docs/keys.md\n${pemEnd()}`);
  });
});

describe("high-entropy tokens", () => {
  it("redacts a long random token with no known prefix", () => {
    const tok = randomToken(rand, 40);
    expectRedacted(`echo ${tok} | base64 -d`, tok, "high-entropy token");
    expectRedacted(`https://drive.example.com/file/d/${tok}/view`, tok, "high-entropy token");
  });

  it("is on for nearly every random 32+ character token", () => {
    let hit = 0;
    for (let i = 0; i < 500; i++) if (looksRandomToken(rnd(rand, 40, B64URL))) hit++;
    expect(hit / 500).toBeGreaterThan(0.95);
  });

  it("leaves digests, ids, identifiers and file names alone", () => {
    for (const s of [
      "git show 1c4816994a5b3e2f1c4816994a5b3e2f1c481699",
      "sha256sum: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      "session 550e8400-e29b-41d4-a716-446655440000 started",
      "shouldReturn404WhenUserIsNotFoundInDatabase",
      "handleUtf8EncodingForBase64Strings2FAVerification",
      "/home/u/.npm/_logs/2026-08-31T10_22_33_123Z-debug-0.log",
      "https://docs.example.org/assets/files/Offchain_Labs_Whitepaper-2024-3f9c1a2b7d.pdf",
      `integrity sha512-${rnd(rand, 86, ALNUM + "+/")}==`,
      `pkg/__init__.py,sha256=${rnd(rand, 43, B64URL)},1024`,
    ]) {
      expectUntouched(s);
    }
  });
});

describe("this machine's own secret environment variables", () => {
  it("redacts their exact values, naming the variable", () => {
    const v = rnd(rand, 32, HEX); // hex: no pattern would catch it by shape
    setEnvSecretSource({ DATADOG_API_KEY: v, HOME: "/home/u", EDITOR: "vim" });
    const out = expectRedacted(`curl -H "DD-API-KEY-HEADER-X ${v}" https://x`, v, "value of $DATADOG_API_KEY");
    expect(out).not.toContain(v);
  });

  it("ignores short, non-token and non-secret-named values", () => {
    setEnvSecretSource({ SHORT_TOKEN: "abc123", APP_SECRET: "production-environment", HOME: "/home/u/abcdefghijk" });
    expectUntouched("abc123 production-environment /home/u/abcdefghijk");
  });
});

describe("scrubKnownSecrets", () => {
  it("replaces the longest known secret first, so a shorter prefix cannot split it", () => {
    const short = randomToken(rand, 16);
    const long = short + rnd(rand, 10);
    const r = scrubKnownSecrets(`use ${long} and ${short}`, [short, long]);
    expect(r.text).toBe("use <redacted:repeated secret> and <redacted:repeated secret>");
    expect(r.count).toBe(2);
  });
});

describe("counting and stability", () => {
  it("counts each secret once, even when two rules could claim it", () => {
    const key = SK + randomToken(rand, 36);
    expectRedacted(`export OPENAI_API_KEY=${key}`, key, "OpenAI API key", 1);
    const tok = randomToken(rand, 24);
    const r = redactSecrets(`export OPENAI_API_KEY=${key} GITHUB_TOKEN=${tok}`);
    expect(r.count).toBe(2);
  });

  it("is idempotent: redacted output redacts to itself", () => {
    const input = [
      `export A_TOKEN=${randomToken(rand, 20)}`,
      `curl -H "Authorization: Bearer ${randomToken(rand, 30)}"`,
      gatewayKey(rand, 9),
      `${pemBegin()}\n${rnd(rand, 64)}\n${pemEnd()}`,
    ].join("\n");
    const once = redactSecrets(input).text;
    const twice = redactSecrets(once);
    expect(twice.text).toBe(once);
    expect(twice.count).toBe(0);
  });

  it("stays fast on adversarial input", () => {
    const inputs = [
      "a=".repeat(1000),
      `x = "${"'".repeat(999)}`,
      `${SK}${"-".repeat(1990)}`,
      pemBegin().repeat(70),
      "Authorization: ".repeat(130),
      `${"k".repeat(40)}=`.repeat(48),
    ];
    for (const s of inputs) {
      const t0 = performance.now();
      redactSecrets(s);
      expect(performance.now() - t0, s.slice(0, 30)).toBeLessThan(250);
    }
  });
});

describe("secretNameStrength", () => {
  it("classifies names", () => {
    const table: Array<[string, "strong" | "weak" | null]> = [
      ["DATABASE_PASSWORD", "strong"],
      ["PGPASSWORD", "strong"],
      ["client_secret", "strong"],
      ["GITHUB_TOKEN", "strong"],
      ["_authToken", "strong"],
      ["apiKey", "strong"],
      ["OPENAI_API_KEY", "strong"],
      ["x-api-key", "strong"],
      ["SECRET_KEY_BASE", "strong"],
      ["STRIPE_KEY", "strong"],
      ["KEY", "strong"],
      ["TOKEN", "strong"],
      ["SECRET", "strong"],
      ["stripeKey", "weak"],
      ["sentry_dsn", "weak"],
      ["key", null],
      ["sort_key", null],
      ["cacheKey", null],
      ["max_tokens", null],
      ["page_token", null],
      ["SECRETS_DIR", null],
      ["PASSWORD_MIN_LENGTH", null],
      ["DB_PASSWORD_FILE", null],
      ["NEXT_PUBLIC_API_KEY", null],
      ["STRIPE_PUBLISHABLE_KEY", null],
      ["has_key", null],
      ["SECRET_PATTERNS", null],
    ];
    for (const [name, want] of table) expect(secretNameStrength(name), name).toBe(want);
  });
});

describe("the shared floor", () => {
  it("extends every token-class pattern to the end of its token, and only those", () => {
    SECRET_PATTERNS.forEach(([, label], i) => {
      const extended = SHARED_PATTERN_EXTENDED[i];
      expect(extended, label).toBe(!["database credentials", "private key"].includes(label));
    });
  });

  /** One positive fixture per SECRET_PATTERNS entry, all built at runtime. */
  const UPPER_DIGITS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const uuid = (): string => [8, 4, 4, 4, 12].map((n) => rnd(rand, n, HEX)).join("-");
  const samples: Array<[label: string, sample: string, body: string]> = (() => {
    const mk = (label: string, sample: string, body = sample): [string, string, string] => [label, sample, body];
    const jwtPart = (): string => rnd(rand, 20, B64URL);
    const bearer = rnd(rand, 40);
    const dbPass = rnd(rand, 16);
    return [
      mk("private key", pemBegin()),
      mk("JWT", `ey${"J"}${jwtPart()}.${jwtPart()}.${jwtPart()}`),
      mk("bearer token", `Authorization: Bearer ${bearer}`, bearer),
      mk("database credentials", `postgres://admin:${dbPass}@db.internal/app`, dbPass),
      mk("Anthropic API key", SK + "ant-api03-" + rnd(rand, 40)),
      mk("OpenAI project API key", SK + "proj-" + rnd(rand, 40)),
      mk("OpenAI API key", SK + rnd(rand, 32)),
      mk("OpenRouter API key", SK + "or-v1-" + rnd(rand, 64, HEX)),
      mk("Langfuse secret key", SK + "lf-" + uuid()),
      mk("GitHub personal access token", "ghp_" + rnd(rand, 36)),
      mk("GitHub fine-grained token", "github_pat_" + rnd(rand, 82, ALNUM + "_")),
      mk("AWS access key ID", "AKIA" + rnd(rand, 16, UPPER_DIGITS)),
      mk("Stripe live secret key", "sk" + "_live_" + rnd(rand, 24)),
      mk("Stripe test secret key", "sk" + "_test_" + rnd(rand, 24)),
      mk("Google API key", "AIza" + rnd(rand, 35)),
      mk("sk- API key", gatewayKey(rand, 5)),
    ];
  })();

  it("has a fixture for every entry, in the list's own order", () => {
    expect(samples.map(([label]) => label)).toEqual(SECRET_PATTERNS.map(([, label]) => label));
  });

  /**
   * The boundary contract, for BOTH consumers of the list at once.
   *
   * An entry may open with a consuming capture group holding the character in
   * front of the secret (a lookbehind would cost the blocking policy its regex
   * JIT). Every consumer that replaces a match has to put that character back,
   * and only that character:
   *
   *  - forgetting it deletes the character in front of every key — `export
   *    KEY=<key>` became `export KEY[REDACTED: sk- API key]`, `{"k":"<key>"}`
   *    lost its opening quote, and two lines merged where the boundary was a
   *    newline (the audit consumer shipped exactly this);
   *  - re-emitting a group that holds part of the SECRET would print the
   *    secret in front of the marker.
   *
   * Both show up here as the marker no longer sitting exactly where the secret
   * started, whichever entry is at fault and whoever adds the next one.
   */
  it("replaces each secret in place, keeping the character in front of it — in the redactor and the audit masker", () => {
    // The tail is parenthesised because a PEM header with no footer takes a
    // short base64-looking word after it as the key line a cut split.
    const tail = " (tail)";
    for (const [label, sample, body] of samples) {
      const redacted = redactSecrets(`prefix ${sample}${tail}`).text;
      expect(redacted, label).toContain(`<redacted:${label}>`);
      expect(redacted.startsWith("prefix <redacted:"), `${label}: ${redacted.slice(0, 40)}`).toBe(true);
      expect(redacted.endsWith(tail), label).toBe(true);
      expect(redacted, label).not.toContain(body.slice(0, 12));

      const masked = maskSecrets(`prefix ${sample}${tail}`);
      expect(masked, label).toContain(`[REDACTED: ${label}]`);
      expect(masked.startsWith("prefix [REDACTED: "), `${label}: ${masked.slice(0, 40)}`).toBe(true);
      expect(masked.endsWith(tail), label).toBe(true);
      expect(masked, label).not.toContain(body.slice(0, 12));
    }
  });

  it("declares its prefix-keeping entries instead of inferring them from the source", () => {
    for (const re of SECRET_PATTERNS_KEEPING_PREFIX) {
      expect(SECRET_PATTERNS.some(([p]) => p === re), re.source.slice(0, 20)).toBe(true);
      // A member MUST open with a capture group, or there is no group 1 to keep.
      expect(re.source.startsWith("(") && !re.source.startsWith("(?"), re.source.slice(0, 20)).toBe(true);
    }
  });

  it("reports the most specific label when two entries could claim the output", () => {
    // sanitize-api-keys returns on the first pattern that matches, so the
    // generic `sk- API key` entry sits last: a vendor prefix with a name of
    // its own must keep it.
    const key = gatewayKey(rand, 5);
    const policy = BUILTIN_POLICIES.find((p) => p.name === "sanitize-api-keys")!;
    const cases: Array<[string, string]> = [
      [`token ghp_${rnd(rand, 36)} and ${key}`, "GitHub personal access token"],
      [`AKIA${rnd(rand, 16, UPPER_DIGITS)} and ${key}`, "AWS access key ID"],
      [`AIza${rnd(rand, 35)} and ${key}`, "Google API key"],
      [`${key} alone`, "sk- API key"],
    ];
    for (const [output, label] of cases) {
      const ctx = { eventType: "PostToolUse", payload: { tool_response: { output } }, toolName: "Bash", toolInput: {} };
      const r = policy.fn(ctx as unknown as PolicyContext) as { decision: string; reason?: string };
      expect(r.decision, label).toBe("deny");
      expect(r.reason, label).toContain(label);
    }
  });
});

describe("cost", () => {
  const RUN_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_";
  // Step 5, not 7: 7 shares a factor with the 63-character alphabets below,
  // so `(i * 7) % 63` emitted NINE distinct characters and never the
  // separator — the one character each of those cases was written to put in
  // the run. The step has to be coprime with every alphabet's length.
  const run = (n: number, alphabet: string): string => {
    let s = "";
    for (let i = 0; i < n; i++) s += alphabet[(i * 5) % alphabet.length];
    return s;
  };

  it("builds a run out of the WHOLE alphabet it was given", () => {
    for (const alphabet of [RUN_CHARS, B64URL, ALNUM + "-", ALNUM + "_"]) {
      const s = run(alphabet.length * 3, alphabet);
      expect(new Set(s).size, alphabet.slice(-3)).toBe(alphabet.length);
      expect(s, alphabet.slice(-3)).toContain(alphabet[alphabet.length - 1]);
    }
  });

  it("scans a run of name characters once, not once per character in it", () => {
    // ASSIGNMENT_RE's name could start at ANY character of a token, so on a
    // run with no separator in it the engine consumed the rest of the run at
    // every position and backtracked over it: 7 ms at 2 000 characters, 35 ms
    // at 4 000 — quadratic, on a PreToolUse path that then still has to call
    // Jev. A leading token-boundary group makes each position inside a run
    // fail in one step. The budget is ~50x the linear cost and ~3x below the
    // quadratic one at 4 000 characters.
    for (const alphabet of [RUN_CHARS, `${B64URL}`, ALNUM + "-"]) {
      for (const n of [1_000, 2_000, 4_000]) {
        const s = run(n, alphabet);
        const t0 = performance.now();
        redactSecrets(s);
        expect(performance.now() - t0, `${n} of ${alphabet.slice(-4)}`).toBeLessThan(15);
      }
    }
  });

  it("stays linear on a run of hyphenated flags", () => {
    // FLAG_VALUE_RE had the same shape: `-` is a name character, so every
    // hyphen of a kebab-case run started a flag whose tail was consumed and
    // backtracked. The two URL rules then kept the same string quadratic
    // through their `\b` (see below): 8.5 ms of this 15 ms budget at 4 200
    // characters, and 33 ms at 8 400. Both lengths are now ~0.3 ms.
    for (const n of [1_400, 2_800]) {
      const s = "-ab".repeat(n);
      const t0 = performance.now();
      redactSecrets(s);
      expect(performance.now() - t0, `${s.length} chars`).toBeLessThan(15);
    }
  });

  it("scans a run of URL-scheme characters once, not once per character in it", () => {
    // URL_CREDENTIALS_RE and URL_TOKEN_USERINFO_RE opened with `\b`, which
    // matches after every `-`, `.` and `+` — all three non-word characters
    // that `[a-z][a-z0-9+.-]*` can also consume. The scheme group then took
    // the rest of the run and backtracked over it from each of those starts:
    // 11 ms at 4 000 characters, 45 ms at 8 000, which was 44 of the 47 ms
    // the whole redactor spent on that string.
    //
    // The `x://` prefix is load-bearing: both rules are skipped outright for a
    // string with no `://` in it, so without one this measures that guard and
    // not the scan it is guarding.
    //
    // Sizes are chosen so the budget separates the two shapes by a wide
    // margin on BOTH sides, measured under this runner: at 16 004 characters
    // the anchored rules take 0.5 ms and the `\b` ones 126 ms.
    for (const unit of ["a-", "a.", "x+"]) {
      for (const n of [2_000, 8_000]) {
        const s = `x://${unit.repeat(n)}`;
        const t0 = performance.now();
        redactSecrets(s);
        expect(performance.now() - t0, `${s.length} of ${unit}`).toBeLessThan(15);
      }
    }
  });

  it("stays linear on repeated private-key armour lines", () => {
    // The complete-block alternative is a lazy scan for `-----END`, so in a
    // text with no footer anywhere it read to the end of the string — from
    // every header in it. A grep hit list across a key directory is that
    // text, and `buildEnvelope` redacts up to 576 strings. 1.9 ms at 33 600
    // characters once the footerless case gets its own rule, 58 ms before.
    for (const n of [600, 1_200]) {
      const s = `${pemBegin()} `.repeat(n);
      const t0 = performance.now();
      redactSecrets(s);
      expect(performance.now() - t0, `${s.length} chars`).toBeLessThan(15);
    }
  });
});
