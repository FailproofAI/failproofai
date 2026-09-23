// @vitest-environment node
/**
 * The Vercel AI Gateway key (`vck_`), on the envelope path only.
 *
 * `vercel` is one of the five providers a Jev config can name, and
 * `jev-config.ts`'s `CREDENTIAL_PREFIX_RE` already refuses a `vck_` string as a
 * model id because it is credential-shaped — but `redact.ts` carried no pattern
 * for it, so a gateway key written bare in a command went to the provider in the
 * Jev request body in cleartext. `AI_GATEWAY_API_KEY=<key>` was caught by the
 * assignment rule; the bare form was not.
 *
 * The pattern belongs in `VENDOR_RULES`, this file's own list, and NOT in
 * `SECRET_PATTERNS`: the default-on `sanitize-*` builtins read that one and
 * answer a match by replacing the whole tool result, so a pattern added there
 * costs output to every user who never enabled Jev. `sanitize-gateway-keys.test.ts`
 * is the standing pin on that line; this file only adds the missing vendor.
 *
 * Key-shaped fixtures are built at runtime (see ./redaction-fixtures) so nothing
 * credential-shaped appears literally in a test source.
 */
import { describe, expect, it } from "vitest";
import { SECRET_PATTERNS } from "../../../src/hooks/builtin-policies";
import { redactSecrets } from "../../../src/hooks/semantic/redact";
import { ALNUM, prng, rnd } from "./redaction-fixtures";

const rand = prng(0x7c4b);
/** `vck` + `_`, joined at runtime. */
const VCK = ["vck", "_"].join("");
const gatewayKey = (len = 36): string => VCK + "A1b" + rnd(rand, len - 3, ALNUM);

describe("the Vercel AI Gateway key reaches no Jev request body", () => {
  it("is redacted bare in a command, where the assignment rule never saw it", () => {
    const key = gatewayKey();
    const r = redactSecrets(`curl -s https://ai-gateway.vercel.sh/typesafe/v1/systemone ${key}`, { blunt: false });
    expect(r.text).not.toContain(key);
    // Not a partial redaction: nothing of the key's tail survives either.
    expect(r.text).not.toContain(key.slice(-12));
    expect(r.text).toContain("<redacted:Vercel AI Gateway key>");
  });

  it("is redacted in every shape a command or a body puts it in", () => {
    for (const [label, text] of [
      ["assignment", `AI_GATEWAY_API_KEY=${gatewayKey()}`],
      ["quoted flag", `failproofai jev setup --provider vercel --key "${gatewayKey()}"`],
      ["json body", JSON.stringify({ apiKey: gatewayKey() })],
      ["header", `-H "authorization: Bearer ${gatewayKey()}"`],
    ] as const) {
      const key = text.slice(text.indexOf(VCK)).match(/^[A-Za-z0-9_]+/)![0];
      for (const blunt of [false, true]) {
        const r = redactSecrets(text, { blunt });
        expect(r.text, `${label} (blunt=${blunt})`).not.toContain(key);
      }
    }
  });

  it("a longer key is redacted whole, not down to its first 24 body characters", () => {
    const key = gatewayKey(64);
    const r = redactSecrets(`k ${key}`, { blunt: false });
    expect(r.text).toBe("k <redacted:Vercel AI Gateway key>");
  });

  it("leaves ordinary text that merely starts with the prefix alone", () => {
    for (const text of [`${VCK}short`, `the ${VCK} prefix is Vercel's`, `git checkout ${VCK}feature-branch`, `${VCK}`]) {
      expect(redactSecrets(text, { blunt: true }).text, text).toBe(text);
    }
  });

  it("stays OFF the blocking floor, which the default-on sanitize policies read", () => {
    // A pattern here would replace a whole tool result for users who never
    // enabled Jev, and an earlier round's addition to this list caused exactly
    // that regression. The redactor's own list is the right home.
    expect(SECRET_PATTERNS.map(([re]) => re.source).filter((s) => s.includes("vck"))).toEqual([]);
  });
});
