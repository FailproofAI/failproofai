import pytest
import respx

from fp_cli.app import app


@pytest.mark.parametrize("key_mode", [False, True])
@pytest.mark.parametrize("status", [200, 404])
def test_re_evaluate(logged_in, runner, key_mode, status):
    prefix = "v1" if key_mode else "api"
    with respx.mock:
        route = respx.post(f"http://dash.test/{prefix}/sessions/run-001/re-evaluate").respond(
            status, json={"queued": True} if status == 200 else {"error": "unknown route"},
        )
        result = runner.invoke(app, ["--json", *(["--api-key", "key"] if key_mode else []), "sessions", "re-evaluate", "run-001"])
    assert route.called
    assert result.exit_code == (0 if status == 200 else 6), result.output
    if status == 404:
        assert "not available on this FailproofAI Cloud yet" in result.stdout


@pytest.mark.parametrize("key_mode", [False, True])
@pytest.mark.parametrize("error_body", [{}, {"error": "session not found"}])
def test_re_evaluate_missing_session(logged_in, runner, key_mode, error_body):
    prefix = "v1" if key_mode else "api"
    with respx.mock as mock:
        mock.post(f"http://dash.test/{prefix}/sessions/missing/re-evaluate").respond(404, json=error_body)
        result = runner.invoke(app, [
            "--json", *(["--api-key", "key"] if key_mode else []), "sessions", "re-evaluate", "missing",
        ])
    assert result.exit_code == 6, result.output
    assert "not found" in result.stdout
    assert "not available on this FailproofAI Cloud yet" not in result.stdout
