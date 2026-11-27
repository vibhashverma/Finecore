"""ASGI entrypoint: `uvicorn fincore_analytics.main:app`.

Uvicorn handles SIGTERM with a graceful drain.
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import cast

from fastapi import FastAPI
from starlette.concurrency import run_in_threadpool

from .api import ReportRows
from .app import ReadinessCheck, create_app
from .config import Settings
from .logging import configure_logging

settings = Settings()
configure_logging(settings.log_level)

checks: dict[str, ReadinessCheck] = {}
report_rows: ReportRows | None = None

if settings.database_url:
    # Sync pool used from a worker thread: portable (async psycopg can't use Windows' Proactor event loop).
    from psycopg.rows import dict_row
    from psycopg_pool import ConnectionPool

    pool = ConnectionPool(settings.database_url, min_size=1, max_size=4, open=False, kwargs={"row_factory": dict_row})

    def _ping() -> None:
        with pool.connection() as conn:
            conn.execute("SELECT 1")

    def _fetch() -> list[dict[str, object]]:
        with pool.connection() as conn:
            cur = conn.execute(
                "SELECT status, currency, amount_minor, risk_score FROM analytics.transfer_facts "
                "WHERE created_at > now() - interval '30 days'"
            )
            return cast(list[dict[str, object]], cur.fetchall())

    async def _db_check() -> None:
        await run_in_threadpool(_ping)

    async def _rows() -> list[dict[str, object]]:
        return await run_in_threadpool(_fetch)

    checks["postgres"] = _db_check
    report_rows = _rows

app = create_app(checks, settings.token, report_rows)

if settings.database_url:
    _inner = app.router.lifespan_context

    @asynccontextmanager
    async def _lifespan(a: FastAPI) -> AsyncIterator[None]:
        pool.open()
        try:
            async with _inner(a):
                yield
        finally:
            pool.close()

    app.router.lifespan_context = _lifespan
