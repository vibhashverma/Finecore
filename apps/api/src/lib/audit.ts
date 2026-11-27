import type { Db, Tx } from "./db.js";

export interface AuditEntry {
  actorId?: string | null | undefined;
  actorRoles?: string[] | undefined;
  action: string; // e.g. "transfer.create"
  resourceType?: string | undefined;
  resourceId?: string | undefined;
  outcome: "ALLOWED" | "DENIED" | "ERROR";
  requestId?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

/**
 * Appends to the hash-chained audit log (ADR-006). Call it LAST inside a transaction (it takes a global
 * advisory lock). Metadata must already be free of secrets and PII: ids, amounts and codes only.
 */
export async function audit(c: Tx | Db, e: AuditEntry): Promise<void> {
  await c.query(
    `INSERT INTO audit_log (actor_id, actor_roles, action, resource_type, resource_id, outcome, request_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      e.actorId ?? null,
      e.actorRoles ?? [],
      e.action,
      e.resourceType ?? null,
      e.resourceId ?? null,
      e.outcome,
      e.requestId ?? null,
      JSON.stringify(e.metadata ?? {}, (_k, v: unknown) =>
        typeof v === "bigint" ? v.toString() : v,
      ),
    ],
  );
}
