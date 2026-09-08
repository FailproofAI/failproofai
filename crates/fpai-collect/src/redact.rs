//! Deterministic scrubbing of credentials before an event leaves the machine.
//!
//! # Determinism is the binding constraint
//!
//! The server dedups on a content hash, so the same input must always produce
//! the same bytes. That rules out anything sampled, time-dependent, or
//! model-driven — an LLM pass here would make a re-read of the same source
//! bytes hash differently and defeat dedup entirely. What is left is a fixed
//! pattern set, which is exactly what this is.
//!
//! # This is a floor, not a guarantee
//!
//! It catches the common accident: a key pasted into a terminal, a token in an
//! environment assignment, a bearer header in a captured request. It does not
//! catch a secret that looks like ordinary prose, and it is not a substitute
//! for not collecting sessions you would rather not send. The module says so
//! plainly because the config option is called `minimal` and users will
//! reasonably ask what it covers.
//!
//! # Redaction is visible
//!
//! Every match is replaced with a marker naming the pattern that fired, rather
//! than being silently dropped. A reader looking at a truncated command should
//! be able to tell that something was removed and why.

use serde_json::Value;

use crate::config::Redact;

/// Characters that can appear inside an opaque token.
fn is_token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

/// A token must not be preceded by another token character, or `sk-` would
/// match inside `risk-averse` and `ri` would be left dangling in the output.
fn at_boundary(bytes: &[u8], start: usize) -> bool {
    if start == 0 {
        return true;
    }
    let prev = bytes[start - 1] as char;
    !is_token_char(prev)
}

/// A literal-prefixed opaque token: `<prefix><token chars>`.
struct PrefixRule {
    prefix: &'static str,
    /// Token characters required after the prefix before this counts as a
    /// secret. Keeps ordinary hyphenated words from matching.
    min_len: usize,
    label: &'static str,
}

/// Order matters: longer, more specific prefixes are tried first so
/// `sk-ant-...` is labelled as an Anthropic key rather than a generic one.
const PREFIX_RULES: &[PrefixRule] = &[
    PrefixRule {
        prefix: "sk-ant-api",
        min_len: 16,
        label: "anthropic-key",
    },
    PrefixRule {
        prefix: "sk-ant-",
        min_len: 16,
        label: "anthropic-key",
    },
    PrefixRule {
        prefix: "sk-proj-",
        min_len: 16,
        label: "openai-key",
    },
    PrefixRule {
        prefix: "sk-",
        min_len: 16,
        label: "api-key",
    },
    PrefixRule {
        prefix: "ghp_",
        min_len: 20,
        label: "github-token",
    },
    PrefixRule {
        prefix: "gho_",
        min_len: 20,
        label: "github-token",
    },
    PrefixRule {
        prefix: "ghu_",
        min_len: 20,
        label: "github-token",
    },
    PrefixRule {
        prefix: "ghs_",
        min_len: 20,
        label: "github-token",
    },
    PrefixRule {
        prefix: "ghr_",
        min_len: 20,
        label: "github-token",
    },
    PrefixRule {
        prefix: "github_pat_",
        min_len: 20,
        label: "github-token",
    },
    PrefixRule {
        prefix: "sb_secret_",
        min_len: 16,
        label: "supabase-key",
    },
    PrefixRule {
        prefix: "sbp_",
        min_len: 20,
        label: "supabase-key",
    },
    PrefixRule {
        prefix: "xoxb-",
        min_len: 16,
        label: "slack-token",
    },
    PrefixRule {
        prefix: "xoxp-",
        min_len: 16,
        label: "slack-token",
    },
    PrefixRule {
        prefix: "AKIA",
        min_len: 16,
        label: "aws-access-key-id",
    },
    PrefixRule {
        prefix: "ASIA",
        min_len: 16,
        label: "aws-access-key-id",
    },
];

