import pytest
import respx

from fp_cli.app import app


@pytest.mark.parametrize("key_mode", [False, True])
@pytest.mark.parametrize("status", [200, 404])
def test_re_evaluate(logged_in, runner, key_mode, status):
    prefix = "v1" if key_mode else "api"
    with respx.mock:
        route = respx.post(f"http://dash.test/{prefix}/sessions/run-001/re-evaluate").respond(status, json={"queued": True})
        result = runner.invoke(app, ["--json", *(["--api-key", "key"] if key_mode else []), "sessions", "re-evaluate", "run-001"])
    assert route.called
    assert result.exit_code == (0 if status == 200 else 6), result.output
    if status == 404:
        assert "not available on this FailproofAI Cloud yet" in result.stdout
