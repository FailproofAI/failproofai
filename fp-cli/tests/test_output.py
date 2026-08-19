from __future__ import annotations

import json

from rich.console import Console

from fp_cli import output, theme
from fp_cli.models import (Alert, AgentEvent, ApiKey, DashboardUser, Evaluation, Incident,
                                 IncidentComment, IncidentSubscriber, QueryResult, SavedQuery, Session,
                                 SessionUser)


def _event(ts: str, event_type: str = "tool_use") -> AgentEvent:
    return AgentEvent(id=1, session_id="sess-1", agent_id="bot",
                      event_type=event_type, ts=ts, environment="prod")


def _wide_stdout(width: int = 140) -> None:
    """Force wide, no-color stdout+stderr consoles so panels/footers never wrap in assertions."""
    output.configure(no_color=True, quiet=False)
    output._stdout = Console(width=width, no_color=True)
    output._stderr = Console(stderr=True, width=width, no_color=True)


def test_format_scores():
    assert output.format_scores(None) == "-"
    assert output.format_scores({}) == "-"
    rendered = output.format_scores({"helpfulness": 0.857, "count": 1})
    assert "helpfulness=0.86" in rendered
    assert "count=1.00" in rendered


def test_emit_json_roundtrip(capsys):
    output.emit_json({"a": 1, "b": [1, 2, 3]})
    out = capsys.readouterr().out
    assert json.loads(out) == {"a": 1, "b": [1, 2, 3]}


def test_emit_json_serializes_dataclasses(capsys):
    output.emit_json({"user": SessionUser(id="u1", email="e@test")})
    data = json.loads(capsys.readouterr().out)
    assert data["user"] == {
        "id": "u1",
        "email": "e@test",
        "is_instance_admin": False,
        "memberships": [],
    }


def test_print_table_writes_to_stdout(capsys):
    output.configure(no_color=True, quiet=False)
    output.print_table(["a", "b"], [["1", "2"]], title="Demo")
    out = capsys.readouterr().out
    assert "Demo" in out
    assert "1" in out and "2" in out


def test_info_and_error_go_to_stderr(capsys):
    output.configure(no_color=True, quiet=False)
    output.info("hello")
    output.error("boom")
    captured = capsys.readouterr()
    assert "hello" in captured.err
    assert "boom" in captured.err
    assert captured.out == ""


def test_quiet_suppresses_info(capsys):
    output.configure(no_color=True, quiet=True)
    output.info("hidden")
    output.error("shown")
    captured = capsys.readouterr()
    assert "hidden" not in captured.err
    assert "shown" in captured.err
    # reset for other tests
    output.configure(no_color=True, quiet=False)


# --- events box renderer ----------------------------------------------------


def test_parse_iso():
    assert output._parse_iso("2026-06-22T12:21:54.104714Z") is not None
    assert output._parse_iso("2026-06-22T12:21:54+00:00") is not None
    assert output._parse_iso("t") is None  # opaque/unparseable → None (caller falls back)
    assert output._parse_iso("") is None


def test_render_events_box_to_stdout(capsys):
    output.configure(no_color=True, quiet=False)
    output.render_events([_event("2026-06-22T12:21:54Z")], order="desc")
    captured = capsys.readouterr()
    # The box (human data view) goes to STDOUT; the title carries count, direction and date.
    assert "events" in captured.out
    assert "newest first" in captured.out
    assert "2026-06-22" in captured.out
    assert captured.err == ""


def test_render_events_order_and_empty(capsys):
    output.configure(no_color=True, quiet=False)
    output.render_events([], order="asc")
    out = capsys.readouterr().out
    assert "oldest first" in out
    assert "no events in this window" in out


def test_events_footer_more_available(capsys):
    output.configure(no_color=True, quiet=False)
    output.events_footer(10, more=True)
    err = capsys.readouterr().err  # the footer hint is stderr chrome
    assert "10 shown" in err
    assert "more available" in err
    assert "fp events --all" in err


def test_events_footer_no_more_and_quiet(capsys):
    output.configure(no_color=True, quiet=False)
    output.events_footer(3, more=False)
    err = capsys.readouterr().err
    assert "3 shown" in err
    assert "more available" not in err
    output.configure(no_color=True, quiet=True)
    output.events_footer(3, more=True)
    assert capsys.readouterr().err == ""  # suppressed under --quiet
    output.configure(no_color=True, quiet=False)


def test_events_columns_reordered(capsys):
    # New column order: time, type, env, agent, session.
    _wide_stdout()
    output.render_events([_event("2026-06-22T12:21:54Z", "tool_use")], order="desc")
    out = capsys.readouterr().out
    i = {c: out.index(c) for c in ("time", "type", "env", "agent", "session")}
    assert i["time"] < i["type"] < i["env"] < i["agent"] < i["session"]
    output.configure(no_color=True, quiet=False)


# --- sessions box renderer + score helpers ----------------------------------


def test_fmt_score_num():
    assert output._fmt_score_num(0.94) == ".94"
    assert output._fmt_score_num(0.90) == ".90"
    assert output._fmt_score_num(1.0) == "1.0"
    assert output._fmt_score_num(0.0) == ".00"
    assert output._fmt_score_num(0.7) == ".70"


def test_fmt_avg():
    # aggregate avg keeps the leading zero; 1.00 -> 1.0
    assert output._fmt_avg(0.71) == "0.71"
    assert output._fmt_avg(0.99) == "0.99"
    assert output._fmt_avg(1.0) == "1.0"


def test_score_value_thresholds():
    output.configure(no_color=False, quiet=False)  # no '!' marker in the colour path
    assert output._score_value(0.94) == (".94", theme.SCORE_HIGH)   # >= .80 cyan-green
    assert output._score_value(0.66) == (".66", theme.AMBER)        # .50–.80 amber
    assert output._score_value(0.45) == (".45", theme.ERROR)        # < .50 red
    # non-numeric: pass/fail substring rule
    assert output._score_value("fail") == ("fail", theme.ERROR)
    assert output._score_value("pass") == ("pass", theme.SUCCESS)
    assert output._score_value("partial")[1] == theme.TEXT_DIM


def test_score_value_no_color_failure_marker():
    output.configure(no_color=True, quiet=False)
    label, _ = output._score_value(0.45)
    assert label == ".45!"   # < .50 gets a '!' so failures stay visible without colour
    label_ok, _ = output._score_value(0.66)
    assert label_ok == ".66"  # >= .50 gets no marker
    output.configure(no_color=False, quiet=False)


def test_status_color_enum():
    assert output._status_cell("done").style == theme.SUCCESS
    assert output._status_cell("error").style == theme.ERROR
    assert output._status_cell("timeout").style == theme.ERROR
    assert output._status_cell("weird-unknown").style == theme.TEXT_DIM  # never crash


def test_short_session():
    assert output._short_session("sess-20260615-fcf97e01") == "sess-…fcf97e01"
    assert output._short_session("sess-20260615-fcf97e01", full=True) == "sess-20260615-fcf97e01"
    assert output._short_session("nonnum-3-b9d9de") == "nonnum-3-b9d9de"  # short → intact
    assert output._short_session("short") == "short"


def test_scores_cell_budget_truncates_with_plus_n():
    scores = {"a": 0.9, "b": 0.8, "c": 0.7, "d": 0.6, "e": 0.5}
    cell = output._scores_cell(scores, budget=24)
    assert "+" in cell.plain                 # leftover pairs collapsed to +N
    assert cell.cell_len <= 24 + 1           # stays within (roughly) the budget
    full = output._scores_cell(scores, full=True)
    assert "+" not in full.plain             # full shows every pair
    assert "a" in full.plain and "e" in full.plain


def _sample_eval():
    return Evaluation(id="1", session_id="sess-20260615-fcf97e01", agent_id="agent-codegen",
                      environment="staging", status="done", scores={"coherence": 0.94},
                      completed_at="2026-06-22T12:56:31Z")


def test_render_sessions_box_has_no_scores(capsys):
    _wide_stdout()
    output.render_sessions([_sample_eval()])
    out = capsys.readouterr().out
    assert "sessions" in out and "newest first" in out and "2026-06-22" in out
    assert "agent-codegen" in out and "done" in out
    assert "12:56:31" in out and "sess-…fcf97e01" in out
    assert "coherence" not in out and "scores" not in out  # scores moved to evals
    output.configure(no_color=True, quiet=False)


def test_render_evals_box_has_scores(capsys):
    _wide_stdout()
    output.render_evals([_sample_eval()])
    out = capsys.readouterr().out
    assert "evals" in out and "scores" in out and "coherence" in out
    assert "agent-codegen" in out and "sess-…fcf97e01" in out
    output.configure(no_color=True, quiet=False)


