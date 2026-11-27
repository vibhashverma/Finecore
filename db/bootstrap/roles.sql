-- One-time cluster bootstrap, run as a SUPERUSER before any migration (ADR-006).
-- psql variables (never hard-code secrets): dbname, owner_password, api_password, workers_password, analytics_password
--   psql -v ON_ERROR_STOP=1 -v dbname=fincore -v owner_password=... -f db/bootstrap/roles.sql
--
-- Role model:
--   fincore_owner         owns the schema; ONLY the migration job logs in as it
--   fincore_app           NOLOGIN group: runtime privileges for api + workers (granted by migrations)
--   fincore_analytics_ro  NOLOGIN group: read-only views for analytics (Phase 6)
--   fincore_api, fincore_workers, fincore_analytics   LOGIN roles that inherit from a group

CREATE ROLE fincore_app NOLOGIN;
CREATE ROLE fincore_analytics_ro NOLOGIN;

CREATE ROLE fincore_owner LOGIN PASSWORD :'owner_password';
CREATE ROLE fincore_api LOGIN PASSWORD :'api_password' IN ROLE fincore_app;
CREATE ROLE fincore_workers LOGIN PASSWORD :'workers_password' IN ROLE fincore_app;
CREATE ROLE fincore_analytics LOGIN PASSWORD :'analytics_password' IN ROLE fincore_analytics_ro;

-- Safe defaults for runtime sessions (ADR-003). The app may tighten these per transaction with SET LOCAL.
ALTER ROLE fincore_api SET statement_timeout = '10s';
ALTER ROLE fincore_api SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE fincore_workers SET statement_timeout = '60s';
ALTER ROLE fincore_workers SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE fincore_analytics SET statement_timeout = '30s';
ALTER ROLE fincore_analytics SET default_transaction_read_only = on;

ALTER DATABASE :"dbname" OWNER TO fincore_owner;
REVOKE ALL ON DATABASE :"dbname" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"dbname" TO fincore_owner, fincore_app, fincore_analytics_ro;