/// Assignment names whose value is treated as secret.
///
/// Matched case-insensitively as a suffix of the identifier, so `API_KEY`,
/// `OPENAI_API_KEY` and `--api-key` all hit `key`. Deliberately narrow:
/// widening it to anything like `NAME` or `ID` would redact most of a command
/// line and make the capture useless.
/// Names strong enough to redact on their own, even as a bare identifier.
const STRONG_SECRET_NAMES: &[&str] = &["secret", "password", "passwd", "passphrase", "credential"];
/// Names that are only convincing as part of a COMPOUND identifier.
///
/// `key` and `token` are ordinary words in source code — measured against 40
/// real transcripts, a bare `key=` matched React's `key` prop on every JSX
/// list. Requiring a `_`, a `-` or a camelCase hump keeps `API_KEY`, `api_key`,
/// `--api-token` and `sessionKey` while dropping that entire class of false
/// positive.
///
/// `pwd` is here rather than in STRONG for the same reason: `MYSQL_PWD` is a
/// documented password variable, and a bare `PWD` is the working directory.
const WEAK_SECRET_NAMES: &[&str] = &["key", "token", "pwd"];

/// Shortest assignment value worth redacting. Below this it is far more likely
/// to be a placeholder or a flag than a credential.
const MIN_ASSIGNMENT_VALUE: usize = 12;

/// Scrub every string leaf of an event in place.
///
/// Returns the number of replacements, so a caller can log that redaction
/// actually did something without logging what it removed.
pub fn scrub_value(v: &mut Value, mode: Redact) -> usize {
    if mode == Redact::Off {
        return 0;
    }
    let mut n = 0;
    scrub_in_place(v, &mut n);
    n
}

fn scrub_in_place(v: &mut Value, n: &mut usize) {
    match v {
        Value::String(s) => {
            if let Some(replaced) = scrub_str(s) {
                *n += replaced.1;
                *s = replaced.0;
            }
        }
        Value::Array(a) => a.iter_mut().for_each(|e| scrub_in_place(e, n)),
        Value::Object(o) => o.values_mut().for_each(|e| scrub_in_place(e, n)),
        _ => {}
    }
}

/// Scrub one string. `None` when nothing matched, so an unchanged string is
/// never reallocated.
pub fn scrub_str(s: &str) -> Option<(String, usize)> {
    let bytes = s.as_bytes();
    let mut out = String::new();
    let mut i = 0usize;
    let mut hits = 0usize;

    while i < s.len() {
        if !s.is_char_boundary(i) {
            i += 1;
            continue;
        }
        let rest = &s[i..];

        if let Some((len, label)) = match_prefix_rule(bytes, i, rest)
            .or_else(|| match_jwt(bytes, i, rest))
            .or_else(|| match_bearer(rest))
            .or_else(|| match_assignment(s, i, rest))
        {
            if hits == 0 {
                out.push_str(&s[..i]);
            }
            out.push_str(&format!("[redacted:{label}]"));
            hits += 1;
            i += len;
            continue;
        }

        if hits > 0 {
            out.push_str(&rest[..rest.chars().next().map(char::len_utf8).unwrap_or(1)]);
        }
        i += rest.chars().next().map(char::len_utf8).unwrap_or(1);
    }

    (hits > 0).then_some((out, hits))
}

fn match_prefix_rule(bytes: &[u8], i: usize, rest: &str) -> Option<(usize, &'static str)> {
    if !at_boundary(bytes, i) {
        return None;
    }
    for rule in PREFIX_RULES {
        let Some(after) = rest.strip_prefix(rule.prefix) else {
            continue;
        };
        let token_len = after.chars().take_while(|c| is_token_char(*c)).count();
        if token_len >= rule.min_len {
            return Some((rule.prefix.len() + token_len, rule.label));
        }
    }
    None
}

/// A JWT: three dot-separated base64url segments starting `eyJ`.
///
/// Matched structurally rather than by prefix alone, because `eyJ` on its own
/// is just base64 for `{"` and appears in plenty of non-secret payloads.
fn match_jwt(bytes: &[u8], i: usize, rest: &str) -> Option<(usize, &'static str)> {
    if !at_boundary(bytes, i) || !rest.starts_with("eyJ") {
        return None;
    }
    let is_b64 = |c: char| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '=';

    let mut len = 0usize;
    let mut segments = 0usize;
    let mut cursor = rest;
    loop {
        let seg = cursor.chars().take_while(|c| is_b64(*c)).count();
        if seg == 0 {
            break;
        }
        len += seg;
        segments += 1;
        cursor = &cursor[seg..];
        if segments == 3 {
            break;
        }
        if cursor.starts_with('.') {
            len += 1;
            cursor = &cursor[1..];
        } else {
            break;
        }
    }
    // Three segments and a plausible total length. A two-segment match is far
    // more likely to be ordinary base64 than a token.
    (segments == 3 && len >= 40).then_some((len, "jwt"))
}

