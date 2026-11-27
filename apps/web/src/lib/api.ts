/**
 * Browser API client. Same-origin (/api/v1 via Caddy or the Next.js rewrite), httpOnly cookies, double-submit
 * CSRF header on unsafe methods, one silent refresh on 401. Tokens are never visible to JavaScript.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
    readonly details?: Array<{ path?: string; message: string }>,
  ) {
    super(message);
  }
}

function csrfToken(): string {
  return (
    document.cookie
      .split("; ")
      .find((c) => c.startsWith("fc_csrf="))
      ?.slice(8) ?? ""
  );
}

export interface CallOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  idempotencyKey?: string;
  retryOnRefresh?: boolean;
}

export async function apiCall<T>(
  path: string,
  o: CallOptions = {},
): Promise<{ data: T; meta: Record<string, unknown> }> {
  const method = o.method ?? "GET";
  const headers: Record<string, string> = { accept: "application/json" };
  if (o.body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET") headers["x-csrf-token"] = decodeURIComponent(csrfToken());
  if (o.idempotencyKey) headers["idempotency-key"] = o.idempotencyKey;
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers,
    credentials: "same-origin",
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
  });
  if (res.status === 401 && o.retryOnRefresh !== false && !path.startsWith("/auth/")) {
    const body = (await res
      .clone()
      .json()
      .catch(() => null)) as { error?: { code?: string } } | null;
    if (body?.error?.code === "UNAUTHENTICATED") {
      const r = await fetch("/api/v1/auth/refresh", {
        method: "POST",
        credentials: "same-origin",
        headers: { "x-csrf-token": decodeURIComponent(csrfToken()) },
      });
      if (r.ok) return apiCall<T>(path, { ...o, retryOnRefresh: false });
    }
  }
  const json = (await res.json().catch(() => ({}))) as {
    data?: T;
    meta?: Record<string, unknown>;
    error?: {
      code: string;
      message: string;
      request_id?: string;
      details?: Array<{ path?: string; message: string }>;
    };
  };
  if (!res.ok || json.error) {
    const e = json.error;
    throw new ApiError(
      res.status,
      e?.code ?? "INTERNAL_ERROR",
      e?.message ?? "Something went wrong.",
      e?.request_id,
      e?.details,
    );
  }
  return { data: json.data as T, meta: json.meta ?? {} };
}

export const newIdempotencyKey = () => crypto.randomUUID();
