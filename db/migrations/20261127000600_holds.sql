-- migrate:up

-- Funds reserved against a wallet (pending transfer, dispute, risk review). Available = posted − active holds.
-- Only accounts with a cached balance (wallets) can be held, enforced by the FK to account_balances.
CREATE TABLE holds (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid        NOT NULL REFERENCES account_balances (account_id),
  amount_minor   bigint      NOT NULL CHECK (amount_minor > 0),
  reason         text        NOT NULL CHECK (reason IN ('TRANSFER_PENDING', 'DISPUTE', 'RISK_REVIEW')),
  reference_type text        CHECK (reference_type ~ '^[a-z_]+$'),
  reference_id   uuid,
  status         text        NOT NULL DEFAULT 'ACTIVE',
  expires_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  released_at    timestamptz,
  CONSTRAINT holds_released_iff_inactive CHECK ((status = 'ACTIVE') = (released_at IS NULL)),
  CONSTRAINT holds_reference_pair CHECK ((reference_type IS NULL) = (reference_id IS NULL))
);
CREATE INDEX holds_active_by_account_idx ON holds (account_id) WHERE status = 'ACTIVE';
CREATE INDEX holds_reference_idx ON holds (reference_type, reference_id) WHERE reference_id IS NOT NULL;
CREATE INDEX holds_expiry_idx ON holds (expires_at) WHERE status = 'ACTIVE' AND expires_at IS NOT NULL;

-- Only status (and the derived released_at) may change; everything else is immutable.
CREATE FUNCTION hold_before_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.account_id, NEW.amount_minor, NEW.reason, NEW.reference_type, NEW.reference_id, NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM
     (OLD.account_id, OLD.amount_minor, OLD.reason, OLD.reference_type, OLD.reference_id, OLD.created_at, OLD.expires_at)
  THEN
    RAISE EXCEPTION 'hold % may only change status', OLD.id USING ERRCODE = 'FC005';
  END IF;
  IF NEW.status <> 'ACTIVE' AND NEW.released_at IS NULL THEN
    NEW.released_at := now();
  END IF;
  RETURN NEW;
END
$$;

-- Keeps held_minor in step. Placing a hold larger than available funds fails the CHECK (SQLSTATE 23514).
CREATE FUNCTION hold_apply_balance() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status = 'ACTIVE' THEN
    UPDATE account_balances SET held_minor = held_minor + NEW.amount_minor, updated_at = now()
     WHERE account_id = NEW.account_id;
  ELSIF TG_OP = 'UPDATE' AND OLD.status = 'ACTIVE' AND NEW.status <> 'ACTIVE' THEN
    UPDATE account_balances SET held_minor = held_minor - OLD.amount_minor, updated_at = now()
     WHERE account_id = OLD.account_id;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER holds_immutable_fields BEFORE UPDATE ON holds
  FOR EACH ROW EXECUTE FUNCTION hold_before_update();
CREATE TRIGGER holds_state BEFORE INSERT OR UPDATE OF status ON holds
  FOR EACH ROW EXECUTE FUNCTION enforce_state_transition('HOLD');
CREATE TRIGGER holds_apply_balance AFTER INSERT OR UPDATE OF status ON holds
  FOR EACH ROW EXECUTE FUNCTION hold_apply_balance();
CREATE TRIGGER holds_no_delete BEFORE DELETE ON holds
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER holds_no_truncate BEFORE TRUNCATE ON holds
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- migrate:down
DROP TABLE holds;
DROP FUNCTION hold_apply_balance();
DROP FUNCTION hold_before_update();
