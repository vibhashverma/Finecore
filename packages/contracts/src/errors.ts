/**
 * Error catalog: the single source of truth for API error codes and their HTTP status.
 * Documented in docs/API.md (Phase 5). Adding a code here is a contract change.
 */
export const ERROR_CATALOG = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  REAUTH_REQUIRED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INVALID_STATE_TRANSITION: 409,
  IDEMPOTENCY_KEY_REUSED: 422,
  INSUFFICIENT_FUNDS: 422,
  LIMIT_EXCEEDED: 422,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  UPSTREAM_UNAVAILABLE: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_CATALOG;

export const ERROR_CODES = Object.keys(ERROR_CATALOG) as ErrorCode[];

export function httpStatusFor(code: ErrorCode): number {
  return ERROR_CATALOG[code];
}
