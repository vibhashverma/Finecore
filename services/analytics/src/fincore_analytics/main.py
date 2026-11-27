"""ASGI entrypoint: `uvicorn fincore_analytics.main:app`.

Uvicorn handles SIGTERM with a graceful drain.
"""

from .app import create_app
from .config import Settings
from .logging import configure_logging

settings = Settings()
configure_logging(settings.log_level)
# The read-only Postgres readiness check is added in Phase 6, when the DB views exist.
app = create_app()
