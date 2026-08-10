//! User-supplied extra capture paths, one set per source.
//!
//! Every source watches one default location — `~/.claude/projects`,
//! `~/.hermes/state.db`, and so on. That is right for the machine the agent was
//! installed on by its own installer, and wrong for every arrangement that puts
//! a second copy somewhere else: a second profile, a bind-mounted team share, a
//! container's home mapped in beside the host's, an agent relocated by an
//! operator. Those paths hold real sessions and nothing collected them.
//!
//! # A labelled path, not just a path
//!
//! Each entry is `label=path` or bare `path`, and the label becomes an agent-id
//! namespace — `<label>-<agentId>`. Without it two paths holding the same
//! project produce the same derived agent id (`claude-myrepo` from the `cwd`
//! inside the transcript, which is identical in both copies) and the product
//! shows one agent whose sessions interleave from two machines' worth of
//! history. The label is the only thing that keeps them apart, so it is part of
//! the grammar rather than an option.
//!
//! This matches the shape AgentEye's collector already ships for its own two
//! multi-path sources (`--openclaw-extra-path`, `--hermes-extra-path`): same
//! `label=path` grammar, same folder-name fallback, same `<label>-<agentId>`
//! namespacing. Diverging would have meant one product with two answers for
//! what an extra path is.
//!
//! # What is rejected, and why each one is silent otherwise
//!
//! Validation is deliberately loud, because every failure here is invisible at
//! runtime:
//!
//! * **A path that overlaps a default root** would be walked by two tasks with
//!   two cursor stores. Both ship every line, under two different agent ids,
//!   forever — and it looks like the feature working.
//! * **Two entries with the same label** collapse into one cursor directory,
//!   whose whole map is written atomically, so the two tasks clobber each
//!   other's watermark and each re-reads from zero after every restart.
//! * **An empty label** produces `-<agentId>`, which reads as a typo in the
//!   product and groups nothing.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// One resolved extra path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtraPath {
    /// Agent-id namespace. Non-empty, `[a-z0-9-]`, unique within its source.
    pub label: String,
    /// Where to capture from. A directory for file-tailing sources, a database
    /// file for SQLite ones — this module does not know or care which, and
    /// deliberately does NOT require it to exist: an entry for a share that is
    /// mounted later must survive a daemon start, exactly like the default
    /// roots, which are also allowed to be absent.
    pub path: PathBuf,
}

/// A rejected entry, kept rather than dropped so the caller can log it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rejected {
    pub entry: String,
    pub reason: String,
}

/// Everything one source's `extra_paths` resolved to.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Resolved {
    pub accepted: Vec<ExtraPath>,
    pub rejected: Vec<Rejected>,
}

