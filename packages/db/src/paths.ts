import { fileURLToPath } from "node:url";

/** Repo root, resolved from this file: works from both packages/db/src and packages/db/dist. */
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const MIGRATIONS_DIR = fileURLToPath(new URL("../../../db/migrations/", import.meta.url));
export const ROLES_SQL = fileURLToPath(new URL("../../../db/bootstrap/roles.sql", import.meta.url));
