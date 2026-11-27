/**
 * Queue names, the one place they are declared. More queues are added in Phases 4 and 7
 * (outbox-relay, provider-events, notifications, reconciliation, statements, recovery).
 */
export const QUEUES = {
  system: "fincore-system",
} as const;

/** Default job options: bounded retries with exponential backoff. Exhausted jobs go to failed_jobs (Phase 4). */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: "exponential", delay: 1000 },
  removeOnComplete: { age: 24 * 3600, count: 10_000 },
  removeOnFail: false,
} as const;

export interface PingJob {
  sentAt: string;
}

/** Trivial processor for the system queue, used to prove the queue round-trip end to end. */
export function processPing(
  data: PingJob,
  now: () => Date = () => new Date(),
): { latencyMs: number } {
  const sent = Date.parse(data.sentAt);
  if (Number.isNaN(sent)) throw new Error("invalid sentAt");
  return { latencyMs: Math.max(0, now().getTime() - sent) };
}
