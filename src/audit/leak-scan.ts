/**
 * Pulling credential VALUES out of a tool event.
 *
 * The audit already replays every event through the policy engine, but
 * `ReplayHit` carries `{policyName, decision, reason}` and no matched text —
 * the engine answers "did a rule fire", not "on what". That is the right answer
 * for enforcement and the wrong one for a leak report, which has to say *which*
 * key, so this walks the event itself.
 *
 * Running beside the replay rather than inside it is also what the pattern
 * census concluded independently: detection wants a vocabulary tuned for
 * PRECISION (a false positive becomes an email to a customer about a key that
 * never leaked), while the redactor's vocabulary is tuned for RECALL (a false
 * positive costs a few characters in a digest). Sharing one list would drag one
 * of them to the other's error costs — measured, importing the detector's names
 * into the redactor stopped 305 of 646 currently-masked names from being masked.
 *
 * ## Where it looks, and why both directions matter
 *
 * Tool INPUT and tool RESULT are separate exposures with separate remedies. An
 * input is what the agent SENT — deniable at PreToolUse on all 12 CLIs, and
 * 39.5% of measured credential appearances live there. A result is what the
 * agent RECEIVED, blockable on 2 of 12 and only after the fact. The record keeps
 * them apart so the report can tell a user which of the two happened.
 */
import { SECRET_PATTERNS } from "../hooks/builtin-policies";
import { secretNameStrength } from "./redact-example";

/** One credential value found in one event. */
export interface SecretMatch {
  /** The raw value. Held in memory only — the caller fingerprints it and must
   *  never persist or transmit this. */
  value: string;
  /** The identifier it was assigned to, when it came from an assignment. For
   *  the first-party class (230 of 237 secret-named assignments match no vendor
   *  pattern) this is the only actionable label there is. */
  name: string | null;
  /** Which rule found it — a vendor label, or "assigned secret". */
  rule: string;
  /** Whether the value carried a recognised vendor shape. Drives the record's
   *  confidence, and therefore whether an alert may name a console. */
  shaped: boolean;
}

/**
 * `NAME=value` in its four real spellings.
 *
 * Kept in step with `redact-example.ts`'s ASSIGNMENT_RE — same four shapes, same
 * scheme guard — because a value the DETECTOR can report but the REDACTOR
 * cannot mask is a leak in the report itself. The redactor may be broader; it
 * must never be narrower. `__tests__/audit/leak-scan.test.ts` asserts that
 * direction explicitly.
 */
/**
 * The identifier is BOUNDED, and the bound is load-bearing rather than tidy.
 *
 * Unbounded (`[A-Za-z0-9_]*`), this is quadratic on a long unbroken token: the
 * engine starts at every one of n positions, consumes the whole run, then
 * backtracks a character at a time looking for the `=` or `:` that never comes.
 * Measured on a plain 300 KB base64 blob — `"A".repeat(300000)` — it ran for
 * over 20 SECONDS on one string. That is not an exotic input: agent transcripts
 * carry base64 images, minified bundles and whole file contents as single
 * lines, and the audit reads every one of them. A scheduled scan hitting a few
 * of these would stall for minutes with nobody watching.
 *
 * 128 characters is far past any real environment-variable or field name, so
 * bounding it costs nothing that exists and makes the scan linear in n.
 */
const ASSIGNMENT_RE =
  /(["']?)\b([A-Za-z_][A-Za-z0-9_]{0,127})\1([ \t]*(?::(?!\/\/)|=)[ \t]*)("[^"]*"|'[^']*'|[^\s;|&"']+)/g;

/** Shortest value worth reporting. Below this it is a flag, a boolean or a
 *  placeholder far more often than a credential. */
const MIN_VALUE_LEN = 8;

/**
 * Values that are structurally incapable of being a leaked credential.
 *
 * Deliberately structural, never entropy: the corpus's one confirmed-live
 * password measures 3.19 bits per character while 1.3 million UUIDs in the same
 * corpus sit at 3.72, so any entropy threshold that catches the password also
 * catches every UUID. These tests are decisive instead — a `$VAR` reference
 * contains no secret by construction, and `process.env.X` is the CORRECT secure
 * form, which the redactor currently flags 7,870 times.
 */
