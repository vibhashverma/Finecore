.DEFAULT_GOAL := help
COMPOSE      ?= docker compose
DEV_COMPOSE  := $(COMPOSE) -f compose.yaml -f infra/compose/compose.dev.yaml
ANALYTICS    := services/analytics

.PHONY: help install up up-dev down logs ps lint typecheck test fmt migrate seed capstone

help: ## List targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-12s %s\n", $$1, $$2}'

.env:
	cp .env.example .env

install: ## Install Node and Python dependencies
	pnpm install --frozen-lockfile
	cd $(ANALYTICS) && uv sync --frozen

up: .env ## Build and start the full stack, waiting for healthchecks
	$(COMPOSE) up -d --build --wait

up-dev: .env ## Start with dev overrides (DB, Redis and Mailpit on 127.0.0.1)
	$(DEV_COMPOSE) up -d --build --wait

down: ## Stop the stack (keeps volumes)
	$(COMPOSE) down

logs: ## Follow logs
	$(COMPOSE) logs -f --tail=100

ps: ## Show service health
	$(COMPOSE) ps

lint: ## Lint everything
	pnpm lint
	cd $(ANALYTICS) && uv run ruff check . && uv run ruff format --check . && uv run mypy

typecheck: ## Typecheck TypeScript
	pnpm typecheck

test: ## Run all unit/API tests
	pnpm test
	cd $(ANALYTICS) && uv run pytest --cov=fincore_analytics

fmt: ## Format everything
	pnpm format
	cd $(ANALYTICS) && uv run ruff format . && uv run ruff check --fix .

migrate: ## Apply DB migrations (Phase 2)
	@echo "Not implemented until Phase 2" && exit 1

seed: ## Load synthetic seed data (Phase 2)
	@echo "Not implemented until Phase 2" && exit 1

capstone: ## Run the capstone scenario (Phase 12)
	@echo "Not implemented until Phase 12" && exit 1
