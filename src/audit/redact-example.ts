/**
 * What an audit example looks like by the time it is allowed to leave the box.
 *
 * The audit keeps up to three 80-character examples per policy, and they are
 * slices of REAL commands and paths — `cat /home/sidd/work/acme/.env.production`,
 * `aws s3 rm s3://prod-bucket --recursive`. Naming what happened is the whole
 * value of the digest, and those strings are also the only thing in the report
 * that could carry something a person would mind sending.
 *
 * Two transforms, in this order, and the order matters:
 *
 *  1. **Secrets are masked**, against `SECRET_PATTERNS` — the same list the
 *     `sanitize-*` policies block on. One definition of "secret", used for both
 *     blocking and redacting, rather than a second pattern list beside it that
 *     eventually disagrees. A second pass then catches a secret that arrived
 *     ALREADY CUT: the audit truncates examples to 80 characters at capture
 *     time, so a command ending in a credential reaches this module with the
 *     credential's tail missing and the full pattern no longer matching. See
 *     `maskTruncatedSecret`.
 *  2. **Home paths are shortened**, so `/home/sidd/work/acme/src/db.ts` becomes
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
 */
const SECRET_PREFIXES: ReadonlyArray<readonly [RegExp, string]> = [
  [/(?:Authorization:\s*)?Bearer\s+\S*$/i, "bearer token"],
  [/sk-ant-\S*$/, "Anthropic API key"],
  [/sk-proj-\S*$/, "OpenAI project API key"],
  [/sk-\S*$/, "OpenAI API key"],
  [/ghp_\S*$/, "GitHub personal access token"],
  [/github_pat_\S*$/, "GitHub fine-grained token"],
  [/AKIA\S*$/, "AWS access key ID"],
  [/sk_live_\S*$/, "Stripe live secret key"],
  [/sk_test_\S*$/, "Stripe test secret key"],
  [/AIza\S*$/, "Google API key"],
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
  return input.replace(ABSOLUTE_PATH_RE, (match) => {
    // Kernel/device paths are the same on every machine and identify nobody.
    if (PUBLIC_PATH_ROOTS.some((root) => match.startsWith(root))) return match;
    const trailingSlash = match.endsWith("/");
    const segments = match.split("/").filter(Boolean);
    if (segments.length === 0) return match;
    const basename = segments[segments.length - 1];
    const kept = segments.slice(
      Math.max(0, segments.length - 1 - KEPT_PARENT_SEGMENTS),
      segments.length - 1,
    );
    const underHome = home.length > 0 && match.startsWith(home);
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
  const masked = maskTruncatedSecret(maskSecrets(input));
  const shortened = shortenPaths(masked, home);
  const collapsed = shortened.replace(/\s+/g, " ").trim();
  return collapsed.length > REDACTED_EXAMPLE_MAX_CHARS
    ? `${collapsed.slice(0, REDACTED_EXAMPLE_MAX_CHARS - 1)}…`
    : collapsed;
}
