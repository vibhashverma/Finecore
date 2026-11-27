import type { TestProject } from "vitest/node";
import { startFincoreDatabase } from "../src/testing.js";

export interface DbUrls {
  superUrl: string;
  ownerUrl: string;
  appUrl: string;
  workersUrl: string;
  analyticsUrl: string;
}

declare module "vitest" {
  export interface ProvidedContext {
    db: DbUrls;
  }
}

/** Starts one throwaway PostgreSQL 16 cluster, bootstraps roles and applies all migrations. */
export default async function setup(project: TestProject) {
  const db = await startFincoreDatabase();
  project.provide("db", {
    superUrl: db.superUrl,
    ownerUrl: db.ownerUrl,
    appUrl: db.appUrl,
    workersUrl: db.workersUrl,
    analyticsUrl: db.analyticsUrl,
  });
  return async () => {
    await db.stop();
  };
}
