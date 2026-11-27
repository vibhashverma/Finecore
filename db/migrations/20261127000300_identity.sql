-- migrate:up

-- Sessions, refresh tokens and MFA challenges are added in Phase 3 (Assessment 04).
CREATE TABLE users (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email          citext      NOT NULL UNIQUE CHECK (char_length(email) <= 254 AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  -- Never plaintext: only Argon2id PHC strings are accepted (ADR-004).
  password_hash  text        NOT NULL CHECK (password_hash LIKE '$argon2id$%'),
  mfa_secret_enc bytea,
  status         text        NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'LOCKED', 'DISABLED')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER users_touch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE user_roles (
  user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role_code  text        NOT NULL REFERENCES roles (code),
  granted_by uuid        REFERENCES users (id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_code)
);

CREATE TABLE customers (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL UNIQUE REFERENCES users (id),
  full_name  text        NOT NULL CHECK (char_length(full_name) BETWEEN 1 AND 200),
  -- KYC is SIMULATED: no identity documents are ever collected.
  kyc_status text        NOT NULL DEFAULT 'SIMULATED_VERIFIED'
             CHECK (kyc_status IN ('SIMULATED_PENDING', 'SIMULATED_VERIFIED', 'SIMULATED_REJECTED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER customers_touch BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- migrate:down
DROP TABLE customers;
DROP TABLE user_roles;
DROP TABLE users;
