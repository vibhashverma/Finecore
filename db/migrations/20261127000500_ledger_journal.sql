-- migrate:up

-- Journal header. One row per balanced money movement. Immutable.
CREATE TABLE transactions (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                    text        NOT NULL CHECK (kind IN (
                            'TRANSFER', 'TOPUP', 'REFUND', 'REVERSAL', 'FEE', 'INTEREST',
                            'SETTLEMENT', 'DISPUTE', 'ADJUSTMENT', 'SIMULATED_FUNDING')),
  currency                char(3)     NOT NULL REFERENCES currencies (code),
  description             text        NOT NULL CHECK (char_length(description) BETWEEN 1 AND 500),
  -- What caused this movement (e.g. 'transfer', '<transfer id>'). Polymorphic, so there is no FK.
  reference_type          text        CHECK (reference_type ~ '^[a-z_]+$'),
  reference_id            uuid,
  reverses_transaction_id uuid        UNIQUE,  -- UNIQUE: a transaction can be reversed at most once
  created_by              uuid        REFERENCES users (id),
  -- The database transaction that created this header. Lines may only be added in that same transaction.
  db_xact                 xid8        NOT NULL DEFAULT pg_current_xact_id(),
  posted_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transactions_id_currency_key UNIQUE (id, currency),
  CONSTRAINT transactions_reversal_same_currency
    FOREIGN KEY (reverses_transaction_id, currency) REFERENCES transactions (id, currency),
  CONSTRAINT transactions_reversal_kind CHECK ((kind = 'REVERSAL') = (reverses_transaction_id IS NOT NULL)),
  CONSTRAINT transactions_no_self_reversal CHECK (reverses_transaction_id <> id),
  CONSTRAINT transactions_reference_pair CHECK ((reference_type IS NULL) = (reference_id IS NULL))
);
CREATE INDEX transactions_reference_idx ON transactions (reference_type, reference_id) WHERE reference_id IS NOT NULL;
CREATE INDEX transactions_posted_idx ON transactions (posted_at, id);

