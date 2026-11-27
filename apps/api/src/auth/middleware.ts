import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { AuthContext, Deps } from "../deps.js";
import { audit } from "../lib/audit.js";
import { AppError } from "../lib/errors.js";
import { can, type Permission } from "./permissions.js";
import { REAUTH_WINDOW_SEC, SESSION_IDLE_SEC, verifyAccessToken } from "./tokens.js";

export const COOKIES = { access: "fc_at", refresh: "fc_rt", csrf: "fc_csrf" } as const;

export function getAuth(res: Response): AuthContext {
  const a = res.locals.auth as AuthContext | undefined;
  if (!a) throw new AppError("UNAUTHENTICATED", "Authentication required.");
  return a;
}

/** Customer-only helper: every customer query is scoped by this id IN THE QUERY (no fetch-then-check). */
export function customerIdOf(res: Response): string {
  const a = getAuth(res);
  if (!a.customerId) throw new AppError("FORBIDDEN", "This action is only available to customers.");
  return a.customerId;
}

const deny = async (
  deps: Deps,
  res: Response,
  action: string,
  code: "UNAUTHENTICATED" | "FORBIDDEN" | "REAUTH_REQUIRED",
  meta = {},
) => {
  const a = res.locals.auth as AuthContext | undefined;
  await audit(deps.db, {
    actorId: a?.userId,
    actorRoles: a?.roles,
    action,
    outcome: "DENIED",
    requestId: String(res.locals.requestId),
    metadata: { code, ...meta },
  }).catch((err: unknown) => deps.logger.error({ err }, "audit write failed"));
};

const safeEqual = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Authenticates via the fc_at cookie (browser) or a Bearer token (Postman/Newman). The session row is checked on
 * every request, so logout/revocation is immediate. Cookie-authenticated unsafe requests must pass the
 * double-submit CSRF check.
 */
export function authenticate(deps: Deps): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      const header = req.header("authorization");
      const bearer = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
      const cookieToken = (req.cookies as Record<string, string> | undefined)?.[COOKIES.access];
      const token = bearer ?? cookieToken;
      const claims = token ? await verifyAccessToken(deps.keys, token) : null;
      if (!claims) {
        await deny(deps, res, "auth.authenticate", "UNAUTHENTICATED", { route: req.path });
        throw new AppError("UNAUTHENTICATED", "Authentication required.");
      }
      const r = await deps.db.query<{
        user_status: string;
        reauth_at: Date | null;
        roles: string[];
        customer_id: string | null;
        idle: boolean;
      }>(
        `SELECT u.status AS user_status, s.reauth_at,
                array(SELECT role_code FROM user_roles WHERE user_id = u.id ORDER BY 1) AS roles,
                (SELECT id FROM customers WHERE user_id = u.id) AS customer_id,
                s.last_seen_at < now() - make_interval(secs => $3) AS idle
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.id = $1 AND s.user_id = $2 AND s.revoked_at IS NULL AND s.expires_at > now()
            AND s.mfa_verified_at IS NOT NULL`,
        [claims.sid, claims.sub, SESSION_IDLE_SEC],
      );
      const row = r.rows[0];
      if (!row || row.user_status !== "ACTIVE" || row.idle) {
        await deny(deps, res, "auth.authenticate", "UNAUTHENTICATED", {
          reason: row ? "inactive_or_idle" : "session",
        });
        throw new AppError("UNAUTHENTICATED", "Your session has ended. Please sign in again.");
      }
      const viaCookie = !bearer;
      if (viaCookie && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
        const sent = req.header("x-csrf-token") ?? "";
        const expected = (req.cookies as Record<string, string>)[COOKIES.csrf] ?? "";
        if (!expected || !safeEqual(sent, expected)) {
          await deny(deps, res, "auth.csrf", "FORBIDDEN", { route: req.path });
          throw new AppError("FORBIDDEN", "CSRF check failed.");
        }
      }
      await deps.db.query(
        `UPDATE sessions SET last_seen_at = now() WHERE id = $1 AND last_seen_at < now() - interval '30 seconds'`,
        [claims.sid],
      );
      res.locals.auth = {
        userId: claims.sub,
        sessionId: claims.sid,
        roles: row.roles,
        customerId: row.customer_id,
        reauthAt: row.reauth_at,
        viaCookie,
      } satisfies AuthContext;
    })().then(() => next(), next);
  };
}

/** RBAC gate. Every denial is audited (brief §2). */
export function requirePermission(deps: Deps, permission: Permission): RequestHandler {
  return (req, res, next) => {
    const a = getAuth(res);
    if (can(a.roles, permission)) return next();
    void deny(deps, res, `permission.${permission.replace(":", "_")}`, "FORBIDDEN", {
      route: req.path,
    }).then(
      () => next(new AppError("FORBIDDEN", "You do not have permission to perform this action.")),
      next,
    );
  };
}

/** Step-up check: password + TOTP re-entered within the last 5 minutes (read from the session row). */
export async function assertRecentReauth(deps: Deps, res: Response, action: string): Promise<void> {
  const a = getAuth(res);
  const fresh = a.reauthAt && Date.now() - a.reauthAt.getTime() <= REAUTH_WINDOW_SEC * 1000;
  if (!fresh) {
    await deny(deps, res, action, "REAUTH_REQUIRED");
    throw new AppError(
      "REAUTH_REQUIRED",
      "Please confirm your identity (password and MFA code) to continue.",
    );
  }
}

export const requireReauth =
  (deps: Deps, action: string): RequestHandler =>
  (_req, res, next) => {
    assertRecentReauth(deps, res, action).then(() => next(), next);
  };
