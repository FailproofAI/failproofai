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
 * and send the base64 key body underneath it. The second alternative covers a
 * block whose footer was cut off by the envelope's length cap: it takes the
 * lines that follow the header while they still look like key material (base64
 * of 16+ characters, or an encrypted key's `Proc-Type:`-style header line),
 * separated by real or JSON-escaped newlines (`redactPemBlocks` adds a last
 * line shorter than that when it ends the text or meets the envelope's cut
 * marker: a block cut mid-line). A lone header in a command — a `grep` for
 * the armour line across `*.pem` — therefore takes nothing after it.
 * The body of a complete block is limited to what a PEM body contains, so a
 * header and a footer quoted separately in documentation do not take the
 * prose between them.
 *
 * "JSON-escaped" is one to four backslashes before the `n`: a block inside a
 * JSON string that was itself serialised again (a service-account file passed
 * as a string argument, then stringified by the envelope at depth 2) arrives as
 * `\\n`. The count is bounded so a run of backslashes cannot backtrack.
 */
const PEM_BLOCK_RE =
  /-----BEGIN[ A-Z0-9]*PRIVATE KEY(?: BLOCK)?-----(?:(?:[A-Za-z0-9+/=\s:,.-]|\\{1,4}[nrt])*?-----END[ A-Z0-9]*PRIVATE KEY(?: BLOCK)?-----|(?:(?:\s|\\{1,4}[nrt])+(?:[A-Za-z0-9+/=]{16,}|[A-Za-z-]+:[^\n\\]*))*)/g;
const PEM_COMPLETE_RE = /-----END[ A-Z0-9]*PRIVATE KEY(?: BLOCK)?-----$/;
/**
 * The short tail of a key line a cut split, right after a block that lost its
 * footer. Matched in code at the end of such a block: as an optional group at
 * the end of `PEM_BLOCK_RE` it cost that regex ~8x on every string.
 */
const PEM_CUT_FRAGMENT_RE = /(?:\s|\\{1,4}[nrt])+[A-Za-z0-9+/=]{1,15}(?=\s*(?:$|…\[))/y;

/** Every PEM private-key block, whole or cut short, as one marker each. */
function redactPemBlocks(text: string, counter: { n: number; found: string[] }): string {
  if (!text.includes("-----BEGIN")) return text;
  let out = "";
  let last = 0;
  PEM_BLOCK_RE.lastIndex = 0;
  for (let m = PEM_BLOCK_RE.exec(text); m !== null; m = PEM_BLOCK_RE.exec(text)) {
    let end = m.index + m[0].length;
    if (!PEM_COMPLETE_RE.test(m[0])) {
      PEM_CUT_FRAGMENT_RE.lastIndex = end;
      const f = PEM_CUT_FRAGMENT_RE.exec(text);
      if (f) end += f[0].length;
    }
    out += text.slice(last, m.index) + marker("private key");
    counter.n++;
    counter.found.push(text.slice(m.index, end));
    last = end;
    PEM_BLOCK_RE.lastIndex = end;
  }
  PEM_BLOCK_RE.lastIndex = 0;
  return last === 0 ? text : out + text.slice(last);
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

/** `scheme://user:password@host` on ANY scheme; the shared list covers databases only. */
const URL_CREDENTIALS_RE = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:"'<>]+):([^\s/@"'<>]+)@/gi;

/** `scheme://<token>@host`, the shape `git clone https://<token>@github.com/…` uses. */
const URL_TOKEN_USERINFO_RE = /\b([a-z][a-z0-9+.-]*:\/\/)([A-Za-z0-9_.~-]{20,})@/gi;

/** `curl -u user:pass`, both spellings and both separators. */
const BASIC_AUTH_FLAG_RE =
  /(\b(?:curl|wget|http|https|xh|httpie)\b[^\n;&|]*?\s(?:-u|--user|--proxy-user)(?:[ \t]+|=)["']?)([^\s:"']+):([^\s"']+)/g;

/**
 * `Authorization: <scheme> <credentials>` in a header, JSON or YAML. Whatever
 * follows a scheme in that header IS the credential, whatever it looks like —
 * the shared rule wants 20+ characters, and a dev stack's `Bearer
 * dev-admin-key` is 13 of them. With no scheme the value must look like a token,
 * so `authorization: required` in prose is left alone.
 */
const AUTHORIZATION_RE =
  /\b((?:proxy-)?authorization\\?["']?[ \t]*[:=][ \t]*\\?["']?[ \t]*)((?:bearer|basic|token|bot|apikey|sso-key|ssws|digest|negotiate)[ \t]+)?([A-Za-z0-9\-._~+/=:]{6,})/gi;

/**
 * A Bearer credential with no `Authorization` in front of it — `"Bearer …"` as a
 * value in a script or a config. Must look like a token, because "bearer" is also
 * an English word ("the bearer authentication scheme").
 */
const BEARER_RE = /\b(bearer[ \t]+)([A-Za-z0-9\-._~+/=]{8,})/gi;

/**
 * Credentials passed positionally to tools that take them that way. A name-based
 * rule cannot see these because the name is a subcommand, not an identifier.
 */
const CLI_RULES: ReadonlyArray<RegExp> = [
  // mysql -pSECRET (glued; a bare -p prompts)
  /(\b(?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump)\b[^\n;&|]*?\s-p)("[^"\n]*"|'[^'\n]*'|[^\s"';&|]+)/g,
  // sshpass -p SECRET
  /(\bsshpass\b(?:[ \t]+-[A-Za-z]+)*?[ \t]+-p[ \t]*)("[^"\n]*"|'[^'\n]*'|[^\s"';&|]+)/g,
  // redis-cli -a SECRET
  /(\bredis-cli\b[^\n;&|]*?\s-a[ \t]+)("[^"\n]*"|'[^'\n]*'|[^\s"';&|]+)/g,
  // docker / podman / helm / oras … login -p SECRET
  /(\b(?:docker|podman|helm(?:[ \t]+registry)?|oras|skopeo|buildah|nerdctl)[ \t]+login\b[^\n;&|]*?\s(?:-p|--password)(?:[ \t]+|=))("[^"\n]*"|'[^'\n]*'|[^\s"';&|]+)/g,
  // gh secret set NAME --body SECRET
  /(\bgh[ \t]+secret[ \t]+set\b[^\n;&|]*?\s(?:--body|-b)(?:[ \t]+|=))("[^"\n]*"|'[^'\n]*'|[^\s"';&|]+)/g,
];

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

/** True for a string that could be a literal value rather than a reference, a path or a keyword. */
function isLiteral(value: string): boolean {
  if (!value) return false;
  if (/^[$`{(<[%]/.test(value)) return false; // $VAR, ${VAR}, `cmd`, {expr}, (expr), <placeholder>, [list], %VAR%
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

/** Header names whose value IS a credential, whatever it looks like. */
const AUTHORIZATION_FIELD_RE = /^(?:x-|proxy-)?authorization$/i;
/**
 * The scheme words `AUTHORIZATION_RE` keeps in front of a redacted credential,
 * as a whole-word test. The two lists are the same list on purpose: a word
 * outside it is not known to be a scheme, and the first word of an
 * `Authorization` value is then as likely to BE the credential as the rest is.
 */
const AUTH_SCHEME_WORDS = /^(?:bearer|basic|token|bot|apikey|sso-key|ssws|digest|negotiate)$/i;

/**
 * The value of an `Authorization` field in structured input — `{"headers":
 * {"Authorization": "Basic …"}}` from an HTTP-calling MCP tool. The text rules
 * only see such a value when the word `authorization` sits in the same string,
 * and a name-based rule cannot tell the scheme from the credential. Whatever
 * follows a KNOWN scheme is the credential, and with no scheme the whole value
 * is. A known scheme is kept, because which kind of credential it was is
 * context Jev can use.
 *
 * Only a word from `AUTH_SCHEME_WORDS` is kept. Anything else in that position
 * is sent whole to the marker, because the first word of the value is as likely
 * to be the credential as the rest: a `{"Authorization": "<gateway key>
 * signature=…"}` field used to keep its 25-character `sk-` key verbatim as a
 * "scheme" — the one shape this redactor exists for — while the envelope
 * reported a redaction. The value returned here never goes through
 * `redactSecrets`, so whatever it keeps is sent as it stands.
 *
 * Returns the redacted value and the credential it removed, or null when the
 * field is not an authorization header or its value is a reference
 * (`Bearer ${TOKEN}`, `Bearer <token>`) or a bare scheme word. Null also for
 * prose under the name (`{"authorization": "required for this endpoint"}`):
 * an unknown first word that does not even look like a token is a word, and
 * the caller redacts the string with the text rules instead.
 */
export function redactAuthorizationField(name: string, value: string): { text: string; secret: string } | null {
  if (!AUTHORIZATION_FIELD_RE.test(name.trim())) return null;
  const v = value.trim();
  const schemed = /^(\S+)[ \t]+(\S[\s\S]*)$/.exec(v);
  if (schemed) {
    const [, first, rest] = schemed;
    if (AUTH_SCHEME_WORDS.test(first)) {
      if (!isLiteral(rest)) return null;
      return { text: `${first} ${marker(/^bearer$/i.test(first) ? "bearer token" : "authorization header")}`, secret: rest };
    }
    if (!isLiteral(v) || !tokenLike(first)) return null;
    return { text: marker("authorization header"), secret: v };
  }
  if (!isLiteral(v) || AUTH_SCHEME_WORDS.test(v)) return null;
  return { text: marker("authorization header"), secret: v };
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

/** The part of `match` a replacement removed: what lies between their common prefix and suffix. */
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
  out = replaceCounting(out, URL_CREDENTIALS_RE, (_m, g) => (isLiteral(g[2]) ? `${g[0]}${g[1]}:${marker("URL credentials")}@` : null), c);
  out = replaceCounting(out, URL_TOKEN_USERINFO_RE, (_m, g) => (tokenLike(g[1]) ? `${g[0]}${marker("URL credentials")}@` : null), c);
  out = replaceCounting(out, BASIC_AUTH_FLAG_RE, (_m, g) => (isLiteral(g[2]) ? `${g[0]}${g[1]}:${marker("basic auth")}` : null), c);
  out = replaceCounting(
    out,
    AUTHORIZATION_RE,
    (_m, g) => {
      if (!isLiteral(g[2])) return null;
      // No scheme: the value must look like a token, and must not BE a scheme
      // word — `Authorization: Bearer $TOKEN` would otherwise lose "Bearer".
      if (!g[1] && (!tokenLike(g[2]) || /^(?:bearer|basic|token|bot|apikey|digest|negotiate)$/i.test(g[2]))) return null;
      return `${g[0]}${g[1]}${marker(/^bearer/i.test(g[1]) ? "bearer token" : "authorization header")}`;
    },
    c,
  );
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

  // 6. Credentials passed positionally to tools that take them that way.
  for (const re of CLI_RULES) {
    out = replaceCounting(out, re, (_m, g) => (isLiteral(g[1].replace(/^["']/, "")) ? `${g[0]}${marker("credential argument")}` : null), c);
  }
  out = replaceCounting(
    out,
    CONFIG_SET_RE,
    (_m, g) => {
      const value = g[3].replace(/^(["'])(.*)\1$/, "$2");
      return assignmentValueIsSecret(g[1], value, { quoted: false, spaced: false, urlQuery: false, flag: true })
        ? `${g[0]}${g[1]}${g[2]}${marker("assigned secret")}`
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
