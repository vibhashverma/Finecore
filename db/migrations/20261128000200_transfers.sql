-- migrate:up
-- Assessments 02/07: beneficiaries, fee schedules, transfers, reversals, risk alerts, idempotency, outbox/job queue.

CREATE TABLE beneficiaries (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id      uuid        NOT NULL REFERENCES customers (id),
  target_wallet_id uuid        NOT NULL REFERENCES wallets (id),
  nickname         text        NOT NULL CHECK (char_length(nickname) BETWEEN 1 AND 60),
  created_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);
CREATE UNIQUE INDEX beneficiaries_active_uniq ON beneficiaries (customer_id, target_wallet_id) WHERE deleted_at IS NULL;
CREATE INDEX beneficiaries_customer_idx ON beneficiaries (customer_id, created_at, id);

-- Versioned fee rules (owned by config; evaluated by the analytics service in Decimal, ADR-011).
CREATE TABLE fee_schedules (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  kind           text        NOT NULL CHECK (kind IN ('TRANSFER')),
  currency       char(3)     NOT NULL REFERENCES currencies (code),
  flat_minor     bigint      NOT NULL DEFAULT 0 CHECK (flat_minor >= 0),
  rate_bps       integer     NOT NULL DEFAULT 0 CHECK (rate_bps BETWEEN 0 AND 10000),
  min_minor      bigint      NOT NULL DEFAULT 0 CHECK (min_minor >= 0),
  max_minor      bigint      CHECK (max_minor IS NULL OR max_minor >= min_minor),
  effective_from timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fee_schedules_lookup_idx ON fee_schedules (kind, currency, effective_from DESC);
INSERT INTO fee_schedules (kind, currency, flat_minor, rate_bps, min_minor, max_minor, effective_from) VALUES
  ('TRANSFER', 'INR', 0, 10, 100, 5000, '2026-01-01'),   -- 0.10%, min ₹1.00, max ₹50.00
  ('TRANSFER', 'USD', 0, 10, 10, 500, '2026-01-01'),     -- 0.10%, min $0.10, max $5.00
  ('TRANSFER', 'JPY', 0, 10, 10, 500, '2026-01-01');     -- 0.10%, min ¥10, max ¥500

CREATE TABLE transfers (
  id               uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id      uuid         NOT NULL REFERENCES customers (id),
  source_wallet_id uuid         NOT NULL REFERENCES wallets (id),
  dest_wallet_id   uuid         NOT NULL REFERENCES wallets (id),
  beneficiary_id   uuid         NOT NULL REFERENCES beneficiaries (id),
  amount_minor     bigint       NOT NULL CHECK (amount_minor > 0),
  fee_minor        bigint       NOT NULL DEFAULT 0 CHECK (fee_minor >= 0),
  currency         char(3)      NOT NULL REFERENCES currencies (code),
  status           text         NOT NULL DEFAULT 'INITIATED',
  description      text         CHECK (char_length(description) <= 140),
  transaction_id   uuid         UNIQUE REFERENCES transactions (id),
  hold_id          uuid         REFERENCES holds (id),
  risk_score       numeric(5,2) CHECK (risk_score BETWEEN 0 AND 100),
  risk_reasons     jsonb        NOT NULL DEFAULT '[]'::jsonb,
  failure_code     text,
  version          bigint       NOT NULL DEFAULT 0,
  created_at       timestamptz  NOT NULL DEFAULT now(),
  updated_at       timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT transfers_distinct_wallets CHECK (source_wallet_id <> dest_wallet_id),
  CONSTRAINT transfers_posted_has_journal CHECK (status NOT IN ('POSTED', 'REVERSED') OR transaction_id IS NOT NULL)
);
CREATE INDEX transfers_customer_idx ON transfers (customer_id, created_at, id);
CREATE INDEX transfers_source_idx ON transfers (source_wallet_id, created_at);
CREATE INDEX transfers_pending_idx ON transfers (updated_at) WHERE status IN ('INITIATED', 'PENDING');
CREATE TRIGGER transfers_touch BEFORE UPDATE ON transfers FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER transfers_state BEFORE INSERT OR UPDATE OF status ON transfers
  FOR EACH ROW EXECUTE FUNCTION enforce_state_transition('TRANSFER');
CREATE TRIGGER transfers_no_delete BEFORE DELETE ON transfers FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE reversals (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id    uuid        NOT NULL UNIQUE REFERENCES transfers (id),
  transaction_id uuid        NOT NULL UNIQUE REFERENCES transactions (id),
  requested_by   uuid        NOT NULL REFERENCES users (id),
  reason         text        NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 500),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER reversals_append_only BEFORE UPDATE OR DELETE ON reversals FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Decision support only: a score is never proof of fraud (Assessment 06).
CREATE TABLE risk_alerts (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text         NOT NULL DEFAULT 'TRANSFER_RISK'
                  CHECK (kind IN ('TRANSFER_RISK', 'SETTLEMENT_FAILED', 'SETTLEMENT_MISMATCH', 'WEBHOOK_ANOMALY')),
  customer_id     uuid         REFERENCES customers (id),
  transfer_id     uuid         REFERENCES transfers (id),
  settlement_id   uuid         REFERENCES settlements (id),
  score           numeric(5,2) NOT NULL CHECK (score BETWEEN 0 AND 100),
  reasons         jsonb        NOT NULL DEFAULT '[]'::jsonb,
  status          text         NOT NULL DEFAULT 'NEW',
  assignee_id     uuid         REFERENCES users (id),
  resolution_note text         CHECK (char_length(resolution_note) <= 1000),
  version         bigint       NOT NULL DEFAULT 0,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX risk_alerts_status_idx ON risk_alerts (status, created_at, id);
CREATE TRIGGER risk_alerts_touch BEFORE UPDATE ON risk_alerts FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER risk_alerts_state BEFORE INSERT OR UPDATE OF status ON risk_alerts
  FOR EACH ROW EXECUTE FUNCTION enforce_state_transition('RISK_ALERT');

-- Idempotency for money-moving POSTs (ADR-008).
CREATE TABLE idempotency_keys (
  user_id       uuid        NOT NULL REFERENCES users (id),
  key           uuid        NOT NULL,
  route         text        NOT NULL,
  request_hash  bytea       NOT NULL,
  status        text        NOT NULL CHECK (status IN ('IN_PROGRESS', 'COMPLETED')),
  response_code integer,
  response_body jsonb,
  locked_until  timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY (user_id, key),
  CONSTRAINT idempotency_completed_has_response CHECK (status <> 'COMPLETED' OR response_code IS NOT NULL)
);
CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys (expires_at);

-- Transactional outbox, which is also the job queue (ADR-009): written in the same transaction as the
-- business change, then claimed by workers with FOR UPDATE SKIP LOCKED.
CREATE TABLE outbox (
  id              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  topic           text        NOT NULL CHECK (topic ~ '^[a-z_]+\.[a-z_]+$'),
  payload         jsonb       NOT NULL,
  dedupe_key      text        UNIQUE,
  status          text        NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DONE', 'DEAD')),
  attempts        integer     NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  processed_at    timestamptz
);
CREATE INDEX outbox_due_idx ON outbox (next_attempt_at, id) WHERE status = 'PENDING';

CREATE TABLE failed_jobs (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  outbox_id   bigint      NOT NULL UNIQUE REFERENCES outbox (id),
  topic       text        NOT NULL,
  error       text        NOT NULL,
  attempts    integer     NOT NULL,
  failed_at   timestamptz NOT NULL DEFAULT now(),
  replayed_at timestamptz,
  replayed_by uuid        REFERENCES users (id)
);

GRANT SELECT, INSERT, UPDATE (nickname, deleted_at) ON beneficiaries TO fincore_app;
GRANT SELECT ON fee_schedules TO fincore_app;
GRANT SELECT, INSERT, UPDATE (status, transaction_id, hold_id, risk_score, risk_reasons, failure_code, version) ON transfers TO fincore_app;
GRANT SELECT, INSERT ON reversals TO fincore_app;
GRANT SELECT, INSERT, UPDATE (status, assignee_id, resolution_note, version) ON risk_alerts TO fincore_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON idempotency_keys TO fincore_app;
GRANT SELECT, INSERT, UPDATE (status, attempts, next_attempt_at, last_error, processed_at) ON outbox TO fincore_app;
GRANT SELECT, INSERT, UPDATE (error, attempts, failed_at, replayed_at, replayed_by) ON failed_jobs TO fincore_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO fincore_app;

-- migrate:down
DROP TABLE failed_jobs;
DROP TABLE outbox;
DROP TABLE idempotency_keys;
DROP TABLE risk_alerts;
DROP TABLE reversals;
DROP TABLE transfers;
DROP TABLE fee_schedules;
DROP TABLE beneficiaries;
