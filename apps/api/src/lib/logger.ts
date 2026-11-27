import { pino, type Logger } from "pino";

/**
 * Structured JSON logger. Redaction paths keep credentials, tokens and PII out of logs.
 * Extend REDACT_PATHS whenever a new sensitive field is introduced.
 */
export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['x-csrf-token']",
  "res.headers['set-cookie']",
  "*.password",
  "*.password_hash",
  "*.token",
  "*.refresh_token",
  "*.mfa_secret",
  "*.code",
  "*.account_number",
];

export function createLogger(level: string, service: string): Logger {
  return pino({
    level,
    base: { service },
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  });
}