def test_render_sessions_empty(capsys):
    _wide_stdout()
    output.render_sessions([])
    assert "no sessions" in capsys.readouterr().out
    output.configure(no_color=True, quiet=False)


def test_sessions_footer_plain_no_legend(capsys):
    output.configure(no_color=True, quiet=False)
    output.sessions_footer(3, more=True)
    err = capsys.readouterr().err
    assert "3 shown" in err and "fp sessions --all" in err


# ── multi-agent roster (agents column) ─────────────────────────────────────

def _multi_session():
    """A 3-agent session: root `agent-codegen`, roster sorted by event count desc."""
    return Session(
        session_id="sess-20260716-abcd1234", agent_id="agent-codegen", environment="dev",
        last_event_at="2026-07-16T14:00:00Z",
        agents=[
            {"agent_id": "agent-codegen", "event_count": 52},
            {"agent_id": "agent-linter", "event_count": 18},
            {"agent_id": "agent-testgen", "event_count": 9},
        ],
    )


def _single_session():
    return Session(
        session_id="sess-20260716-single01", agent_id="solo-agent", environment="dev",
        last_event_at="2026-07-16T13:00:00Z",
        agents=[{"agent_id": "solo-agent", "event_count": 12}],
    )


def test_is_multi_agent():
    assert output.is_multi_agent(_multi_session()) is True
    assert output.is_multi_agent(_single_session()) is False
    # a legacy row with no `agents` field is never multi-agent (back-compat)
    assert output.is_multi_agent(Session(session_id="s", agent_id="a", environment="dev")) is False


def test_render_sessions_shows_plus_n_badge(capsys):
    _wide_stdout()
    output.render_sessions([_multi_session()])
    out = capsys.readouterr().out
    assert "agent-codegen +2" in out           # 3 agents → +2 others, badge next to the root
    # the other agents' NAMES are never listed inline in the default view
    assert "agent-linter" not in out and "agent-testgen" not in out
    output.configure(no_color=True, quiet=False)


def test_render_sessions_single_agent_has_no_badge(capsys):
    _wide_stdout()
    output.render_sessions([_single_session()])
    out = capsys.readouterr().out
    assert "solo-agent" in out
    assert "+" not in out                       # single-agent → no badge at all
    output.configure(no_color=True, quiet=False)


def test_render_sessions_expanded_lists_full_roster(capsys):
    _wide_stdout()
    output.render_sessions_expanded([_multi_session()])
    out = capsys.readouterr().out
    assert "agent-codegen" in out and "52 ev" in out       # every agent listed with its count
    assert "agent-linter" in out and "18 ev" in out
    assert "agent-testgen" in out and "9 ev" in out
    assert "●" not in out                                  # uniform: no special "root" marker
    assert "├" in out and "└" in out                       # uniform tree glyphs, └ closes the list
    assert "sessions · 1" in out                           # panel count = sessions, not rows
    output.configure(no_color=True, quiet=False)


def test_render_sessions_expanded_skips_single_agent(capsys):
    _wide_stdout()
    output.render_sessions_expanded([_single_session()])
    out = capsys.readouterr().out
    assert "solo-agent" in out
    assert "├ solo-agent" not in out            # single-agent rows are not expanded
    output.configure(no_color=True, quiet=False)


def test_sessions_footer_multi_agent(capsys):
    output.configure(no_color=True, quiet=False)
    output.sessions_footer(6, more=True, multi_agent=2)
    err = capsys.readouterr().err
    assert "6 shown" in err
    assert "2 multi-agent" in err and "fp sessions --agents" in err
    assert "fp sessions --all" in err     # the more-available segment still shows


def test_sessions_footer_no_multi_agent_hides_segment(capsys):
    output.configure(no_color=True, quiet=False)
    output.sessions_footer(3, more=False, multi_agent=0)
    err = capsys.readouterr().err
    assert "3 shown" in err
    assert "multi-agent" not in err and "--agents" not in err
    assert "score:" not in err  # sessions has no scores → no legend
    output.configure(no_color=True, quiet=False)


def test_evals_footer_has_legend(capsys):
    output.configure(no_color=True, quiet=False)
    output.evals_footer(3, more=False)
    err = capsys.readouterr().err
    assert "3 shown" in err
    assert "score:" in err and "≥.80" in err and "<.50" in err
    output.configure(no_color=True, quiet=False)


def test_avg_bar_zoomed_braille():
    output.configure(no_color=False, quiet=False)  # colour path → braille glyphs
    # zoomed .40–1.0: 0.70 → (0.30/0.60)=0.5 → 5 filled
    bar = output._avg_bar(0.70)
    assert bar.plain.count("⣿") == 5 and bar.plain.count("⣀") == 5
    assert output._avg_bar(1.0).plain.count("⣿") == 10   # at/above hi → full
    assert output._avg_bar(0.40).plain.count("⣿") == 0   # at floor → empty
    assert output._avg_bar(None).plain == "⣀" * 10       # no avg → all track


def test_avg_bar_blocks_when_no_color():
    output.configure(no_color=True, quiet=False)  # no-colour → solid-block fallback
    bar = output._avg_bar(0.70)
    assert bar.plain.count("█") == 5 and bar.plain.count("░") == 5
    output.configure(no_color=False, quiet=False)


def test_render_eval_aggregate(capsys):
    _wide_stdout()
    data = {
        "total": 324,
        "status_counts": {"done": 320, "error": 4, "timeout": 0},
        "score_stats": [
            {"key": "helpfulness", "count": 285, "avg": 0.66, "min": 0.28, "max": 1.0, "p50": 0.7},
            {"key": "coherence", "count": 13, "avg": 0.81, "min": 0.54, "max": 0.98, "p50": 0.83},
        ],
        "timeline": {"bucket_unit": "day", "points": []},
    }
    output.render_eval_aggregate(data)
    cap = capsys.readouterr()
    out = cap.out
    assert "eval-aggregate" in out and "324" in out and "320 done" in out
    assert "98.8% success rate" in out                       # 320/324
    assert "score stats" in out and "2 metrics" in out and "sorted by avg" in out
    # worst-avg first: helpfulness (.66) before coherence (.81)
    assert out.index("helpfulness") < out.index("coherence")
    assert "0.66" in out and "0.81" in out                   # avg keeps leading zero
    # the band/scale legend prints under the panel (stderr chrome)
    assert "scale .40–1.0" in cap.err and "≥.80" in cap.err
    output.configure(no_color=True, quiet=False)


# --- errors list + aggregate -------------------------------------------------


def _errevent(event_type, summary, ts="2026-06-22T17:51:34Z"):
    # A light-feed (/events/summary) row: the server supplies `summary` precomputed; the CLI
    # renders it directly and never parses the (absent) payload.
    return AgentEvent(id=1, session_id="sess-20260622-4b90b240", agent_id="agent-orderbot",
                      event_type=event_type, ts=ts, environment="prod", summary=summary,
                      is_error=("error" in event_type or "fail" in event_type))


def test_event_cell_red_only_on_error_substring():
    output.configure(no_color=False, quiet=False)
    err = output._event_cell("error")
    ok = output._event_cell("tool_result")
    # the error type's spans are ERROR red; a neutral type has none
    assert any(s.style == theme.ERROR for s in err.spans)
    assert not any(s.style == theme.ERROR for s in ok.spans)


def test_render_errors_box(capsys):
    _wide_stdout()
    output.render_errors([_errevent("error", "RateLimitError: upstream timed out")])
    out = capsys.readouterr().out
    assert "errors" in out and "newest first" in out
    assert "agent-orderbot" in out and "sess-…4b90b240" in out  # truncated session (shared last-8)
    assert "RateLimitError: upstream timed out" in out          # server-computed summary field
    assert "17:51:34" in out
    output.configure(no_color=True, quiet=False)


def test_render_errors_empty(capsys):
    _wide_stdout()
    output.render_errors([])
    assert "no errors" in capsys.readouterr().out
    output.configure(no_color=True, quiet=False)


def test_render_error_aggregate_card(capsys):
    _wide_stdout()
    output.render_error_aggregate({"total": 66, "sessions": 62, "agents": 6, "last_ts": "2026-01-01T00:00:00Z", "bins": []})
    out = capsys.readouterr().out
    assert "errors-aggregate" in out and "66" in out and "errored events" in out
    assert "across" in out and "62 sessions" in out and "6 agents" in out
    output.configure(no_color=True, quiet=False)


def test_render_error_aggregate_empty_is_healthy(capsys):
    _wide_stdout()
    output.render_error_aggregate({"total": 0, "sessions": 0, "agents": 0, "last_ts": None, "bins": []})
    out = capsys.readouterr().out
    assert "no errors found" in out
    output.configure(no_color=True, quiet=False)


def test_relative_age():
    assert output._relative_age(None) == ""
    assert output._relative_age("not-a-ts") == ""
    assert output._relative_age("2020-01-01T00:00:00Z").endswith("ago")  # well in the past


