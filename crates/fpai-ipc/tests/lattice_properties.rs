//! Property tests for the decision lattice.
//!
//! The verification plan calls this out specifically: the combination rule
//! "deserves a property test rather than three examples", because the last
//! property below — **adding any number of `user-context` results never lowers
//! a `sealed` deny** — is the formal statement of the entire two-tier security
//! argument. Three hand-picked examples would pass against an implementation
//! that is wrong for the fourth.

use fpai_ipc::combine::{Decision, Tier, TieredDecision, combine, combine_all, combine_tiered};
use fpai_ipc::envelope::Attestation;
use proptest::prelude::*;

fn any_decision() -> impl Strategy<Value = Decision> {
    prop_oneof![
        Just(Decision::Allow),
        Just(Decision::Instruct),
        Just(Decision::Deny)
    ]
}

fn any_attestation() -> impl Strategy<Value = Attestation> {
    prop_oneof![
        Just(Attestation::Sealed),
        Just(Attestation::SealedUnattested),
        Just(Attestation::UserContext),
    ]
}

fn any_tier() -> impl Strategy<Value = Tier> {
    prop_oneof![Just(Tier::Sealed), Just(Tier::UserContext)]
}

fn any_tiered() -> impl Strategy<Value = TieredDecision> {
    (any_decision(), any_tier()).prop_map(|(decision, tier)| TieredDecision { decision, tier })
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 4096, ..ProptestConfig::default() })]

    #[test]
    fn combine_is_associative(a in any_decision(), b in any_decision(), c in any_decision()) {
        prop_assert_eq!(combine(combine(a, b), c), combine(a, combine(b, c)));
    }

    #[test]
    fn combine_is_commutative(a in any_decision(), b in any_decision()) {
        prop_assert_eq!(combine(a, b), combine(b, a));
    }

    #[test]
    fn combine_is_idempotent(a in any_decision()) {
        prop_assert_eq!(combine(a, a), a);
    }

    #[test]
    fn allow_is_the_identity(a in any_decision()) {
        prop_assert_eq!(combine(a, Decision::Allow), a);
        prop_assert_eq!(combine(Decision::Allow, a), a);
    }

    /// The combined result equals the maximum under `deny > instruct > allow`.
    #[test]
    fn combine_is_the_maximum(a in any_decision(), b in any_decision()) {
        let expected = if a.rank() >= b.rank() { a } else { b };
        prop_assert_eq!(combine(a, b), expected);
        prop_assert!(combine(a, b) >= a);
        prop_assert!(combine(a, b) >= b);
    }

    /// Combining can only ever tighten. This is what makes evaluation order
    /// irrelevant, and it is the reason a forged `allow` is harmless.
    #[test]
    fn combining_never_relaxes(a in any_decision(), b in any_decision()) {
        prop_assert!(combine(a, b) >= a.max(b));
        prop_assert!(combine(a, b) != Decision::Allow || (a == Decision::Allow && b == Decision::Allow));
    }

    #[test]
    fn combine_all_equals_the_maximum_of_the_list(
        decisions in prop::collection::vec(any_decision(), 0..32)
    ) {
        let expected = decisions.iter().copied().max().unwrap_or(Decision::Allow);
        prop_assert_eq!(combine_all(decisions.iter().copied()), expected);
    }

    /// Order-independence stated directly: shuffling the inputs cannot change
    /// the outcome, so "which policy ran first" is never a security-relevant
    /// question.
    #[test]
    fn combine_all_is_order_independent(
        decisions in prop::collection::vec(any_decision(), 0..32)
    ) {
        let forwards = combine_all(decisions.iter().copied());
        let backwards = combine_all(decisions.iter().rev().copied());
        prop_assert_eq!(forwards, backwards);
    }

    // ---- the two-tier security argument ---------------------------------

    /// **Adding any number of `user-context` results never lowers a `sealed`
    /// deny.** Folding an arbitrary list of `user_context` verdicts — of any
    /// length, in any combination, including all-`allow` — into a sealed `Deny`
    /// still yields `Deny`.
    #[test]
    fn user_context_results_cannot_lower_a_sealed_deny(
        user in prop::collection::vec(any_decision(), 0..64)
    ) {
        let mut results = vec![TieredDecision::sealed(Decision::Deny)];
        results.extend(user.iter().copied().map(TieredDecision::user_context));

        let outcome = combine_tiered(results.iter().copied());
        prop_assert_eq!(outcome.decision(), Decision::Deny);

        // And the deny is still reported as sealed: a user-context verdict that
        // merely echoed it did not decide it, so the daemon can still stand
        // behind the verdict as unforgeable.
        prop_assert!(!outcome.decided_by_user_context());
        prop_assert_eq!(outcome.attestation_ceiling(), Attestation::Sealed);

        // Position is irrelevant too: putting the sealed deny last must not
        // change the answer.
        results.rotate_left(1);
        prop_assert_eq!(combine_tiered(results).decision(), Decision::Deny);
    }

    /// The general form: `user_context` verdicts can raise the outcome and can
    /// never lower it, whatever the sealed tier decided.
    #[test]
    fn user_context_can_only_tighten(
        sealed in prop::collection::vec(any_decision(), 0..32),
        user in prop::collection::vec(any_decision(), 0..32),
    ) {
        let sealed_only = combine_all(sealed.iter().copied());

        let mut all: Vec<TieredDecision> =
            sealed.iter().copied().map(TieredDecision::sealed).collect();
        all.extend(user.iter().copied().map(TieredDecision::user_context));

        let outcome = combine_tiered(all);
        prop_assert_eq!(outcome.sealed, sealed_only);
        prop_assert!(outcome.decision() >= sealed_only);
    }

    /// Attribution is honest in both directions: a `user_context` verdict is
    /// blamed for the outcome exactly when it strictly exceeded every sealed
    /// verdict, never merely because it was present.
    #[test]
    fn attestation_is_weakened_only_when_user_context_actually_decided(
        results in prop::collection::vec(any_tiered(), 0..32)
    ) {
        let outcome = combine_tiered(results.iter().copied());
        let sealed_max = combine_all(
            results.iter().filter(|r| r.tier == Tier::Sealed).map(|r| r.decision),
        );
        let user_max = combine_all(
            results.iter().filter(|r| r.tier == Tier::UserContext).map(|r| r.decision),
        );

        prop_assert_eq!(outcome.sealed, sealed_max);
        prop_assert_eq!(outcome.user_context, user_max);
        prop_assert_eq!(outcome.decision(), combine(sealed_max, user_max));
        prop_assert_eq!(outcome.decided_by_user_context(), user_max > sealed_max);
        prop_assert_eq!(
            outcome.attestation_ceiling() == Attestation::UserContext,
            user_max > sealed_max
        );
    }

    /// A tier split cannot manufacture strictness either: the combined result
    /// is exactly the result of ignoring tiers entirely.
    #[test]
    fn tiering_does_not_change_the_combined_decision(
        results in prop::collection::vec(any_tiered(), 0..32)
    ) {
        let untiered = combine_all(results.iter().map(|r| r.decision));
        prop_assert_eq!(combine_tiered(results).decision(), untiered);
    }

    // ---- the attestation lattice ----------------------------------------

    #[test]
    fn attestation_combination_is_associative_commutative_and_idempotent(
        a in any_attestation(), b in any_attestation(), c in any_attestation()
    ) {
        prop_assert_eq!(a.combine(b).combine(c), a.combine(b.combine(c)));
        prop_assert_eq!(a.combine(b), b.combine(a));
        prop_assert_eq!(a.combine(a), a);
        prop_assert_eq!(a.combine(Attestation::Sealed), a);
    }

    /// Least attested wins: a combined result can never be reported as more
    /// attested than its weakest input.
    #[test]
    fn attestation_combination_never_strengthens(
        items in prop::collection::vec(any_attestation(), 1..32)
    ) {
        let combined = Attestation::combine_all(items.iter().copied());
        for item in &items {
            prop_assert!(combined >= *item, "{combined:?} is stronger than input {item:?}");
        }
        prop_assert_eq!(combined, items.iter().copied().max().unwrap());
    }

    /// Serde round-trip, so the lattice's spellings survive the wire.
    #[test]
    fn decisions_and_attestations_round_trip(d in any_decision(), a in any_attestation()) {
        let d_json = serde_json::to_string(&d).unwrap();
        prop_assert_eq!(serde_json::from_str::<Decision>(&d_json).unwrap(), d);
        prop_assert_eq!(d_json, format!("\"{}\"", d.as_str()));

        let a_json = serde_json::to_string(&a).unwrap();
        prop_assert_eq!(serde_json::from_str::<Attestation>(&a_json).unwrap(), a);
        prop_assert_eq!(a_json, format!("\"{}\"", a.as_str()));
    }
}

