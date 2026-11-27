import { httpStatusFor, type ErrorCode, type ErrorDetail } from "@fincore/contracts";

/**
 * The only error type the API deliberately throws. `message` must be safe to show to end users.
 * Anything else that reaches the error handler is treated as INTERNAL_ERROR.
 */
export class AppError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: ErrorDetail[],
  ) {
    super(message);
    this.name = "AppError";
    this.status = httpStatusFor(code);
  }
}
