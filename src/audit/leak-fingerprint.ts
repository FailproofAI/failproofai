/**
 * How a leaked credential is NAMED once it leaves the machine.
 *
 * Every other redactor in this codebase exists to destroy a value. This one
 * exists to describe one, because the leak report has the opposite job: a
 * finding the reader cannot tie to a row in a vendor console is a finding they
 * cannot act on. `[REDACTED: GitHub token]` tells you nothing you can revoke.
 *
 * The rule is: **enough to identify, never enough to use.**
 *
 * ## Why the mask character matters, which is not obvious
 *
 * The three most natural masking characters — `X`, `x` and `0` — RE-MATCH every
 * vendor prefix pattern we ship. `AKIA` + sixteen `X`s satisfies
 * `AKIA[A-Z0-9]{16}`, so a masked AWS key is reported by failproofai as a live
 * AWS key on the next scan. The same holds for a masked connection string,
 * whose pattern keys on `://…@` and does not care what sits between. So the
 * mask is `•` (U+2022), which is in no credential charset anywhere, and the
 * unit tests assert that every masked form fails to re-match.
 *
 * That is not a hypothetical: this product measured its own audit output
 * feeding back into its own corpus, one leaked credential becoming seven
 * reported findings across four sessions.
 *
 * ## Why the last four, and why not always
 *
 * Last-4 is what vendor consoles display next to a key, so it is the token that
 * lets a human find the right row and press revoke. But it is only safe when
 * what remains is genuinely unguessable. For a 40-character GitHub token,
 * showing `ghp_` and four trailing characters leaves ~32 unknown base62
 * characters — no help to anyone. For a 13-character human-chosen password,
 * last-4 is nearly a third of the secret, and the corpus's one confirmed-live
 * password was exactly 13 characters at 3.19 bits per character.
 *
 * So the tail is shown only when the value clears BOTH bars: a recognised
 * public vendor prefix (which proves it is a minted token, not a typed
 * password) AND enough residual length. Everything else is described by class
 * and length alone.
 */

/** The mask glyph. Never `X`, `x` or `0` — see the module header. */
const MASK_CHAR = "•";

/** Longest run of mask glyphs rendered, so a 200-char token stays readable. */
const MAX_MASK_RUN = 8;

/**
 * Minimum total length before any trailing characters are shown.
 *
 * 24 is chosen so that even the shortest minted token we recognise keeps well
 * over 100 bits of residual entropy after the prefix and tail are removed.
 * Human-chosen passwords essentially never reach it, which is the point.
 */
const MIN_LEN_FOR_TAIL = 24;

/** How many trailing characters a vendor console typically shows. */
const TAIL_CHARS = 4;

/**
 * Public, minted prefixes — the part of a credential that carries no secret.
 *
 * Each of these is published by its issuer and identical across every key they
 * mint, so showing it discloses nothing while telling the reader which console
 * to open. Ordered longest-first, so `sk-ant-api03-` wins over `sk-ant-` and
 * `sk-`; the first match is the one rendered.
 *
 * Deliberately NOT the full detection vocabulary. This list only has to be
 * right about what is safe to PRINT — a prefix missing from it costs a less
 * specific label, never a disclosure.
 */
const PUBLIC_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ["sk-ant-api03-", "Anthropic API key"],
  ["sk-ant-oat01-", "Anthropic OAuth token"],
  ["sk-ant-", "Anthropic key"],
  ["sk-proj-", "OpenAI project key"],
  ["sk-svcacct-", "OpenAI service-account key"],
  ["sk-admin-", "OpenAI admin key"],
  ["sk-or-v1-", "OpenRouter key"],
  ["github_pat_", "GitHub fine-grained token"],
  ["ghp_", "GitHub personal access token"],
  ["gho_", "GitHub OAuth token"],
  ["ghu_", "GitHub user-to-server token"],
  ["ghs_", "GitHub server-to-server token"],
  ["ghr_", "GitHub refresh token"],
  ["glpat-", "GitLab personal access token"],
  ["xoxb-", "Slack bot token"],
  ["xoxp-", "Slack user token"],
  ["xapp-", "Slack app-level token"],
  ["sk_live_", "Stripe live secret key"],
  ["sk_test_", "Stripe test secret key"],
  ["rk_live_", "Stripe restricted key"],
  ["AKIA", "AWS access key ID"],
  ["ASIA", "AWS temporary access key ID"],
  ["AIza", "Google API key"],
  ["hf_", "Hugging Face token"],
  ["gsk_", "Groq API key"],
  ["r8_", "Replicate token"],
  ["xai-", "xAI key"],
  ["npm_", "npm access token"],
  ["dop_v1_", "DigitalOcean token"],
  ["shpat_", "Shopify access token"],
  ["sbp_", "Supabase token"],
];