#[test]
fn the_ordering_is_exactly_deny_over_instruct_over_allow() {
    // Pinned as an example as well as a property: the properties above are all
    // stated in terms of `Ord`, so an inverted `Ord` would satisfy every one of
    // them while denying nothing.
    assert!(Decision::Allow < Decision::Instruct);
    assert!(Decision::Instruct < Decision::Deny);
    assert_eq!(Decision::Allow.rank(), 0);
    assert_eq!(Decision::Instruct.rank(), 1);
    assert_eq!(Decision::Deny.rank(), 2);

    assert!(Attestation::Sealed < Attestation::SealedUnattested);
    assert!(Attestation::SealedUnattested < Attestation::UserContext);
}

#[test]
fn a_user_context_allow_cannot_unblock_a_sealed_deny() {
    // The concrete attack, spelled out: the user owns the agent, so they can
    // make it return whatever they like. The strongest thing they can say is
    // "allow", and it changes nothing.
    let outcome = combine_tiered([
        TieredDecision::sealed(Decision::Deny),
        TieredDecision::user_context(Decision::Allow),
        TieredDecision::user_context(Decision::Allow),
        TieredDecision::user_context(Decision::Allow),
    ]);
    assert_eq!(outcome.decision(), Decision::Deny);
    assert_eq!(outcome.attestation_ceiling(), Attestation::Sealed);
}