/// `Bearer <token>` from an Authorization header.
///
/// Length is summed in BYTES, not characters. `scrub_str` uses what these
/// matchers return as a byte offset (`i += len`), and unlike `is_token_char`
/// and the JWT matcher's `is_b64` — both ASCII-only, so a char count and a byte
/// count coincide — this predicate accepts any non-whitespace character. One
/// multi-byte character in a token therefore made the returned length SHORTER
/// than the text it covered, so the cursor landed back inside the secret and
/// the unconsumed tail was copied to the output verbatim. Every test passed,
/// because every test token was ASCII.
fn match_bearer(rest: &str) -> Option<(usize, &'static str)> {
    let lower = rest.get(..7)?.to_ascii_lowercase();
    if lower != "bearer " {
        return None;
    }
    let after = &rest[7..];
    let token_len: usize = after
        .chars()
        .take_while(|c| !c.is_whitespace() && *c != '"' && *c != '\'')
        .map(char::len_utf8)
        .sum();
    (token_len >= 8).then_some((7 + token_len, "bearer-token"))
}

/// Prefixes whose values a build tool INLINES INTO THE BROWSER BUNDLE.
///
/// Not conventionally public — mechanically public. Next.js, Vite, CRA, Expo,
/// Nuxt, Gatsby, SvelteKit and Astro each substitute the value into the
/// JavaScript shipped to every visitor, so a key named this way was published
/// by the framework before this collector ever saw it.
const CLIENT_BUNDLE_PREFIXES: &[&str] = &[
    "next_public",
    "vite",
    "react_app",
    "expo_public",
    "nuxt_public",
    "gatsby",
    "storybook",
    "public",
];

/// True when the identifier says the value is meant to be public.
///
/// Every publishable key on earth is named `*_key`, and `WEAK_SECRET_NAMES`
/// matches all of them — so `NEXT_PUBLIC_POSTHOG_KEY` and
/// `NEXT_PUBLIC_SUPABASE_ANON_KEY` were scrubbed as credentials on their way to
/// the spool. Redaction usually errs safe, but this is the case where the value
/// is PROVABLY not a secret, and marking it as one reports an exposure that did
/// not happen.
///
/// The marker must be a PREFIX, so a mid-name `public` in
/// `my_public_facing_secret` does not disarm the rule, and `publisher_api_key`
/// (which merely starts with the same letters) is unaffected.
fn is_published_by_design(name: &str) -> bool {
    for prefix in CLIENT_BUNDLE_PREFIXES {
        if name == *prefix || name.starts_with(&format!("{prefix}_")) {
            return true;
        }
    }
    name.contains("publishable") || name.ends_with("public_key") || name.ends_with("anon_key")
}

/// Split the text before a value into `(name, separator)`.
///
/// Four spellings reach this collector and only the first used to match:
/// `NAME=value`, `NAME = value`, `NAME: value` and `"name": value`. The other
/// three are what a config file, a YAML key and a JSON body look like — most of
/// where credentials are actually written down — and every one of them was
/// leaving the machine in the spool, because this redactor required the `=` to
/// sit immediately before the value.
///
/// Horizontal whitespace only. `char::is_whitespace` would step back over a
/// newline and read the previous line's last word as this line's name.
fn split_assignment(before: &str) -> Option<(&str, char)> {
    let trimmed = before.trim_end_matches([' ', '\t']);
    let separator = trimmed.chars().next_back()?;
    if separator != '=' && separator != ':' {
        return None;
    }
    let name = trimmed[..trimmed.len() - separator.len_utf8()].trim_end_matches([' ', '\t']);
    // A JSON key carries its own closing quote (`"api_key": …`), which is not
    // part of the identifier and would otherwise end the backwards name scan
    // before it read a single character.
    Some((name.strip_suffix(['"', '\'']).unwrap_or(name), separator))
}

