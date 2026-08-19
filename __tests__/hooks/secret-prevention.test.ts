/**
 * The two PreToolUse policies that make secret detection actually PREVENT
 * something.
 *
 * Why they exist: PostToolUse `block` is honoured on codex and copilot only
 * (src/hooks/enforcement-capability.ts) and even there it replaces the result
 * AFTER the tool ran. On the other ten CLIs — Claude Code included — a
 * sanitize-* deny is an appended note and the model reads the real output
 * anyway. PreToolUse blocks on all twelve, so this is the only place a secret
 * finding can stop anything.
 *
 * Kept out of builtin-policies.test.ts because every credential-shaped fixture
 * added there trips the sanitize-* family for the other ~40 policies sharing
 * the file.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { BUILTIN_POLICIES } from "../../src/hooks/builtin-policies";
import type { PolicyContext } from "../../src/hooks/policy-types";

const inWrite = BUILTIN_POLICIES.find((p) => p.name === "block-secret-in-write")!;
const credFiles = BUILTIN_POLICIES.find((p) => p.name === "block-credential-files")!;

const KEY = `sk-ant-api03-${"A".repeat(32)}`;
const AWS = `AKIA${"B".repeat(16)}`;

function ctx(
  toolName: string,
  toolInput: Record<string, unknown>,
  params: Record<string, unknown> = {},
): PolicyContext {
  return {
    eventType: "PreToolUse",
    payload: { tool_name: toolName, tool_input: toolInput },
    toolName,
    toolInput,
    params,
  } as unknown as PolicyContext;
}

describe("block-secret-in-write", () => {
  it("is registered for Write and Edit at PreToolUse, on by default", () => {
    expect(inWrite.match.events).toEqual(["PreToolUse"]);
    expect(inWrite.match.toolNames).toEqual(["Write", "Edit"]);
    expect(inWrite.defaultEnabled).toBe(true);
  });

  it("denies a credential in Write content", async () => {
    const r = await inWrite.fn(ctx("Write", { file_path: "/app/src/config.ts", content: `export const k = "${KEY}";` }));
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("Anthropic API key");
  });

  it("denies a credential introduced by an Edit", async () => {
    const r = await inWrite.fn(ctx("Edit", {
      file_path: "/app/src/config.ts",
      old_string: "const k = process.env.KEY;",
      new_string: `const k = "${KEY}";`,
    }));
    expect(r.decision).toBe("deny");
  });

  /**
   * The single most important case in this file.
   *
   * Removing a leaked key is an Edit whose `old_string` IS the key. Scanning the
   * whole payload — which is what the sanitize-* family does — denies exactly
   * that edit, leaving the credential in the file with no way to take it out.
   */
  describe("never blocks the remediation", () => {
    it("allows an Edit that REMOVES a credential", async () => {
      const r = await inWrite.fn(ctx("Edit", {
        file_path: "/app/src/config.ts",
        old_string: `const k = "${KEY}";`,
        new_string: "const k = process.env.ANTHROPIC_API_KEY;",
      }));
      expect(r.decision).toBe("allow");
    });

    it("allows an Edit that replaces one credential reference with an env lookup", async () => {
      const r = await inWrite.fn(ctx("Edit", {
        file_path: "/app/.config",
        old_string: `aws_access_key_id = ${AWS}`,
        new_string: "aws_access_key_id = ${AWS_ACCESS_KEY_ID}",
      }));
      expect(r.decision).toBe("allow");
    });

    it("still denies when the credential survives into new_string", async () => {
      const r = await inWrite.fn(ctx("Edit", {
        file_path: "/app/src/config.ts",
        old_string: `const k = "${KEY}"; // old`,
        new_string: `const k = "${KEY}"; // new`,
      }));
      expect(r.decision).toBe("deny");
    });

    it("does not fire on Bash, where grepping for the key is how you find it", async () => {
      // Registered for Write/Edit only, but assert the guard directly too — a
      // widened `toolNames` would otherwise start denying `git grep`.
      expect((await inWrite.fn(ctx("Bash", { command: `git grep ${AWS}` }))).decision).toBe("allow");
    });

    it("does not fire on Read", async () => {
      expect((await inWrite.fn(ctx("Read", { file_path: "/app/.config" }))).decision).toBe("allow");
    });
  });

  /**
   * Only copilot, opencode and antigravity canonicalise a content field
   * (src/hooks/types.ts) — pi, goose, hermes and openclaw map the path alone.
   * Scanning every string value except the known OLD-content keys is what keeps
   * this policy from being silently inert on those CLIs while the UI shows it
   * enabled.
   */
  describe("does not depend on a content field being canonicalised", () => {
    for (const key of ["content", "file_text", "contents", "text", "CodeContent", "after", "body"]) {
      it(`denies a credential arriving under \`${key}\``, async () => {
        const r = await inWrite.fn(ctx("Write", { file_path: "/app/x.ts", [key]: `k = "${KEY}"` }));
        expect(r.decision).toBe("deny");
      });
    }

    for (const key of ["old_string", "old_str", "before", "search"]) {
      it(`ignores a credential arriving under \`${key}\` (pre-existing content)`, async () => {
        const r = await inWrite.fn(ctx("Edit", { file_path: "/app/x.ts", [key]: `k = "${KEY}"`, new_string: "k = env" }));
        expect(r.decision).toBe("allow");
      });
    }

    it("ignores non-string values rather than throwing", async () => {
      const r = await inWrite.fn(ctx("Write", { file_path: "/app/x.ts", content: null, replace_all: true, count: 3 }));
      expect(r.decision).toBe("allow");
    });
  });

  describe("test fixtures", () => {
    const fixturePaths = [
      "/repo/__tests__/hooks/secret.test.ts",
      "/repo/src/thing.test.ts",
      "/repo/src/thing.spec.js",
      "/repo/tests/data.json",
      "/repo/fixtures/keys.json",
      "/repo/examples/policies/index.js",
    ];

    for (const path of fixturePaths) {
      it(`skips ${path} by default`, async () => {
        expect((await inWrite.fn(ctx("Write", { file_path: path, content: KEY }))).decision).toBe("allow");
      });
    }

    it("scans them when skipTestFixtures is false", async () => {
      const r = await inWrite.fn(ctx("Write", { file_path: "/repo/src/a.test.ts", content: KEY }, { skipTestFixtures: false }));
      expect(r.decision).toBe("deny");
    });

    // "test" appearing anywhere in a name is not evidence of a fixture.
    it("does not treat src/config.test-utils.ts as a fixture", async () => {
      const r = await inWrite.fn(ctx("Write", { file_path: "/repo/src/config.test-utils.ts", content: KEY }));
      expect(r.decision).toBe("deny");
    });

    it("does not treat src/latest/index.ts as a fixture", async () => {
      const r = await inWrite.fn(ctx("Write", { file_path: "/repo/src/latest/index.ts", content: KEY }));
      expect(r.decision).toBe("deny");
    });
  });

  describe("allowedSecretHashes", () => {
    const hash = (v: string) => createHash("sha256").update(v, "utf8").digest("hex");

    it("excuses a specific literal by hash", async () => {
      const r = await inWrite.fn(
        ctx("Write", { file_path: "/app/src/a.ts", content: KEY }, { allowedSecretHashes: [hash(KEY)] }),
      );
      expect(r.decision).toBe("allow");
    });

    it("is case-insensitive about the configured digest", async () => {
      const r = await inWrite.fn(
        ctx("Write", { file_path: "/app/src/a.ts", content: KEY }, { allowedSecretHashes: [hash(KEY).toUpperCase()] }),
      );
      expect(r.decision).toBe("allow");
    });

    it("does not excuse a DIFFERENT credential", async () => {
      const r = await inWrite.fn(
        ctx("Write", { file_path: "/app/src/a.ts", content: `sk-ant-api03-${"Z".repeat(32)}` }, { allowedSecretHashes: [hash(KEY)] }),
      );
      expect(r.decision).toBe("deny");
    });

    it("tolerates a malformed allowedSecretHashes without throwing", async () => {
      const r = await inWrite.fn(ctx("Write", { file_path: "/app/src/a.ts", content: KEY }, { allowedSecretHashes: "nope" }));
      expect(r.decision).toBe("deny");
    });

    it("names the escape hatch in the denial, so the fix is discoverable", async () => {
      const r = await inWrite.fn(ctx("Write", { file_path: "/app/src/a.ts", content: KEY }));
      expect(r.reason).toContain("allowedSecretHashes");
    });
  });

  describe("uses the blocking tier only", () => {
    it("does not deny a Twilio-shaped hex string, which collides with a git SHA", async () => {
      const r = await inWrite.fn(ctx("Write", { file_path: "/app/a.ts", content: `const sid = "AC${"a1".repeat(16)}"` }));
      expect(r.decision).toBe("allow");
    });

    it("allows ordinary source with no credential in it", async () => {
      const r = await inWrite.fn(ctx("Write", {
        file_path: "/app/src/index.ts",
        content: "export const risk_assessment = { key: 1 };\nconst token = getToken();\n",
      }));
      expect(r.decision).toBe("allow");
    });
  });
});

