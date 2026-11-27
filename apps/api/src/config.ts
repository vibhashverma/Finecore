import { LOCAL_DEV_MFA_KEY } from "@fincore/db";
import { z } from "zod";

const bool = z.enum(["true", "false"]).transform((v) => v === "true");
const minor = z
  .string()
  .regex(/^\d{1,15}$/)
  .transform((v) => BigInt(v));

/**
 * Environment configuration, validated once at startup.
 * The process refuses to start on invalid config. Secret values are never logged.
 */
const envSchema = z
  .object({
    APP_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    DATABASE_URL: z.url(),
    REDIS_URL: z.url().optional(),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    // Auth (ADR-004). PEM keys are required outside development/test.
    JWT_PRIVATE_KEY_PEM: z.string().optional(),
    JWT_PUBLIC_KEY_PEM: z.string().optional(),
    MFA_ENC_KEY: z.string().default(LOCAL_DEV_MFA_KEY),
    COOKIE_SECURE: bool.optional(),
    // Business limits (minor units)
    TRANSFER_MAX_MINOR: minor.default(10_000_000n), //         ₹100,000.00
    TRANSFER_REAUTH_THRESHOLD_MINOR: minor.default(2_000_000n), // ₹20,000.00 needs step-up
    RISK_REVIEW_SCORE: z.coerce.number().min(0).max(100).default(70),
    RISK_FAILSAFE_REVIEW_MINOR: minor.default(1_000_000n), // analytics down: hold transfers >= ₹10,000
    SUPPORT_DISPUTE_LIMIT_MINOR: minor.default(500_000n), // support resolves up to ₹5,000
    // Integrations
    ANALYTICS_URL: z.url().default("http://127.0.0.1:8000"),
    ANALYTICS_TOKEN: z.string().min(16).default("local-dev-only-analytics-token"),
    PAYMENT_PROVIDER: z.enum(["SIMULATOR", "STRIPE_TEST"]).default("SIMULATOR"),
    WEBHOOK_SECRET: z.string().min(16).default("local-dev-only-webhook-secret"),
    WEBHOOK_TARGET_URL: z.url().default("http://127.0.0.1:4000/api/v1/webhooks/payments"),
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
    SMTP_URL: z.string().default("smtp://127.0.0.1:1025"),
    MAIL_FROM: z.string().default("FinCore (SIMULATED) <no-reply@fincore.test>"),
  })
  .superRefine((c, ctx) => {
    const prodLike = c.APP_ENV === "staging" || c.APP_ENV === "production";
    if (prodLike && (!c.JWT_PRIVATE_KEY_PEM || !c.JWT_PUBLIC_KEY_PEM)) {
      ctx.addIssue({
        code: "custom",
        path: ["JWT_PRIVATE_KEY_PEM"],
        message: "required in staging/production",
      });
    }
    if (prodLike && c.MFA_ENC_KEY === LOCAL_DEV_MFA_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["MFA_ENC_KEY"],
        message: "dev key not allowed in staging/production",
      });
    }
    if (c.STRIPE_SECRET_KEY && !c.STRIPE_SECRET_KEY.startsWith("sk_test_")) {
      // Test mode only: a live key must never be accepted (brief §13).
      ctx.addIssue({
        code: "custom",
        path: ["STRIPE_SECRET_KEY"],
        message: "only sk_test_ keys are allowed",
      });
    }
  });

export type Config = z.infer<typeof envSchema> & { cookieSecure: boolean };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    // Report only which keys are invalid, never their values (they may be secrets).
    const keys = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid configuration for: ${keys}`);
  }
  const c = parsed.data;
  return {
    ...c,
    cookieSecure: c.COOKIE_SECURE ?? (c.APP_ENV === "staging" || c.APP_ENV === "production"),
  };
}
