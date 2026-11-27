import { z } from "zod";
import { ERROR_CODES, type ErrorCode } from "./errors.js";

/** Metadata attached to every successful response. */
export const metaSchema = z.object({
  request_id: z.string(),
  next_cursor: z.string().nullable().optional(),
});

export const errorDetailSchema = z.object({
  path: z.string().optional(),
  message: z.string(),
});

export const errorBodySchema = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES as [ErrorCode, ...ErrorCode[]]),
    message: z.string(),
    details: z.array(errorDetailSchema).optional(),
    request_id: z.string(),
  }),
});

export type Meta = z.infer<typeof metaSchema>;
export type ErrorDetail = z.infer<typeof errorDetailSchema>;
export type ErrorBody = z.infer<typeof errorBodySchema>;

export interface SuccessBody<T> {
  data: T;
  meta: Meta;
}

/** Build a success envelope for `data`. */
export function successSchema<T extends z.ZodType>(data: T) {
  return z.object({ data, meta: metaSchema });
}
