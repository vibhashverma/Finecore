-- migrate:up
-- Assessment 08: payment intents, refunds, disputes, webhook inbox, settlement lines, reconciliation, statements.

CREATE TABLE payment_intents (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id    uuid        NOT NULL REFERENCES customers (id),
  wallet_id      uuid        NOT NULL REFERENCES wallets (id),
  amount_minor   bigint      NOT NULL CHECK (amount_minor > 0),
  refunded_minor bigint      NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0),
  currency       char(3)     NOT NULL REFERENCES currencies (code),
  status         text        NOT NULL DEFAULT 'CREATED',
  provider       text        NOT NULL CHECK (provider IN ('SIMULATOR', 'STRIPE_TEST')),
  provider_ref   text        CHECK (char_length(provider_ref) <= 128),
  transaction_id uuid        UNIQUE REFERENCES transactions (id),
  failure_code   text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_intents_refund_bound CHECK (refunded_minor <= amount_minor),
  CONSTRAINT payment_intents_provider_ref_key UNIQUE (provider, provider_ref)
);
CREATE INDEX payment_intents_customer_idx ON payment_intents (customer_id, created_at, id);
CREATE TRIGGER payment_intents_touch BEFORE UPDATE ON payment_intents FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER payment_intents_state BEFORE INSERT OR UPDATE OF status ON payment_intents
  FOR EACH ROW EXECUTE FUNCTION enforce_state_transition('PAYMENT_INTENT');

CREATE TABLE refunds (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_intent_id uuid        NOT NULL REFERENCES payment_intents (id),
  amount_minor      bigint      NOT NULL CHECK (amount_minor > 0),
  status            text        NOT NULL DEFAULT 'REQUESTED',
  reason            text        NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 500),
  provider_ref      text,
  transaction_id    uuid        UNIQUE REFERENCES transactions (id),
  requested_by      uuid        NOT NULL REFERENCES users (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER refunds_touch BEFORE UPDATE ON refunds FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER refunds_state BEFORE INSERT OR UPDATE OF status ON refunds
  FOR EACH ROW EXECUTE FUNCTION enforce_state_transition('REFUND');

CREATE TABLE disputes (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id       uuid        NOT NULL REFERENCES customers (id),
  raised_by         uuid        NOT NULL REFERENCES users (id),
  transfer_id       uuid        REFERENCES transfers (id),
  payment_intent_id uuid        REFERENCES payment_intents (id),
  amount_minor      bigint      NOT NULL CHECK (amount_minor > 0),
  currency          char(3)     NOT NULL REFERENCES currencies (code),
  reason            text        NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 1000),
  status            text        NOT NULL DEFAULT 'OPEN',
  hold_id           uuid        REFERENCES holds (id),
  transaction_id    uuid        UNIQUE REFERENCES transactions (id),
  resolution_note   text        CHECK (char_length(resolution_note) <= 1000),
  resolved_by       uuid        REFERENCES users (id),
  version           bigint      NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT disputes_exactly_one_subject CHECK ((transfer_id IS NULL) <> (payment_intent_id IS NULL))
);
CREATE UNIQUE INDEX disputes_one_open_per_transfer ON disputes (transfer_id)
  WHERE transfer_id IS NOT NULL AND status IN ('OPEN', 'UNDER_REVIEW');
CREATE INDEX disputes_customer_idx ON disputes (customer_id, created_at, id);
CREATE INDEX disputes_status_idx ON disputes (status, created_at, id);
CREATE TRIGGER disputes_touch BEFORE UPDATE ON disputes FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER disputes_state BEFORE INSERT OR UPDATE OF status ON disputes
  FOR EACH ROW EXECUTE FUNCTION enforce_state_transition('DISPUTE');

-- Webhook inbox: one row per provider event id, whatever the number of deliveries (dedup).
CREATE TABLE provider_events (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider          text        NOT NULL CHECK (provider IN ('SIMULATOR', 'STRIPE_TEST')),
  provider_event_id text        NOT NULL CHECK (char_length(provider_event_id) BETWEEN 1 AND 128),
  type              text        NOT NULL,
  payload           jsonb       NOT NULL,
  status            text        NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED')),
  deliveries        integer     NOT NULL DEFAULT 1,
  error             text,
  received_at       timestamptz NOT NULL DEFAULT now(),
  processed_at      timestamptz,
  CONSTRAINT provider_events_dedup_key UNIQUE (provider, provider_event_id)
);
CREATE INDEX provider_events_pending_idx ON provider_events (received_at) WHERE status = 'RECEIVED';

