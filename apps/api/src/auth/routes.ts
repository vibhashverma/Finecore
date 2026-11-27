import { randomBytes, randomUUID } from "node:crypto";
import { decryptSecret, encryptSecret } from "@fincore/db";
import { hash, verify } from "@node-rs/argon2";
import { Router, type CookieOptions, type Request, type Response } from "express";
import { z } from "zod";
import type { Deps } from "../deps.js";
import { audit } from "../lib/audit.js";
import { withTx, type Tx } from "../lib/db.js";
import { AppError } from "../lib/errors.js";
import { ok, parse, route } from "../lib/http.js";
import { authenticate, COOKIES, getAuth } from "./middleware.js";
import {
  ACCESS_TTL_SEC,
  newOpaqueToken,
  REFRESH_TTL_SEC,
  sha256,
  signAccessToken,
} from "./tokens.js";
import { generateTotpSecret, otpauthUrl, totp, verifyTotp } from "./totp.js";

const ARGON2 = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const; // OWASP baseline (ADR-004)
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MIN = 15;
const CHALLENGE_TTL_SEC = 300;

const email = z
  .email()
  .max(254)
  .transform((e) => e.toLowerCase());
const password = z.string().min(12, "at least 12 characters").max(128);
const registerBody = z.object({ email, password, full_name: z.string().trim().min(1).max(200) });
const loginBody = z.object({ email, password: z.string().min(1).max(128) });
const mfaBody = z.object({ challenge_id: z.uuid(), code: z.string().regex(/^\d{6}$/) });
const reauthBody = z.object({
  password: z.string().min(1).max(128),
  code: z.string().regex(/^\d{6}$/),
});

const GENERIC_LOGIN_ERROR = "Invalid email or password, or the account is temporarily locked.";
let dummyHash: Promise<string> | undefined;

