-- migrate:up

-- Expected provider payouts and their outcome. Ledger postings link back via
-- transactions.reference_type = 'settlement'. Reconciliation runs and items are added in Phase 7.
CREATE TABLE settlements (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider           text        NOT NULL CHECK (provider IN ('SIMULATOR', 'STRIPE_TEST')),
  provider_payout_id text        NOT NULL CHECK (char_length(provider_payout_id) BETWEEN 1 AND 128),
  currency           char(3)     NOT NULL REFERENCES currencies (code),
  expected_minor     bigint      NOT NULL CHECK (expected_minor >= 0),
  actual_minor       bigint      CHECK (actual_minor >= 0),
  status             text        NOT NULL DEFAULT 'EXPECTED',
  value_date         date        NOT NULL,
  version            bigint      NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settlements_provider_payout_key UNIQUE (provider, provider_payout_id),
  CONSTRAINT settlements_matched_amounts CHECK (status <> 'MATCHED' OR actual_minor = expected_minor),
  CONSTRAINT settlements_mismatched_amounts CHECK (
    status <> 'MISMATCHED' OR (actual_minor IS NOT NULL AND actual_minor <> expected_minor))
);
CREATE INDEX settlements_status_idx ON settlements (status, value_date) WHERE status IN ('EXPECTED', 'MISMATCHED', 'FAILED');

CREATE TRIGGER settlements_touch BEFORE UPDATE ON settlements FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER settlements_state BEFORE INSERT OR UPDATE OF status ON settlements
  FOR EACH ROW EXECUTE FUNCTION enforce_state_transition('SETTLEMENT');
CREATE TRIGGER settlements_no_delete BEFORE DELETE ON settlements
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- migrate:down
DROP TABLE settlements;
