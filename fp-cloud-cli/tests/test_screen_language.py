import json
from io import StringIO

from rich.console import Console

from fp_cli import output, theme
from fp_cli.models import AgentEvent


def test_two_accent_palette():
    assert theme.ACCENT == "#66d1b5"
    assert theme.PINK == "#e4587d"
    assert {theme.SUCCESS, theme.ERROR, theme.AMBER, theme.BLUE, theme.SCORE_HIGH} <= {theme.ACCENT, theme.PINK}


def test_permission_risk_order_is_independent_of_shared_colours():
    assert theme.PERM_WRITE == theme.PERM_ACTION == theme.PERM_DANGER
    assert sorted(["delete", "run", "write", "read"], key=output._perm_act_key) == [
        "read", "write", "run", "delete",
    ]


def test_open_table_and_header(capsys):
    output.configure(no_color=True)
    output.print_table(["Id", "URL"], [["run-001", "https://cloud.example.test"]], title="Resources")
    text = capsys.readouterr().out
    assert "failproof ai v" in text
    assert "RESOURCES" in text
    assert not any(c in text for c in "╭╮╰╯┌┐└┘─━│┃")


def test_legacy_panels_use_open_screen(capsys):
    output.configure(no_color=True)
    output.render_events([AgentEvent(id=1, session_id="run-001", agent_id="agent", event_type="tool_use", ts="2026-10-13T00:00:00Z")])
    text = capsys.readouterr().out
    assert "EVENTS" in text
    assert "failproof ai v" in text
    assert not any(c in text for c in "╭╮╰╯┌┐└┘─━│┃")


def test_narrow_ids_and_urls_are_not_cut(capsys):
    output.configure(no_color=True)
    output._stdout = Console(width=45, no_color=True)
    id = "session-001-abcdefghijklmnopqrstuvwxyz-123456789"
    url = "https://cloud.example.test/organizations/reliability/sessions/" + id
    output.print_table(["Id", "URL"], [[id, url]])
    compact = "".join(capsys.readouterr().out.split())
    assert id in compact and url in compact
    assert "…" not in compact


def test_json_bytes_unchanged(capsys):
    output.configure(json=True)
    data = {"session_id": "run-001", "scores": {"quality": 0.9}}
    output.emit_json(data)
    assert capsys.readouterr().out == json.dumps(data, indent=2, ensure_ascii=False) + "\n"


def test_generated_help_has_no_boxes(logged_in, runner):
    from fp_cli.app import app
    result = runner.invoke(app, ["evaluators", "create", "--help"])
    assert result.exit_code == 0
    assert "Code:" in result.stdout and "Judge:" in result.stdout and "Jev:" in result.stdout
    assert not any(c in result.stdout for c in "╭╮╰╯┌┐└┘─━│┃")


def test_shared_key_value_labels_are_grey():
    capture = StringIO()
    output.configure()
    output._stdout = Console(file=capture, width=140, force_terminal=True, color_system="truecolor")
    output.print_table(["Field", "Value"], [["enabled", "true"]])
    assert "\x1b[38;2;118;127;139menabled" in capture.getvalue()


def test_help_typeable_commands_are_pink():
    capture = StringIO()
    output.configure()
    output._stdout = Console(file=capture, width=140, force_terminal=True, color_system="truecolor")
    output.render_top_level_help()
    assert "\x1b[38;2;228;88;125mfp login" in capture.getvalue()
