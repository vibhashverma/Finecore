"""ASGI entrypoint: `uvicorn fincore_analytics.main:app`.

Uvicorn handles SIGTERM with a graceful drain.
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import cast

from fastapi import FastAPI

from .api import ReportRows
from .app import ReadinessCheck, create_app
from .config import Settings
from .logging import configure_logging

settings = Settings()
configure_logging(settings.log_level)

checks: dict[str, ReadinessCheck] = {}
report_rows: ReportRows | None = None

if settings.database_url:
    from psycopg.rows import dict_row
    from psycopg_pool import AsyncConnectionPool

    pool = AsyncConnectionPool(
        settings.database_url, min_size=1, max_size=4, open=False, kwargs={"row_factory": dict_row}
    )

    async def _db_check() -> None:
        async with pool.connection() as conn:
            await conn.execute("SELECT 1")

    async def _rows() -> list[dict[str, object]]:
        async with pool.connection() as conn:
            cur = await conn.execute(
                "SELECT status, currency, amount_minor, risk_score FROM analytics.transfer_facts "
                "WHERE created_at > now() - interval '30 days'"
            )
            return cast(list[dict[str, object]], await cur.fetchall())

    checks["postgres"] = _db_check
    report_rows = _rows

app = create_app(checks, settings.token, report_rows)

if settings.database_url:
    _inner = app.router.lifespan_context

    @asynccontextmanager
    async def _lifespan(a: FastAPI) -> AsyncIterator[None]:
        await pool.open()
        try:
            async with _inner(a):
                yield
        finally:
            await pool.close()

    app.router.lifespan_context = _lifespan
