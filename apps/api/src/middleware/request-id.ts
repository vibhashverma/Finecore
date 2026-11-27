import type { NextFunction, Request, Response } from "express";
import { v7 as uuidv7 } from "uuid";

export const REQUEST_ID_HEADER = "x-request-id";
const SAFE_ID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Accept an upstream request id (from Caddy or Next.js) only if it is well-formed; otherwise mint one.
 * The id is echoed in the response header and in every log line and error body,
 * so a single request can be traced across services.
 */
export function resolveRequestId(incoming: string | undefined): string {
  if (incoming && SAFE_ID.test(incoming)) return incoming;
  return `req_${uuidv7().replaceAll("-", "")}`;
}

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const id = resolveRequestId(req.header(REQUEST_ID_HEADER));
  res.locals.requestId = id;
  res.setHeader(REQUEST_ID_HEADER, id);
  next();
}