/// Reduce a raw label to the alphabet agent ids use.
///
/// Mirrors the sanitising the transforms already apply to derived id parts, so
/// a label cannot introduce a character the rest of the pipeline would have
/// stripped anyway — which would make the configured label and the label in the
/// product differ.
fn sanitize_label(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut last_dash = true; // leading dashes are trimmed by starting true
    for ch in raw.chars() {
        let c = ch.to_ascii_lowercase();
        if c.is_ascii_alphanumeric() {
            out.push(c);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    out
}

/// Label for an entry that did not name one: the final path component.
///
/// Leading dots are stripped first so `/srv/.hermes-1` derives `hermes-1`
/// rather than `-hermes-1`. A path whose last component sanitises to nothing
/// (`/`, `/...`) yields `None` and the entry is rejected — guessing a label for
/// it would silently group unrelated captures together.
fn derive_label(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    let label = sanitize_label(name.trim_start_matches('.'));
    (!label.is_empty()).then_some(label)
}

/// Split one entry into its label and path halves.
///
/// Splits on the FIRST `=`, so a path containing `=` still works when a label
/// is given. A bare path containing `=` is ambiguous and resolves as
/// `label=path`; that is the documented grammar and the reason `list` prints
/// the resolved pair back.
fn split_entry(entry: &str) -> (Option<&str>, &str) {
    match entry.split_once('=') {
        Some((label, path)) if !label.trim().is_empty() => (Some(label.trim()), path.trim()),
        _ => (None, entry.trim()),
    }
}

/// True when `a` and `b` are the same path or one contains the other.
///
/// Both are compared after `clean`, which is lexical — no symlink resolution
/// and no `canonicalize`, because a path is allowed to be absent and
/// `canonicalize` fails on those. So a symlinked duplicate is NOT caught here;
/// it is caught at runtime by the cursor store, which keys on `(dev, inode)`.
fn overlaps(a: &Path, b: &Path) -> bool {
    a.starts_with(b) || b.starts_with(a)
}

/// Expand `~` and drop a trailing separator so comparisons are stable.
fn clean(raw: &str, home: Option<&Path>) -> PathBuf {
    let expanded = match (raw.strip_prefix("~/"), home) {
        (Some(rest), Some(home)) => home.join(rest),
        _ if raw == "~" => home
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from(raw)),
        _ => PathBuf::from(raw),
    };
    // `PathBuf::from("/a/b/")` keeps the trailing slash in its OsString, which
    // `starts_with` handles but `==` does not.
    PathBuf::from(expanded.to_string_lossy().trim_end_matches('/').to_string())
}

/// Resolve one source's configured entries against its default roots.
///
/// `defaults` are the roots the source already watches. An entry overlapping
/// any of them is rejected rather than silently double-collected.
pub fn resolve(entries: &[String], defaults: &[PathBuf], home: Option<&Path>) -> Resolved {
    resolve_reserving(entries, defaults, &[], home)
}

/// As [`resolve`], additionally refusing labels a source's own DEFAULT tasks
/// already use.
///
/// `defaults` catches an entry pointing at a path the source already watches. It
/// cannot catch an entry whose LABEL collides with one a default task derived —
/// and for Hermes those are derived, one per profile database
/// (`cursors/hermes/<profile>`, health key `hermes:<profile>`). So
/// `add-path hermes prod=/mnt/other/state.db` on a machine with a `prod` profile
/// was accepted, and the two SQLite pollers then shared a cursor directory and a
/// health key.
///
/// Which is precisely the failure this whole feature documents preventing: the
/// cursor store rewrites its map atomically, so both instances clobber each
/// other's watermark and each re-reads from zero after every restart, and one
/// health record overwrites the other so `root_present` alternates — destroying
/// the "absent root versus merely idle" distinction that record exists to draw.
/// Hermes is called out by name in that note as the source that reached this shape
/// first; it is also the one source whose default labels are derived rather than
/// fixed, which is why it is the one that could collide.
///
/// Separate entry point rather than a fourth parameter on `resolve`: reserving is a
/// Hermes-only concern, and `resolve` is the three-argument shape the rest of the
/// crate documents and the tests exercise, so it stays the one that reads as the
/// API. It is a thin forwarder — every production caller reaches this function.
pub fn resolve_reserving(
    entries: &[String],
    defaults: &[PathBuf],
    reserved_labels: &[String],
    home: Option<&Path>,
) -> Resolved {
    let mut out = Resolved::default();
    // Seeded with the names the source's own default tasks already occupy, so a
    // collision with one is rejected by the same check that catches a collision
    // between two extras.
    //
    // RESERVED NAMES GO IN RAW — deliberately NOT through `sanitize_label`, which
    // is the mistake this replaces. A collision is only real when an extra's
    // cursor directory equals a default task's, and those two names are built by
    // DIFFERENT normalisers: an extra's is `sanitize_label(label)`, while a
    // default's is whatever the caller derived (for Hermes, `profile_dir_name`,
    // which maps each non-alphanumeric one-for-one, does not lowercase, and does
    // not trim). Sanitising the reserved side compared the wrong pair.
    //
    // Concretely, on every machine: the root Hermes database lives in `.hermes`,
    // so its task owns `-hermes`, and sanitising gave `hermes`. That reserved a
    // name NO task owns — refusing a legitimate `hermes` label — while leaving the
    // real one unguarded. Raw is also self-correcting for names an extra can never
    // produce: `sanitize_label` output is always lowercase with no leading dash
    // and no doubled dash, so `-hermes` simply never matches and costs nothing.
    let reserved: BTreeSet<&str> = reserved_labels
        .iter()
        .map(|l| l.as_str())
        .filter(|l| !l.is_empty())
        .collect();
    let mut seen_labels: BTreeSet<String> = BTreeSet::new();
    let mut seen_paths: Vec<PathBuf> = Vec::new();

    let defaults: Vec<PathBuf> = defaults
        .iter()
        .map(|d| clean(&d.to_string_lossy(), home))
        .collect();

    for entry in entries {
        let raw = entry.trim();
        if raw.is_empty() {
            continue;
        }
        let (label_raw, path_raw) = split_entry(raw);
        if path_raw.is_empty() {
            out.rejected.push(Rejected {
                entry: raw.to_string(),
                reason: "no path".into(),
            });
            continue;
        }
        let path = clean(path_raw, home);

        let label = match label_raw {
            Some(l) => {
                let s = sanitize_label(l);
                if s.is_empty() {
                    out.rejected.push(Rejected {
                        entry: raw.to_string(),
                        reason: format!("label {l:?} contains no usable characters"),
                    });
                    continue;
                }
                s
            }
            None => match derive_label(&path) {
                Some(l) => l,
                None => {
                    out.rejected.push(Rejected {
                        entry: raw.to_string(),
                        reason: "no label given and none could be derived from the path".into(),
                    });
                    continue;
                }
            },
        };

        if let Some(clash) = defaults.iter().find(|d| overlaps(&path, d)) {
            out.rejected.push(Rejected {
                entry: raw.to_string(),
                reason: format!(
                    "overlaps the default root {}; it is already captured, and capturing it \
                     twice ships every session under two agent ids",
                    clash.display()
                ),
            });
            continue;
        }

        if reserved.contains(label.as_str()) {
            out.rejected.push(Rejected {
                entry: raw.to_string(),
                reason: format!(
                    "label {label:?} is already used by one of this source's own default \
                     capture paths"
                ),
            });
            continue;
        }

        if !seen_labels.insert(label.clone()) {
            out.rejected.push(Rejected {
                entry: raw.to_string(),
                reason: format!(
                    "label {label:?} is already used by another extra path for this source"
                ),
            });
            continue;
        }

        if let Some(clash) = seen_paths.iter().find(|p| overlaps(&path, p)) {
            out.rejected.push(Rejected {
                entry: raw.to_string(),
                reason: format!("overlaps another extra path, {}", clash.display()),
            });
            continue;
        }

        seen_paths.push(path.clone());
        out.accepted.push(ExtraPath { label, path });
    }

    out
}

/// Prefix an agent id with a label. The one place the `<label>-<agentId>`
/// convention is spelled out.
pub fn namespaced(label: &str, agent_id: &str) -> String {
    format!("{label}-{agent_id}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn bare_path_derives_its_label_from_the_final_component() {
        let r = resolve(&e(["/srv/claude-work"].as_slice()), &[], None);
        assert!(r.rejected.is_empty(), "{:?}", r.rejected);
        assert_eq!(r.accepted[0].label, "claude-work");
        assert_eq!(r.accepted[0].path, PathBuf::from("/srv/claude-work"));
    }

    #[test]
    fn leading_dots_are_stripped_before_deriving() {
        let r = resolve(&e(["/srv/.hermes-1"].as_slice()), &[], None);
        assert_eq!(r.accepted[0].label, "hermes-1");
    }

    #[test]
    fn explicit_label_wins_and_is_sanitized() {
        let r = resolve(&e(["Team Share=/mnt/x"].as_slice()), &[], None);
        assert_eq!(r.accepted[0].label, "team-share");
        assert_eq!(r.accepted[0].path, PathBuf::from("/mnt/x"));
    }

    #[test]
    fn a_path_containing_equals_still_works_with_an_explicit_label() {
        let r = resolve(&e(["a=/mnt/k=v/x"].as_slice()), &[], None);
        assert_eq!(r.accepted[0].path, PathBuf::from("/mnt/k=v/x"));
    }

    #[test]
    fn tilde_expands_against_the_supplied_home() {
        let home = PathBuf::from("/home/u");
        let r = resolve(&e(["x=~/alt/projects"].as_slice()), &[], Some(&home));
        assert_eq!(r.accepted[0].path, PathBuf::from("/home/u/alt/projects"));
    }

    #[test]
    fn trailing_slash_does_not_defeat_the_overlap_check() {
        let defaults = vec![PathBuf::from("/home/u/.claude/projects")];
        let r = resolve(
            &e(["a=/home/u/.claude/projects/"].as_slice()),
            &defaults,
            None,
        );
        assert!(r.accepted.is_empty());
        assert!(r.rejected[0].reason.contains("overlaps the default root"));
    }

    /// The bug this exists to prevent: a path inside a default root is walked
    /// by both tasks, so every line ships twice under two agent ids.
    #[test]
    fn a_path_nested_under_a_default_root_is_rejected() {
        let defaults = vec![PathBuf::from("/home/u/.claude/projects")];
        let r = resolve(
            &e(["a=/home/u/.claude/projects/sub"].as_slice()),
            &defaults,
            None,
        );
        assert!(r.accepted.is_empty());
        assert!(r.rejected[0].reason.contains("overlaps the default root"));
    }

    /// ...and the reverse: a default root nested under the extra path.
    #[test]
    fn a_path_containing_a_default_root_is_rejected() {
        let defaults = vec![PathBuf::from("/home/u/.claude/projects")];
        let r = resolve(&e(["a=/home/u/.claude"].as_slice()), &defaults, None);
        assert!(r.accepted.is_empty());
        assert!(r.rejected[0].reason.contains("overlaps the default root"));
    }

    #[test]
    fn duplicate_labels_are_rejected_not_merged() {
        let r = resolve(&e(["a=/srv/one", "a=/srv/two"].as_slice()), &[], None);
        assert_eq!(r.accepted.len(), 1);
        assert_eq!(r.accepted[0].path, PathBuf::from("/srv/one"));
        assert!(r.rejected[0].reason.contains("already used"));
    }

    #[test]
    fn two_extra_paths_that_overlap_each_other_are_rejected() {
        let r = resolve(&e(["a=/srv/one", "b=/srv/one/two"].as_slice()), &[], None);
        assert_eq!(r.accepted.len(), 1);
        assert!(r.rejected[0].reason.contains("overlaps another extra path"));
    }

    #[test]
    fn an_unusable_label_is_rejected_rather_than_emptied() {
        let r = resolve(&e(["===/srv/x", "!!!=/srv/y"].as_slice()), &[], None);
        // `===/srv/x` splits into label "" (falsy) -> bare path "==/srv/x".
        // `!!!=/srv/y` has a label that sanitizes away.
        assert!(
            r.rejected
                .iter()
                .any(|x| x.reason.contains("no usable characters"))
        );
    }

    #[test]
    fn a_path_with_no_derivable_label_is_rejected() {
        let r = resolve(&e(["/"].as_slice()), &[], None);
        assert!(r.accepted.is_empty());
        assert!(r.rejected[0].reason.contains("none could be derived"));
    }

    #[test]
    fn blank_entries_are_skipped_silently() {
        let r = resolve(&e(["", "   "].as_slice()), &[], None);
        assert!(r.accepted.is_empty());
        assert!(r.rejected.is_empty());
    }

    #[test]
    fn a_missing_path_is_still_accepted() {
        // Deliberate: a share mounted after the daemon starts must not be
        // dropped at config-resolution time.
        let r = resolve(&e(["a=/definitely/not/here"].as_slice()), &[], None);
        assert_eq!(r.accepted.len(), 1);
    }

    #[test]
    fn namespacing_is_label_dash_agent() {
        assert_eq!(namespaced("work", "claude-myrepo"), "work-claude-myrepo");
    }

    /// A label a DEFAULT task already derived is refused.
    ///
    /// `defaults` catches an entry pointing at a path the source already watches;
    /// it cannot catch one whose LABEL collides with a default's. Hermes is the
    /// only source where that is possible, because its default labels are derived
    /// per profile database rather than fixed — so `prod=<other>.db` on a machine
    /// with a `prod` profile was accepted, and the two SQLite pollers then shared
    /// `cursors/hermes/prod` and the health key `hermes:prod`. Both re-read from
    /// zero after every restart, and one health record overwrote the other.
    #[test]
    fn a_label_reserved_by_a_default_task_is_refused() {
        let entries = vec!["prod=/mnt/other/state.db".to_string()];
        let reserved = vec!["prod".to_string()];

        let resolved = resolve_reserving(&entries, &[], &reserved, None);

        assert!(
            resolved.accepted.is_empty(),
            "a reserved label must not be accepted"
        );
        assert_eq!(resolved.rejected.len(), 1);
        assert!(
            resolved.rejected[0].reason.contains("prod"),
            "the reason must name the label, got: {}",
            resolved.rejected[0].reason
        );
    }

    /// The comparison is `sanitize_label(extra)` vs the reserved name VERBATIM — the
    /// extra's label is the only side that gets normalised, because the reserved side
    /// is already the literal directory name its default task uses.
    #[test]
    fn an_extra_label_is_sanitised_before_it_is_compared_to_a_reserved_name() {
        let entries = vec!["Prod Two=/mnt/other/state.db".to_string()];
        // The default task derived this from a directory called "prod-two".
        let reserved = vec!["prod-two".to_string()];

        let resolved = resolve_reserving(&entries, &[], &reserved, None);

        assert!(resolved.accepted.is_empty());
    }

    /// The reserved side must NOT be sanitised, and this is the case that proves it:
    /// the root Hermes database lives in `~/.hermes`, so `profile_dir_name` gives its
    /// task the directory `-hermes` — a name no extra can ever produce, since
    /// `sanitize_label` strips leading dashes. Sanitising the reserved side turned
    /// `-hermes` into `hermes` and reserved THAT, which is a name no task owns. The
    /// first version of this guard shipped exactly that, so on every machine (index 0
    /// is always the root db) it refused a legitimate `hermes` label while leaving the
    /// directory it meant to protect unguarded.
    #[test]
    fn a_reserved_name_that_sanitisation_would_change_does_not_shadow_its_sanitised_form() {
        let entries = vec!["hermes=/mnt/other/state.db".to_string()];
        let reserved = vec!["-hermes".to_string()];

        let resolved = resolve_reserving(&entries, &[], &reserved, None);

        assert_eq!(
            resolved.accepted.len(),
            1,
            "`hermes` collides with nothing — the root db's directory is `-hermes`; \
             rejected: {:?}",
            resolved.rejected
        );
        assert_eq!(resolved.accepted[0].label, "hermes");
    }

    /// A collision with a DEFAULT task and a collision with another EXTRA are
    /// different mistakes with different fixes, so they must not share a reason. The
    /// first version said "already used by another extra path" for both, sending the
    /// operator to hunt for a duplicate entry they never wrote.
    #[test]
    fn a_reserved_collision_does_not_blame_a_nonexistent_extra_path() {
        let entries = vec!["prod=/mnt/other/state.db".to_string()];
        let reserved = vec!["prod".to_string()];

        let resolved = resolve_reserving(&entries, &[], &reserved, None);

        let reason = &resolved.rejected[0].reason;
        assert!(
            reason.contains("default"),
            "the reason must point at the source's own default paths, got: {reason}"
        );
        assert!(
            !reason.contains("another extra path"),
            "there is no other extra path to blame, got: {reason}"
        );
    }

    /// And an unreserved label still works — the check must not refuse everything.
    #[test]
    fn a_label_no_default_uses_is_still_accepted() {
        let entries = vec!["staging=/mnt/other/state.db".to_string()];
        let reserved = vec!["prod".to_string()];

        let resolved = resolve_reserving(&entries, &[], &reserved, None);

        assert_eq!(
            resolved.accepted.len(),
            1,
            "rejected: {:?}",
            resolved.rejected
        );
        assert_eq!(resolved.accepted[0].label, "staging");
    }

    /// `resolve` keeps its old behaviour: nothing reserved.
    #[test]
    fn plain_resolve_reserves_nothing() {
        let entries = vec!["prod=/mnt/other/state.db".to_string()];
        let resolved = resolve(&entries, &[], None);
        assert_eq!(resolved.accepted.len(), 1);
    }
}