/**
 * Does this VALUE plausibly hold a credential, given how sure the NAME is?
 *
 * The name layer exists for first-party secrets with no recognisable format, so
 * it cannot lean on shape the way the vendor layer does. But leaning on the
 * name ALONE produced 394 findings on one real machine, of which 389 carried no
 * vendor prefix and 227 were under 24 characters — `keyType`,
 * `tokenLimitCancelled`, `max_output_tokens`, `resultKey`, `configDirKey`.
 * Ordinary programming vocabulary, holding ordinary programming values.
 *
 * So the bar depends on how much the name is really claiming:
 *
 *   strong — `DB_PASSWORD`, `STRIPE_SECRET`, `API_KEY`, `PRIVATE_KEY`. The word
 *            means credential and nothing else, so the value gets the benefit of
 *            the doubt: `hunter2` under `PASSWORD` is a leaked password and
 *            length is no argument against it.
 *   weak   — `key`, `token`, `auth`, `sig`, `cookie`. Also normal English and
 *            normal code. The value has to carry the claim instead.
 *
 * The weak bar is deliberately close to what real keys look like: at least 24
 * characters (the shortest common vendor key is 32; nothing at 8-15 is an API
 * key) and more than one character class, because a lone lowercase word —
 * `primary`, `cancelled`, `standard` — is a config value, not a secret.
 *
 * A real vendor key that happens to sit under a weak name is unaffected: the
 * SHAPE layer matches it on format, whatever it is called.
 */
const WEAK_NAME_MIN_LEN = 24;

function looksLikeSecretValue(value: string): boolean {
  if (value.length < WEAK_NAME_MIN_LEN) return false;
  const classes =
    Number(/[a-z]/.test(value)) + Number(/[A-Z]/.test(value)) + Number(/[0-9]/.test(value));
  // One class only — an all-lowercase or all-numeric run — reads as prose, an
  // enum, or an id, not as something minted to be unguessable.
  if (classes < 2) return false;
  // A dotted or dashed sentence of words (`some-long-feature-flag-name`) has the
  // length and can have mixed case, but no run of unbroken entropy anywhere.
  const longestRun = Math.max(0, ...value.split(/[^A-Za-z0-9]+/).map((p) => p.length));
  if (longestRun < 12) return false;
  // camelCase clears "two character classes" and "one long run" on letters
  // alone — `someLongCamelCaseFieldName` is 26 characters of it. Minted keys
  // almost always carry digits; the ones that do not are long. Requiring one or
  // the other is what separates an identifier from a secret.
  return /[0-9]/.test(value) || value.length >= 32;
}

