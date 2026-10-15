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


def test_new_capability_html_404_degrades():
    ctx = client.ClientContext("http://dash.test", api_key="key", auth_mode=client.AuthMode.API_KEY)
    with respx.mock as mock:
        mock.get("http://dash.test/v1/dashboards").respond(404, text="<html>old Cloud</html>", headers={"content-type": "text/html"})
        with pytest.raises(NotFoundError, match="not available on this FailproofAI Cloud yet") as exc:
            client.cloud_request(ctx, "GET", "/api/dashboards")
    assert exc.value.exit_code == 6


@pytest.mark.parametrize("key_mode", [False, True])
@pytest.mark.parametrize("method,path,body,params", [
    ("PATCH", "/api/evaluator-definitions/stale-id", {"enabled": False}, None),
    ("GET", "/api/sessions/missing/export", None, None),
    ("POST", "/api/sessions/missing/re-evaluate", None, None),
    ("GET", "/api/dashboards/missing/tiles", None, None),
    ("DELETE", "/api/dashboards/board/tiles/stale-tile", None, None),
    ("GET", "/api/events/sentiment/sessions/missing", None, None),
    ("GET", "/api/audits/contracts/stale-id", None, None),
    ("POST", "/api/queries/run", {"query_id": "missing"}, None),
    ("POST", "/api/agent/answer", {"callId": "missing", "decision": "reject"}, None),
    ("DELETE", "/api/settings/model-context-windows", None, {"model": "missing"}),
])
def test_record_404_is_not_route_unavailable(key_mode, method, path, body, params):
    ctx = client.ClientContext(
        "http://dash.test", token=None if key_mode else "tok",
        api_key="key" if key_mode else None,
        auth_mode=client.AuthMode.API_KEY if key_mode else client.AuthMode.SESSION,
    )
    if key_mode and path.startswith("/api/agent/"):
        pytest.skip("the agent has no key route; tested via session-only command guards")
    wire_path = client._v1_path(path) if key_mode else path
    with respx.mock as mock:
        mock.request(method, f"http://dash.test{wire_path}").respond(404, json={})
        with pytest.raises(NotFoundError) as exc:
            client.cloud_request(ctx, method, path, body=body, params=params)
    assert exc.value.exit_code == 6
    assert "Record not found" in exc.value.message
    assert "not available on this FailproofAI Cloud yet" not in exc.value.message


@pytest.mark.parametrize("response,route_unknown", [
    ({"code": "route_not_found"}, True),
    ({"error": {"code": "route_not_found"}}, True),
    ({"error": "unknown endpoint"}, True),
    ({"message": "Cannot PATCH /evaluator-definitions/stale-id"}, True),
    ({"error": "route does not exist"}, True),
    ({"error": "old Cloud route absent"}, True),
    ({"error": "evaluator definition not found"}, False),
    ({"error": "session not found"}, False),
    ({"error": "query not found"}, False),
    ({"error": "not available in demo"}, False),
])
def test_404_response_overrides_request_shape(response, route_unknown):
    ctx = client.ClientContext("http://dash.test", token="tok")
    with respx.mock as mock:
        mock.patch("http://dash.test/api/evaluator-definitions/stale-id").respond(404, json=response)
        with pytest.raises(NotFoundError) as exc:
            client.cloud_request(ctx, "PATCH", "/api/evaluator-definitions/stale-id", body={"enabled": False})
    assert exc.value.exit_code == 6
    if route_unknown:
        assert exc.value.message == "not available on this FailproofAI Cloud yet"
    else:
        assert exc.value.message == response.get("error", response.get("message"))


@pytest.mark.parametrize("body", [{"code": "record_not_found"}, {"error": "resource_not_found"}])
def test_record_error_code_on_collection_is_not_unavailable(body):
    ctx = client.ClientContext("http://dash.test", token="tok")
    with respx.mock as mock:
        mock.post("http://dash.test/api/queries/run").respond(404, json=body)
        with pytest.raises(NotFoundError, match="Record not found") as exc:
            client.cloud_request(ctx, "POST", "/api/queries/run", body={"sql": "SELECT 1"})
    assert "not available" not in exc.value.message


def test_collection_with_missing_saved_query_preserves_server_error():
    ctx = client.ClientContext("http://dash.test", token="tok")
    with respx.mock as mock:
        mock.post("http://dash.test/api/queries/run").respond(404, json={"error": "saved query not found"})
        with pytest.raises(NotFoundError, match="saved query not found"):
            client.cloud_request(ctx, "POST", "/api/queries/run", body={"query_id": "stale"})


def test_stream_404_distinguishes_route_and_record():
    ctx = client.ClientContext("http://dash.test", token="tok")
    for error, expected in [
        ({"code": "unknown_route"}, "not available on this FailproofAI Cloud yet"),
        ({"error": "conversation not found"}, "conversation not found"),
    ]:
        with respx.mock as mock:
            mock.post("http://dash.test/api/agent/chat").respond(404, json=error)
            with pytest.raises(NotFoundError, match=expected):
                list(client.cloud_stream(ctx, "/api/agent/chat", {"conversationId": "missing"}))


@pytest.mark.parametrize("path", [
    "/api/agent/conversations/stale",
    "/api/offers/stale",
    "/api/integrations/slack/stale",
])
def test_named_endpoint_families_do_not_hide_record_404s(path):
    ctx = client.ClientContext("http://dash.test", token="tok")
    with respx.mock as mock:
        mock.get(f"http://dash.test{path}").respond(404, json={})
        with pytest.raises(NotFoundError, match="Record not found") as exc:
            client.cloud_request(ctx, "GET", path)
    assert "not available" not in exc.value.message
