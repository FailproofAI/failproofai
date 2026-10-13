import httpx
import pytest
import respx

from fp_cli import client
from fp_cli.errors import NotFoundError


@pytest.mark.parametrize("family", [
    "evaluator-definitions", "evaluator-instances", "evaluator-schema-profile",
    "evaluation-jobs", "dashboards", "otel", "offers", "team-trial",
])
def test_added_v1_families(family):
    assert client._v1_path(f"/api/{family}") == f"/v1/{family}"


@pytest.mark.parametrize("method", ["GET", "POST", "PATCH", "DELETE"])
@pytest.mark.parametrize("key_mode", [False, True])
def test_cloud_request_degrades(method, key_mode):
    ctx = client.ClientContext(
        "http://dash.test", token=None if key_mode else "tok",
        api_key="key" if key_mode else None,
        auth_mode=client.AuthMode.API_KEY if key_mode else client.AuthMode.SESSION,
    )
    prefix = "v1" if key_mode else "api"
    with respx.mock:
        route = respx.request(method, f"http://dash.test/{prefix}/dashboards").respond(404, json={})
        with pytest.raises(NotFoundError, match="not available on this FailproofAI Cloud yet") as exc:
            client.cloud_request(ctx, method, "/api/dashboards")
    assert exc.value.exit_code == 6
    headers = route.calls[0].request.headers
    assert ("authorization" in headers) is key_mode
    assert ("cookie" in headers) is not key_mode
