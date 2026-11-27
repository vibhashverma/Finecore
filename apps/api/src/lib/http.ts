import type { NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";
import { AppError } from "./errors.js";

/** Success envelope: { data, meta: { request_id, ... } }. bigint values serialize as strings (app json replacer). */
export function ok(
  res: Response,
  data: unknown,
  status = 200,
  meta: Record<string, unknown> = {},
): void {
  res.status(status).json({ data, meta: { request_id: res.locals.requestId, ...meta } });
}

/** Validates untrusted input; on failure throws VALIDATION_ERROR with per-field details. */
export function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input);
  if (!r.success) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Request validation failed.",
      r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return r.data;
}

/** Positive amount in minor units, as a JSON string of digits (ADR-001). Never a JS number. */
export const amountMinor = z
  .string()
  .regex(/^[1-9]\d{0,15}$/, 'must be a positive integer string in minor units, e.g. "125050"')
  .transform((v) => BigInt(v));

export const uuid = z.uuid();
export const idParam = z.object({ id: z.uuid() });
export const currency = z.enum(["INR", "USD", "JPY"]);

/** Wraps a handler so thrown errors (sync or async) reach the error middleware. */
export const route =
  (fn: (req: Request, res: Response) => Promise<void> | void): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next);
  };

/** Stable JSON (sorted keys): used to hash idempotent request bodies. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : 1,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}
