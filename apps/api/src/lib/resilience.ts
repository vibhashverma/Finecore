import { AppError } from "./errors.js";

/**
 * Outbound-call resilience (brief §11): a per-attempt timeout, bounded retries with exponential backoff and full
 * jitter (ONLY for idempotent calls), and a circuit breaker that fails fast while a dependency is down.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;

  constructor(
    readonly name: string,
    private readonly threshold = 5,
    private readonly coolDownMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  get state(): "closed" | "open" | "half-open" {
    if (this.failures < this.threshold) return "closed";
    return this.now() - this.openedAt >= this.coolDownMs ? "half-open" : "open";
  }

  async exec<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      throw new AppError("UPSTREAM_UNAVAILABLE", `${this.name} is temporarily unavailable.`);
    }
    try {
      const result = await fn();
      this.failures = 0;
      return result;
    } catch (err) {
      this.failures++;
      if (this.failures >= this.threshold) this.openedAt = this.now();
      throw err;
    }
  }
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
  /** Only retry when this returns true (e.g. network errors / 5xx, never 4xx). */
  retryable?: (err: unknown) => boolean;
}

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export const isTransient = (err: unknown) =>
  !(err instanceof UpstreamError) ||
  err.status === undefined ||
  err.status >= 500 ||
  err.status === 429;

export async function withRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  o: RetryOptions = {},
): Promise<T> {
  const attempts = o.attempts ?? 3;
  const base = o.baseDelayMs ?? 100;
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 2000);
    try {
      return await fn(ctrl.signal);
    } catch (err) {
      last = err;
      if (!(o.retryable ?? isTransient)(err) || i === attempts - 1) break;
      await new Promise((r) => setTimeout(r, Math.random() * base * 2 ** i)); // full jitter
    } finally {
      clearTimeout(timer);
    }
  }
  throw last;
}

/** JSON POST with timeout; non-2xx becomes UpstreamError(status). */
export async function postJson<T>(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)),
      signal,
    });
  } catch (err) {
    throw new UpstreamError(`network error: ${(err as Error).name}`);
  }
  if (!res.ok) throw new UpstreamError(`upstream responded ${res.status}`, res.status);
  return (await res.json()) as T;
}
