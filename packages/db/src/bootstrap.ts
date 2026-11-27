import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { resolveBinary } from "dbmate";
import pg from "pg";
import { MIGRATIONS_DIR, ROLES_SQL } from "./paths.js";

const run = promisify(execFile);

export interface RolePasswords {
  owner: string;
  api: string;
  workers: string;
  analytics: string;
}

const quoteLiteral = (v: string) => `'${v.replaceAll("'", "''")}'`;
const quoteIdent = (v: string) => `"${v.replaceAll('"', '""')}"`;

/**
 * Renders db/bootstrap/roles.sql with values for its psql variables (:'x' as a literal, :"x" as an
 * identifier), so the exact file used by the Postgres container can also run from Node (tests, local DB).
 */
export function renderPsqlVariables(sql: string, vars: Record<string, string>): string {
  return sql.replace(/:(['"])([a-z_]+)\1/g, (match, quote: string, name: string) => {
    const value = vars[name];
    if (value === undefined) throw new Error(`missing psql variable: ${name}`);
    return quote === "'" ? quoteLiteral(value) : quoteIdent(value);
  });
}

/** Creates FinCore roles and hands the database to fincore_owner. Requires a superuser connection. */
export async function bootstrapRoles(
  superUrl: string,
  dbname: string,
  pw: RolePasswords,
): Promise<void> {
  const sql = renderPsqlVariables(await readFile(ROLES_SQL, "utf8"), {
    dbname,
    owner_password: pw.owner,
    api_password: pw.api,
    workers_password: pw.workers,
    analytics_password: pw.analytics,
  });
  const client = new pg.Client({ connectionString: superUrl });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

/** Removes credentials from any postgres:// URL in a message. */
export function redactUrls(text: string): string {
  return text.replace(/(postgres(?:ql)?:\/\/[^:/\s]+:)[^@\s]+@/g, "$1***@");
}

/**
 * Applies pending migrations with dbmate as the schema owner. Returns dbmate's output.
 * The URL is passed via the environment, never argv, so the password can't appear in
 * process listings or in error messages.
 */
export async function migrate(
  ownerUrl: string,
  command: "up" | "status" | "rollback" = "up",
): Promise<string> {
  try {
    const { stdout } = await run(
      resolveBinary(),
      ["--migrations-dir", MIGRATIONS_DIR, "--no-dump-schema", "--wait", command],
      { windowsHide: true, env: { ...process.env, DATABASE_URL: ownerUrl } },
    );
    return stdout;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    throw new Error(
      redactUrls(`dbmate ${command} failed:\n${e.stdout ?? ""}${e.stderr ?? e.message ?? ""}`),
      { cause: undefined },
    );
  }
}

export function connectionUrl(
  user: string,
  password: string,
  port: number,
  db: string,
  host = "127.0.0.1",
): string {
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${db}?sslmode=disable`;
}
