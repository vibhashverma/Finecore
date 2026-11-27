-- migrate:up
-- Assessment 04: sessions, rotating refresh tokens, MFA challenges (ADR-004).
ALTER TABLE users
  ADD COLUMN failed_login_count integer NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  ADD COLUMN locked_until timestamptz;

CREATE TABLE sessions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid        NOT NULL REFERENCES users (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,              -- absolute lifetime
  mfa_verified_at timestamptz,
  reauth_at       timestamptz,                       -- step-up (sensitive actions need < 5 min)
  revoked_at      timestamptz,
  revoke_reason   text CHECK (revoke_reason IN ('LOGOUT', 'REFRESH_REUSE', 'ADMIN', 'PASSWORD_CHANGE')),
  user_agent      text CHECK (char_length(user_agent) <= 300)
);
CREATE INDEX sessions_user_active_idx ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE refresh_tokens (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid        NOT NULL REFERENCES sessions (id),
  family_id  uuid        NOT NULL,
  token_hash bytea       NOT NULL UNIQUE,            -- sha256 of the opaque token; the token itself is never stored
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  revoked_at timestamptz
);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);

CREATE TABLE mfa_challenges (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES users (id),
  purpose     text        NOT NULL CHECK (purpose IN ('LOGIN')),
  attempts    integer     NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz
);

GRANT SELECT, INSERT, UPDATE (last_seen_at, mfa_verified_at, reauth_at, revoked_at, revoke_reason) ON sessions TO fincore_app;
GRANT SELECT, INSERT, UPDATE (used_at, revoked_at) ON refresh_tokens TO fincore_app;
GRANT SELECT, INSERT, UPDATE (attempts, consumed_at) ON mfa_challenges TO fincore_app;

-- migrate:down
DROP TABLE mfa_challenges;
DROP TABLE refresh_tokens;
DROP TABLE sessions;
ALTER TABLE users DROP COLUMN locked_until, DROP COLUMN failed_login_count;
