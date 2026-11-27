import { z } from "zod";
import { AppError } from "./errors.js";

/** Cursor pagination on a stable (created_at, id) order; limit <= 100 (brief §7). */
export const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(200).optional(),
});
export type PageQuery = z.infer<typeof pageQuery>;

export interface Cursor {
  ts: string;
  id: string;
}

export function encodeCursor(ts: Date | string, id: string): string {
  const t = ts instanceof Date ? ts.toISOString() : ts;
  return Buffer.from(JSON.stringify([t, id])).toString("base64url");
}

export function decodeCursor(cursor: string | undefined): Cursor | null {
  if (!cursor) return null;
  try {
    const [ts, id] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as [
      string,
      string,
    ];
    if (Number.isNaN(Date.parse(ts)) || !z.uuid().safeParse(id).success)
      throw new Error("bad cursor");
    return { ts, id };
  } catch {
    throw new AppError("VALIDATION_ERROR", "Invalid pagination cursor.", [
      { path: "cursor", message: "invalid" },
    ]);
  }
}

/** Given limit+1 rows, returns the page and the next cursor. */
export function page<T extends { created_at: Date; id: string }>(rows: T[], limit: number) {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null,
  };
}

/** SQL fragment for "after cursor"; params are appended to `params`. */
export function afterCursor(cursor: Cursor | null, params: unknown[], alias = ""): string {
  if (!cursor) return "";
  params.push(cursor.ts, cursor.id);
  const p = alias ? `${alias}.` : "";
  return ` AND (${p}created_at, ${p}id) > ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
}
