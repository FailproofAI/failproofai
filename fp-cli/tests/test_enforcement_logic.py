"""The deploy planner, the race check, and source resolution.

These are tested hard because they are the two places this feature can destroy
something: `PUT /enforcement/deployments/{id}` is a FULL REPLACE with no
server-side lock, so a wrong resulting set is a permanent silent undeploy, and a
missed race is somebody else's change gone with a 200 on screen.
"""
from __future__ import annotations

import io

import pytest

from fp_cli.enforcement import (
    DeployPlan,
    RefError,
    check_race,
    latest_versions,
    parse_ref,
    plan_deploy,
    read_source,
    resolve_ref,
)
from fp_cli.errors import ApiError
from fp_cli.models import PolicyRef, PolicyVersion


def ref(pid, version=1, effect="enforce"):
    return PolicyRef(id=pid, version=version, effect=effect)


def pv(pid, version=1, archived=False):
    return PolicyVersion(
        id=pid, version=version, description="", sha256="", source=None,
        created_at="", created_by=None, disabled=False, archived=archived,
    )


# ── parsing ──────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "token,expected",
    [
        ("a", ("a", None, None)),
        ("a@3", ("a", 3, None)),
        ("a:observe", ("a", None, "observe")),
        ("a@3:observe", ("a", 3, "observe")),
        ("a@3:enforce", ("a", 3, "enforce")),
        ("no-force-push.v2_x", ("no-force-push.v2_x", None, None)),
    ],
)
def test_parse_ref_shapes(token, expected):
    assert parse_ref(token) == expected


@pytest.mark.parametrize("token", ["", "  ", "a@", "a@x", "a:", "a:enforced", "a b", "a@1:bad"])
def test_parse_ref_rejects_junk(token):
    with pytest.raises(RefError):
        parse_ref(token)


def test_an_unknown_effect_names_the_valid_ones():
    """The message has to say what IS allowed — 'invalid effect' helps nobody."""
    with pytest.raises(RefError, match="enforce, observe"):
        parse_ref("a:audit")


# ── version and effect resolution ────────────────────────────────────────────


def test_add_of_an_already_deployed_policy_keeps_its_version():
    """`--add` must not silently upgrade.

    A machine pinned to v1 while v3 exists is pinned deliberately. Treating a
    bare `--add` as "give me the newest" would roll the fleet forward on a
    command whose author was only reordering.
    """
    got = resolve_ref("a", latest={"a": 3}, current={"a": ref("a", 1)})
    assert (got.version, got.effect) == (1, "enforce")


def test_add_of_a_new_policy_takes_the_latest_version():
    got = resolve_ref("a", latest={"a": 3}, current={})
    assert got.version == 3


def test_an_explicit_version_always_wins():
    got = resolve_ref("a@2", latest={"a": 3}, current={"a": ref("a", 1)})
    assert got.version == 2


def test_effect_is_inherited_then_defaults_to_enforce():
    assert resolve_ref("a", latest={"a": 1}, current={"a": ref("a", 1, "observe")}).effect == "observe"
    assert resolve_ref("a", latest={"a": 1}, current={}).effect == "enforce"
    assert resolve_ref("a:observe", latest={"a": 1}, current={}).effect == "observe"


def test_an_unpublished_policy_is_refused_before_any_write():
    with pytest.raises(RefError, match="no published policy"):
        resolve_ref("ghost", latest={"a": 1}, current={})


def test_latest_versions_ignores_archived():
    assert latest_versions([pv("a", 1), pv("a", 3, archived=True), pv("b", 2)]) == {"a": 1, "b": 2}


# ── the planner: the thing that decides what gets written ────────────────────