-- Journal lines. Strictly append-only.
CREATE TABLE ledger_entries (
  id             bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id uuid        NOT NULL,
  account_id     uuid        NOT NULL,
  currency       char(3)     NOT NULL,
  direction      text        NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
  amount_minor   bigint      NOT NULL CHECK (amount_minor > 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- Composite FKs: a line's currency must equal both its transaction's and its account's currency.
  CONSTRAINT ledger_entries_transaction_fk FOREIGN KEY (transaction_id, currency) REFERENCES transactions (id, currency),
  CONSTRAINT ledger_entries_account_fk FOREIGN KEY (account_id, currency) REFERENCES accounts (id, currency)
);
CREATE INDEX ledger_entries_account_idx ON ledger_entries (account_id, id);
CREATE INDEX ledger_entries_transaction_idx ON ledger_entries (transaction_id);

-- Server-controlled columns can't be forged by the client.
CREATE FUNCTION transaction_before_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.db_xact := pg_current_xact_id();
  NEW.posted_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER transactions_server_fields BEFORE INSERT ON transactions
  FOR EACH ROW EXECUTE FUNCTION transaction_before_insert();

-- Blocks appending a (balanced) pair of lines to a journal that was committed earlier.
CREATE FUNCTION ledger_entry_before_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_xact xid8;
BEGIN
  SELECT t.db_xact INTO v_xact FROM transactions t WHERE t.id = NEW.transaction_id;
  IF FOUND AND v_xact <> pg_current_xact_id() THEN
    RAISE EXCEPTION 'ledger entries can only be added to transaction % in the database transaction that created it',
      NEW.transaction_id USING ERRCODE = 'FC003';
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER ledger_entries_same_xact BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_entry_before_insert();

-- Keeps cached balances in step with the ledger. SECURITY DEFINER: the app role can't touch balances itself.
-- The CHECK on account_balances makes an overdrafting line fail immediately (SQLSTATE 23514).
CREATE FUNCTION ledger_entry_apply_balance() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE account_balances b
     SET posted_minor = b.posted_minor
                        + CASE WHEN NEW.direction = a.normal_side THEN NEW.amount_minor ELSE -NEW.amount_minor END,
         updated_at = now()
    FROM accounts a
   WHERE b.account_id = NEW.account_id
     AND a.id = NEW.account_id;
  RETURN NULL;
END
$$;
CREATE TRIGGER ledger_entries_apply_balance AFTER INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_entry_apply_balance();

-- Checked at COMMIT (deferred), once per journal:
--   * at least 2 lines, and Σ debits = Σ credits
--   * a reversal exactly mirrors its original (same accounts and amounts, opposite directions)
--   * a reversal can't itself be reversed
CREATE FUNCTION check_transaction_integrity() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_debits    bigint;
  v_credits   bigint;
  v_lines     integer;
  v_orig_kind text;
  v_mismatch  integer;
BEGIN
  SELECT coalesce(sum(e.amount_minor) FILTER (WHERE e.direction = 'DEBIT'), 0),
         coalesce(sum(e.amount_minor) FILTER (WHERE e.direction = 'CREDIT'), 0),
         count(*)
    INTO v_debits, v_credits, v_lines
    FROM ledger_entries e
   WHERE e.transaction_id = NEW.id;

  IF v_lines < 2 THEN
    RAISE EXCEPTION 'transaction % has % ledger entries; at least 2 are required', NEW.id, v_lines
      USING ERRCODE = 'FC002';
  END IF;
  IF v_debits <> v_credits THEN
    RAISE EXCEPTION 'transaction % is unbalanced: debits % <> credits %', NEW.id, v_debits, v_credits
      USING ERRCODE = 'FC002';
  END IF;

  IF NEW.reverses_transaction_id IS NOT NULL THEN
    SELECT t.kind INTO v_orig_kind FROM transactions t WHERE t.id = NEW.reverses_transaction_id;
    IF v_orig_kind = 'REVERSAL' THEN
      RAISE EXCEPTION 'transaction % is a reversal and cannot itself be reversed', NEW.reverses_transaction_id
        USING ERRCODE = 'FC004';
    END IF;

    SELECT count(*) INTO v_mismatch FROM (
      (SELECT o.account_id,
              CASE o.direction WHEN 'DEBIT' THEN 'CREDIT' ELSE 'DEBIT' END AS direction,
              o.amount_minor
         FROM ledger_entries o WHERE o.transaction_id = NEW.reverses_transaction_id
       EXCEPT ALL
       SELECT r.account_id, r.direction, r.amount_minor
         FROM ledger_entries r WHERE r.transaction_id = NEW.id)
      UNION ALL
      (SELECT r.account_id, r.direction, r.amount_minor
         FROM ledger_entries r WHERE r.transaction_id = NEW.id
       EXCEPT ALL
       SELECT o.account_id,
              CASE o.direction WHEN 'DEBIT' THEN 'CREDIT' ELSE 'DEBIT' END,
              o.amount_minor
         FROM ledger_entries o WHERE o.transaction_id = NEW.reverses_transaction_id)
    ) AS diff;

    IF v_mismatch > 0 THEN
      RAISE EXCEPTION 'reversal % does not exactly mirror transaction %', NEW.id, NEW.reverses_transaction_id
        USING ERRCODE = 'FC004';
    END IF;
  END IF;

  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER transactions_integrity AFTER INSERT ON transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_transaction_integrity();

-- Append-only, enforced twice: by these triggers and by the absence of UPDATE/DELETE grants.
CREATE TRIGGER transactions_append_only BEFORE UPDATE OR DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER transactions_no_truncate BEFORE TRUNCATE ON transactions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- migrate:down
DROP TABLE ledger_entries;
DROP TABLE transactions;
DROP FUNCTION check_transaction_integrity();
DROP FUNCTION ledger_entry_apply_balance();
DROP FUNCTION ledger_entry_before_insert();
DROP FUNCTION transaction_before_insert();