# --- orgs: current card + perms + shared panels -----------------------------

_ORGS = [
    {"is_active": True, "slug": "globex", "name": "Globex Corp", "role": "admin", "perms": 28},
    {"is_active": False, "slug": "acme", "name": "Acme Corp", "role": "admin", "perms": 27},
]


def test_render_orgs_list(capsys):
    _wide_stdout()
    output.render_orgs_list(_ORGS)
    out = capsys.readouterr().out
    assert "your orgs" in out and "· 2" in out
    assert "globex" in out and "Globex Corp" in out and "acme" in out
    assert "switch with fp orgs switch <slug>" in out  # generic switch hint
    output.configure(no_color=True, quiet=False)


def test_render_current_org_card(capsys):
    _wide_stdout()
    output.render_current_org(slug="globex", name="Globex Corp", role="admin",
                              permission_count=28, email="admin@local.host")
    cap = capsys.readouterr()
    out = cap.out
    assert "current org" in out and "globex" in out and "Globex Corp" in out
    assert "role admin" in out and "28 permissions" in out
    assert "signed in as admin@local.host" in out
    # footer cross-links the related commands (stderr chrome)
    assert "fp orgs perms" in cap.err and "fp orgs switch <slug>" in cap.err
    output.configure(no_color=True, quiet=False)


def test_render_org_perms(capsys):
    _wide_stdout()
    output.render_org_perms(slug="globex", role="admin", name="Globex Corp",
                            permissions=["dashboards:read", "dashboards:write", "keys:read", "keys:delete", "agent:use"])
    out = capsys.readouterr().out
    # header leads with the org name + slug + role; the count moved into the box title
    assert "Globex Corp" in out and "globex" in out and "role admin" in out
    assert "permissions · 5 · Globex Corp" in out
    assert "dashboards" in out and "keys" in out and "agent" in out
    output.configure(no_color=True, quiet=False)


def test_permissions_panel_shared_with_whoami():
    # whoami and orgs perms render the SAME permissions component (no drift).
    perms = ["keys:read", "keys:delete", "dashboards:read"]
    a = output.render_permissions_panel(perms)
    b = output.render_permissions_panel(perms)
    assert type(a) is type(b)  # same renderable type from the one shared helper


# --- list <kind> column-flow ------------------------------------------------


def test_render_value_list_short_no_footer(capsys):
    _wide_stdout()
    output.render_value_list("envs", ["prod", "dev", "staging"], description="seen across events")
    cap = capsys.readouterr()
    out = cap.out
    assert "envs · 3 seen across events" in out
    for v in ("dev", "prod", "staging"):
        assert v in out
    # the filter-hint footer was removed from every list kind
    assert "filter" not in cap.err


def test_render_value_list_columns_and_sorted(capsys):
    _wide_stdout()
    vals = [f"v{i:02d}" for i in range(20)]  # 20 items, COL_HEIGHT 8 → 3 columns
    output.render_value_list("tools", list(reversed(vals)), description="seen across events")
    out = capsys.readouterr().out
    assert "tools · 20" in out
    assert all(v in out for v in vals)        # every value shown (no truncation)
    # sorted + column-major: col0 = v00..v07, so v00 appears before v08 (col1) and v16 (col2)
    assert out.index("v00") < out.index("v08") < out.index("v16")


def test_render_value_list_empty(capsys):
    _wide_stdout()
    output.render_value_list("error_types", [], description="seen across events")
    assert "none found" in capsys.readouterr().out
    output.configure(no_color=True, quiet=False)


def test_render_value_list_never_has_footer(capsys):
    _wide_stdout()
    output.render_value_list("models", ["gpt", "claude"])
    assert "filter" not in capsys.readouterr().err  # the footer was removed for all kinds
    output.configure(no_color=True, quiet=False)


def test_render_value_list_narrow_caps_columns(capsys):
    from rich.console import Console
    output.configure(no_color=True, quiet=False)
    output._stdout = Console(width=30, no_color=True)  # very narrow
    vals = [f"value-{i:02d}" for i in range(20)]
    output.render_value_list("tools", vals)
    out = capsys.readouterr().out
    # never wider than the terminal; all values still present (taller, fewer columns)
    assert all(len(line) <= 30 for line in out.splitlines())
    assert all(v in out for v in vals)
    output.configure(no_color=True, quiet=False)


# --- keys: list box + status + destructive confirm/cancel/secret -------------


def test_short_id():
    assert output._short_id("1f58376d-7947-9826") == "1f58…9826"
    assert output._short_id("short") == "short"


def test_key_status_cell():
    output.configure(no_color=False, quiet=False)
    act = output._key_status_cell("active")
    rev = output._key_status_cell("revoked")
    unk = output._key_status_cell("mystery")
    assert "●" in act.plain and any(s.style == theme.SUCCESS for s in act.spans)   # live = filled green
    assert "○" in rev.plain and any(s.style == theme.ERROR for s in rev.spans)     # dead = hollow red
    assert "●" in unk.plain and any(s.style == theme.TEXT_DIM for s in unk.spans)  # unknown = neutral


def test_render_keys_box_and_footer(capsys):
    _wide_stdout()
    keys = [
        ApiKey(id="1f58376d", name="admin", permissions=["a", "b"], created_at="2026-06-18T05:14:00Z"),
        ApiKey(id="9c22aa01", name="old", permissions=["x"], created_at="2026-06-10T00:00:00Z", revoked_at="2026-06-12T00:00:00Z"),
    ]
    output.render_keys(keys)
    output.keys_footer(keys)
    cap = capsys.readouterr()
    out = cap.out
    assert "api keys · 2 · active first" in out
    assert "admin" in out and "active" in out and "revoked" in out
    assert "06-18 05:14" in out              # compact created stamp
    assert "1f58376d" not in out             # id hidden by default
    assert out.index("admin") < out.index("old")  # active key sorts above the revoked one
    assert "2 keys" in cap.err and "1 active" in cap.err and "1 revoked" in cap.err
    output.configure(no_color=True, quiet=False)


def test_render_keys_show_id(capsys):
    _wide_stdout()
    output.render_keys([ApiKey(id="1f58376d-7947-9826", name="admin", created_at="2026-06-18T05:14:00Z")], show_id=True)
    assert "1f58…9826" in capsys.readouterr().out  # short id column when --show-id
    output.configure(no_color=True, quiet=False)


def test_print_cancelled(capsys):
    output.configure(no_color=True, quiet=False)
    output.print_cancelled()
    err = capsys.readouterr().err  # boxed chrome → stderr
    assert "cancelled" in err and "nothing changed" in err


def test_key_not_found(capsys):
    output.configure(no_color=True, quiet=False)
    output.key_not_found("admn")
    err = capsys.readouterr().err  # red error box → stderr
    assert "error" in err and "no key named" in err and "admn" in err
    assert "fp keys list" in err  # hint


def test_render_secret_box(capsys):
    output.configure(no_color=True, quiet=False)
    output.render_secret_box("admin", "a" * 64)
    err = capsys.readouterr().err
    assert "secret rotated" in err and "new secret for key" in err and "admin" in err
    assert "a" * 64 in err and "shown once" in err
    output.configure(no_color=True, quiet=False)


def test_key_disabled_box(capsys):
    output.configure(no_color=True, quiet=False)
    output.key_disabled("admin")
    err = capsys.readouterr().err  # green boxed result → stderr (scripts use --json / exit code)
    assert "disabled" in err and "admin" in err and "it can no longer be used" in err


# --- users: list box + identity cards + permission diff ----------------------


def _du(**over) -> DashboardUser:
    base = dict(id="u1", email="a@test", permissions=[], permission_set=None,
                permission_added=[], permission_removed=[], disabled_at=None,
                is_protected=False, created_at="2026-06-25T08:00:00Z", updated_at="")
    base.update(over)
    return DashboardUser(**base)


def test_fmt_user_joined():
    assert output._fmt_user_joined("2026-06-25T08:00:00Z", False) == "06-25"
    assert output._fmt_user_joined("2026-06-25T08:00:00Z", True) == "2026-06-25"  # spans years
    assert output._fmt_user_joined("nope", False) == "-"


def test_user_status_cell():
    output.configure(no_color=False, quiet=False)
    act = output._user_status_cell(False)
    dis = output._user_status_cell(True)
    assert "● active" in act.plain and any(s.style == theme.SUCCESS for s in act.spans)
    assert "○ disabled" in dis.plain and any(s.style == theme.ERROR for s in dis.spans)
    muted = output._user_status_cell(True, muted=True)
    assert any(s.style == theme.TEXT_DIM for s in muted.spans)  # dimmed in disabled list rows
    output.configure(no_color=True, quiet=False)


