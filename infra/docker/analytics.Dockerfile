# syntax=docker/dockerfile:1.7
# FastAPI analytics image: uv builds a self-contained venv, and the runtime image has no build tools.
ARG PYTHON_IMAGE=python:3.13-slim

FROM ${PYTHON_IMAGE} AS build
COPY --from=ghcr.io/astral-sh/uv:0.11.2 /uv /bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
WORKDIR /app
COPY services/analytics/pyproject.toml services/analytics/uv.lock services/analytics/.python-version ./
RUN --mount=type=cache,target=/root/.cache/uv uv sync --frozen --no-dev --no-install-project
COPY services/analytics/src ./src
RUN --mount=type=cache,target=/root/.cache/uv uv sync --frozen --no-dev --no-editable

FROM ${PYTHON_IMAGE} AS runtime
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin app
COPY --from=build /app/.venv /app/.venv
ENV PATH=/app/.venv/bin:$PATH PYTHONUNBUFFERED=1
USER 10001
EXPOSE 8000
CMD ["uvicorn", "fincore_analytics.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-server-header", "--timeout-graceful-shutdown", "20"]