describe("block-credential-files", () => {
  const blocked = [
    ["/home/u/.ssh/id_rsa", "SSH RSA private key"],
    ["/home/u/.ssh/id_ed25519", "SSH ed25519 private key"],
    ["/home/u/.ssh/id_ecdsa", "SSH ecdsa private key"],
    ["/home/u/.aws/credentials", "AWS credentials"],
    ["/home/u/.git-credentials", "stored git credentials"],
    ["/home/u/.netrc", "netrc"],
    ["/home/u/.pypirc", "PyPI credentials"],
    ["/home/u/.docker/config.json", "Docker registry auth"],
    ["/app/service-account.json", "GCP service account"],
    ["/app/service-account-prod.json", "GCP service account, suffixed"],
    ["/app/keystore.p12", "PKCS#12 keystore"],
    ["/app/release.jks", "Java keystore"],
    ["/home/u/.gnupg/secring.gpg", "GnuPG material"],
    ["/home/u/.config/gcloud/credentials.db", "gcloud credentials"],
  ];

  for (const [path, why] of blocked) {
    it(`blocks reading ${why}`, async () => {
      const r = await credFiles.fn(ctx("Read", { file_path: path }));
      expect(r.decision, path).toBe("deny");
    });
  }

  it("blocks a Bash read of an absolute credential path", async () => {
    expect((await credFiles.fn(ctx("Bash", { command: "cat /home/u/.aws/credentials" }))).decision).toBe("deny");
  });

  it("blocks a Bash read of a RELATIVE credential path", async () => {
    // extractAbsolutePaths only yields absolute and ~-rooted paths, so the
    // relative form needs the argv pass or `cat .aws/credentials` walks through.
    expect((await credFiles.fn(ctx("Bash", { command: "cat .aws/credentials" }))).decision).toBe("deny");
  });

  it("blocks a quoted Bash path", async () => {
    expect((await credFiles.fn(ctx("Bash", { command: "cat '.git-credentials'" }))).decision).toBe("deny");
  });

  // A public key is meant to be distributed; blocking it is pure friction.
  for (const pub of ["/home/u/.ssh/id_rsa.pub", "/home/u/.ssh/id_ed25519.pub"]) {
    it(`allows ${pub}`, async () => {
      expect((await credFiles.fn(ctx("Read", { file_path: pub }))).decision).toBe("allow");
    });
  }

  const ordinary = [
    "/app/src/index.ts",
    "/app/package.json",
    "/app/README.md",
    "/app/src/credentials-form.tsx",
    "/app/config/netrc-parser.ts",
  ];
  for (const path of ordinary) {
    it(`allows ${path}`, async () => {
      expect((await credFiles.fn(ctx("Read", { file_path: path }))).decision, path).toBe("allow");
    });
  }

  describe("strict tier", () => {
    const strictOnly = [
      "/app/.npmrc",
      "/home/u/.kube/config",
      "/app/prod.tfvars",
      "/app/terraform.tfstate",
      "/app/secrets.yaml",
    ];

    for (const path of strictOnly) {
      it(`allows ${path} by default — these frequently hold no credential`, async () => {
        expect((await credFiles.fn(ctx("Read", { file_path: path }))).decision, path).toBe("allow");
      });

      it(`blocks ${path} when strict is on`, async () => {
        expect((await credFiles.fn(ctx("Read", { file_path: path }, { strict: true }))).decision, path).toBe("deny");
      });
    }
  });

  it("explains what to do instead", async () => {
    const r = await credFiles.fn(ctx("Read", { file_path: "/home/u/.ssh/id_ed25519" }));
    expect(r.reason).toMatch(/environment|secret store|ask the user/i);
  });
});