def test_render_users_box_and_footer(capsys):
    _wide_stdout()
    users = [
        _du(id="u1", email="root@test", permissions=["events:read"] * 28, permission_set="admin", is_protected=True),
        _du(id="u2", email="dev@test", permissions=["events:read"] * 9, permission_set="read-only"),
        _du(id="u3", email="off@test", permission_set="standard", disabled_at="2026-01-01T00:00:00Z"),
    ]
    output.render_users(users)
    output.users_footer(users)
    cap = capsys.readouterr()
    out, err = cap.out, cap.err
    assert "users · 3" in out
    for c in ("email", "access", "perms", "joined", "status"):
        assert c in out
    assert "root@test" in out and "admin" in out and "06-25" in out
    assert "active" in out and "disabled" in out
    assert "P" in out  # protected lock fallback (no-color → P marker)
    assert "3 users" in err and "2 active" in err and "1 disabled" in err and "1 protected" in err
    output.configure(no_color=True, quiet=False)


def test_render_users_active_sorted_first(capsys):
    _wide_stdout()
    output.render_users([
        _du(id="u2", email="off@test", disabled_at="2026-01-01T00:00:00Z"),
        _du(id="u1", email="on@test", disabled_at=None),
    ])
    out = capsys.readouterr().out
    assert out.index("on@test") < out.index("off@test")  # active above disabled
    output.configure(no_color=True, quiet=False)


def test_render_users_empty(capsys):
    _wide_stdout()
    output.render_users([])
    assert "no users" in capsys.readouterr().out
    output.configure(no_color=True, quiet=False)


def test_render_user_show_card_and_perms(capsys):
    _wide_stdout()
    u = _du(email="dev@test", permissions=["keys:read", "keys:delete", "dashboards:read"],
            permission_set="admin", is_protected=True)
    output.render_user_show(u)
    out = capsys.readouterr().out  # show is a read view → stdout
    assert "user" in out and "dev@test" in out and "protected" in out
    assert "access admin" in out and "3 permissions" in out and "active" in out
    assert "permissions · 3" in out and "keys" in out and "dashboards" in out
    output.configure(no_color=True, quiet=False)


def test_render_user_created_green_card(capsys):
    _wide_stdout()
    u = _du(email="new@test", permissions=["events:read", "keys:read"], permission_set="read-only")
    output.render_user_created(u)
    err = capsys.readouterr().err  # write result → stderr chrome
    assert "user created" in err and "new@test" in err
    assert "access read-only" in err and "2 permissions" in err and "active" in err
    assert "permissions · 2 · read-only" in err  # suffix shows the set
    output.configure(no_color=True, quiet=False)


def test_render_user_updated_diff(capsys):
    _wide_stdout()  # no-color → +/- prefixes for the diff
    result = _du(email="dev@test", permissions=["users:read", "users:create", "keys:read"], permission_set="admin")
    union = sorted({"users:read", "users:write", "keys:read"} | {"users:read", "users:create", "keys:read"})
    output.render_user_updated(result, added=["users:create"], removed=["users:write"], union=union)
    err = capsys.readouterr().err
    assert "permissions updated · dev@test" in err
    assert "now 3" in err and "+1 added" in err and "−1 removed" in err
    assert "permissions · 3" in err          # NEW set size (struck removal not counted)
    assert "+create" in err and "-write" in err  # added chip / removed ghost (no-color prefixes)
    assert "unchanged" in err                # legend
    output.configure(no_color=True, quiet=False)


def test_user_notice_boxes(capsys):
    output.configure(no_color=True, quiet=False)
    output.user_not_found("ghost@test")
    output.user_disabled("dev@test")
    output.user_enabled("dev@test")
    output.user_no_change()
    err = capsys.readouterr().err  # all notice boxes → stderr
    assert "no user with email" in err and "ghost@test" in err and "fp users list" in err
    assert "can no longer sign in" in err and "fp users enable dev@test" in err
    assert "they can sign in again" in err
    assert "no change" in err and "already match" in err


# --- saved queries: list box + show (card + highlighted SQL) ----------------


def _sq(**over) -> SavedQuery:
    base = dict(id="q1", name="errs", description="", sql_text="select 1", params=[],
                created_by="system", created_at="2026-06-18T05:14:51Z", updated_at="")
    base.update(over)
    return SavedQuery(**base)


def test_render_queries_box(capsys):
    _wide_stdout()
    qs = [
        _sq(name="q_eval_score_avg", description="Average value for each score key. " * 6, created_by="system"),
        _sq(name="q_eval_total", description="Count by KPI tiles.", created_by="alice@corp.com"),
    ]
    output.render_queries(qs)
    cap = capsys.readouterr()
    out, err = cap.out, cap.err
    assert "saved queries · 2" in out  # the count glows in the title
    for c in ("name", "description", "created by", "created"):
        assert c in out
    assert "q_eval_score_avg" in out and "06-18" in out
    assert "…" in out                 # long description truncated to one line
    assert "updated" not in out       # updated_at not shown
    assert "run one with" not in err  # the run-hint footer was removed


def test_render_queries_empty(capsys):
    _wide_stdout()
    output.render_queries([])
    assert "no saved queries" in capsys.readouterr().out
    output.configure(no_color=True, quiet=False)


def test_render_query_show_card_and_sql(capsys):
    _wide_stdout()
    q = _sq(name="q_eval_score_avg", description="Average value for each score key.",
            sql_text="SELECT score_key,\n  avg(score_val) AS value\nFROM analytics.evaluations")
    output.render_query_show(q)
    out = capsys.readouterr().out
    assert "q_eval_score_avg · saved query" in out
    assert "Average value for each score key." in out                 # full description
    assert "created by system · created 2026-06-18" in out            # created_at, not updated_at
    assert "sql · clickhouse" in out
    assert "SELECT" in out and "avg" in out and "FROM" in out          # full SQL, no truncation
    assert "1" in out and "2" in out and "3" in out                    # line numbers
    output.configure(no_color=True, quiet=False)


def test_query_not_found_boxed(capsys):
    _wide_stdout()
    output.query_not_found("nope")
    err = capsys.readouterr().err  # red `error` notice box
    assert "error" in err and "no query named" in err and "nope" in err and "fp query list" in err
    output.configure(no_color=True, quiet=False)


def test_query_write_feedback_boxed(capsys):
    _wide_stdout()
    output.query_exists("dup")
    output.query_failed("Syntax error near 'FORM'")
    output.query_deleted("errs")
    output.query_cancelled("nothing deleted")
    err = capsys.readouterr().err
    assert "a query named" in err and "dup" in err and "fp query update dup" in err
    assert "query failed — Syntax error near 'FORM'" in err and "check your query and rerun it" in err
    assert "deleted saved query" in err and "errs" in err
    assert "cancelled" in err and "nothing deleted" in err  # boxed (title `cancelled` + body)
    output.configure(no_color=True, quiet=False)


def test_query_failed_permission_has_no_query_hint(capsys):
    _wide_stdout()
    output.query_failed("Your account lacks permission", permission=True)
    err = capsys.readouterr().err
    assert "Your account lacks permission" in err
    assert "check your query" not in err  # permission error → no query-fix hint
    output.configure(no_color=True, quiet=False)


def test_render_query_created_and_updated(capsys):
    _wide_stdout()
    q = _sq(name="sample_query_1", description="sample query", sql_text="SELECT * FROM tables")
    output.render_query_created(q)
    err = capsys.readouterr().err  # write result → stderr
    assert "query created" in err and "sample_query_1" in err and "sample query" in err
    assert "created by you · just now" in err
    assert "SELECT" in err and "FROM" in err          # numbered sql box
    assert "run it with" not in err                   # the run-hint footer was removed

    q2 = _sq(name="sample_query1", description="hi", sql_text="SELECT 1")
    output.render_query_updated(q2, old_name="sample_query_1")
    err2 = capsys.readouterr().err
    assert "query updated" in err2 and "sample_query1" in err2 and "was sample_query_1" in err2  # rename shown
    output.configure(no_color=True, quiet=False)


def test_render_query_delete_preview(capsys):
    output.configure(no_color=True, quiet=False)
    q = _sq(name="q_eval_total", description="Count of evaluations matching filters. Used by KPI tiles.",
            created_by="system")
    output.render_query_delete_preview(q)
    err = capsys.readouterr().err  # amber preview box → stderr
    assert "delete saved query" in err and "q_eval_total" in err
    assert "created by system · 2026-06-18" in err


def _qr(columns, rows, elapsed_ms=12) -> QueryResult:
    return QueryResult(columns=columns, rows=rows, truncated=False, elapsed_ms=elapsed_ms)


def test_render_query_result_scalar(capsys):
    _wide_stdout()
    output.render_query_result("q_eval_total", _qr([{"name": "total", "type": "UInt64"}], [["1284"]], 6))
    out = capsys.readouterr().out
    assert "q_eval_total · 1 row · 6ms" in out
    assert "1,284" in out and "total" in out  # thousands separator + column-name label
    output.configure(no_color=True, quiet=False)


