/**
 * SQLSTATEs raised by FinCore's database integrity rules, and the API error each one maps to.
 * FCxxx codes are custom (see db/migrations/20261127000100_foundations.sql).
 */
export const DB_ERROR = {
  APPEND_ONLY: "FC001",
  UNBALANCED: "FC002",
  LATE_ENTRY: "FC003",
  INVALID_REVERSAL: "FC004",
  IMMUTABLE_FIELD: "FC005",
  INVALID_STATE_TRANSITION: "FC006",
  INVALID_WALLET_ACCOUNT: "FC007",
  CHECK_VIOLATION: "23514",
  UNIQUE_VIOLATION: "23505",
  FOREIGN_KEY_VIOLATION: "23503",
  INSUFFICIENT_PRIVILEGE: "42501",
  SERIALIZATION_FAILURE: "40001",
  DEADLOCK_DETECTED: "40P01",
  LOCK_NOT_AVAILABLE: "55P03",
  QUERY_CANCELED: "57014",
} as const;

/** The CHECK constraint that refuses overdrafts on account_balances. */
export const OVERDRAFT_CONSTRAINT = "available_not_below_floor";

export interface PgError extends Error {
  code: string;
  constraint?: string;
}

export function isPgError(err: unknown): err is PgError {
  return err instanceof Error && typeof (err as { code?: unknown }).code === "string";
}

export function isOverdraft(err: unknown): boolean {
  return (
    isPgError(err) &&
    err.code === DB_ERROR.CHECK_VIOLATION &&
    err.constraint === OVERDRAFT_CONSTRAINT
  );
}

/** Errors that are safe to retry by re-running the whole transaction (ADR-003). */
export function isRetryableTxError(err: unknown): boolean {
  return (
    isPgError(err) &&
    (err.code === DB_ERROR.SERIALIZATION_FAILURE || err.code === DB_ERROR.DEADLOCK_DETECTED)
  );
}
