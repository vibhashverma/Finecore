-- migrate:up

-- Both are "trusted" extensions: the database owner can create them without superuser rights.
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Custom SQLSTATEs raised by FinCore integrity rules (mapped to API errors in docs/assessments/03-ledger-database.md):
--   FC001 append-only violation       FC002 unbalanced / too few lines   FC003 late ledger entry
--   FC004 invalid reversal            FC005 immutable column changed     FC006 invalid state transition
--   FC007 invalid wallet account

-- Attached to append-only tables. It fires even for the table owner, as defense in depth on top of the grants.
CREATE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on table "%" is not allowed: the table is append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'FC001',
          HINT = 'Record corrections as new rows, e.g. a reversing transaction.';
END
$$;

CREATE FUNCTION touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

-- migrate:down
DROP FUNCTION touch_updated_at();
DROP FUNCTION forbid_mutation();
DROP EXTENSION IF EXISTS pgcrypto;
DROP EXTENSION IF EXISTS citext;