def test_render_query_result_record(capsys):
    _wide_stdout()
    res = _qr([{"name": "session", "type": "String"}, {"name": "score", "type": "Float64"}],
              [["sess-2026-4b90", "0.912"]], 8)
    output.render_query_result("latest_run", res)
    out = capsys.readouterr().out
    assert "latest_run · 1 row · 8ms" in out
    assert "session" in out and "sess-2026-4b90" in out and "score" in out and "0.912" in out
    output.configure(no_color=True, quiet=False)


def test_render_query_result_table_and_null(capsys):
    _wide_stdout()
    res = _qr([{"name": "score_key", "type": "String"}, {"name": "value", "type": "Float64"}, {"name": "n", "type": "UInt64"}],
              [["helpfulness", "0.847", "285"], [None, "0.503", "11"]], 12)
    output.render_query_result("q_eval_score_avg", res)
    cap = capsys.readouterr()
    out = cap.out
    assert "q_eval_score_avg · 2 rows · 12ms" in out
    assert "helpfulness" in out and "0.847" in out and "285" in out
    assert "null" in out                       # None cell → 'null', not '-'
    assert "2 rows" in cap.err and "3 columns" in cap.err  # footer
    output.configure(no_color=True, quiet=False)


def test_render_query_result_empty(capsys):
    _wide_stdout()
    output.render_query_result("sample_query", _qr([{"name": "n", "type": "UInt64"}], [], 3))
    assert "no rows returned" in capsys.readouterr().out
    output.configure(no_color=True, quiet=False)


def test_render_query_result_row_cap(capsys):
    _wide_stdout()
    rows = [[str(i), str(i * 2)] for i in range(120)]
    res = _qr([{"name": "a", "type": "UInt64"}, {"name": "b", "type": "UInt64"}], rows, 50)
    output.render_query_result("big", res, row_cap=50)
    cap = capsys.readouterr()
    assert "showing 50 of 120 rows" in cap.err and "query run" in cap.err  # capped footer + --json pointer
    output.configure(no_color=True, quiet=False)


def test_render_query_schema(capsys):
    _wide_stdout()
    data = {"schema": "analytics", "tables": [
        {"name": "events", "columns": [{"name": "id", "type": "int"}, {"name": "tool_name", "type": "string?"}]},
        {"name": "evaluations", "columns": [{"name": "status", "type": "string"}]},
    ]}
    output.render_query_schema(data)
    output.schema_footer(2, 3)
    cap = capsys.readouterr()
    out, err = cap.out, cap.err
    assert "schema · analytics · 2 tables · 3 columns" in out
    assert "events" in out and "evaluations" in out
    assert out.count("events") == 1                  # table name printed once per group (not per column)
    assert "tool_name" in out and "?" in out          # nullable marker
    assert "2 tables" in err and "nullable" in err     # footer legend
    output.configure(no_color=True, quiet=False)


def test_schema_type_cell_categories():
    output.configure(no_color=False, quiet=False)
    assert output._schema_type_cell("int").style == theme.PINK
    assert output._schema_type_cell("string").style == theme.SUCCESS
    assert output._schema_type_cell("uuid").style == theme.BLUE
    assert output._schema_type_cell("timestamp").style == theme.BLUE
    assert output._schema_type_cell("Bool").style == theme.AMBER
    nullable = output._schema_type_cell("string?")
    assert nullable.plain == "string ?" and nullable.style == theme.SUCCESS  # base green + dim ? split off
    output.configure(no_color=True, quiet=False)


# --- alerts: list box + show cards (per-trigger-kind parsing) ----------------


def _alert(**over) -> Alert:
    base = dict(id="a1", name="alert", description=None, enabled=True, trigger_kind="metric_threshold",
                trigger_spec={}, min_breaches=1, eval_window=1, eval_interval_secs=300, severity="warning",
                channels=[], created_by="admin@local.host", created_at="2026-06-28T00:00:00Z",
                updated_at="", last_attempted_at="2026-06-28T00:00:00Z", open_incidents=0)
    base.update(over)
    return Alert(**base)


def test_humanize_secs():
    assert output.humanize_secs(300) == "5m"
    assert output.humanize_secs(900) == "15m"
    assert output.humanize_secs(3600) == "1h"
    assert output.humanize_secs(86400) == "1d"
    assert output.humanize_secs(45) == "45s"
    assert output.humanize_secs(60) == "1m"
    assert output.humanize_secs(None) == "-"


def test_severity_and_status_cells():
    output.configure(no_color=False, quiet=False)
    assert output._severity_cell("critical").style == theme.ERROR
    assert output._severity_cell("warning").style == theme.AMBER
    assert output._severity_cell("info").style == theme.TEXT_DIM
    assert output._severity_cell("weird").style == theme.TEXT_DIM     # unknown → neutral
    on = output._alert_status_cell(True)
    off = output._alert_status_cell(False)
    assert "● on" in on.plain and any(s.style == theme.SUCCESS for s in on.spans)
    assert "○ off" in off.plain
    output.configure(no_color=True, quiet=False)


def test_render_alerts_box_and_footer(capsys):
    _wide_stdout()
    alerts = [
        _alert(name="live", trigger_kind="custom_sql", severity="critical", enabled=True, open_incidents=1),
        _alert(name="off1", trigger_kind="metric_threshold", severity="warning", enabled=False,
               last_attempted_at=None, created_at="2026-06-20T00:00:00Z"),
    ]
    output.render_alerts(alerts)
    output.alerts_footer(alerts)
    cap = capsys.readouterr()
    out, err = cap.out, cap.err
    assert "alerts · 2 · newest first" in out
    for c in ("created", "name", "by", "trigger", "severity", "last alert"):  # no status column
        assert c in out
    assert "status" not in out                      # the status column was removed
    assert "live" in out and "admin@local.host" in out   # the actual creator, not "you"
    assert "never" in out
    assert out.index("live") < out.index("off1")   # newest first
    assert "2 alerts" in err and "1 on" in err and "1 off" in err  # on/off split in the footer
    assert "1 critical" in err and "1 warning" in err
    output.configure(no_color=True, quiet=False)


def test_render_alert_show_metric_threshold(capsys):
    _wide_stdout()
    a = _alert(name="metric-threshold-alert", trigger_kind="metric_threshold", severity="warning",
               trigger_spec={"filter": {"environment": "production", "event_type": "tool_call"},
                             "metric": "error_count", "op": ">", "value": 50, "window_secs": 900},
               channels=[])
    output.render_alert_show(a)
    out = capsys.readouterr().out
    assert "metric-threshold-alert" in out and "warning" in out and "enabled" in out
    assert "0 open incidents" in out
    assert "trigger · metric threshold" in out
    assert "fire when error_count > 50 over 15m" in out
    assert "environment = production" in out and "event_type = tool_call" in out
    assert "window 1" in out and "min breaches 1" in out and "checks every 5m" in out
    assert "channels · default" in out and "slack" in out and "default webhook" in out
    output.configure(no_color=True, quiet=False)


def test_render_alert_show_custom_sql(capsys):
    _wide_stdout()
    a = _alert(trigger_kind="custom_sql",
               trigger_spec={"op": ">", "query_name": "sample-query", "sql": "SELECT model\nFROM analytics.events", "value": 10})
    output.render_alert_show(a)
    out = capsys.readouterr().out
    assert "fire when query sample-query > 10 rows" in out
    assert "SELECT" in out and "FROM" in out  # SQL via Syntax box inside the card
    output.configure(no_color=True, quiet=False)


def test_render_alert_show_evaluation_score(capsys):
    _wide_stdout()
    a = _alert(trigger_kind="evaluation_score",
               trigger_spec={"environment": "dev", "min_count": 3, "op": ">", "score_key": "hallucination", "value": 0.8, "window_secs": 3600})
    output.render_alert_show(a)
    out = capsys.readouterr().out
    assert "fire when hallucination > 0.8 (min 3) over 1h" in out
    assert "environment" in out and "dev" in out
    output.configure(no_color=True, quiet=False)


def test_render_alert_show_per_event(capsys):
    _wide_stdout()
    a = _alert(trigger_kind="per_event",
               trigger_spec={"agent_id": "agent_id", "environment": "dev", "error_type": "RuntimeError",
                             "event_type": "error", "lookback_secs": 60, "message_contains": "runtimeerror", "tool_name": "bash"})
    output.render_alert_show(a)
    out = capsys.readouterr().out
    assert "fire on error events within 1m" in out
    assert "tool_name" in out and "bash" in out and "error_type" in out and "RuntimeError" in out
    assert 'message ~' in out and "runtimeerror" in out
    output.configure(no_color=True, quiet=False)