def test_add_preserves_everything_already_deployed():
    """The whole reason --add exists. A full replace built from the delta alone
    would drop `b` and `c` here, permanently, with a 200."""
    plan = plan_deploy(
        "m", current=[ref("b"), ref("c")], base=4, add=["a"], latest={"a": 1},
    )
    assert [p.id for p in plan.result] == ["a", "b", "c"]
    assert [p.id for p in plan.added] == ["a"]
    assert [p.id for p in plan.unchanged] == ["b", "c"]
    assert plan.removed == []


def test_remove_takes_exactly_one_out():
    plan = plan_deploy("m", current=[ref("a"), ref("b")], base=1, remove=["a"])
    assert [p.id for p in plan.result] == ["b"]
    assert [p.id for p in plan.removed] == ["a"]


def test_removing_something_not_deployed_is_refused():
    """Silently succeeding would let a typo read as "already gone"."""
    with pytest.raises(RefError, match="not deployed"):
        plan_deploy("m", current=[ref("a")], base=1, remove=["b"])


def test_set_replaces_the_whole_set():
    plan = plan_deploy(
        "m", current=[ref("a"), ref("b")], base=2, replace=["c"], latest={"c": 5},
    )
    assert [p.id for p in plan.result] == ["c"]
    assert [p.id for p in plan.removed] == ["a", "b"]
    assert plan.result[0].version == 5


def test_set_cannot_be_mixed_with_add_or_remove():
    """"exactly these" and "these as well" have no single reading."""
    with pytest.raises(RefError, match="cannot be combined"):
        plan_deploy("m", current=[], base=None, replace=["a"], add=["b"], latest={"a": 1, "b": 1})


def test_a_version_or_effect_change_is_reported_as_changed_not_add_remove():
    plan = plan_deploy(
        "m", current=[ref("a", 1, "enforce")], base=3, add=["a@2:observe"], latest={"a": 2},
    )
    assert plan.added == [] and plan.removed == []
    was, now = plan.changed[0]
    assert (was.version, was.effect) == (1, "enforce")
    assert (now.version, now.effect) == (2, "observe")


def test_a_noop_is_detectable_so_the_cli_can_skip_the_write():
    plan = plan_deploy("m", current=[ref("a")], base=1, add=["a"], latest={"a": 1})
    assert plan.is_noop is True


def test_deploying_to_a_machine_with_nothing_yet():
    plan = plan_deploy("m", current=None, base=None, add=["a"], latest={"a": 2})
    assert [p.label for p in plan.result] == ["a@2:enforce"]
    assert plan.base is None


def test_the_result_is_sorted_so_two_equal_sets_serialise_identically():
    plan = plan_deploy("m", current=[], base=None, add=["c", "a", "b"],
                       latest={"a": 1, "b": 1, "c": 1})
    assert [p.id for p in plan.result] == ["a", "b", "c"]


def test_plan_json_carries_the_diff_a_harness_would_otherwise_recompute():
    plan = plan_deploy("m", current=[ref("b")], base=1, add=["a"], latest={"a": 1})
    d = plan.to_dict()
    assert d["machineId"] == "m" and d["base"] == 1 and d["noop"] is False
    assert [p["id"] for p in d["result"]] == ["a", "b"]
    assert [p["id"] for p in d["added"]] == ["a"]


# ── the race check ───────────────────────────────────────────────────────────


def test_a_clean_write_is_base_plus_one():
    check_race(4, 5)  # no raise


def test_a_skipped_generation_means_someone_else_wrote():
    with pytest.raises(ApiError, match="someone else deployed"):
        check_race(4, 7)


def test_a_repeated_generation_is_also_a_race():
    with pytest.raises(ApiError):
        check_race(4, 4)


def test_a_first_deployment_has_no_base_to_check():
    check_race(None, 1)  # no raise


def test_the_race_message_says_a_deploy_replaces():
    """The operator's next move depends on knowing it did not merge."""
    with pytest.raises(ApiError, match="REPLACES"):
        check_race(1, 9)


# ── source input ─────────────────────────────────────────────────────────────


