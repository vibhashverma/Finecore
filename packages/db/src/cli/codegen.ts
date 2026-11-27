/**
 * Regenerates src/generated/db.ts (Kysely table types) from a freshly migrated throwaway database (ADR-002).
 * The database is the source of truth; CI fails if the committed types drift from the migrations.
 */
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startFincoreDatabase } from "../testing.js";

const run = promisify(execFile);
const require = createRequire(import.meta.url);

async function main(): Promise<void> {
  const pkgJson = require.resolve("kysely-codegen/package.json");
  const binRel = (require(pkgJson) as { bin: Record<string, string | undefined> }).bin[
    "kysely-codegen"
  ];
  if (!binRel) throw new Error("kysely-codegen bin not found");
  const bin = join(dirname(pkgJson), binRel);
  const outFile = fileURLToPath(new URL("../generated/db.ts", import.meta.url));

  // int8 is parsed as bigint at runtime (configurePgTypes), and `number` is never accepted for money (ADR-001).
  const typeMapping = JSON.stringify({
    int8: "ColumnType<bigint, bigint | string, bigint | string>",
  });
  const verify = process.argv.includes("--verify");

  const db = await startFincoreDatabase();
  try {
    const { stdout } = await run(
      process.execPath,
      [
        bin,
        "--dialect",
        "postgres",
        "--out-file",
        outFile,
        "--exclude-pattern",
        "schema_migrations",
        "--type-mapping",
        typeMapping,
        ...(verify ? ["--verify"] : []),
      ],
      // URL via env, not argv (keeps the password out of process listings).
      { windowsHide: true, env: { ...process.env, DATABASE_URL: db.ownerUrl } },
    );
    process.stdout.write(verify ? stdout : `generated ${outFile}\n`);
  } finally {
    await db.stop();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
