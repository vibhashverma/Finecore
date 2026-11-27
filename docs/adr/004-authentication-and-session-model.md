# ADR-004: Authentication and session model

- Status: Accepted (2026-11-27, Phase 0 review)
- Date: 2026-11-27

## Context

The brief requires:

- short-lived access JWTs, plus rotating refresh tokens in httpOnly/Secure/SameSite cookies;
- revocation;
- Argon2id;
- simulated MFA;
- RBAC plus resource-level checks;
- step-up reauthentication within 5 minutes for sensitive actions;
- transaction confirmation;
- an audit trail of all of the above.

## Decision

**Transport and origin**

- One origin behind Caddy: `/` serves Next.js and `/api/v1` serves Express. The browser never sees a token in JS.
- Next.js server components forward the incoming `Cookie` and `x-request-id` headers to Express over the internal network.

**Credentials**

- Argon2id (`argon2` npm), with m = 19 MiB, t = 2, p = 1 (OWASP baseline). Parameters are encoded in the hash, so they can be upgraded later and rehashed on login.
- Login uses a constant-time dummy verify for unknown emails, to avoid user enumeration.

**Tokens**

- **Access token:** JWT, EdDSA (Ed25519) via `jose`, 10-minute TTL.
  - Claims: `sub`, `sid`, `roles`, `mfa: true`, `iat`, `exp`, `jti`.
  - Delivered as cookie `fc_at` with `httpOnly`, `Secure`, `SameSite=Strict` and `Path=/api`.
  - Express also accepts `Authorization: Bearer` for Postman and Newman.
- **Refresh token:** an opaque 256-bit random value, stored only as SHA-256 in `refresh_tokens` with a `family_id`.
  - Cookie `fc_rt` with `Path=/api/v1/auth/refresh`, 7-day absolute session lifetime and 30-minute idle timeout.
  - **Rotation on every use.** Presenting an already-used token is **reuse detection**: the whole family and the session are revoked, and the event is audited as a security alert.
- **Revocation:**
  - Logout or admin action sets `sessions.revoked_at` and writes `sid` to a Redis denylist with TTL = access-token TTL.
  - The auth middleware checks the denylist per request (an O(1) Redis GET), so revocation takes effect immediately rather than waiting up to 10 minutes.
  - If Redis is down, the middleware falls back to a DB lookup on the session.
- **CSRF:** `SameSite=Strict` cookies plus an `Origin`/`Sec-Fetch-Site` check on unsafe methods, plus a double-submit CSRF token header (`x-csrf-token`) as a second layer.

**MFA (SIMULATED delivery, real algorithm)**

- RFC 6238 TOTP via `otplib`. The secret is encrypted at rest with AES-256-GCM, using a key from env or Docker secret.
- Seeded demo users get known synthetic secrets, documented in the README, so evaluators can use any authenticator app.
- In `NODE_ENV=test|development` only, `GET /auth/mfa/dev-code` returns the current code. It is labelled **SIMULATED**, compiled out of production builds, and refuses with 404 if `APP_ENV=production`.
- Login has two steps. The password step yields a 5-minute `mfa_challenge`, and only `/auth/mfa/verify` issues tokens. Each challenge allows 5 attempts.

**Step-up reauthentication**

- `POST /auth/reauth` takes password + TOTP and sets `sessions.reauth_at = now()`.
- Middleware `requireRecentReauth(5 * 60)` reads `reauth_at` **from the session row**, not the JWT, so it can't be replayed from an old token. If it is stale, the API returns `401 REAUTH_REQUIRED`.
- It applies to: adding a beneficiary, transfers above the threshold, refunds, reversals, role and config changes, and failed-job replay.

**Transaction confirmation**

- Transfers above the confirmation threshold first return `202` with a `confirmation_id`.
- The client submits a TOTP code to `POST /transfers/confirm`. The challenge stores `binding_hash = SHA-256(source, beneficiary, amount, currency, idempotency_key)`, so a code can't be reused for a different payee or amount (simulated PSD2-style dynamic linking).

**Authorization**

- Roles: CUSTOMER, SUPPORT, OPS, FINANCE, ADMIN. Permissions are code constants (`transfers:create`, `refunds:create`, `audit:read`, …) mapped from roles in one module, with a unit test asserting the brief's matrix exactly.
- **Resource checks happen in the query**: repositories take an `AuthContext` and add `WHERE owner_customer_id = $ctx.customerId` for customers.
  - Not found or not owned returns **404**, so resource existence isn't leaked.
  - Staff reads go through masking serializers (account number `••••1234`, email `a•••@x.com`).
- Every denial (401/403/REAUTH_REQUIRED) writes an `audit_log` row with `outcome = DENIED`.

**Abuse controls**

- Login and MFA rate limits use `rate-limiter-flexible` with Redis, per IP and per account, with exponential lockout. Over the limit returns `429 RATE_LIMITED`.

## Alternatives considered

- **Opaque server sessions only (no JWT).** Simpler revocation, but the brief explicitly expects JWT plus refresh. The design above keeps a server-side session row anyway, so revocation is exact.
- **Access token in JS memory and the `Authorization` header.** Exposed to XSS and complicates server components. Rejected.
- **SMS OTP for MFA.** Needs a paid SMS sandbox and weaker security. Kept only as a MOCK notification channel.

## Consequences

- One DB or Redis read per request for session validity. This is accepted for immediate revocation.
- Postman and Newman need a login pre-request script to get a Bearer token; it will be provided.