/// The VALUE of a `SOMETHING_KEY=` / `--api-token=` assignment.
///
/// Anchored at the start of the value rather than at the `=`, so the marker
/// replaces only the secret and the assignment still reads as one:
/// `API_KEY=[redacted:secret-assignment]`, not `API_KEY[redacted:...]`.
///
/// Looks BACKWARDS at the identifier, so it works for env assignments, CLI
/// flags and `key=value` pairs alike, and steps back over one opening quote so
/// the quoting survives intact.
fn match_assignment(s: &str, i: usize, rest: &str) -> Option<(usize, &'static str)> {
    if i == 0 {
        return None;
    }
    let before = &s[..i];
    // The cursor is ON the opening quote, so the value starts one character
    // later. Decline here and let the left-to-right scan match at the value
    // itself on its next step.
    //
    // Matching here is what broke quoted assignments. `scrub_str` walks
    // forward, so this position is reached FIRST, and from it `quoted` (which
    // looks at the character before the cursor) sees the `=` rather than the
    // quote and reads false. The unquoted stop-set then ran past the closing
    // quote and swallowed whatever was glued to it:
    // `API_KEY="sk-…"myapp/image:latest` lost the image tag entirely, with
    // nothing in the output to distinguish redaction from deletion. It also
    // meant the plain `KEY="value"` case ate both quotes, which the doc comment
    // above says it does not.
    if split_assignment(before).is_some() && rest.starts_with(['"', '\'']) {
        return None;
    }
    // Step back over an opening quote, if any, then require the separator.
    let before = match before.chars().next_back() {
        Some('"') | Some('\'') => &before[..before.len() - 1],
        _ => before,
    };
    let (name_part, separator) = split_assignment(before)?;
    // A URL scheme is the one `name:value` shape that is not an assignment.
    if separator == ':' && rest.starts_with("//") {
        return None;
    }
    let name_len = name_part
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .count();
    if name_len == 0 {
        return None;
    }
    let original = &name_part[name_part.len() - name_len..];
    let raw = original.to_ascii_lowercase();
    let name = raw.trim_matches('-');
    // A camelCase hump makes an identifier compound just as much as a `_` does,
    // and lowercasing first destroyed the only evidence of one — so `sessionKey`
    // and `authCookie` failed the compound test that `session_key` passes, and
    // shipped their values to the spool. Tested on the ORIGINAL casing for that
    // reason. The bare-`key` protection is untouched: a lone `key=` has no hump,
    // so it stays non-compound and JSX keeps its prop.
    let has_hump = original
        .as_bytes()
        .windows(2)
        .any(|w| (w[0].is_ascii_lowercase() || w[0].is_ascii_digit()) && w[1].is_ascii_uppercase());
    let compound = name.contains('_') || name.contains('-') || has_hump;
    // Beats every other signal: a value the framework compiles into the browser
    // bundle is public no matter what the rest of the name says.
    if is_published_by_design(name) {
        return None;
    }
    let convincing = STRONG_SECRET_NAMES.iter().any(|n| name.ends_with(n))
        || (compound && WEAK_SECRET_NAMES.iter().any(|n| name.ends_with(n)));
    if !convincing {
        return None;
    }

    // An expression reference is not a literal secret: `key={m.id}`,
    // `Bearer ${API_KEY}`, `token=<placeholder>`. Redacting these adds no
    // safety and makes captured source unreadable.
    if rest.starts_with(['{', '$', '<', '(', '`']) {
        return None;
    }

    // The value runs to the closing quote, or to whitespace / a shell
    // separator when unquoted. The closing quote is left in place.
    let quoted = matches!(s[..i].chars().next_back(), Some('"') | Some('\''));
    // Bytes, not characters — see the note on `match_bearer`. This predicate
    // also accepts non-ASCII, so a char count under-reports the span and
    // `scrub_str`'s `i += len` leaves the cursor inside the value.
    let value_len: usize = rest
        .chars()
        .take_while(|c| {
            if quoted {
                *c != '"' && *c != '\''
            } else {
                // Quotes end an unquoted value too, matching `match_bearer`'s
                // token run. An unquoted shell word does not contain a bare
                // quote, so stopping costs no real redaction — and running past
                // one destroys whatever it delimits, which is the strictly
                // worse error: an under-redacted value is still visibly a
                // value, while a swallowed one is gone with no marker saying so.
                !c.is_whitespace() && *c != ';' && *c != '&' && *c != '"' && *c != '\''
            }
        })
        .map(char::len_utf8)
        .sum();
    (value_len >= MIN_ASSIGNMENT_VALUE).then_some((value_len, "secret-assignment"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scrub(s: &str) -> String {
        scrub_str(s)
            .map(|(v, _)| v)
            .unwrap_or_else(|| s.to_string())
    }

    /// The TypeScript redactor had a catastrophic backtracking bug on exactly
    /// these inputs: a 300 KB unbroken token took over 20 SECONDS, because an
    /// unbounded `[A-Za-z0-9_]*` restarted and backtracked at every position.
    /// This side is hand-rolled scanning with no regex engine, so it is
    /// structurally immune — but "structurally immune" is a claim, and the two
    /// engines are required to agree, so it is measured rather than asserted.
    #[test]
    fn pathological_input_stays_linear() {
        let cases: Vec<String> = vec![
            format!("A={}", "a".repeat(200_000)),
            "A".repeat(300_000),
            format!("https://{}?token=x", "a".repeat(50_000)),
            "=".repeat(100_000),
            ":".repeat(100_000),
            "\"".repeat(50_000),
            "/a".repeat(40_000),
            (0..20_000)
                .map(|i| format!("K{i}=v{i}"))
                .collect::<Vec<_>>()
                .join(" "),
        ];
        for case in &cases {
            let started = std::time::Instant::now();
            let _ = scrub(case);
            let elapsed = started.elapsed();
            assert!(
                elapsed < std::time::Duration::from_secs(3),
                "scrub took {elapsed:?} on a {}-byte input",
                case.len()
            );
        }
    }

    #[test]
    fn redacts_the_key_shapes_that_actually_leak() {
        // Labelled by the most specific rule that matches: the key's own
        // prefix beats the generic assignment rule, which is more useful to
        // whoever reads the redacted line.
        assert_eq!(
            scrub("export ANTHROPIC_API_KEY=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv"),
            "export ANTHROPIC_API_KEY=[redacted:anthropic-key]"
        );
        // A value with no recognisable prefix still goes, via the assignment
        // rule — this is the case the prefix list cannot cover.
        assert_eq!(
            scrub("DATABASE_PASSWORD=hunter2hunter2hunter2"),
            "DATABASE_PASSWORD=[redacted:secret-assignment]"
        );
        assert!(
            scrub("here is sk-proj-abcdefghijklmnopqrstuvwxyz").contains("[redacted:openai-key]")
        );
        assert!(
            scrub("token ghp_abcdefghijklmnopqrstuvwxyz0123").contains("[redacted:github-token]")
        );
        assert!(scrub("AKIAIOSFODNN7EXAMPLE0000").contains("[redacted:aws-access-key-id]"));
    }

    #[test]
    fn redacts_a_bearer_header() {
        let out = scrub(r#"curl -H "Authorization: Bearer sk-pv7KDjLZ2u-uMgM2ym2uyw" https://x"#);
        assert!(out.contains("[redacted:bearer-token]"), "got {out}");
        assert!(!out.contains("pv7KDjLZ"), "the token survived: {out}");
    }

    /// A secret containing one multi-byte character used to leak its own tail.
    ///
    /// `scrub_str` advances by `i += len`, where `len` comes from a matcher.
    /// `match_bearer` and `match_assignment` both accept any non-whitespace
    /// character and both returned a CHARACTER count, so a value holding
    /// anything outside ASCII reported fewer units than it occupied bytes. The
    /// cursor then resumed INSIDE the secret and copied everything from there
    /// on into the output verbatim.
    ///
    /// Invisible to every other test in this module because every token in
    /// them is ASCII, where the two counts are equal. Non-ASCII in a secret is
    /// not exotic: a generated passphrase, a password a human chose, or any
    /// value that arrives through a UTF-8 field.
    ///
    /// Asserted with exact equality, not `!contains(tail)`. The number of bytes
    /// that leak equals the number of EXTRA bytes the value carries over its
    /// character count, so a value with a single two-byte character leaks
    /// exactly one character — which a "does the tail survive" assertion sails
    /// straight past while the bug is fully present. Exact equality cannot.
    #[test]
    fn a_multibyte_character_does_not_leak_the_rest_of_the_secret() {
        // One 2-byte character: exactly one byte of the secret used to survive
        // (`…[redacted:secret-assignment]K`).
        assert_eq!(
            scrub("DATABASE_PASSWORD=hunter2é-TAILWOULDLEAK"),
            "DATABASE_PASSWORD=[redacted:secret-assignment]"
        );

        // Eleven 2-byte characters: eleven bytes survived, which here is the
        // whole readable tail (`…[redacted:secret-assignment]ENDOFSECRET`).
        assert_eq!(
            scrub("API_TOKEN=пароль-очень-ENDOFSECRET"),
            "API_TOKEN=[redacted:secret-assignment]"
        );

        // A 4-byte character, so the fix cannot be right only for the 2-byte
        // case, and a bearer header rather than an assignment, so both of the
        // two affected matchers are covered.
        assert_eq!(
            scrub(r#"Authorization: Bearer tok-🔑🔑🔑-SECRETTAIL"#),
            "Authorization: [redacted:bearer-token]"
        );
    }

    #[test]
    fn redacts_a_jwt_but_not_ordinary_base64() {
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sIgNaTuRe0123456789ab";
        assert!(scrub(jwt).contains("[redacted:jwt]"));
        // Two segments is far more likely to be ordinary base64 than a token.
        assert_eq!(
            scrub("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0"),
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0"
        );
    }

    #[test]
    fn leaves_ordinary_text_alone() {
        // The false-positive cases that would make a capture useless. `risk-`
        // contains `sk-`, which is why prefixes are boundary-anchored.
        for s in [
            "this is a risk-averse approach",
            "run the task-runner now",
            "cargo build --release",
            "AWS_REGION=us-east-1",
            "let name = compute();",
            "no secrets here at all",
        ] {
            assert_eq!(scrub(s), s, "false positive on {s:?}");
        }
    }

    #[test]
    fn a_bare_key_prop_in_source_code_is_not_a_secret() {
        // Measured against 40 real transcripts: a bare `key=` matched React's
        // `key` prop on every JSX list, 169 times. Requiring a compound
        // identifier keeps API_KEY and api_key while dropping that whole class.
        assert_eq!(
            scrub("<MatchCard key={m.identifier} match={m} />"),
            "<MatchCard key={m.identifier} match={m} />"
        );
        assert_eq!(scrub("key=someLongIdentifier"), "key=someLongIdentifier");
        // Compound names still redact.
        assert!(scrub("API_KEY=abcdefghijklmnop").contains("[redacted:"));
        assert!(scrub("--api-token=abcdefghijklmnop").contains("[redacted:"));
        // Strong names redact even bare.
        assert!(scrub("password=abcdefghijklmnop").contains("[redacted:"));
    }

    /// A quoted value must lose the secret and NOTHING else.
    ///
    /// `match_assignment` used to match at the opening quote rather than at the
    /// value, so `quoted` read false and the unquoted stop-set ran past the
    /// closing quote to the next space. Anything glued to that quote was
    /// deleted, with no marker to say a redaction had eaten it — and a
    /// destroyed image tag reads exactly like one that was never there.
    #[test]
    fn a_quoted_value_is_redacted_without_swallowing_what_follows() {
        // The reported case: the image ref is glued to the closing quote.
        assert_eq!(
            scrub(
                r#"docker run -e API_KEY="abcdefghijklmnop"myapp/image:latest --flag positional-arg"#
            ),
            r#"docker run -e API_KEY="[redacted:secret-assignment]"myapp/image:latest --flag positional-arg"#
        );
        // The plain case, which lost both quotes: the doc comment promises the
        // assignment still reads as one.
        assert_eq!(
            scrub(r#"API_KEY="abcdefghijklmnop""#),
            r#"API_KEY="[redacted:secret-assignment]""#
        );
        assert_eq!(
            scrub("API_KEY='abcdefghijklmnop'"),
            "API_KEY='[redacted:secret-assignment]'"
        );
        // Ordinary trailing content, separated normally, is still untouched.
        assert_eq!(
            scrub(r#"API_KEY="abcdefghijklmnop" && echo done"#),
            r#"API_KEY="[redacted:secret-assignment]" && echo done"#
        );
        // Unquoted values keep working, and stop at the shell separators.
        assert_eq!(
            scrub("API_KEY=abcdefghijklmnop && echo done"),
            "API_KEY=[redacted:secret-assignment] && echo done"
        );
        // An unquoted value abutting a quoted argument must not eat it either.
        assert_eq!(
            scrub(r#"--api-token=abcdefghijklmnop"trailing""#),
            r#"--api-token=[redacted:secret-assignment]"trailing""#
        );
    }

    /// Redaction must never be a net data loss beyond the secret itself: every
    /// character outside the replaced span survives verbatim.
    #[test]
    fn redaction_only_ever_removes_the_matched_span() {
        for s in [
            r#"docker run -e API_KEY="abcdefghijklmnop"myapp/image:latest"#,
            r#"API_KEY="abcdefghijklmnop""#,
            "API_KEY=abcdefghijklmnop tail",
        ] {
            let out = scrub(s);
            let (before, rest) = out.split_once("[redacted:").expect("should redact");
            let after = rest.split_once(']').expect("marker should close").1;
            assert!(
                s.starts_with(before),
                "text before the marker was altered: {s:?} -> {out:?}"
            );
            assert!(
                s.ends_with(after),
                "text after the marker was dropped: {s:?} -> {out:?}"
            );
        }
    }

    // This redactor scrubs events on their way to the spool, so a shape it
    // misses is a credential shipped off the machine. It required the `=` to
    // sit immediately before the value, which meant a spaced assignment, a YAML
    // key and a JSON body all went out intact — verified by probe before the
    // fix, and these are that probe.
    #[test]
    fn an_assignment_is_redacted_whatever_the_separator_or_spacing() {
        for s in [
            "MY_API_KEY = synthetic0000111122223333",
            "MY_API_KEY:  synthetic0000111122223333",
            r#"my_api_key: "synthetic0000111122223333""#,
            r#"{"api_key": "synthetic0000111122223333"}"#,
            "  db_password:   synthetic0000111122223333",
        ] {
            assert!(
                scrub(s).contains("secret-assignment"),
                "leaked {s:?} -> {}",
                scrub(s)
            );
            assert!(
                !scrub(s).contains("synthetic0000111122223333"),
                "value survived in {s:?} -> {}",
                scrub(s)
            );
        }
    }

    #[test]
    fn a_camelcase_name_is_compound_too() {
        // The compound test ran on the LOWERCASED name, which had already
        // destroyed the hump — so `session_key` was redacted and `sessionKey`
        // was shipped to the spool verbatim.
        for s in [
            "sessionKey=synthetic0000111122223333",
            "authToken=synthetic0000111122223333",
            "apiKey=synthetic0000111122223333",
            "MYSQL_PWD=synthetic0000111122223333",
            "GPG_PASSPHRASE=synthetic0000111122223333",
        ] {
            assert!(
                scrub(s).contains("[redacted:"),
                "leaked {s:?} -> {}",
                scrub(s)
            );
        }
    }

    #[test]
    fn a_bare_weak_name_is_still_not_a_secret() {
        // The whole point of the compound rule: a lone `key=` is React's prop
        // on every JSX list, and a lone `PWD=` is the working directory.
        for s in [
            "key=synthetic0000111122223333",
            "token=synthetic0000111122223333",
            "PWD=/home/user/some/project/path",
        ] {
            assert!(
                !scrub(s).contains("secret-assignment"),
                "over-redacted {s:?} -> {}",
                scrub(s)
            );
        }
    }

    #[test]
    fn a_browser_bundled_key_is_not_a_secret() {
        // The build tool ships these to every visitor; scrubbing one reports an
        // exposure that did not happen.
        for s in [
            "NEXT_PUBLIC_POSTHOG_KEY=synthetic0000111122223333",
            "NEXT_PUBLIC_SUPABASE_ANON_KEY=synthetic0000111122223333",
            "VITE_API_KEY=synthetic0000111122223333",
            "REACT_APP_API_KEY=synthetic0000111122223333",
            "VAPID_PUBLIC_KEY=synthetic0000111122223333",
        ] {
            assert_eq!(scrub(s), s, "over-redacted {s:?}");
        }
    }

    #[test]
    fn a_name_that_merely_contains_public_is_still_a_secret() {
        for s in [
            "MY_PUBLIC_FACING_API_SECRET=synthetic0000111122223333",
            "PUBLISHER_API_KEY=synthetic0000111122223333",
            "REPUBLIC_TOKEN=synthetic0000111122223333",
        ] {
            assert!(
                scrub(s).contains("[redacted:"),
                "leaked {s:?} -> {}",
                scrub(s)
            );
        }
    }

    #[test]
    fn a_url_scheme_is_not_an_assignment() {
        // `https://…` is the one `name:value` shape that is not one. The name
        // is not convincing either, but the guard is what stops a scheme that
        // happens to end in a secret word from being read as its own value.
        let s = "curl https://api.example.com/v1/synthetic0000111122223333";
        assert_eq!(scrub(s), s);
    }

    #[test]
    fn a_separator_at_end_of_line_does_not_reach_the_next_line() {
        // Horizontal whitespace only when stepping back: `is_whitespace` would
        // cross the newline and read `API_KEY` as the name of the next line's
        // first word.
        let s = "API_KEY:\nsynthetic0000111122223333";
        assert_eq!(scrub(s), s);
    }

    #[test]
    fn an_expression_reference_is_not_redacted() {
        // Redacting these adds no safety and makes captured source unreadable.
        for s in [
            "Authorization: `Bearer ${API_KEY}`",
            "api_key=$OPENAI_API_KEY",
            "--token=<your-token-here>",
        ] {
            assert!(
                !scrub(s).contains("secret-assignment"),
                "over-redacted {s:?} -> {}",
                scrub(s)
            );
        }
    }

    #[test]
    fn a_short_assignment_value_is_left_alone() {
        // Placeholders and flags, not credentials.
        assert_eq!(scrub("API_KEY=abc"), "API_KEY=abc");
        assert_eq!(scrub("--token=x"), "--token=x");
    }

    #[test]
    fn redaction_is_deterministic() {
        // Non-negotiable: the server dedups on a content hash, so the same
        // input must always produce the same bytes.
        let s = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv and ghp_abcdefghijklmnopqrstuvwxyz0123";
        // Three independent runs over the same input, since a single
        // comparison would also pass for a function that returned its input.
        assert_eq!(scrub(s), scrub(s));
        assert_eq!(scrub(s), scrub(s));
        assert!(
            scrub(s).contains("[redacted:"),
            "the input really is redacted"
        );
    }

    #[test]
    fn the_marker_names_the_pattern_that_fired() {
        // Redaction must be visible, not a silent deletion.
        let out = scrub("ghp_abcdefghijklmnopqrstuvwxyz0123");
        assert_eq!(out, "[redacted:github-token]");
    }

    #[test]
    fn scrubs_nested_event_payloads() {
        let mut v = json!({
            "type": "tool_use",
            "input": { "command": "curl -H 'Authorization: Bearer sk-abcdefghijklmnopqrstuv'" },
            "nested": [{ "output": "ghp_abcdefghijklmnopqrstuvwxyz0123" }]
        });
        let n = scrub_value(&mut v, Redact::Minimal);
        assert!(n >= 2, "expected both leaves scrubbed, got {n}");
        let text = v.to_string();
        assert!(!text.contains("ghp_abcdefghij"));
        assert!(!text.contains("sk-abcdefghij"));
        // Structure is untouched.
        assert_eq!(v["type"], "tool_use");
    }

    #[test]
    fn off_mode_changes_nothing() {
        let mut v = json!({"output": "ghp_abcdefghijklmnopqrstuvwxyz0123"});
        assert_eq!(scrub_value(&mut v, Redact::Off), 0);
        assert_eq!(v["output"], "ghp_abcdefghijklmnopqrstuvwxyz0123");
    }

    #[test]
    fn multibyte_text_survives() {
        // Slicing on a non-char-boundary would panic and take the task down.
        let s = "héllo sk-abcdefghijklmnopqrstuv wörld → ✓";
        let out = scrub(s);
        assert!(out.contains("héllo"));
        assert!(out.contains("wörld → ✓"));
        assert!(out.contains("[redacted:"));
    }
}
