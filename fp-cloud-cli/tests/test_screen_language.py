import json
from io import StringIO

import pytest
from rich.console import Console

from fp_cli import output, theme
from fp_cli.models import AgentEvent

BOXES = "╭╮╰╯┌┐└┘─━│┃"


def test_palette():
    assert theme.ACCENT == "#9d7bff"
    assert theme.SUCCESS == "#5dcaa5"
    assert theme.AMBER == "#ef9f27"
    assert theme.ERROR == "#e2564a"
    assert theme.BLUE == "#6b86d8"
    assert theme.PINK == "#d4537e"
    # The states that have to read differently are different colours.
    assert len({theme.PERM_READ, theme.PERM_WRITE, theme.PERM_ACTION, theme.PERM_DANGER}) == 4


def test_permission_risk_order_is_independent_of_shared_colours():
    assert sorted(["delete", "run", "write", "read"], key=output._perm_act_key) == [
        "read", "write", "run", "delete",
    ]


def test_boxed_table_and_no_header(capsys):
    output.configure(no_color=True)
    output.print_table(["Id", "URL"], [["run-001", "https://cloud.example.test"]], title="Resources")
    text = capsys.readouterr().out
    assert "failproof ai v" not in text
    assert "Resources" in text and "RESOURCES" not in text
    assert any(c in text for c in BOXES)


def test_panels_have_rounded_boxes_and_lowercase_titles(capsys):
    output.configure(no_color=True)
    output.render_events([AgentEvent(id=1, session_id="run-001", agent_id="agent", event_type="tool_use", ts="2026-10-13T00:00:00Z")])
    text = capsys.readouterr().out
    assert "╭─ events" in text and "╰" in text
    assert "EVENTS" not in text
    assert "failproof ai v" not in text


def test_errors_are_a_red_box(capsys):
    output.configure(no_color=True)
    output._error_box("that failed", "try fp login")
    text = capsys.readouterr().err
    assert "╭─ error" in text and "✗" in text
    assert "that failed" in text and "try fp login" in text


@pytest.mark.parametrize("say", [output.error, output.warn, output.success])
def test_a_message_is_shown_as_written_whatever_is_in_it(capsys, say):
    # Rich would read these as markup: one raises, the other disappears.
    output.configure(no_color=True)
    say("from the server: [/] and [red]")
    assert "from the server: [/] and [red]" in capsys.readouterr().err


def test_a_table_title_is_shown_as_written(capsys):
    output.configure(no_color=True)
    output.print_table(["a"], [["1"]], title="from the server: [/] and [red]")
    assert "fromtheserver:[/]and[red]" in "".join(capsys.readouterr().out.split())  # it wraps to the table


def test_only_a_key_hint_lights_up_its_keys():
    lit = lambda text: [text[span.start:span.end] for span in output._login_keys(text).spans]
    assert lit("enter send a code · tab SSO · esc cancel") == ["enter", "tab", "esc"]
    assert lit("  enter the 6-digit code") == []


def test_narrow_ids_and_urls_are_not_cut(capsys):
    output.configure(no_color=True)
    output._stdout = Console(width=45, no_color=True)
    id = "session-001-abcdefghijklmnopqrstuvwxyz-123456789"
    url = "https://cloud.example.test/organizations/reliability/sessions/" + id
    output.print_table(["Id", "URL"], [[id, url]])
    compact = "".join(capsys.readouterr().out.split())
    assert id in compact and url in compact
    assert "…" not in compact


@pytest.mark.parametrize("field", ["session_id", "agent_id"])
def test_a_value_in_a_boxed_table_is_never_cut(field):
    capture = StringIO()
    output.configure(no_color=True)
    output._stdout = Console(file=capture, width=70, no_color=True)
    long_value = "sess-20260615-" + "abcdef0123456789" * 3
    event = {"session_id": "run-001", "agent_id": "agent", field: long_value}
    output.render_events([AgentEvent(id=1, event_type="tool_use", ts="2026-10-13T00:00:00Z", **event)])
    text = capture.getvalue()
    assert any(c in text for c in BOXES)
    assert "…" not in text
    # Flattened, a wrapped value reads whole once the short cell beside its first row is gone.
    assert long_value in "".join(c for c in text if c not in BOXES and not c.isspace()).replace("run-001", "")


@pytest.mark.parametrize("render", [output.render_events, output.render_errors])
def test_short_values_stay_on_one_line_when_a_long_one_wraps(render):
    capture = StringIO()
    output.configure(no_color=True)
    output._stdout = Console(file=capture, width=100, no_color=True)
    long_id = "sess-20260615-" + "abcdef0123456789" * 4
    # Two days, so the time column carries the date as well, at its widest.
    render([
        AgentEvent(id=1, session_id=long_id, agent_id="agent", event_type="tool_use", ts="2026-10-13T09:41:07Z"),
        AgentEvent(id=2, session_id=long_id, agent_id="agent", event_type="tool_use", ts="2026-10-12T17:51:34Z"),
    ])
    text = capture.getvalue()
    assert "10-13 09:41:07" in text and "10-12 17:51:34" in text, text


def test_json_bytes_unchanged(capsys):
    output.configure(json=True)
    data = {"session_id": "run-001", "scores": {"quality": 0.9}}
    output.emit_json(data)
    assert capsys.readouterr().out == json.dumps(data, indent=2, ensure_ascii=False) + "\n"


def test_generated_help_has_boxes(logged_in, runner):
    from fp_cli.app import app
    result = runner.invoke(app, ["evaluators", "create", "--help"])
    assert result.exit_code == 0
    assert "Code:" in result.stdout and "Judge:" in result.stdout and "Jev:" in result.stdout
    assert any(c in result.stdout for c in BOXES)


def test_help_has_the_brand_mark_and_old_command_colours():
    capture = StringIO()
    output.configure()
    output._stdout = Console(file=capture, width=140, force_terminal=True, color_system="truecolor")
    output.render_top_level_help()
    text = capture.getvalue()
    assert "◆ fp" in text
    assert "failproof ai v" not in text
    assert "\x1b[38;2;157;123;255mfp login" in text  # theme.ACCENT
    assert "\x1b[38;2;228;88;125m" not in text        # the redesign's pink
