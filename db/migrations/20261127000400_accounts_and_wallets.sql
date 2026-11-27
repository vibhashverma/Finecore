-- migrate:up

-- Chart of accounts. Every ledger line posts to exactly one account. Accounts are immutable once created.
CREATE TABLE accounts (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text        NOT NULL UNIQUE CHECK (code ~ '^[A-Z]+:[A-Za-z0-9_:-]+$'),
  name        text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  type        text        NOT NULL CHECK (type IN ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE')),
  normal_side text        NOT NULL CHECK (normal_side IN ('DEBIT', 'CREDIT')),
  currency    char(3)     NOT NULL REFERENCES currencies (code),
  is_system   boolean     NOT NULL DEFAULT false,
  system_role text        CHECK (system_role IN (
                'PROVIDER_CLEARING', 'SETTLEMENT_BANK', 'SETTLEMENT_SUSPENSE', 'DISPUTE_SUSPENSE',
                'FEES_REVENUE', 'INTEREST_EXPENSE', 'SIMULATED_FUNDING')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- Target of composite FKs, so a line's currency must equal its account's currency.
  CONSTRAINT accounts_id_currency_key UNIQUE (id, currency),
  CONSTRAINT accounts_normal_side_matches_type CHECK (
    (type IN ('ASSET', 'EXPENSE') AND normal_side = 'DEBIT') OR
    (type IN ('LIABILITY', 'EQUITY', 'REVENUE') AND normal_side = 'CREDIT')),
  CONSTRAINT accounts_system_role_iff_system CHECK (is_system = (system_role IS NOT NULL))
);
CREATE UNIQUE INDEX accounts_one_system_role_per_currency ON accounts (system_role, currency)
  WHERE system_role IS NOT NULL;

CREATE TRIGGER accounts_immutable BEFORE UPDATE OR DELETE ON accounts
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER accounts_no_truncate BEFORE TRUNCATE ON accounts
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- System accounts (one per role per currency).
INSERT INTO accounts (code, name, type, normal_side, currency, is_system, system_role)
SELECT 'SYS:' || r.role || ':' || c.code, r.label || ' (' || c.code || ')', r.type, r.side, c.code, true, r.role
  FROM currencies c
 CROSS JOIN (VALUES
   ('PROVIDER_CLEARING',   'Payment provider clearing',         'ASSET',     'DEBIT'),
   ('SETTLEMENT_BANK',     'Settlement bank (SIMULATED)',       'ASSET',     'DEBIT'),
   ('SETTLEMENT_SUSPENSE', 'Settlement suspense',               'ASSET',     'DEBIT'),
   ('DISPUTE_SUSPENSE',    'Dispute suspense',                  'LIABILITY', 'CREDIT'),
   ('FEES_REVENUE',        'Fee revenue',                       'REVENUE',   'CREDIT'),
   ('INTEREST_EXPENSE',    'Interest expense',                  'EXPENSE',   'DEBIT'),
   ('SIMULATED_FUNDING',   'SIMULATED funding (demo money)',    'EQUITY',    'CREDIT')
 ) AS r (role, label, type, side);

-- Cached balances, only for accounts that need an overdraft check (customer wallets; ADR-003).
-- posted_minor is in normal-side terms: for a wallet (credit-normal) it is credits minus debits.
-- It is maintained ONLY by ledger/hold triggers: the app role may lock rows (SELECT FOR UPDATE)
-- but has no privilege to change the balance columns.
CREATE TABLE account_balances (
  account_id   uuid        PRIMARY KEY REFERENCES accounts (id),
  posted_minor bigint      NOT NULL DEFAULT 0,
  held_minor   bigint      NOT NULL DEFAULT 0 CHECK (held_minor >= 0),
  floor_minor  bigint      NOT NULL DEFAULT 0,
  version      bigint      NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  -- The overdraft backstop: fails the statement (SQLSTATE 23514) if available funds would go below the floor.
  CONSTRAINT available_not_below_floor CHECK (posted_minor - held_minor >= floor_minor)
);

CREATE TABLE wallets (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id    uuid        NOT NULL REFERENCES customers (id),
  account_id     uuid        NOT NULL UNIQUE,
  currency       char(3)     NOT NULL,
  -- Synthetic account number; masked (••••1234) in every staff view and log.
  account_number text        NOT NULL UNIQUE CHECK (account_number ~ '^FC[0-9]{10}$'),
  nickname       text        CHECK (char_length(nickname) <= 60),
  status         text        NOT NULL DEFAULT 'ACTIVE',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wallets_account_currency_fk FOREIGN KEY (account_id, currency) REFERENCES accounts (id, currency)
);
CREATE INDEX wallets_customer_idx ON wallets (customer_id, created_at, id);

CREATE TRIGGER wallets_touch BEFORE UPDATE ON wallets FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER wallets_state BEFORE INSERT OR UPDATE OF status ON wallets
  FOR EACH ROW EXECUTE FUNCTION enforce_state_transition('WALLET');

-- A wallet must be backed by a non-system LIABILITY account. Creating it opens a zero balance with floor 0.
CREATE FUNCTION wallet_open_balance() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_type text;
  v_system boolean;
BEGIN
  SELECT a.type, a.is_system INTO v_type, v_system FROM accounts a WHERE a.id = NEW.account_id;
  IF v_type IS DISTINCT FROM 'LIABILITY' OR v_system THEN
    RAISE EXCEPTION 'wallet % must be backed by a non-system LIABILITY account', NEW.id USING ERRCODE = 'FC007';
  END IF;
  INSERT INTO account_balances (account_id, floor_minor) VALUES (NEW.account_id, 0);
  RETURN NULL;
END
$$;
CREATE TRIGGER wallets_open_balance AFTER INSERT ON wallets
  FOR EACH ROW EXECUTE FUNCTION wallet_open_balance();

-- migrate:down
DROP TABLE wallets;
DROP FUNCTION wallet_open_balance();
DROP TABLE account_balances;
DROP TABLE accounts;
