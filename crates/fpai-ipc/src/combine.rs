//! The decision lattice: `deny` over `instruct` over `allow`.
//!
//! This is the algebra the entire two-tier security argument rests on. A
//! `user-context` policy runs in a process the requesting user owns, so that
//! user can `ptrace` it, preload into it, or substitute the interpreter — its
//! verdict is forgeable by construction. That is tolerable **only** because
//! combination is a join over a total order in which `deny` is the top: a
//! forged `allow` changes nothing, and a forged `deny` harms only the user who
//! forged it.
//!
//! So the properties in this module's tests are not unit-test hygiene. They are
//! the security argument, written down in a form that a machine re-checks.

use serde::{Deserialize, Serialize};

use crate::envelope::Attestation;

/// A policy verdict.
///
/// Ordered `Allow < Instruct < Deny`. [`Ord`] is written by hand rather than
/// derived so that reordering the variants — a cosmetic-looking edit — cannot
/// silently invert the lattice and turn a deny into an allow.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    /// No policy objected.
    Allow,
    /// Proceed, but carry an instruction back to the agent.
    Instruct,
    /// Stop the operation.
    Deny,
}

impl Decision {
    /// Rank in the lattice; higher is stricter.
    #[must_use]
    pub const fn rank(self) -> u8 {
        match self {
            Self::Allow => 0,
            Self::Instruct => 1,
            Self::Deny => 2,
        }
    }

    /// The on-wire spelling, matching `EvaluationResult["decision"]` in
    /// `src/hooks/policy-evaluator.ts`.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::Instruct => "instruct",
            Self::Deny => "deny",
        }
    }
}

impl Default for Decision {
    /// [`Decision::Allow`], the identity of [`combine`].
    fn default() -> Self {
        Self::Allow
    }
}

impl Ord for Decision {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.rank().cmp(&other.rank())
    }
}

impl PartialOrd for Decision {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl std::fmt::Display for Decision {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Combine two verdicts: `deny` over `instruct` over `allow`.
///
/// Associative, commutative, and idempotent, with [`Decision::Allow`] as the
/// identity — i.e. a join semilattice, which is what makes the order in which
/// policies happen to be evaluated irrelevant to the result.
#[must_use]
pub fn combine(a: Decision, b: Decision) -> Decision {
    a.max(b)
}

/// Combine any number of verdicts. An empty input is [`Decision::Allow`].
pub fn combine_all<I: IntoIterator<Item = Decision>>(decisions: I) -> Decision {
    decisions.into_iter().fold(Decision::Allow, combine)
}

/// Which process computed a verdict, and therefore whether it can be trusted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Tier {
    /// The daemon's pinned runtime, running as the service account. No
    /// filesystem, subprocess, or network access; verdict is unforgeable.
    Sealed,
    /// A worker running as the requesting UID. Full access, bounded by that
    /// user's own authority; verdict is forgeable *by that user*.
    UserContext,
}

/// One policy's verdict, tagged with the tier that produced it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct TieredDecision {
    /// The verdict.
    pub decision: Decision,
    /// Where it was computed.
    pub tier: Tier,
}

impl TieredDecision {
    /// A verdict from the sealed tier.
    #[must_use]
    pub const fn sealed(decision: Decision) -> Self {
        Self {
            decision,
            tier: Tier::Sealed,
        }
    }

    /// A verdict from a per-user agent.
    #[must_use]
    pub const fn user_context(decision: Decision) -> Self {
        Self {
            decision,
            tier: Tier::UserContext,
        }
    }
}

/// The outcome of combining tiered verdicts.
///
/// The per-tier maxima are kept rather than collapsed because the *combined*
/// decision alone cannot tell you whether a forgeable process influenced it,
/// and that question is what [`TieredOutcome::attestation_ceiling`] answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TieredOutcome {
    /// The strictest sealed verdict. [`Decision::Allow`] if none ran.
    pub sealed: Decision,
    /// The strictest `user-context` verdict. [`Decision::Allow`] if none ran.
    pub user_context: Decision,
}

impl TieredOutcome {
    /// The combined verdict returned to the client.
    #[must_use]
    pub fn decision(self) -> Decision {
        combine(self.sealed, self.user_context)
    }

