import pg from "pg";

const INT8_OID = 20;
let configured = false;

/**
 * Parse Postgres int8 (BIGINT) as JS `bigint`, never `number` (ADR-001), so amounts above 2^53
 * stay exact. It is a process-wide setting of the pg driver, so call it once at startup (createPool does).
 */
export function configurePgTypes(): void {
  if (configured) return;
  pg.types.setTypeParser(INT8_OID, (value: string) => BigInt(value));
  configured = true;
}

export interface PoolOptions {
  max?: number;
  applicationName?: string;
}

export function createPool(connectionString: string, options: PoolOptions = {}): pg.Pool {
  configurePgTypes();
  return new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30_000,
    application_name: options.applicationName ?? "fincore",
  });
}

/** Run `fn` in a transaction on one client: COMMIT on success, ROLLBACK on any error. */
export async function withClientTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Returns the first row of a result, or throws: used where a query must return exactly one row. */
export function firstRow<T>(result: { rows: T[] }, what = "row"): T {
  const row = result.rows[0];
  if (row === undefined) throw new Error(`expected a ${what}, got none`);
  return row;
}
