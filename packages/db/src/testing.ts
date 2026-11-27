import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { bootstrapRoles, connectionUrl, migrate, type RolePasswords } from "./bootstrap.js";

/**
 * A real PostgreSQL 16 cluster for tests and local development, without Docker (ADR-005).
 * The binaries are the official PostgreSQL builds packaged by `embedded-postgres`.
 */
export interface FincoreDatabase {
  port: number;
  superUrl: string;
  ownerUrl: string;
  appUrl: string;
  workersUrl: string;
  analyticsUrl: string;
  migrateOutput: string;
  stop: () => Promise<void>;
}

export interface StartOptions {
  /** Keep data between runs (local dev). Default: a throwaway temp dir. */
  dataDir?: string;
  port?: number;
  passwords?: Partial<RolePasswords> & { super?: string };
}

const DB_NAME = "fincore";
const SUPER_USER = "fincore_super";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

const secret = () => randomBytes(18).toString("hex");

export async function startFincoreDatabase(options: StartOptions = {}): Promise<FincoreDatabase> {
  const persistent = options.dataDir !== undefined;
  const dataDir = options.dataDir ?? join(tmpdir(), `fincore-pg-${randomBytes(6).toString("hex")}`);
  const fresh = !existsSync(join(dataDir, "PG_VERSION"));
  const port = options.port ?? (await freePort());
  const pw: RolePasswords & { super: string } = {
    super: options.passwords?.super ?? secret(),
    owner: options.passwords?.owner ?? secret(),
    api: options.passwords?.api ?? secret(),
    workers: options.passwords?.workers ?? secret(),
    analytics: options.passwords?.analytics ?? secret(),
  };

  const errors: string[] = [];
  const cluster = new EmbeddedPostgres({
    databaseDir: dataDir,
    port,
    user: SUPER_USER,
    password: pw.super,
    persistent,
    // UTF-8 everywhere (Windows initdb otherwise defaults to WIN1252); C locale for deterministic sorting.
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => undefined,
    onError: (e) => errors.push(String(e)),
  });

  try {
    if (fresh) {
      await mkdir(dataDir, { recursive: true });
      await cluster.initialise();
    }
    await cluster.start();
    if (fresh) {
      await cluster.createDatabase(DB_NAME);
      await bootstrapRoles(connectionUrl(SUPER_USER, pw.super, port, DB_NAME), DB_NAME, pw);
    }
  } catch (err) {
    throw new Error(
      `embedded postgres failed to start: ${String(err)}\n${errors.slice(-5).join("\n")}`,
    );
  }

  const ownerUrl = connectionUrl("fincore_owner", pw.owner, port, DB_NAME);
  const migrateOutput = await migrate(ownerUrl);

  return {
    port,
    superUrl: connectionUrl(SUPER_USER, pw.super, port, DB_NAME),
    ownerUrl,
    appUrl: connectionUrl("fincore_api", pw.api, port, DB_NAME),
    workersUrl: connectionUrl("fincore_workers", pw.workers, port, DB_NAME),
    analyticsUrl: connectionUrl("fincore_analytics", pw.analytics, port, DB_NAME),
    migrateOutput,
    stop: async () => {
      await cluster.stop();
      if (!persistent) await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
