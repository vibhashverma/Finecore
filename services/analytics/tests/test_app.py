import pytest
from fastapi.testclient import TestClient
from pydantic import BaseModel

from fincore_analytics.app import create_app, resolve_request_id


async def _ok() -> None:
    return None


async def _down() -> None:
    raise ConnectionError("db at 10.0.0.9 refused")


def test_healthz_ok() -> None:
    client = TestClient(create_app({"postgres": _down}))
    res = client.get("/healthz")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}


def test_readyz_ready_when_checks_pass() -> None:
    res = TestClient(create_app({"postgres": _ok})).get("/readyz")
    assert res.status_code == 200
    assert res.json() == {"status": "ready", "checks": {"postgres": "ok"}}


def test_readyz_not_ready_and_does_not_leak_internals() -> None:
    res = TestClient(create_app({"postgres": _down})).get("/readyz")
    assert res.status_code == 503
    assert res.json()["checks"] == {"postgres": "fail"}
    assert "10.0.0.9" not in res.text


def test_readyz_shutting_down() -> None:
    app = create_app()
    app.state.flags["shutting_down"] = True
    assert TestClient(app).get("/readyz").status_code == 503


def test_unknown_route_uses_error_envelope() -> None:
    res = TestClient(create_app()).get(
        "/analytics/v1/nope", headers={"x-request-id": "req_abcdef12"}
    )
    assert res.status_code == 404
    body = res.json()["error"]
    assert body["code"] == "NOT_FOUND"
    assert body["request_id"] == "req_abcdef12"
    assert res.headers["x-request-id"] == "req_abcdef12"


class _Echo(BaseModel):
    amount_minor: int


def test_validation_error_envelope() -> None:
    app = create_app()

    @app.post("/echo")
    async def echo(body: _Echo) -> _Echo:
        return body

    res = TestClient(app).post("/echo", json={"amount_minor": "not-a-number"})
    assert res.status_code == 400
    err = res.json()["error"]
    assert err["code"] == "VALIDATION_ERROR"
    assert err["details"][0]["path"] == "amount_minor"


def test_unhandled_exception_is_hidden() -> None:
    app = create_app()

    @app.get("/boom")
    async def boom() -> None:
        raise RuntimeError("password=hunter2 traceback")

    res = TestClient(app, raise_server_exceptions=False).get("/boom")
    assert res.status_code == 500
    assert res.json()["error"]["code"] == "INTERNAL_ERROR"
    assert "hunter2" not in res.text


def test_metrics_exposed() -> None:
    client = TestClient(create_app())
    client.get("/healthz")
    res = client.get("/metrics")
    assert res.status_code == 200
    assert "python_info" in res.text


@pytest.mark.parametrize(
    ("incoming", "reused"),
    [("req_abcdef12", True), ("bad id\n", False), (None, False), ("x" * 200, False)],
)
def test_resolve_request_id(incoming: str | None, reused: bool) -> None:
    rid = resolve_request_id(incoming)
    assert (rid == incoming) is reused
    assert rid.startswith("req_") or reused
