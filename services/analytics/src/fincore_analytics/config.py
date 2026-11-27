from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Environment configuration. Values are validated at startup and never logged."""

    model_config = SettingsConfigDict(env_prefix="ANALYTICS_", extra="ignore")

    app_env: Literal["development", "test", "staging", "production"] = "development"
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"
    port: int = 8000