def test_source_from_a_path(tmp_path):
    f = tmp_path / "p.mjs"
    f.write_text("export default {}")
    assert read_source(str(f)) == "export default {}"


def test_source_from_an_at_path(tmp_path):
    f = tmp_path / "p.mjs"
    f.write_text("x")
    assert read_source(f"@{f}") == "x"


def test_source_from_explicit_stdin():
    assert read_source("-", stdin=io.StringIO("piped"), isatty=False) == "piped"


def test_source_from_a_pipe_with_no_argument():
    assert read_source(None, stdin=io.StringIO("piped"), isatty=False) == "piped"


def test_source_from_a_paste_prompts_first():
    """On a TTY, blocking on stdin without saying so is indistinguishable from a hang."""
    called = []
    out = read_source(None, stdin=io.StringIO("pasted"), isatty=True, prompt=lambda: called.append(1))
    assert out == "pasted" and called == [1]


def test_a_missing_file_names_the_path():
    with pytest.raises(RefError, match="no such file"):
        read_source("/nope/definitely-not-here.mjs")


# ── the JSON contract ────────────────────────────────────────────────────────


def test_models_emit_the_server_shape_not_pythons():
    """`vars()` would leak snake_case into a contract that is camelCase
    everywhere else — a difference a harness finds at runtime, not in review."""
    from fp_cli.models import Deployment, Machine, PolicyVersion

    pv_keys = set(PolicyVersion.from_dict({"id": "a", "version": 1}).to_dict())
    assert "createdAt" in pv_keys and "created_at" not in pv_keys

    dep_keys = set(Deployment.from_dict({"machineId": "m", "deployment": 1}).to_dict())
    assert "machineId" in dep_keys and "machine_id" not in dep_keys

    m = Machine.from_dict({"machineId": "m", "deployment": 3, "appliedDeployment": 1})
    keys = set(m.to_dict())
    assert "appliedDeployment" in keys
    assert not [k for k in keys if "_" in k], keys


def test_drift_is_intent_ahead_of_delivery():
    """The one field the CLI computes, and the reason `fleet diff` exists: a
    machine can be deployed-to and still enforcing an older set."""
    from fp_cli.models import Machine

    def m(intended, delivered):
        return Machine.from_dict({"machineId": "m", "deployment": intended,
                                  "appliedDeployment": delivered})

    assert m(3, 1).drifted is True     # behind
    assert m(3, None).drifted is True  # never collected anything
    assert m(3, 3).drifted is False    # in sync
    assert m(None, None).drifted is False  # nothing deployed: not drift


def test_a_nul_byte_in_source_is_refused_with_a_readable_reason():
    """Reaching Postgres with a NUL returns a bare "database error" — an internal
    failure shown to somebody who most likely pointed the command at a binary
    file. Catching it here turns that into a sentence."""
    with pytest.raises(RefError, match="NUL byte"):
        read_source("-", stdin=io.StringIO("export default {}\x00\x01"), isatty=False)


def test_the_nul_check_covers_every_input_shape(tmp_path):
    """A guard on one of five paths is not a guard."""
    f = tmp_path / "bin.mjs"
    f.write_text("ok\x00bad")
    with pytest.raises(RefError, match="NUL byte"):
        read_source(str(f))
    with pytest.raises(RefError, match="NUL byte"):
        read_source(f"@{f}")
    with pytest.raises(RefError, match="NUL byte"):
        read_source(None, stdin=io.StringIO("a\x00b"), isatty=False)
    with pytest.raises(RefError, match="NUL byte"):
        read_source(None, stdin=io.StringIO("a\x00b"), isatty=True, prompt=lambda: None)


def test_ordinary_unicode_is_not_mistaken_for_binary():
    """Emoji and CJK are legitimate policy content; only NUL is refused."""
    assert read_source("-", stdin=io.StringIO("// 日本語 🎌\n"), isatty=False) == "// 日本語 🎌\n"
