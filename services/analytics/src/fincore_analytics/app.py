"""FastAPI application factory: health, readiness, metrics, request ids and error envelope."""

import re
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

import structlog
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from prometheus_fastapi_instrumentator import Instrumentator
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import Response

ReadinessCheck = Callable[[], Awaitable[None]]

_SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
_log = structlog.get_logger("analytics")

_HTTP_CODE = {404: "NOT_FOUND", 405: "NOT_FOUND", 401: "UNAUTHENTICATED", 403: "FORBIDDEN"}


def resolve_request_id(incoming: str | None) -> str:
    """Reuse a well-formed upstream id so a request can be traced Express → FastAPI."""
    if incoming and _SAFE_ID.match(incoming):
        return incoming
    return f"req_{uuid.uuid4().hex}"


def _error(
    status: int, code: str, message: str, request_id: str, details: Any = None
) -> JSONResponse:
    body: dict[str, Any] = {"code": code, "message": message, "request_id": request_id}
    if details:
        body["details"] = details
    return JSONResponse(
        status_code=status, content={"error": body}, headers={"x-request-id": request_id}
    )


def create_app(readiness_checks: dict[str, ReadinessCheck] | None = None) -> FastAPI:
    checks = readiness_checks or {}
    app = FastAPI(
        title="FinCore Analytics",
        version="0.1.0",
        description="SIMULATED data only. Risk scores are decision support, not proof of fraud.",
        openapi_url="/analytics/v1/openapi.json",
        docs_url="/analytics/v1/docs",
        redoc_url=None,
    )
    state: dict[str, bool] = {"shutting_down": False}
    app.state.flags = state

    @app.middleware("http")
    async def request_id_mw(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        rid = resolve_request_id(request.headers.get("x-request-id"))
        request.state.request_id = rid
        structlog.contextvars.bind_contextvars(request_id=rid)
        try:
            response = await call_next(request)
        except Exception:
            # Unknown errors: log server-side and return a generic envelope with no stack trace.
            _log.exception("unhandled error", route=request.url.path)
            return _error(500, "INTERNAL_ERROR", "An unexpected error occurred.", rid)
        finally:
            structlog.contextvars.clear_contextvars()
        response.headers["x-request-id"] = rid
        return response

    @app.exception_handler(RequestValidationError)
    async def validation_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
        details = [
            {"path": ".".join(str(p) for p in e["loc"][1:]), "message": e["msg"]}
            for e in exc.errors()
        ]
        return _error(
            400, "VALIDATION_ERROR", "Request validation failed.", request.state.request_id, details
        )

    @app.exception_handler(StarletteHTTPException)
    async def http_handler(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = _HTTP_CODE.get(exc.status_code, "INTERNAL_ERROR")
        not_found = code == "NOT_FOUND"
        message = "The requested resource was not found." if not_found else "Request failed."
        return _error(exc.status_code, code, message, request.state.request_id)

    @app.get("/healthz", include_in_schema=False)
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/readyz", include_in_schema=False)
    async def readyz() -> JSONResponse:
        if state["shutting_down"]:
            return JSONResponse(status_code=503, content={"status": "shutting_down", "checks": {}})
        results: dict[str, str] = {}
        for name, check in checks.items():
            try:
                await check()
                results[name] = "ok"
            except Exception:
                results[name] = "fail"
        ready = all(v == "ok" for v in results.values())
        return JSONResponse(
            status_code=200 if ready else 503,
            content={"status": "ready" if ready else "not_ready", "checks": results},
        )

    # /metrics is blocked at the reverse proxy and only scraped on the internal network.
    Instrumentator(excluded_handlers=["/healthz", "/readyz", "/metrics"]).instrument(app).expose(
        app, include_in_schema=False
    )
    return app
