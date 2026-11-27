import importlib

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from fincore_analytics.config import Settings


def test_entrypoint_builds_app_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANALYTICS_LOG_LEVEL", "WARNING")
    main = importlib.import_module("fincore_analytics.main")
    assert TestClient(main.app).get("/healthz").status_code == 200


def test_invalid_settings_fail_fast(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANALYTICS_APP_ENV", "prod-ish")
    with pytest.raises(ValidationError):
        Settings()