def test_render_alert_show_eval_compound(capsys):
    _wide_stdout()
    a = _alert(trigger_kind="eval_compound",
               trigger_spec={"combinator": "any", "window_secs": 3600, "min_count": 1, "environment": "dev",
                             "conditions": [{"score_key": "helpfulness", "op": "<", "value": 0.5},
                                            {"score_key": "safety", "op": "<", "value": 0.8}]})
    output.render_alert_show(a)
    out = capsys.readouterr().out
    assert "fire when any of these over 1h:" in out
    assert "helpfulness < 0.5" in out and "safety < 0.8" in out
    assert "min count 1" in out and "environment" in out and "dev" in out
    output.configure(no_color=True, quiet=False)


def test_render_alert_channels_custom_and_default():
    output.configure(no_color=False, quiet=False)
    # empty → all defaults
    all_def, _ = output._alert_channels_body([])
    assert all_def is True
    # a custom slack + default email → not all-default
    mixed, _ = output._alert_channels_body([
        {"kind": "slack", "webhook_setting_key": "my_slack_url_entered"},
        {"kind": "email", "recipients": None},
    ])
    assert mixed is False
    # alerts.-prefixed key counts as default
    defaulted, _ = output._alert_channels_body([{"kind": "slack", "webhook_setting_key": "alerts.slack_default_webhook"}])
    assert defaulted is True
    output.configure(no_color=True, quiet=False)


def test_render_alert_created_and_updated(capsys):
    _wide_stdout()
    a = _alert(name="errs", trigger_kind="metric_threshold", severity="warning", enabled=True,
               trigger_spec={"metric": "error_count", "op": ">", "value": 50, "window_secs": 900})
    output.render_alert_created(a)
    out = capsys.readouterr().out  # write result → stdout (data)
    assert "alert created" in out and "errs" in out
    assert "warning" in out and "enabled" in out          # identity line
    assert "created by you · just now" in out
    assert "trigger · metric threshold" in out and "fire when error_count > 50 over 15m" in out
    assert "evaluation" in out and "channels" in out      # full config cards

    b = _alert(name="errs2", trigger_kind="metric_threshold", severity="critical")
    output.render_alert_updated(b, old_name="errs")
    out2 = capsys.readouterr().out
    assert "alert updated" in out2 and "errs2" in out2 and "was errs" in out2  # rename shown
    assert "updated by you · just now" in out2
    output.configure(no_color=True, quiet=False)


def test_render_alert_delete_preview_and_feedback(capsys):
    output.configure(no_color=True, quiet=False)
    a = _alert(name="old-alert", severity="warning", open_incidents=2)
    output.render_alert_delete_preview(a)
    output.alert_deleted("old-alert")
    output.cancelled_plain("nothing deleted")
    output.alert_not_found("ghost")
    err = capsys.readouterr().err
    assert "delete alert" in err and "old-alert" in err and "2 open incidents" in err
    assert "deleted alert old-alert" in err
    assert "cancelled — nothing deleted" in err
    assert "no alert named" in err and "ghost" in err and "fp alerts list" in err


def test_alert_exists_and_test_sent(capsys):
    output.configure(no_color=True, quiet=False)
    output.alert_exists("dup")
    output.alert_test_sent("p95", ["slack", "email"])
    err = capsys.readouterr().err
    assert "an alert named" in err and "dup" in err and "fp alerts update dup" in err
    assert "test notification sent for" in err and "p95" in err
    assert "dispatched to" in err and "slack" in err and "email" in err
    assert "delivery isn't confirmed" in err


# --- settings: list box + schema box + set card -----------------------------


class _Setting:
    def __init__(self, key, value, schema=None, updated_at="2026-06-25T16:00:00Z", updated_by=None):
        self.key, self.value, self.schema = key, value, schema or {}
        self.updated_at, self.updated_by, self.scope = updated_at, updated_by, None


def test_setting_value_text_type_aware():
    output.configure(no_color=False, quiet=False)
    assert output._setting_value_text(86400, "positive_int").style == theme.PINK         # numeric pink
    assert output._setting_value_text(["a", "b"], "email_list").plain == "a, b"          # list joined
    assert output._setting_value_text("x", "secret").plain == "(secret)"                 # secret masked
    assert output._setting_value_text("", "url").plain == "(unset)"                      # empty
    assert output._setting_value_text([], "channel_set").plain == "(none)"               # empty list
    output.configure(no_color=True, quiet=False)


def test_render_settings_box(capsys):
    _wide_stdout()
    rows = [
        _Setting("session_ttl_secs", 86400, {"kind": "positive_int"}),
        _Setting("alerts.webhook_signing_secret", "", {"kind": "secret"}),
        _Setting("alerts.email_default_recipients", ["admin@local.host"], {"kind": "email_list"}),
    ]
    output.render_settings(rows)
    cap = capsys.readouterr()
    out, err = cap.out, cap.err
    assert "settings · 3" in out  # the count glows in the title
    for c in ("key", "value", "type", "updated"):
        assert c in out
    assert "session_ttl_secs" in out and "86400" in out and "integer" in out
    assert "(secret)" in out                                  # secret never echoed
    assert "change one with" not in err                       # the footer hint was removed
    output.configure(no_color=True, quiet=False)


def test_render_settings_schema_accepts(capsys):
    _wide_stdout()
    entries = [
        {"key": "session_ttl_secs", "kind": "positive_int", "min": 60, "max": 2592000, "unit": "seconds",
         "description": "session lifetime"},
        {"key": "alerts.enabled_channels", "kind": "channel_set", "options": ["email", "slack", "webhook"],
         "description": "channels"},
    ]
    output.render_settings_schema(entries)
    out = capsys.readouterr().out
    assert "settings schema · 2" in out
    assert "60–2592000 seconds" in out                        # int range + unit
    assert "email · slack · webhook" in out                    # channel options
    output.configure(no_color=True, quiet=False)


def test_render_setting_updated_card(capsys):
    _wide_stdout()
    output.render_setting_updated(_Setting("session_ttl_secs", 3600, {"kind": "positive_int"}), "positive_int")
    out = capsys.readouterr().out  # write result → stdout
    assert "setting updated" in out and "session_ttl_secs" in out and "3600" in out
    assert "updated by you · just now" in out
    output.configure(no_color=True, quiet=False)


def test_setting_feedback_lines(capsys):
    output.configure(no_color=True, quiet=False)
    output.setting_not_found("nope")
    output.setting_no_change("session_ttl_secs", 86400, "positive_int")
    output.setting_failed("value must be between 60 and 2592000")
    err = capsys.readouterr().err
    assert "no setting named" in err and "nope" in err and "fp settings list" in err
    assert "no change" in err and "session_ttl_secs" in err and "already" in err
    assert "value must be between 60 and 2592000" in err


# ══ incidents output tests (added) ══


def _incident(**over) -> Incident:
    base = {"id": "1f5803aaaaaabbbbcccc000000009826", "alert_name": "p95 latency",
            "alert_severity": "critical", "state": "firing", "opened_at": "2026-06-20T00:00:00Z",
            "assignees": []}
    base.update(over)
    return Incident.from_dict(base)


def test_incident_status_cell_enum():
    output.configure(no_color=False, quiet=False)
    fire = output._incident_status_cell("firing")
    assert fire.plain == "● firing" and any(s.style == theme.ERROR for s in fire.spans)
    ack = output._incident_status_cell("acknowledged")
    assert ack.plain == "● acknowledged" and any(s.style == theme.AMBER for s in ack.spans)
    res = output._incident_status_cell("resolved")
    assert res.plain == "○ resolved"                      # hollow dot → distinguishable mono
    assert output._incident_status_cell("weird").plain == "● weird"  # unknown → neutral, no crash
    output.configure(no_color=True, quiet=False)


def test_assignees_cell_overflow():
    output.configure(no_color=True, quiet=False)
    assert output._assignees_cell([]).plain == "—"
    assert output._assignees_cell(["a@x", "b@x", "c@x", "d@x"]).plain == "a@x, b@x  +2"


def test_render_incidents_box_and_footer(capsys):
    _wide_stdout()
    incs = [
        _incident(state="firing", assignees=["a@corp.com"]),
        _incident(id="2266", alert_name=None, alert_severity="warning", state="acknowledged"),
        _incident(id="3399", alert_severity="info", state="resolved", opened_at="2026-06-18T00:00:00Z"),
    ]
    output.render_incidents(incs)
    output.incidents_footer(incs)
    cap = capsys.readouterr()
    out, err = cap.out, cap.err
    assert "issues · 3" in out
    for c in ("id", "alert", "severity", "state", "opened", "assignees"):
        assert c in out
    assert "1f58…9826" in out                       # short id (the handle)
    assert "—" in out                               # manual incident (no alert_name) + no assignees
    assert "firing" in out and "acknowledged" in out and "resolved" in out
    assert "3 issues" in err and "1 firing" in err and "1 resolved" in err  # footer distribution
    output.configure(no_color=True, quiet=False)