/**
 * The generous tier. It returns `instruct`, never `deny`, because a name-based
 * rule cannot tell a live credential from a fixture — and the repo argues that
 * case at length in src/audit/redact-example.ts. Its tuning is copied from the
 * daemon's redactor, NOT from `isSecretName`: the two disagree on 7 of 12 common
 * names, and the redact-example version matches a bare `key=`, which the Rust
 * comment records hitting React's `key` prop across 40 real transcripts.
 */
describe("warn-assigned-secret", () => {
  const warn = BUILTIN_POLICIES.find((p) => p.name === "warn-assigned-secret")!;

  it("warns rather than blocks, and is off by default", () => {
    expect(warn.defaultEnabled).toBe(false);
    expect(warn.match.events).toEqual(["PreToolUse"]);
  });

  const flagged: Array<[string, string]> = [
    ["export DATABASE_PASSWORD=hunter2-prod-acme", "compound name, literal value"],
    ["export API_KEY=abcdef1234567890", "weak name, but compound"],
    ["export AUTH_TOKEN=abcdef1234567890", "token in a compound name"],
    ["PGPASSWORD=letmeinplease psql -h prod", "strong name needs no compound"],
    ["MY_SECRET=abcdefghijklmno ./run.sh", "secret suffix"],
    ["npm config set _authToken=abcdef1234567890", "flag-style assignment"],
  ];

  for (const [command, why] of flagged) {
    it(`instructs on: ${why}`, async () => {
      const r = await warn.fn(ctx("Bash", { command }));
      expect(r.decision, command).toBe("instruct");
    });
  }

  const ignored: Array<[string, string]> = [
    // The measured false positive the Rust tuning exists to avoid.
    ["const el = <Row key=abcdefghijklmnop />", "bare `key=` is a React prop, not a credential"],
    ["const t = token=abcdefghijklmnop", "bare `token=` needs a compound name"],
    ["export EDITOR=vim", "not a credential name"],
    ["export PASSTHROUGH=enabled-for-now", "contains PASS but does not end in it"],
    ["export API_KEY=short", "value below the minimum length"],
    ["export API_KEY=$OTHER_KEY_FROM_ENV", "a reference, not a literal"],
    ["export API_KEY=${VAULT_VALUE_HERE}", "a braced reference"],
    ["export API_KEY=$(vault read -field=x)", "a command substitution"],
    ["export API_KEY=your-key-here", "an obvious placeholder"],
    ["export API_KEY=xxxxxxxxxxxxxxxx", "a redaction placeholder"],
    ["export API_KEY=changeme", "the classic placeholder"],
  ];

  for (const [command, why] of ignored) {
    it(`stays quiet on: ${why}`, async () => {
      const r = await warn.fn(ctx("Bash", { command }));
      expect(r.decision, command).toBe("allow");
    });
  }

  it("sees an assignment written into file content", async () => {
    const r = await warn.fn(ctx("Write", {
      file_path: "/app/config.sh",
      content: "DATABASE_PASSWORD=hunter2-prod-acme\n",
    }));
    expect(r.decision).toBe("instruct");
  });

  it("ignores an assignment being REMOVED by an Edit", async () => {
    const r = await warn.fn(ctx("Edit", {
      file_path: "/app/config.sh",
      old_string: "DATABASE_PASSWORD=hunter2-prod-acme",
      new_string: "DATABASE_PASSWORD=${DB_PASSWORD}",
    }));
    expect(r.decision).toBe("allow");
  });

  it("does not read the file path as content", async () => {
    // A path like /srv/password-reset/config.ts must not trip the name rule.
    const r = await warn.fn(ctx("Write", { file_path: "/srv/password-reset/config.ts", content: "export const a = 1;" }));
    expect(r.decision).toBe("allow");
  });

  it("names the variable, so the warning says what to fix", async () => {
    const r = await warn.fn(ctx("Bash", { command: "export STRIPE_SECRET=abcdefghijklmnop" }));
    expect(r.reason).toContain("STRIPE_SECRET");
  });
});