function isNotACredential(value: string): boolean {
  if (value.length < MIN_VALUE_LEN) return true;
  // Shell/template indirection: the value is a reference, not a secret.
  if (/^[$<{(`%]/.test(value)) return true;
  if (value.includes("${") || value.includes("{{") || value.includes("%(")) return true;
  // A code expression — `process.env.DISCORD_TOKEN` is how you SHOULD do it.
  if (/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/.test(value)) return true;
  // Already masked, by us or by anyone else.
  if (value.includes("[REDACTED") || /^[•*#.]+$/.test(value)) return true;
  if (/(.)\1{5,}/.test(value)) return true;          // xxxxxxxx, 00000000
  if (/^(true|false|null|undefined|none)$/i.test(value)) return true;
  if (/^-?\d+(\.\d+)?$/.test(value)) return true;    // pure number
  if (/^\/|^~\/|^\.\.?\//.test(value)) return true;  // a path
  // A UUID is an identifier, never a credential — and it is the dominant shape
  // of the `session_id` / `request_id` values that the name layer used to flag.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return true;
  return false;
}

/** Strip one layer of surrounding quotes. */
function unquote(v: string): string {
  return (v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))
    ? v.slice(1, -1)
    : v;
}

/**
 * SHA-256 of credentials the vendors themselves publish in their documentation.
 *
 * The single highest-value refuter in the whole detector, and the only one that
 * is decisive rather than heuristic. Measured on the real corpus: **456 of 457
 * `AKIA` matches were AWS's own documentation literal** — 99.8% of that
 * pattern's entire output, and 232 findings collapsing to zero. Across the
 * pattern census, 44 of 113 patterns with five or more hits were at least 85%
 * one literal, and 30 fired on nothing else at all.
 *
 * Stored as hashes so this file does not itself contain the values — a
 * denylist written in plaintext is a file our own scanner flags, and one that
 * lands in the corpus of every machine that installs us.
 *
 * A hash comparison cannot false-positive: either the value is byte-identical
 * to a published sample or it is not. That is what makes this worth more than
 * any amount of pattern tuning.
 */
const DOCS_LITERALS = new Set([
  "1a5d44a2dca19669d72edf4c4f1c27c4c1ca4b4408fbb17f6ce4ad452d78ddb3", // AWS access key ID
  "78314b11be2e581549ac1c4f616563fad3fdf0c3b71678f6e2299182080e0598", // AWS secret access key
  "cb20d34a7adda2f5d2043836051e242fd4c2b233e02c80c91fe9d5af9b100574", // AWS temporary key ID
  "3543c50b0cb9cea8e55eb1f529b79f043cb250d485fde7b66cabbb5183add7da", // GitHub PAT sample
  "1fae28c1b317300acfd90078c973567c8159015822b0c8b81508a5ec40517d20", // Google API key sample
  "23219833092a3136d7ad178ccb62ebd6ac8cba54ff24c2cfcd37b84aba9e95cf", // SendGrid key sample
  "872db7f4419592e397ef45230f910e06b48c36ed9970cf1f9e4fb896e69f129c", // Slack bot token sample
  "78a08441f4314f0a2833cfe58c62e555a162264206982cda39f6804f5048f570", // Stripe live key sample
  "2cafc0970149a84f3b9e62eaf169f36f59907a3b3e31f7b82e68c69cd27f7326", // Stripe test key sample
  "b363ade84d56c43bebbc9339b4971e340e3f13f7f8d45580b53373d2763e9e33", // Twilio account SID sample
]);

/** True when the value is a credential a vendor published on purpose. */
export function isDocsLiteral(value: string): boolean {
  // Required lazily so this module stays importable from the browser bundle.
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  return DOCS_LITERALS.has(createHash("sha256").update(value).digest("hex"));
}

/**
 * Text that is failproofai's OWN output being replayed back at us.
 *
 * Auditing for secrets writes secrets into the corpus the next audit reads.
 * That is measured, not theoretical: the single largest organic cluster in
 * 1.6 GB of transcripts was one file — a previous secret-audit run quoting back
 * the credentials it had found (123 Atlassian tokens, 26 Telegram, 25 Slack,
 * 18 GitHub) — and 108 of the 161 patterns that matched anything matched ONLY
 * inside the investigation's own transcripts.
 *
 * Left unhandled the count climbs every scan, each report inflating the next.
 * These markers appear in our own rendered output and essentially nowhere else.
 */
const SELF_OUTPUT_MARKERS = [
  "[REDACTED:",
  "[redacted:",
  "failproofai audit",
  "assigned secret]",
];

/** True when this text is our own report, not a transcript of real work. */
export function isSelfOutput(text: string): boolean {
  return SELF_OUTPUT_MARKERS.some((m) => text.includes(m));
}

/**
 * Literal prefixes that must appear before any vendor regex is worth running.
 *
 * A prefilter, and it is not an optimisation — it is what makes the pattern set
 * shippable at all. The census measured the cost as LINEAR in pattern count:
 * ~0.095s per pattern per 6 MB, so 288 patterns over a 1.6 GB corpus is roughly
 * two hours, while the handful that ever match take five seconds. Scanning is
 * already the audit's slowest phase and the whole point of adding vendors is
 * that most of them never fire on any given machine.
 *
 * So: one cheap pass over the text asking "does any prefix appear at all", and
 * the regexes only run when one does. Derived from `SECRET_PATTERNS` at module
 * load rather than hand-maintained, because a hand-copied list that drifts from
 * its source silently stops matching — the exact failure class this repo already
 * has a tripwire test for elsewhere.
 *
 * Patterns with no literal prefix (a bare JWT, a connection string, the Telegram
 * `\d{8,10}:` shape) yield no gate token and are always run; they are few, and
 * a pattern that cannot be prefiltered is one whose cost has to be paid.
 */
function literalPrefixOf(source: string): string | null {
  // Walk the regex source until the first construct that is not a plain
  // literal. Anything before that is text the input must contain verbatim.
  let out = "";
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") {
      // An escape: only a handful are literal characters we can rely on.
      const next = source[i + 1];
      if (next === undefined) break;
      if (/[dwsSDWbB]/.test(next)) break; // a class, not a literal
      out += next;
      i++;
      continue;
    }
    if ("[](){}|?*+^$.".includes(c)) break;
    out += c;
  }
  // Two characters is the shortest gate worth having: shorter than that and the
  // prefilter matches nearly every input and buys nothing.
  return out.length >= 2 ? out : null;
}

/** Built once. Each entry is `[pattern, label, gate]`; a null gate always runs. */
const GATED_PATTERNS: ReadonlyArray<readonly [RegExp, string, string | null]> =
  SECRET_PATTERNS.map(([re, label]) => [re, label, literalPrefixOf(re.source)] as const);

/** Patterns worth running against this text. */
function applicablePatterns(text: string): ReadonlyArray<readonly [RegExp, string, string | null]> {
  return GATED_PATTERNS.filter(([, , gate]) => gate === null || text.includes(gate));
}

/**
 * Every credential value in one blob of text.
 *
 * Vendor SHAPES first, then secret-NAMED assignments, deduped by value so one
 * key matched by both layers is reported once — under its vendor label, which
 * is the one that can carry a revocation link. The two layers are near-disjoint
 * in practice: 55.9% of real vendor-shaped credentials in the corpus have no
 * secret-ish word within 60 characters, and 230 of 237 secret-named assignments
 * match no vendor pattern at all.
 *
 * Both refuters run before anything is reported: our own replayed output is
 * dropped whole, and every published documentation sample is dropped by hash.
 */
export function findSecrets(text: string): SecretMatch[] {
  if (!text) return [];
  // Our own report replayed into a transcript is not a leak — see isSelfOutput.
  if (isSelfOutput(text)) return [];
  const byValue = new Map<string, SecretMatch>();

  for (const [pattern, label] of applicablePatterns(text)) {
    const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
    for (const m of text.matchAll(re)) {
      const value = m[0];
      if (isDocsLiteral(value)) continue;
      if (!byValue.has(value)) byValue.set(value, { value, name: null, rule: label, shaped: true });
    }
  }

  for (const m of text.matchAll(ASSIGNMENT_RE)) {
    const name = m[2];
    const value = unquote(m[4]);
    const strength = secretNameStrength(name);
    if (strength === "none" || isNotACredential(value) || isDocsLiteral(value)) continue;
    // A weak name has to be backed by a value that looks minted. See
    // `looksLikeSecretValue` for what that buys and what it costs.
    if (strength === "weak" && !looksLikeSecretValue(value)) continue;
    const existing = byValue.get(value);
    if (existing) {
      // A vendor-shaped value that also has a name: keep the vendor rule (it
      // can name a console) and gain the name (it says which of the user's
      // variables to change).
      existing.name ??= name;
      continue;
    }
    byValue.set(value, { value, name, rule: "assigned secret", shaped: false });
  }

  return [...byValue.values()];
}

/**
 * Serialize a tool input for scanning.
 *
 * Every string leaf, not just `command`: the measured surface includes file
 * bodies on Write, replacement text on Edit, headers on WebFetch and arbitrary
 * MCP payloads. `JSON.stringify` would work but escapes quotes, which breaks
 * the assignment grammar on exactly the JSON-config shape that carries most
 * first-party keys — so the leaves are joined raw.
 */
export function flattenToolInput(input: unknown, depth = 0): string {
  if (depth > 6 || input == null) return "";
  if (typeof input === "string") return input;
  if (typeof input === "number" || typeof input === "boolean") return String(input);
  if (Array.isArray(input)) return input.map((v) => flattenToolInput(v, depth + 1)).join("\n");
  if (typeof input === "object") {
    return Object.entries(input as Record<string, unknown>)
      // Keep the key adjacent to the value so `{"api_key": "…"}` still reads as
      // an assignment to the grammar above.
      .map(([k, v]) => `${k}=${flattenToolInput(v, depth + 1)}`)
      .join("\n");
  }
  return "";
}