def test_render_incidents_show_id_full(capsys):
    _wide_stdout()
    output.render_incidents([_incident()], show_id=True)
    out = capsys.readouterr().out
    assert "1f5803aaaaaabbbbcccc000000009826" in out   # full id when --show-id
    output.configure(no_color=True, quiet=False)


def test_render_incident_count_card(capsys):
    _wide_stdout()
    output.render_incident_count(12)
    output.render_incident_count(4, state="firing")
    out = capsys.readouterr().out
    assert "issues" in out and "12" in out and "open issues" in out
    assert "4" in out and "firing issues" in out
    output.configure(no_color=True, quiet=False)


def test_render_incident_show_sections(capsys):
    _wide_stdout()
    inc = _incident(
        state="acknowledged", acknowledged_by="ops@corp.com", assignees=["a@corp.com"],
        breach_summary="p95 = 1240ms > 1000ms",
        comments=[{"author_email": "ops@corp.com", "body": "on it", "created_at": "2026-06-20T00:01:00Z"},
                  {"author_email": "x@corp.com", "body": None, "created_at": "t", "deleted_at": "t"}],
        subscribers=[{"email": "ops@corp.com", "source": "ack", "subscribed_at": "2026-06-20T00:01:00Z"}],
        activity=[{"kind": "opened", "actor": "system", "at": "2026-06-20T00:00:00Z"}],
    )
    output.render_incident_show(inc)
    out = capsys.readouterr().out
    assert "p95 latency" in out and "1f58…9826" in out
    assert "acknowledged by ops@corp.com" in out and "assigned to a@corp.com" in out
    assert "breach" in out and "1240ms" in out
    assert "comments · 2" in out and "on it" in out and "(deleted)" in out
    assert "subscribers · 1" in out
    assert "activity · 1" in out and "opened" in out and "system" in out
    output.configure(no_color=True, quiet=False)


def test_render_incident_show_omits_empty_sections_and_uses_breach_value(capsys):
    _wide_stdout()
    output.render_incident_show(_incident(alert_name=None, title="checkout 500s",
                                          source="manual", breach_value=1240.0))
    out = capsys.readouterr().out
    # The header used to be hardcoded to the literal "manual incident" for any
    # issue without a parent alert, which said nothing and mislabelled every
    # audit-born issue. It now shows the issue's own title and real source.
    assert "checkout 500s" in out and "manual incident" not in out
    assert "manual" in out and "breach value 1240" in out
    assert "comments" not in out and "subscribers" not in out and "activity" not in out
    output.configure(no_color=True, quiet=False)


def test_incident_model_carries_title_source_and_finding_id():
    """These three shipped with the issues redesign but `from_dict` dropped
    them, so the CLI could not see the field that actually identifies a row."""
    inc = Incident.from_dict({"id": "i1", "title": "checkout 500s", "source": "audit",
                              "source_finding_id": "f7", "state": "firing"})
    assert inc.title == "checkout 500s"
    assert inc.source == "audit" and inc.source_finding_id == "f7"


def test_render_incidents_distinguishes_rows_by_title(capsys):
    """Only a minority of issues have an alert_name, so titling the table by
    alert left every manual and audit-born row rendering as a bare '—'."""
    _wide_stdout()
    output.render_incidents([
        _incident(id="a" * 32, title="checkout 500s", source="manual", alert_name=None),
        _incident(id="b" * 32, title="retry storm in planner", source="audit", alert_name=None),
        _incident(id="c" * 32, title="p95 latency", source="alert", alert_name="p95 latency"),
    ])
    out = capsys.readouterr().out
    assert "checkout 500s" in out and "retry storm in planner" in out
    assert "manual" in out and "audit" in out and "alert" in out
    output.configure(no_color=True, quiet=False)


def test_render_incident_opened_and_comment_added_cards(capsys):
    _wide_stdout()
    output.render_incident_opened(summary="manual page", severity="critical", state="firing")
    output.render_incident_comment_added(IncidentComment.from_dict(
        {"id": "c1", "author_email": "me@test", "body": "looking", "created_at": "t"}))
    out = capsys.readouterr().out                      # write-result cards → stdout
    assert "issue opened" in out and "manual page" in out and "opened by you · just now" in out
    assert "comment added" in out and "by me@test · just now" in out and "looking" in out
    output.configure(no_color=True, quiet=False)


def test_render_incident_comment_delete_preview(capsys):
    _wide_stdout()
    output.render_incident_comment_delete_preview(IncidentComment.from_dict(
        {"id": "c1", "author_email": "x@corp.com", "body": "wrong incident", "created_at": "2026-06-20T00:00:00Z"}))
    err = capsys.readouterr().err                      # preview is stderr chrome
    assert "delete comment" in err and "x@corp.com" in err and "wrong incident" in err
    output.configure(no_color=True, quiet=False)


def test_render_incident_comments_and_subscribers_boxes(capsys):
    _wide_stdout()
    output.render_incident_comments([
        IncidentComment.from_dict({"id": "c1", "author_email": "ops@corp.com", "body": "db pool", "created_at": "2026-06-20T00:00:00Z"}),
        IncidentComment.from_dict({"id": "c2", "author_email": "x@corp.com", "body": None, "created_at": "t", "deleted_at": "t"}),
    ])
    output.render_incident_subscribers([
        IncidentSubscriber.from_dict({"email": "ops@corp.com", "source": "creator", "subscribed_at": "2026-06-20T00:00:00Z"})])
    out = capsys.readouterr().out
    assert "comments · 2" in out and "db pool" in out and "(deleted)" in out
    assert "subscribers · 1" in out and "ops@corp.com" in out and "creator" in out
    output.configure(no_color=True, quiet=False)


def test_confirm_incident_resolve_headline(capsys, monkeypatch):
    output.configure(no_color=True, quiet=False)
    monkeypatch.setattr(output.typer, "confirm", lambda *a, **k: False)
    assert output.confirm_incident_resolve("1f5803aaaaaabbbbcccc000000009826", "p95 latency") is False
    err = capsys.readouterr().err
    assert "resolve issue" in err and "1f58…9826" in err and "(p95 latency)" in err and "this closes it" in err


def test_incident_plain_feedback_lines(capsys):
    output.configure(no_color=True, quiet=False)
    iid = "1f5803aaaaaabbbbcccc000000009826"
    output.incident_acked(iid)
    output.incident_resolved(iid)
    output.incident_assigned(iid, ["a@corp.com", "b@corp.com"])
    output.incident_assigned(iid, [])
    output.incident_subscribed(iid, None)
    output.incident_unsubscribed(iid, "x@y.z")
    output.incident_comment_deleted()
    output.incident_not_found(iid)
    output.incident_comment_not_found("c0ffee001111")
    output.incident_failed("a@x.com is not an operator")
    err = capsys.readouterr().err
    assert "acknowledged issue 1f58…9826" in err
    assert "resolved issue 1f58…9826" in err
    assert "assigned 1f58…9826" in err and "a@corp.com, b@corp.com" in err
    assert "cleared assignees on 1f58…9826" in err
    assert "subscribed you to issue" in err and "unsubscribed x@y.z from issue" in err
    assert "deleted comment" in err
    assert "no issue 1f58…9826" in err and "fp issues list" in err
    assert "no comment" in err and "c0ff…1111" in err
    assert "a@x.com is not an operator" in err


# ══ agent output tests (added) ══


def test_msg_text_extracts_str_and_dict():
    assert output._msg_text("plain") == "plain"
    assert output._msg_text({"text": "wrapped"}) == "wrapped"
    assert output._msg_text({"foo": 1}) == ""
    assert output._msg_text(None) == ""


def test_render_agent_health_configured(capsys):
    _wide_stdout()
    output.render_agent_health(configured=True, default_model="claude-x", model_count=3)
    out = capsys.readouterr().out  # data view → stdout
    assert "assistant" in out and "configured" in out
    assert "default model claude-x" in out and "3 models available" in out
    output.configure(no_color=True, quiet=False)


def test_render_agent_health_not_configured_omits_optional_lines(capsys):
    _wide_stdout()
    output.render_agent_health(configured=False, default_model=None, model_count=0)
    out = capsys.readouterr().out
    assert "not configured" in out
    assert "default model" not in out and "available" not in out  # omitted when none
    output.configure(no_color=True, quiet=False)


def test_render_agent_models_marks_default(capsys):
    _wide_stdout()
    output.render_agent_models(["m-default", "m-fast"], default_model="m-default")
    out = capsys.readouterr().out
    assert "models · 2" in out and "m-default" in out and "m-fast" in out and "default" in out
    output.configure(no_color=True, quiet=False)


