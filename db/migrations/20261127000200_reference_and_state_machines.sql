-- migrate:up

-- ISO 4217 currencies and their minor-unit exponent (ADR-001). JPY (exponent 0) proves exponent handling.
CREATE TABLE currencies (
  code     char(3)  PRIMARY KEY CHECK (code ~ '^[A-Z]{3}$'),
  exponent smallint NOT NULL CHECK (exponent BETWEEN 0 AND 4),
  name     text     NOT NULL
);
INSERT INTO currencies (code, exponent, name) VALUES
  ('INR', 2, 'Indian Rupee'),
  ('USD', 2, 'US Dollar'),
  ('JPY', 0, 'Japanese Yen');

CREATE TABLE roles (
  code        text PRIMARY KEY CHECK (code ~ '^[A-Z_]+$'),
  description text NOT NULL
);
INSERT INTO roles (code, description) VALUES
  ('CUSTOMER', 'Customer: manages own wallets, beneficiaries, transfers and disputes'),
  ('SUPPORT',  'Support agent: masked read access, raises and resolves disputes up to a limit'),
  ('OPS',      'Operations analyst: risk alerts, read-only reconciliation and audit'),
  ('FINANCE',  'Finance administrator: settlements, reconciliation, refunds and reversals'),
  ('ADMIN',    'Platform administrator: users, roles and configuration');

-- Allowed state transitions for every state machine. from_state NULL = the allowed initial state(s).
-- Enforced by enforce_state_transition(); illegal transitions raise FC006 (API: 409 INVALID_STATE_TRANSITION).
CREATE TABLE state_machine_transitions (
  entity_type text NOT NULL CHECK (entity_type ~ '^[A-Z_]+$'),
  from_state  text,
  to_state    text NOT NULL,
  CONSTRAINT state_machine_transitions_uniq UNIQUE NULLS NOT DISTINCT (entity_type, from_state, to_state)
);
INSERT INTO state_machine_transitions (entity_type, from_state, to_state) VALUES
  -- Transfer: INITIATED → PENDING → POSTED | FAILED; POSTED → REVERSED
  ('TRANSFER', NULL, 'INITIATED'),
  ('TRANSFER', 'INITIATED', 'PENDING'),
  ('TRANSFER', 'INITIATED', 'FAILED'),
  ('TRANSFER', 'PENDING', 'POSTED'),
  ('TRANSFER', 'PENDING', 'FAILED'),
  ('TRANSFER', 'POSTED', 'REVERSED'),
  -- Payment intent
  ('PAYMENT_INTENT', NULL, 'CREATED'),
  ('PAYMENT_INTENT', 'CREATED', 'REQUIRES_CONFIRMATION'),
  ('PAYMENT_INTENT', 'CREATED', 'CANCELED'),
  ('PAYMENT_INTENT', 'REQUIRES_CONFIRMATION', 'PROCESSING'),
  ('PAYMENT_INTENT', 'REQUIRES_CONFIRMATION', 'CANCELED'),
  ('PAYMENT_INTENT', 'PROCESSING', 'SUCCEEDED'),
  ('PAYMENT_INTENT', 'PROCESSING', 'FAILED'),
  ('PAYMENT_INTENT', 'PROCESSING', 'CANCELED'),
  -- Refund
  ('REFUND', NULL, 'REQUESTED'),
  ('REFUND', 'REQUESTED', 'PROCESSING'),
  ('REFUND', 'PROCESSING', 'SUCCEEDED'),
  ('REFUND', 'PROCESSING', 'FAILED'),
  -- Dispute
  ('DISPUTE', NULL, 'OPEN'),
  ('DISPUTE', 'OPEN', 'UNDER_REVIEW'),
  ('DISPUTE', 'UNDER_REVIEW', 'RESOLVED_CUSTOMER'),
  ('DISPUTE', 'UNDER_REVIEW', 'RESOLVED_MERCHANT'),
  ('DISPUTE', 'UNDER_REVIEW', 'REJECTED'),
  -- Settlement
  ('SETTLEMENT', NULL, 'EXPECTED'),
  ('SETTLEMENT', 'EXPECTED', 'MATCHED'),
  ('SETTLEMENT', 'EXPECTED', 'MISMATCHED'),
  ('SETTLEMENT', 'EXPECTED', 'FAILED'),
  ('SETTLEMENT', 'MISMATCHED', 'RESOLVED'),
  ('SETTLEMENT', 'FAILED', 'RESOLVED'),
  -- Risk alert
  ('RISK_ALERT', NULL, 'NEW'),
  ('RISK_ALERT', 'NEW', 'INVESTIGATING'),
  ('RISK_ALERT', 'INVESTIGATING', 'CLEARED'),
  ('RISK_ALERT', 'INVESTIGATING', 'ESCALATED'),
  -- Hold
  ('HOLD', NULL, 'ACTIVE'),
  ('HOLD', 'ACTIVE', 'RELEASED'),
  ('HOLD', 'ACTIVE', 'CAPTURED'),
  -- Wallet
  ('WALLET', NULL, 'ACTIVE'),
  ('WALLET', 'ACTIVE', 'FROZEN'),
  ('WALLET', 'FROZEN', 'ACTIVE'),
  ('WALLET', 'ACTIVE', 'CLOSED'),
  ('WALLET', 'FROZEN', 'CLOSED');

-- History of every state change (ADR-007). Written only by the trigger below; append-only.
CREATE TABLE state_transitions (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_type text        NOT NULL,
  entity_id   uuid        NOT NULL,
  from_state  text,
  to_state    text        NOT NULL,
  actor_id    uuid,
  reason      text        CHECK (char_length(reason) <= 500),
  request_id  text,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX state_transitions_entity_idx ON state_transitions (entity_type, entity_id, id);

CREATE TRIGGER state_transitions_append_only BEFORE UPDATE OR DELETE ON state_transitions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER state_transitions_no_truncate BEFORE TRUNCATE ON state_transitions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- Generic state-machine guard. Attach as:
--   BEFORE INSERT OR UPDATE OF status ... EXECUTE FUNCTION enforce_state_transition('<ENTITY_TYPE>')
-- The actor, reason and request id come from transaction-local settings set by the app:
--   SET LOCAL fincore.actor_id = '<uuid>'; SET LOCAL fincore.reason = '...'; SET LOCAL fincore.request_id = '...';
-- SECURITY DEFINER lets it write history the app role cannot write directly.
CREATE FUNCTION enforce_state_transition() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_entity text := TG_ARGV[0];
  v_from   text := NULL;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
      RETURN NEW;
    END IF;
    v_from := OLD.status;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM state_machine_transitions t
     WHERE t.entity_type = v_entity
       AND t.from_state IS NOT DISTINCT FROM v_from
       AND t.to_state = NEW.status
  ) THEN
    RAISE EXCEPTION 'invalid % state transition: % -> %', v_entity, coalesce(v_from, '(new)'), NEW.status
      USING ERRCODE = 'FC006';
  END IF;

  INSERT INTO state_transitions (entity_type, entity_id, from_state, to_state, actor_id, reason, request_id)
  VALUES (
    v_entity, NEW.id, v_from, NEW.status,
    nullif(current_setting('fincore.actor_id', true), '')::uuid,
    nullif(current_setting('fincore.reason', true), ''),
    nullif(current_setting('fincore.request_id', true), '')
  );
  RETURN NEW;
END
$$;

-- migrate:down
DROP FUNCTION enforce_state_transition();
DROP TABLE state_transitions;
DROP TABLE state_machine_transitions;
DROP TABLE roles;
DROP TABLE currencies;
