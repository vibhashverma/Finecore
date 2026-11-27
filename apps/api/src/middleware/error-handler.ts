import type { ErrorBody } from "@fincore/contracts";
import type { NextFunction, Request, Response } from "express";
import type { Logger } from "pino";
import { AppError } from "../lib/errors.js";

/** Errors raised by express.json() carry `type` and `status`. */
interface BodyParserError {
  type: string;
  status: number;
}

function isBodyParserError(err: unknown): err is BodyParserError {
  return typeof err === "object" && err !== null && "type" in err && "status" in err;
}

function toAppError(err: unknown): AppError | null {
  if (err instanceof AppError) return err;
  if (isBodyParserError(err)) {
    if (err.type === "entity.parse.failed") {
      return new AppError("VALIDATION_ERROR", "Request body is not valid JSON.");
    }
    if (err.type === "entity.too.large") {
      return new AppError("VALIDATION_ERROR", "Request body is too large.");
    }
  }
  return null;
}

/** 404 for any route not matched. */
export function notFoundHandler(_req: Request, _res: Response, next: NextFunction): void {
  next(new AppError("NOT_FOUND", "The requested resource was not found."));
}

/**
 * Final error handler. Known errors map to the catalog.
 * Unknown errors are logged with their stack server-side, and the client gets a generic
 * INTERNAL_ERROR with no stack, SQL or secrets.
 */
export function errorHandler(logger: Logger) {
  return (err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    const requestId = String(res.locals.requestId ?? "unknown");
    const known = toAppError(err);
    const appError =
      known ??
      new AppError(
        "INTERNAL_ERROR",
        "An unexpected error occurred. Quote the request_id when contacting support.",
      );

    if (known) {
      logger.warn({ request_id: requestId, code: known.code }, "request failed");
    } else {
      logger.error({ request_id: requestId, err }, "unhandled error");
    }

    const body: ErrorBody = {
      error: {
        code: appError.code,
        message: appError.message,
        ...(appError.details ? { details: appError.details } : {}),
        request_id: requestId,
      },
    };
    res.status(appError.status).json(body);
  };
}