def test_render_agent_models_empty(capsys):
    _wide_stdout()
    output.render_agent_models([], default_model=None)
    out = capsys.readouterr().out
    assert "models · 0" in out and "no models reported" in out
    output.configure(no_color=True, quiet=False)


def test_render_agent_chats_box(capsys):
    _wide_stdout()
    chats = [
        {"id": "07854990-dade-4dea-aaaa", "title": "older", "message_count": 2, "updated_at": "2026-06-20T10:00:00Z"},
        {"id": "17bf35c3-3a5a-4ff7-bbbb", "title": "newer", "message_count": 5, "updated_at": "2026-06-27T10:00:00Z"},
    ]
    output.render_agent_chats(chats)
    cap = capsys.readouterr()
    out, err = cap.out, cap.err
    assert "chats · 2" in out  # the count glows in the title
    for c in ("chat-id", "title", "messages", "updated"):
        assert c in out
    assert "older" in out and "newer" in out
    assert "07854990" in out and "17bf35c3" in out  # short copy-friendly handle (first 8)
    assert "dade" not in out                          # the rest of the id is not shown
    assert out.index("newer") < out.index("older")   # newest first
    assert "open one with" not in err                 # the footer hint was removed
    output.configure(no_color=True, quiet=False)


def test_render_agent_chats_empty(capsys):
    _wide_stdout()
    output.render_agent_chats([])
    assert "no chats" in capsys.readouterr().out
    output.configure(no_color=True, quiet=False)


def test_render_agent_show_thread(capsys):
    _wide_stdout()
    output.render_agent_show(title="perf review", chat_id="conv-123456789", messages=[
        {"role": "user", "content": {"text": "why slow?"}},
        {"role": "assistant", "content": "because cache"},
    ])
    out = capsys.readouterr().out  # transcript → stdout
    assert "perf review" in out and "2 messages" in out
    assert "you" in out and "assistant" in out
    assert "why slow?" in out and "because cache" in out
    output.configure(no_color=True, quiet=False)


def test_render_agent_show_empty(capsys):
    _wide_stdout()
    output.render_agent_show(title="", chat_id="c1", messages=[])
    out = capsys.readouterr().out
    assert "untitled" in out and "no messages yet" in out
    output.configure(no_color=True, quiet=False)


def test_render_agent_renamed_card(capsys):
    _wide_stdout()
    output.render_agent_renamed(chat_id="c1", title="new title", old_title="old title")
    err = capsys.readouterr().err  # write result → stderr
    assert "chat renamed" in err and "new title" in err and "was old title" in err
    output.configure(no_color=True, quiet=False)


def test_render_agent_delete_preview_and_feedback(capsys):
    _wide_stdout()
    output.render_agent_delete_preview(title="perf review", message_count=4, chat_id="07854990-dade")
    output.agent_deleted("perf review")
    output.print_cancelled("nothing deleted")  # boxed cancel, like the command uses
    err = capsys.readouterr().err
    assert "delete chat" in err and "perf review" in err and "4 messages" in err
    assert "07854990" in err and "dade" not in err  # short id in the preview
    assert "deleted chat" in err and "perf review" in err  # boxed deleted
    assert "cancelled" in err and "nothing deleted" in err  # boxed cancel
    output.configure(no_color=True, quiet=False)


def test_confirm_agent_delete(monkeypatch, capsys):
    _wide_stdout()
    monkeypatch.setattr("typer.confirm", lambda *a, **k: True)
    assert output.confirm_agent_delete() is True
    monkeypatch.setattr("typer.confirm", lambda *a, **k: False)
    assert output.confirm_agent_delete() is False
    assert "permanently removes the chat" in capsys.readouterr().err
    output.configure(no_color=True, quiet=False)


def test_agent_ask_chrome_lines(capsys):
    _wide_stdout()
    output.agent_tool_used("run_query")
    output.render_agent_new_chat("07854990-dade-4dea")
    output.agent_error("assistant error: boom")
    output.agent_chat_not_found("07854990-dade-4dea")
    output.agent_unconfigured_note()
    err = capsys.readouterr().err
    assert "used tool: run_query" in err
    assert "new chat" in err and 'fp agent ask --chat 07854990 "…"' in err  # short id, positional msg
    assert "assistant error: boom" in err
    assert "chat not found" in err and "fp agent chats" in err  # boxed not-found
    assert "isn't configured" in err and "fp agent health" in err
    output.configure(no_color=True, quiet=False)



# ── review round: renderers that described the wrong thing ───────────────────


def _history(*gens):
    """`(deployment, [(id, version, effect), ...])` → the server's history shape."""
    return [{"deployment": g, "updatedAt": "2026-08-19T13:49:%02dZ" % g,
             "policies": [{"id": i, "version": v, "effect": e} for i, v, e in pols]}
            for g, pols in gens]


def test_history_shows_an_effect_flip_instead_of_no_change(capsys):
    """enforce → observe is a policy that STOPPED BLOCKING, and history called
    it "no change".

    The row identity was `id@version`, so a generation that changed only the
    effect diffed to nothing. Scanning history for "when did this stop
    blocking?" is one of the two reasons to read it at all.
    """
    _wide_stdout()
    output.render_deployment_history("m", _history(
        (1, [("guard", 1, "enforce")]),
        (2, [("guard", 1, "observe")]),
    ))
    out = capsys.readouterr().out
    assert "no change" not in out
    assert "~guard" in out


def test_history_shows_a_version_bump_as_one_change(capsys):
    """A version bump split into `+guard` and `-guard` on the same row, which
    reads as removed-and-re-added rather than moved."""
    _wide_stdout()
    output.render_deployment_history("m", _history(
        (1, [("guard", 1, "enforce")]),
        (2, [("guard", 2, "enforce")]),
    ))
    # Scoped to generation 2's row: generation 1 is the machine's first, where
    # every policy is legitimately a "+".
    row = [ln for ln in capsys.readouterr().out.splitlines() if "#2" in ln][0]
    assert "~guard" in row
    assert "+guard" not in row and "-guard" not in row


def test_history_still_reports_plain_adds_and_removes(capsys):
    """The `~` case must not have eaten the two it was added beside."""
    _wide_stdout()
    output.render_deployment_history("m", _history(
        (1, [("a", 1, "enforce")]),
        (2, [("a", 1, "enforce"), ("b", 1, "enforce")]),
        (3, [("b", 1, "enforce")]),
    ))
    out = capsys.readouterr().out
    assert "+b" in out and "-a" in out


def test_history_says_no_change_only_when_nothing_moved(capsys):
    """A reissue that lands on an identical set is real, and should still say so."""
    _wide_stdout()
    output.render_deployment_history("m", _history(
        (1, [("a", 1, "enforce")]),
        (2, [("a", 1, "enforce")]),
    ))
    assert "no change" in capsys.readouterr().out


def test_clearing_a_label_is_not_reported_as_renaming_to_blank(capsys):
    """`fp fleet rename m ""` clears the override server-side, and the card
    said `labelled m as ` — a sentence with a hole in it, describing neither
    what was asked nor what happened."""
    _wide_stdout()
    output.machine_renamed("m", "")
    # Notices go to stderr so stdout stays parseable; the box lands there.
    err = capsys.readouterr().err
    assert "cleared the label" in err
    assert "labelled m as" not in err

    output.machine_renamed("m", "CI runner")
    assert "labelled m as CI runner" in capsys.readouterr().err.replace("\n", " ")


def test_policy_list_counts_policies_and_captions_versions(capsys):
    """The panel said `policies · 4` for three policies, because the endpoint
    returns one row per immutable VERSION. The dashboard's own library counts
    distinct policies and captions the version total; this now matches it."""
    from fp_cli.models import PolicyVersion

    def pv(pid, version):
        return PolicyVersion(id=pid, version=version, description="", sha256="",
                             source=None, created_at="", created_by=None,
                             disabled=False, archived=False)

    _wide_stdout()
    output.render_policies([pv("a", 1), pv("b", 2), pv("b", 1)])
    out = capsys.readouterr().out
    assert "policies · 2 · 3 versions" in out
    # newest version of each policy first, rather than server order
    b_rows = [ln for ln in out.splitlines() if "b" in ln and "v" in ln
              and ("v1" in ln or "v2" in ln)]
    assert [("v2" in r) for r in b_rows] == [True, False], b_rows


def test_policy_list_omits_the_caption_when_each_policy_has_one_version(capsys):
    from fp_cli.models import PolicyVersion

    _wide_stdout()
    output.render_policies([PolicyVersion(id="a", version=1, description="", sha256="",
                                          source=None, created_at="", created_by=None,
                                          disabled=False, archived=False)])
    out = capsys.readouterr().out
    assert "policies · 1" in out and "versions" not in out
