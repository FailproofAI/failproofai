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
  redactSecrets,
  secretNameStrength,
  setEnvSecretSource,
} from "../../../src/hooks/semantic/redact";
import { SECRET_PATTERNS } from "../../../src/hooks/builtin-policies";
import { ALNUM, B64URL, HEX, SK, gatewayKey, prng, randomToken, rnd } from "./redaction-fixtures";

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

  it("leaves references and prose alone", () => {
    expectUntouched(`curl -H "Authorization: Bearer $TOKEN" https://x`);
    expectUntouched(`curl -H "Authorization: Bearer \${API_TOKEN}" https://x`);
    expectUntouched("the bearer authentication scheme sends a token");
    expectUntouched("use bearer token-based auth for the API");
    expectUntouched("authorization: required for this endpoint");
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
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${b}\n-----END RSA PRIVATE KEY-----`;
    const out = expectRedacted(`cat > deploy.pem <<'EOF'\n${pem}\nEOF\necho done`, b.slice(0, 64), "private key");
    for (const line of b.split("\n")) expect(out).not.toContain(line);
    expect(out).toContain("echo done");
  });

  it("redacts a JSON-escaped block (a service-account file) and a block cut short", () => {
    const b = body();
    const escaped = `{"private_key": "-----BEGIN PRIVATE KEY-----\\n${b.split("\n").join("\\n")}\\n-----END PRIVATE KEY-----\\n", "client_email": "x@y"}`;
    const out = expectRedacted(escaped, b.slice(0, 64), "private key");
    expect(out).toContain(`"client_email": "x@y"`);
    const cut = `-----BEGIN OPENSSH PRIVATE KEY-----\n${b}`;
    const out2 = redactSecrets(cut).text;
    for (const line of b.split("\n")) expect(out2).not.toContain(line);
  });

  it("takes nothing after a lone header", () => {
    const out = redactSecrets(`grep -l "-----BEGIN PRIVATE KEY-----" *.pem && echo done`).text;
    expect(out).toContain(`*.pem && echo done`);
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
      `-----BEGIN PRIVATE KEY-----\n${rnd(rand, 64)}\n-----END PRIVATE KEY-----`,
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
      "-----BEGIN PRIVATE KEY-----".repeat(70),
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
});