    /// Whether a `user-context` verdict actually changed the outcome.
    ///
    /// False when the two tiers agree: a sealed deny that a `user-context`
    /// policy merely echoed is still a sealed deny, and reporting it as
    /// `user_context` would understate a verdict the daemon can in fact stand
    /// behind. Computed from the per-tier maxima rather than from fold order,
    /// so it does not depend on the sequence policies happened to run in.
    #[must_use]
    pub fn decided_by_user_context(self) -> bool {
        self.user_context > self.sealed
    }

    /// The strongest attestation this outcome could carry.
    ///
    /// A **ceiling**, not the final answer: it accounts for the tier split
    /// only. The caller must additionally weaken it to
    /// [`Attestation::SealedUnattested`] if a deciding policy read `cwd`,
    /// `project_dir`, or an env fact, because those are client-asserted and
    /// this crate has no way to know which policy read what.
    #[must_use]
    pub fn attestation_ceiling(self) -> Attestation {
        if self.decided_by_user_context() {
            Attestation::UserContext
        } else {
            Attestation::Sealed
        }
    }
}

/// Combine tiered verdicts, keeping the per-tier maxima.
///
/// This is where "a `user-context` policy can only tighten" becomes mechanical
/// rather than aspirational: `user_context` contributes to the result solely
/// through a join, and a join can never lower anything.
pub fn combine_tiered<I: IntoIterator<Item = TieredDecision>>(results: I) -> TieredOutcome {
    let mut outcome = TieredOutcome {
        sealed: Decision::Allow,
        user_context: Decision::Allow,
    };
    for result in results {
        match result.tier {
            Tier::Sealed => outcome.sealed = combine(outcome.sealed, result.decision),
            Tier::UserContext => {
                outcome.user_context = combine(outcome.user_context, result.decision);
            }
        }
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deny_beats_instruct_beats_allow() {
        assert_eq!(
            combine(Decision::Allow, Decision::Instruct),
            Decision::Instruct
        );
        assert_eq!(combine(Decision::Instruct, Decision::Deny), Decision::Deny);
        assert_eq!(combine(Decision::Allow, Decision::Deny), Decision::Deny);
    }

    #[test]
    fn an_empty_combination_allows() {
        assert_eq!(combine_all([]), Decision::Allow);
        assert_eq!(Decision::default(), Decision::Allow);
    }

    #[test]
    fn wire_spellings_match_the_typescript_evaluation_result() {
        for (decision, spelling) in [
            (Decision::Allow, "allow"),
            (Decision::Instruct, "instruct"),
            (Decision::Deny, "deny"),
        ] {
            assert_eq!(decision.as_str(), spelling);
            assert_eq!(
                serde_json::to_value(decision).unwrap(),
                serde_json::json!(spelling)
            );
        }
    }

    #[test]
    fn tiers_serialize_snake_case() {
        assert_eq!(
            serde_json::to_value(Tier::UserContext).unwrap(),
            serde_json::json!("user_context")
        );
        assert_eq!(
            serde_json::to_value(Tier::Sealed).unwrap(),
            serde_json::json!("sealed")
        );
    }

    #[test]
    fn a_user_context_deny_that_only_echoes_a_sealed_deny_is_still_sealed() {
        let outcome = combine_tiered([
            TieredDecision::sealed(Decision::Deny),
            TieredDecision::user_context(Decision::Deny),
        ]);
        assert_eq!(outcome.decision(), Decision::Deny);
        assert!(!outcome.decided_by_user_context());
        assert_eq!(outcome.attestation_ceiling(), Attestation::Sealed);
    }

    #[test]
    fn a_user_context_deny_that_tightens_an_allow_is_attributed_to_it() {
        let outcome = combine_tiered([
            TieredDecision::sealed(Decision::Allow),
            TieredDecision::user_context(Decision::Deny),
        ]);
        assert_eq!(outcome.decision(), Decision::Deny);
        assert!(outcome.decided_by_user_context());
        assert_eq!(outcome.attestation_ceiling(), Attestation::UserContext);
    }

    #[test]
    fn no_verdicts_at_all_allows_and_is_sealed() {
        let outcome = combine_tiered([]);
        assert_eq!(outcome.decision(), Decision::Allow);
        assert_eq!(outcome.attestation_ceiling(), Attestation::Sealed);
    }
}
