-- migrate:up

-- Least-privilege grants (ADR-006). The group roles are created by db/bootstrap/roles.sql:
--   fincore_app           api and workers (login roles fincore_api, fincore_workers)
--   fincore_analytics_ro  FastAPI (login role fincore_analytics); granted views only, in Phase 6
-- Rules this migration encodes:
--   * NO UPDATE/DELETE on transactions, ledger_entries, state_transitions or audit_log
--   * NO write on account balance columns: only UPDATE(version), which is what SELECT ... FOR UPDATE needs
--   * NO direct INSERT into state_transitions: only the state-machine trigger writes history
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO fincore_app;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;

GRANT SELECT ON currencies, roles, state_machine_transitions TO fincore_app;

GRANT SELECT, INSERT, UPDATE ON users, customers TO fincore_app;
GRANT SELECT, INSERT, DELETE ON user_roles TO fincore_app;

GRANT SELECT, INSERT ON accounts TO fincore_app;
GRANT SELECT, UPDATE (version) ON account_balances TO fincore_app;
GRANT SELECT, INSERT, UPDATE (status, nickname) ON wallets TO fincore_app;

GRANT SELECT, INSERT ON transactions, ledger_entries TO fincore_app;
GRANT SELECT, INSERT, UPDATE (status) ON holds TO fincore_app;
GRANT SELECT, INSERT, UPDATE (status, actual_minor, version) ON settlements TO fincore_app;

GRANT SELECT ON state_transitions TO fincore_app;
GRANT SELECT, INSERT ON audit_log TO fincore_app;

GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO fincore_app;

-- Functions default to EXECUTE for PUBLIC; restrict the callable ones explicitly.
REVOKE EXECUTE ON FUNCTION audit_log_verify_chain(), ledger_invariant_violations(), audit_row_digest(bytea, audit_log) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_log_verify_chain(), ledger_invariant_violations(), audit_row_digest(bytea, audit_log) TO fincore_app;

-- migrate:down
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM fincore_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM fincore_app;
REVOKE EXECUTE ON FUNCTION audit_log_verify_chain(), ledger_invariant_violations(), audit_row_digest(bytea, audit_log) FROM fincore_app;
REVOKE USAGE ON SCHEMA public FROM fincore_app;
