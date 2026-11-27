# Assessment 04: Financial identity and authorization

**Status:** complete (ADR-004).

**Credentials:**

- Argon2id with OWASP parameters; a DB CHECK rejects anything else.
- Constant-time handling for unknown emails.
- Lockout after 5 failed attempts.
- Rate limits per IP and per email (429).

**MFA:** real RFC 6238 TOTP. Secrets are encrypted with AES-256-GCM. Delivery is SIMULATED: the dev-only code endpoint does not exist in staging or production.

**Sessions:**

- EdDSA JWT valid for 10 minutes, carried in an httpOnly `SameSite=Strict` cookie (or as a Bearer token for API clients).
- The session row is checked on every request, so revocation takes effect immediately.
- Refresh tokens rotate. Reusing an old one revokes the whole token family.
- CSRF protection uses the double-submit pattern.

**Authorization:**

- An RBAC matrix (`src/auth/permissions.ts`). Roles are read from the database on every request.
- Ownership is checked inside the SQL (`customer_id = $me`), so another customer's resources return 404.
- Staff views mask PII.

**Step-up reauthentication (valid 5 minutes)** is required for:

- adding a beneficiary;
- transfers of ₹20,000 or more (transaction confirmation);
- refunds and reversals;
- resolving settlements;
- role changes;
- replaying failed jobs;
- resolving a dispute in the customer's favour.

**Audit:** every denial and every sensitive action is written to the hash-chained audit log.

**Tests (`auth.test.ts`):**

- RFC 6238 test vectors;
- lockout, enumeration resistance, MFA attempt limits and rate limiting;
- refresh-token reuse, logout revocation and tampered JWTs;
- CSRF;
- IDOR, the permission matrix, audited denials and step-up.
