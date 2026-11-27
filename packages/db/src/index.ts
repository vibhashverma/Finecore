// Runtime-safe exports only. The embedded test database lives at "@fincore/db/testing"
// so production code never loads dev-only dependencies.
export * from "./errors.js";
export * from "./pool.js";
export type { DB } from "./generated/db.js";