CREATE TABLE settlement_lines (
  id            uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_id uuid    NOT NULL REFERENCES settlements (id),
  provider_ref  text    NOT NULL,
  amount_minor  bigint  NOT NULL CHECK (amount_minor > 0),
  CONSTRAINT settlement_lines_uniq UNIQUE (settlement_id, provider_ref)
);

CREATE TABLE reconciliation_runs (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_id uuid       NOT NULL REFERENCES settlements (id),
  status       text        NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED')),
  summary      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_by   uuid        REFERENCES users (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE reconciliation_items (
  id                uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            uuid    NOT NULL REFERENCES reconciliation_runs (id),
  provider_ref      text    NOT NULL,
  payment_intent_id uuid    REFERENCES payment_intents (id),
  outcome           text    NOT NULL CHECK (outcome IN ('MATCHED', 'AMOUNT_MISMATCH', 'MISSING_INTERNAL', 'MISSING_PROVIDER')),
  expected_minor    bigint  NOT NULL DEFAULT 0,
  actual_minor      bigint  NOT NULL DEFAULT 0,
  diff_minor        bigint  NOT NULL DEFAULT 0
);
CREATE INDEX reconciliation_items_run_idx ON reconciliation_items (run_id);

CREATE TABLE statements (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id           uuid        NOT NULL REFERENCES wallets (id),
  period_start        date        NOT NULL,
  period_end          date        NOT NULL CHECK (period_end >= period_start),
  opening_minor       bigint      NOT NULL,
  closing_minor       bigint      NOT NULL,
  total_credits_minor bigint      NOT NULL,
  total_debits_minor  bigint      NOT NULL,
  entry_count         integer     NOT NULL,
  generated_at        timestamptz NOT NULL DEFAULT now(),
  -- Immutable snapshots: an open period gets a new snapshot when new entries land (append-only ledger).
  CONSTRAINT statements_snapshot_uniq UNIQUE (wallet_id, period_start, period_end, entry_count),
  CONSTRAINT statements_closing_consistent CHECK (closing_minor = opening_minor + total_credits_minor - total_debits_minor)
);

-- Read-only reporting surface for the analytics service (ADR-006): no PII, no secrets.
CREATE SCHEMA analytics;
CREATE VIEW analytics.transfer_facts AS
  SELECT t.id, t.customer_id, t.source_wallet_id, t.dest_wallet_id, t.amount_minor, t.fee_minor, t.currency,
         t.status, t.risk_score, t.created_at, b.created_at AS beneficiary_created_at
    FROM public.transfers t JOIN public.beneficiaries b ON b.id = t.beneficiary_id;
CREATE VIEW analytics.daily_volume AS
  SELECT date_trunc('day', created_at)::date AS day, currency, status, count(*) AS transfers,
         sum(amount_minor) AS amount_minor, sum(fee_minor) AS fee_minor
    FROM public.transfers GROUP BY 1, 2, 3;
CREATE VIEW analytics.alert_summary AS
  SELECT status, count(*) AS alerts, avg(score)::numeric(5,2) AS avg_score FROM public.risk_alerts GROUP BY status;
GRANT USAGE ON SCHEMA analytics TO fincore_analytics_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA analytics TO fincore_analytics_ro;

GRANT SELECT, INSERT, UPDATE (status, refunded_minor, provider_ref, transaction_id, failure_code) ON payment_intents TO fincore_app;
GRANT SELECT, INSERT, UPDATE (status, provider_ref, transaction_id) ON refunds TO fincore_app;
GRANT SELECT, INSERT, UPDATE (status, hold_id, transaction_id, resolution_note, resolved_by, version) ON disputes TO fincore_app;
GRANT SELECT, INSERT, UPDATE (status, deliveries, error, processed_at) ON provider_events TO fincore_app;
GRANT SELECT, INSERT ON settlement_lines TO fincore_app;
GRANT SELECT, INSERT, UPDATE (status, summary, completed_at) ON reconciliation_runs TO fincore_app;
GRANT SELECT, INSERT ON reconciliation_items TO fincore_app;
GRANT SELECT, INSERT ON statements TO fincore_app;

-- migrate:down
DROP SCHEMA analytics CASCADE;
DROP TABLE statements;
DROP TABLE reconciliation_items;
DROP TABLE reconciliation_runs;
DROP TABLE settlement_lines;
DROP TABLE provider_events;
DROP TABLE disputes;
DROP TABLE refunds;
DROP TABLE payment_intents;