export function authRouter(deps: Deps): Router {
  const r = Router();
  const cookieBase: CookieOptions = {
    httpOnly: true,
    secure: deps.config.cookieSecure,
    sameSite: "strict",
  };
  const reqId = (res: Response) => String(res.locals.requestId);
  const ip = (req: Request) => req.ip ?? "unknown";

  async function limit(res: Response, key: string, max: number, windowSec: number) {
    const { allowed, retryAfterSec } = await deps.limiter.hit(key, max, windowSec);
    if (!allowed) {
      res.setHeader("Retry-After", String(retryAfterSec));
      await audit(deps.db, {
        action: "auth.rate_limited",
        outcome: "DENIED",
        requestId: reqId(res),
        metadata: { key: key.split(":")[0] },
      });
      throw new AppError("RATE_LIMITED", "Too many attempts. Please wait and try again.");
    }
  }

  async function issueSession(res: Response, req: Request, c: Tx, userId: string) {
    const s = await c.query<{ id: string }>(
      `INSERT INTO sessions (user_id, expires_at, mfa_verified_at, user_agent)
       VALUES ($1, now() + make_interval(secs => $2), now(), $3) RETURNING id`,
      [userId, REFRESH_TTL_SEC, (req.header("user-agent") ?? "").slice(0, 300)],
    );
    const sessionId = s.rows[0]?.id as string;
    const refresh = newOpaqueToken();
    await c.query(
      `INSERT INTO refresh_tokens (session_id, family_id, token_hash, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
      [sessionId, randomUUID(), sha256(refresh), REFRESH_TTL_SEC],
    );
    return { sessionId, refresh };
  }

  function setAuthCookies(res: Response, access: string, refresh: string) {
    res.cookie(COOKIES.access, access, {
      ...cookieBase,
      path: "/api",
      maxAge: ACCESS_TTL_SEC * 1000,
    });
    res.cookie(COOKIES.refresh, refresh, {
      ...cookieBase,
      path: "/api/v1/auth",
      maxAge: REFRESH_TTL_SEC * 1000,
    });
    // Double-submit CSRF token: readable by the SPA, echoed in x-csrf-token on unsafe requests.
    res.cookie(COOKIES.csrf, randomBytes(24).toString("base64url"), {
      ...cookieBase,
      httpOnly: false,
      path: "/",
    });
  }

  /** Tokens are returned in the body only for API clients that ask (Postman/Newman); browsers use cookies. */
  const wantsBodyTokens = (req: Request) => req.header("x-token-delivery") === "body";

  r.post(
    "/auth/register",
    route(async (req, res) => {
      await limit(res, `register:${ip(req)}`, 10, 3600);
      const body = parse(registerBody, req.body);
      const secret = generateTotpSecret();
      const passwordHash = await hash(body.password, ARGON2);
      const userId = await withTx(deps.db, { requestId: reqId(res) }, async (c) => {
        const u = await c.query<{ id: string }>(
          `INSERT INTO users (email, password_hash, mfa_secret_enc) VALUES ($1, $2, $3)
           ON CONFLICT (email) DO NOTHING RETURNING id`,
          [body.email, passwordHash, encryptSecret(secret, deps.mfaKey)],
        );
        const id = u.rows[0]?.id;
        // Same response shape whether or not the email exists would leak less, but the brief's UX needs a clear
        // error; we return CONFLICT without revealing anything else about the account.
        if (!id) throw new AppError("CONFLICT", "An account with this email already exists.");
        await c.query(`INSERT INTO user_roles (user_id, role_code) VALUES ($1, 'CUSTOMER')`, [id]);
        const cust = await c.query<{ id: string }>(
          `INSERT INTO customers (user_id, full_name) VALUES ($1, $2) RETURNING id`,
          [id, body.full_name],
        );
        await audit(c, {
          actorId: id,
          action: "auth.register",
          resourceType: "customer",
          resourceId: cust.rows[0]?.id,
          outcome: "ALLOWED",
          requestId: reqId(res),
        });
        return id;
      });
      // SIMULATED MFA enrolment: the secret is shown once so the user can add it to an authenticator app.
      ok(
        res,
        {
          user_id: userId,
          mfa: { simulated: true, secret, otpauth_url: otpauthUrl(secret, body.email) },
        },
        201,
      );
    }),
  );

  r.post(
    "/auth/login",
    route(async (req, res) => {
      const body = parse(loginBody, req.body);
      await limit(res, `login-ip:${ip(req)}`, 30, 900);
      await limit(res, `login-email:${body.email}`, 10, 900);
      const u = await deps.db.query<{
        id: string;
        password_hash: string;
        status: string;
        locked: boolean;
      }>(
        `SELECT id, password_hash, status, coalesce(locked_until > now(), false) AS locked FROM users WHERE email = $1`,
        [body.email],
      );
      const user = u.rows[0];
      dummyHash ??= hash("fincore-dummy-password", ARGON2);
      // Always run one Argon2 verify so unknown emails take as long as known ones (no user enumeration).
      const valid = await verify(user?.password_hash ?? (await dummyHash), body.password);
      if (!user || !valid || user.locked || user.status !== "ACTIVE") {
        if (user && !valid) {
          await deps.db.query(
            `UPDATE users SET failed_login_count = failed_login_count + 1,
                    locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN now() + make_interval(mins => $3) END
              WHERE id = $1`,
            [user.id, MAX_FAILED_LOGINS, LOCKOUT_MIN],
          );
        }
        await audit(deps.db, {
          actorId: user?.id,
          action: "auth.login",
          outcome: "DENIED",
          requestId: reqId(res),
          metadata: {
            reason: !user
              ? "unknown_email"
              : user.locked
                ? "locked"
                : !valid
                  ? "bad_password"
                  : "inactive",
          },
        });
        throw new AppError("UNAUTHENTICATED", GENERIC_LOGIN_ERROR);
      }
      const ch = await deps.db.query<{ id: string }>(
        `WITH reset AS (UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = $1)
         INSERT INTO mfa_challenges (user_id, purpose, expires_at) VALUES ($1, 'LOGIN', now() + make_interval(secs => $2)) RETURNING id`,
        [user.id, CHALLENGE_TTL_SEC],
      );
      ok(res, { mfa_required: true, challenge_id: ch.rows[0]?.id, expires_in: CHALLENGE_TTL_SEC });
    }),
  );

  r.post(
    "/auth/mfa/verify",
    route(async (req, res) => {
      const body = parse(mfaBody, req.body);
      await limit(res, `mfa:${body.challenge_id}`, 10, CHALLENGE_TTL_SEC);
      const result = await withTx(deps.db, { requestId: reqId(res) }, async (c) => {
        const q = await c.query<{
          user_id: string;
          attempts: number;
          usable: boolean;
          mfa_secret_enc: Buffer | null;
        }>(
          `SELECT ch.user_id, ch.attempts, (ch.consumed_at IS NULL AND ch.expires_at > now() AND ch.attempts < 5) AS usable,
                  u.mfa_secret_enc
             FROM mfa_challenges ch JOIN users u ON u.id = ch.user_id WHERE ch.id = $1 FOR UPDATE OF ch`,
          [body.challenge_id],
        );
        const ch = q.rows[0];
        if (!ch || !ch.usable || !ch.mfa_secret_enc)
          return { ok: false as const, userId: ch?.user_id };
        if (!verifyTotp(decryptSecret(ch.mfa_secret_enc, deps.mfaKey), body.code)) {
          await c.query(`UPDATE mfa_challenges SET attempts = attempts + 1 WHERE id = $1`, [
            body.challenge_id,
          ]);
          return { ok: false as const, userId: ch.user_id };
        }
        await c.query(`UPDATE mfa_challenges SET consumed_at = now() WHERE id = $1`, [
          body.challenge_id,
        ]);
        const s = await issueSession(res, req, c, ch.user_id);
        await audit(c, {
          actorId: ch.user_id,
          action: "auth.login",
          resourceType: "session",
          resourceId: s.sessionId,
          outcome: "ALLOWED",
          requestId: reqId(res),
        });
        return { ok: true as const, userId: ch.user_id, ...s };
      });
      if (!result.ok) {
        await audit(deps.db, {
          actorId: result.userId,
          action: "auth.mfa_verify",
          outcome: "DENIED",
          requestId: reqId(res),
        });
        throw new AppError("UNAUTHENTICATED", "Invalid or expired verification code.");
      }
      const access = await signAccessToken(deps.keys, {
        sub: result.userId,
        sid: result.sessionId,
      });
      setAuthCookies(res, access, result.refresh);
      ok(res, {
        user_id: result.userId,
        access_expires_in: ACCESS_TTL_SEC,
        ...(wantsBodyTokens(req) ? { access_token: access, refresh_token: result.refresh } : {}),
      });
    }),
  );

  // SIMULATED MFA delivery for local demos and tests ONLY. Never registered in staging/production.
  if (deps.config.APP_ENV === "development" || deps.config.APP_ENV === "test") {
    r.get(
      "/auth/mfa/dev-code",
      route(async (req, res) => {
        const { challenge_id } = parse(z.object({ challenge_id: z.uuid() }), req.query);
        const q = await deps.db.query<{ mfa_secret_enc: Buffer }>(
          `SELECT u.mfa_secret_enc FROM mfa_challenges ch JOIN users u ON u.id = ch.user_id
            WHERE ch.id = $1 AND ch.consumed_at IS NULL AND ch.expires_at > now() AND u.mfa_secret_enc IS NOT NULL`,
          [challenge_id],
        );
        const row = q.rows[0];
        if (!row) throw new AppError("NOT_FOUND", "Challenge not found.");
        ok(res, { simulated: true, code: totp(decryptSecret(row.mfa_secret_enc, deps.mfaKey)) });
      }),
    );
  }

  r.post(
    "/auth/refresh",
    route(async (req, res) => {
      const raw =
        (req.cookies as Record<string, string>)[COOKIES.refresh] ??
        (wantsBodyTokens(req)
          ? parse(z.object({ refresh_token: z.string().min(20).max(200) }), req.body).refresh_token
          : undefined);
      if (!raw) throw new AppError("UNAUTHENTICATED", "Authentication required.");
      const out = await withTx(deps.db, { requestId: reqId(res) }, async (c) => {
        const q = await c.query<{
          id: string;
          session_id: string;
          family_id: string;
          user_id: string;
          reused: boolean;
          valid: boolean;
        }>(
          `SELECT t.id, t.session_id, t.family_id, s.user_id,
                  (t.used_at IS NOT NULL OR t.revoked_at IS NOT NULL) AS reused,
                  (t.expires_at > now() AND s.revoked_at IS NULL AND s.expires_at > now()) AS valid
             FROM refresh_tokens t JOIN sessions s ON s.id = t.session_id WHERE t.token_hash = $1 FOR UPDATE OF t`,
          [sha256(raw)],
        );
        const t = q.rows[0];
        if (!t) return { kind: "unknown" as const };
        if (t.reused) {
          // Reuse of a rotated token = likely theft: kill the whole family and the session (ADR-004).
          await c.query(
            `UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`,
            [t.family_id],
          );
          await c.query(
            `UPDATE sessions SET revoked_at = now(), revoke_reason = 'REFRESH_REUSE' WHERE id = $1 AND revoked_at IS NULL`,
            [t.session_id],
          );
          await audit(c, {
            actorId: t.user_id,
            action: "auth.refresh_reuse",
            resourceType: "session",
            resourceId: t.session_id,
            outcome: "DENIED",
            requestId: reqId(res),
          });
          return { kind: "reuse" as const };
        }
        if (!t.valid) return { kind: "expired" as const };
        await c.query(`UPDATE refresh_tokens SET used_at = now() WHERE id = $1`, [t.id]);
        const refresh = newOpaqueToken();
        await c.query(
          `INSERT INTO refresh_tokens (session_id, family_id, token_hash, expires_at)
           SELECT $1, $2, $3, expires_at FROM sessions WHERE id = $1`,
          [t.session_id, t.family_id, sha256(refresh)],
        );
        return { kind: "ok" as const, userId: t.user_id, sessionId: t.session_id, refresh };
      });
      if (out.kind !== "ok")
        throw new AppError("UNAUTHENTICATED", "Your session has ended. Please sign in again.");
      const access = await signAccessToken(deps.keys, { sub: out.userId, sid: out.sessionId });
      setAuthCookies(res, access, out.refresh);
      ok(res, {
        access_expires_in: ACCESS_TTL_SEC,
        ...(wantsBodyTokens(req) ? { access_token: access, refresh_token: out.refresh } : {}),
      });
    }),
  );

  r.post(
    "/auth/logout",
    authenticate(deps),
    route(async (_req, res) => {
      const a = getAuth(res);
      await withTx(deps.db, { actorId: a.userId, requestId: reqId(res) }, async (c) => {
        await c.query(
          `UPDATE sessions SET revoked_at = now(), revoke_reason = 'LOGOUT' WHERE id = $1 AND revoked_at IS NULL`,
          [a.sessionId],
        );
        await c.query(
          `UPDATE refresh_tokens SET revoked_at = now() WHERE session_id = $1 AND revoked_at IS NULL`,
          [a.sessionId],
        );
        await audit(c, {
          actorId: a.userId,
          action: "auth.logout",
          resourceType: "session",
          resourceId: a.sessionId,
          outcome: "ALLOWED",
          requestId: reqId(res),
        });
      });
      for (const [name, path] of [
        [COOKIES.access, "/api"],
        [COOKIES.refresh, "/api/v1/auth"],
        [COOKIES.csrf, "/"],
      ] as const) {
        res.clearCookie(name, { ...cookieBase, path });
      }
      ok(res, { logged_out: true });
    }),
  );

  r.post(
    "/auth/reauth",
    authenticate(deps),
    route(async (req, res) => {
      const a = getAuth(res);
      const body = parse(reauthBody, req.body);
      await limit(res, `reauth:${a.userId}`, 10, 900);
      const u = await deps.db.query<{ password_hash: string; mfa_secret_enc: Buffer | null }>(
        `SELECT password_hash, mfa_secret_enc FROM users WHERE id = $1`,
        [a.userId],
      );
      const user = u.rows[0];
      const valid =
        !!user?.mfa_secret_enc &&
        (await verify(user.password_hash, body.password)) &&
        verifyTotp(decryptSecret(user.mfa_secret_enc, deps.mfaKey), body.code);
      if (!valid) {
        await audit(deps.db, {
          actorId: a.userId,
          action: "auth.reauth",
          outcome: "DENIED",
          requestId: reqId(res),
        });
        throw new AppError("UNAUTHENTICATED", "The password or verification code is incorrect.");
      }
      await deps.db.query(`UPDATE sessions SET reauth_at = now() WHERE id = $1`, [a.sessionId]);
      await audit(deps.db, {
        actorId: a.userId,
        action: "auth.reauth",
        outcome: "ALLOWED",
        requestId: reqId(res),
      });
      ok(res, { reauthenticated: true, valid_for_seconds: 300 });
    }),
  );

  r.get(
    "/auth/session",
    authenticate(deps),
    route((_req, res) => {
      const a = getAuth(res);
      ok(res, {
        user_id: a.userId,
        roles: a.roles,
        customer_id: a.customerId,
        reauth_at: a.reauthAt,
      });
    }),
  );

  return r;
}
