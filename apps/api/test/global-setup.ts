import { seed } from "@fincore/db/seed";
import { startFincoreDatabase } from "@fincore/db/testing";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    appUrl: string;
    superUrl: string;
  }
}

/** One real PostgreSQL 16 for the API suite: roles, migrations and the synthetic seed (ADR-005). */
export default async function setup(project: TestProject) {
  const db = await startFincoreDatabase();
  await seed(db.appUrl, "FinCore-Demo-2026!");
  project.provide("appUrl", db.appUrl);
  project.provide("superUrl", db.superUrl);
  return async () => {
    await db.stop();
  };
}
