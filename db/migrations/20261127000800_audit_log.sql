-- migrate:up

-- Append-only, hash-chained audit trail (ADR-006). Each row's hash covers its content plus the previous row's hash,
-- so editing or deleting any row (even by a superuser bypassing triggers) is detectable by audit_log_verify_chain().
CREATE TABLE audit_log (
  id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chain_seq     bigint      NOT NULL UNIQUE,  -- gap-free order of the hash chain, assigned under a lock
  occurred_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_id      uuid,
  actor_roles   text[]      NOT NULL DEFAULT '{}',
  action        text        NOT NULL CHECK (action ~ '^[a-z_]+(\.[a-z_]+)+$'),  -- e.g. 'transfer.create'
  resource_type text,
  resource_id   text,
  outcome       text        NOT NULL CHECK (outcome IN ('ALLOWED', 'DENIED', 'ERROR')),
  request_id    text,
  metadata      jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  prev_hash     bytea       NOT NULL,
  hash          bytea       NOT NULL
);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_id, id);
CREATE INDEX audit_log_resource_idx ON audit_log (resource_type, resource_id, id);
CREATE INDEX audit_log_occurred_idx ON audit_log (occurred_at, id);

-- Canonical serialization: a jsonb array (unambiguous, and jsonb text output is deterministic).
CREATE FUNCTION audit_row_digest(p_prev bytea, r audit_log) RETURNS bytea
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT digest(
    p_prev || convert_to(jsonb_build_array(
      r.chain_seq,
      (extract(epoch FROM r.occurred_at) * 1000000)::bigint,
      r.actor_id, r.actor_roles, r.action, r.resource_type, r.resource_id,
      r.outcome, r.request_id, r.metadata
    )::text, 'UTF8'),
    'sha256')
$$;

-- Chain the new row onto the latest one. The advisory lock serializes audit writers until commit, so chain_seq is
-- gap-free and every writer sees its predecessor. RULE: write the audit row LAST in a transaction, after any row
-- locks, so this global lock is held briefly and never inverts lock order.
CREATE FUNCTION audit_log_chain() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_prev_hash bytea;
  v_prev_seq  bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('fincore.audit_log.chain', 0));
  SELECT a.hash, a.chain_seq INTO v_prev_hash, v_prev_seq FROM audit_log a ORDER BY a.chain_seq DESC LIMIT 1;
  NEW.chain_seq   := coalesce(v_prev_seq, 0) + 1;
  NEW.prev_hash   := coalesce(v_prev_hash, decode(repeat('00', 32), 'hex'));
  NEW.occurred_at := clock_timestamp();
  NEW.hash        := audit_row_digest(NEW.prev_hash, NEW);
  RETURN NEW;
END
$$;
CREATE TRIGGER audit_log_chain BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_chain();
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- Returns one row per problem; an empty result means the chain is intact.
CREATE FUNCTION audit_log_verify_chain() RETURNS TABLE (broken_seq bigint, problem text)
LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  r          audit_log;
  v_prev     bytea  := decode(repeat('00', 32), 'hex');
  v_expected bigint := 1;
BEGIN
  FOR r IN SELECT * FROM audit_log a ORDER BY a.chain_seq LOOP
    IF r.chain_seq <> v_expected THEN
      broken_seq := r.chain_seq; problem := 'gap: expected chain_seq ' || v_expected; RETURN NEXT;
    END IF;
    IF r.prev_hash <> v_prev THEN
      broken_seq := r.chain_seq; problem := 'prev_hash does not match the previous row'; RETURN NEXT;
    END IF;
    IF r.hash <> audit_row_digest(r.prev_hash, r) THEN
      broken_seq := r.chain_seq; problem := 'hash mismatch: row content was altered'; RETURN NEXT;
    END IF;
    v_prev := r.hash;
    v_expected := r.chain_seq + 1;
  END LOOP;
END
$$;

-- migrate:down
DROP FUNCTION audit_log_verify_chain();
DROP TABLE audit_log CASCADE;
DROP FUNCTION audit_log_chain();
