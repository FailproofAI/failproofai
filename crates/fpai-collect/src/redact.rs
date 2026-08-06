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
const STRONG_SECRET_NAMES: &[&str] = &["secret", "password", "passwd", "credential"];
/// Names that are only convincing as part of a COMPOUND identifier.
///
/// `key` and `token` are ordinary words in source code — measured against 40
/// real transcripts, a bare `key=` matched React's `key` prop on every JSX
/// list. Requiring a `_` or `-` keeps `API_KEY`, `api_key` and `--api-token`
/// while dropping that entire class of false positive.
const WEAK_SECRET_NAMES: &[&str] = &["key", "token"];

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
    // Step back over an opening quote, if any, then require the `=`.
    let before = match before.chars().next_back() {
        Some('"') | Some('\'') => &before[..before.len() - 1],
        _ => before,
    };
    if !before.ends_with('=') {
        return None;
    }
    let name_part = &before[..before.len() - 1];
    let name_len = name_part
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .count();
    if name_len == 0 {
        return None;
    }
    let raw = name_part[name_part.len() - name_len..].to_ascii_lowercase();
    let name = raw.trim_matches('-');
    let compound = name.contains('_') || name.contains('-');
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
                !c.is_whitespace() && *c != ';' && *c != '&'
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