export interface LeakFingerprint {
  /** What the reader sees: `ghp_••••••••4f2a` or `[13-char password]`. */
  display: string;
  /** Human label for the class, e.g. "GitHub personal access token". */
  label: string;
  /** Total character length of the original value. */
  length: number;
  /** True when a minted public prefix was recognised — i.e. we can name a
   *  console to revoke at. False means "we know it leaked, not who issued it". */
  attributed: boolean;
}

/** The recognised public prefix for a value, longest match first. */
function matchPublicPrefix(value: string): readonly [string, string] | null {
  for (const entry of PUBLIC_PREFIXES) {
    if (value.startsWith(entry[0])) return entry;
  }
  return null;
}

/**
 * Render a credential as something a human can recognise and nobody can use.
 *
 * `fallbackLabel` names the class when no public prefix is recognised — pass
 * the detecting rule's own label (e.g. "assigned secret", "database password")
 * so an unattributed finding still says what KIND of thing leaked.
 */
export function fingerprintSecret(value: string, fallbackLabel = "secret"): LeakFingerprint {
  const length = value.length;
  const matched = matchPublicPrefix(value);

  if (!matched) {
    // No minted prefix: this is a password, a first-party key, or a format we
    // do not recognise. Nothing but the class and the length is safe to print,
    // and the length is what lets the owner recognise their own value.
    return {
      display: `[${length}-char ${fallbackLabel}]`,
      label: fallbackLabel,
      length,
      attributed: false,
    };
  }

  const [prefix, label] = matched;
  const bodyLength = length - prefix.length;
  const run = MASK_CHAR.repeat(Math.max(1, Math.min(MAX_MASK_RUN, bodyLength)));

  // The tail is the actionable half — but only when what stays hidden is
  // genuinely unguessable. See the module header.
  if (length >= MIN_LEN_FOR_TAIL && bodyLength > TAIL_CHARS * 2) {
    return {
      display: `${prefix}${run}${value.slice(-TAIL_CHARS)}`,
      label,
      length,
      attributed: true,
    };
  }

  return { display: `${prefix}${run}`, label, length, attributed: true };
}

/**
 * A stable identity for one distinct credential, for deduping across scans.
 *
 * Salted with a per-machine secret so the digest cannot be used as a lookup
 * oracle: without the salt, an attacker holding a guessable candidate (and the
 * corpus is full of dictionary passwords) could confirm it by comparing
 * hashes. With it, the id is meaningful only on the machine that produced it.
 *
 * The salt therefore forecloses cross-machine dedupe until an org-scoped key
 * exists — a deliberate trade recorded here so nobody reads a per-machine salt
 * as an oversight.
 */
/**
 * Every id `fingerprintId` can produce, and nothing else.
 *
 * Ids become FILENAMES — one marker file per notified finding, one queue file
 * per pending macOS banner — so an id is a path component, and a path component
 * built from unvalidated input is a directory traversal. Measured: passing
 * `"../../../../tmp/PWNED"` to `markLeakNoticeDelivered` created that file.
 *
 * Ids are HMAC hex today, so nothing in a normal run can carry a `/`. That is
 * not the same as safe: the record is JSON read off disk, and `leaks.json` is a
 * file a user (or anything running as them) can edit. The guard is one regex
 * and it makes the property structural instead of incidental.
 */
export function isFindingId(id: string): boolean {
  return /^[0-9a-f]{16}$/.test(id);
}

export function fingerprintId(value: string, machineSalt: string): string {
  // Lazily required so this module stays importable in the browser bundle,
  // where the dashboard renders findings but never computes ids.
  const { createHmac } = require("node:crypto") as typeof import("node:crypto");
  return createHmac("sha256", machineSalt).update(value).digest("hex").slice(0, 16);
}
