from typing import Literal

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Environment configuration. Values are validated at startup and never logged."""

    model_config = SettingsConfigDict(env_prefix="ANALYTICS_", extra="ignore")

    app_env: Literal["development", "test", "staging", "production"] = "development"
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"
    port: int = 8000
    token: str = Field(default="local-dev-only-analytics-token", min_length=16)
    # Read-only role (fincore_analytics) for the ops report views; optional (SYNTHETIC data otherwise).
    database_url: str | None = None

    @model_validator(mode="after")
    def no_dev_secrets_in_prod(self) -> "Settings":
        if self.app_env in ("staging", "production") and self.token.startswith("local-dev-only"):
            raise ValueError("ANALYTICS_TOKEN must be set in staging/production")
        return self
