import { CircuitBreaker, postJson, withRetry } from "../lib/resilience.js";

/** Client for the FastAPI analytics service (/analytics/v1). Pure calculations, so POST retries are safe. */
export interface FeeSchedule {
  flat_minor: bigint;
  rate_bps: number;
  min_minor: bigint;
  max_minor: bigint | null;
}

export interface TransferFeatures {
  amount_minor: bigint;
  currency: string;
  hour_utc: number;
  beneficiary_age_hours: number;
  account_age_days: number;
  transfers_last_hour: number;
  amount_last_24h_minor: bigint;
  avg_amount_30d_minor: bigint;
  distinct_beneficiaries_24h: number;
}

export interface RiskReason {
  code: string;
  detail: string;
  weight: number;
}
export interface RiskScore {
  score: number;
  reasons: RiskReason[];
  disclaimer: string;
}

export interface ReconLine {
  provider_ref: string;
  amount_minor: bigint;
}
export interface ReconItem {
  provider_ref: string;
  outcome: "MATCHED" | "AMOUNT_MISMATCH" | "MISSING_INTERNAL" | "MISSING_PROVIDER";
  expected_minor: bigint;
  actual_minor: bigint;
  diff_minor: bigint;
}
export interface ReconResult {
  items: ReconItem[];
  expected_total_minor: bigint;
  actual_total_minor: bigint;
  diff_minor: bigint;
}

export interface StatementSummary {
  total_credits_minor: bigint;
  total_debits_minor: bigint;
  closing_minor: bigint;
}

export interface AnalyticsClient {
  calculateFee(
    amountMinor: bigint,
    currency: string,
    schedule: FeeSchedule,
    requestId: string,
  ): Promise<bigint>;
  scoreTransfer(features: TransferFeatures, requestId: string): Promise<RiskScore>;
  compareReconciliation(
    internal: ReconLine[],
    provider: ReconLine[],
    requestId: string,
  ): Promise<ReconResult>;
  summarizeStatement(
    openingMinor: bigint,
    lines: Array<{ direction: "DEBIT" | "CREDIT"; amount_minor: bigint }>,
    requestId: string,
  ): Promise<StatementSummary>;
}

const big = (v: unknown) => BigInt(String(v));

export class HttpAnalyticsClient implements AnalyticsClient {
  private readonly breaker = new CircuitBreaker("analytics");

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs = 1500,
  ) {}

  private call<T>(
    path: string,
    body: unknown,
    requestId: string,
    timeoutMs = this.timeoutMs,
  ): Promise<T> {
    const headers = { authorization: `Bearer ${this.token}`, "x-request-id": requestId };
    return this.breaker.exec(() =>
      withRetry(
        (signal) => postJson<T>(`${this.baseUrl}/analytics/v1${path}`, body, headers, signal),
        {
          attempts: 2,
          timeoutMs,
        },
      ),
    );
  }

  async calculateFee(amountMinor: bigint, currency: string, s: FeeSchedule, requestId: string) {
    const r = await this.call<{ fee_minor: string }>(
      "/fees/calculate",
      { amount_minor: amountMinor, currency, schedule: s },
      requestId,
    );
    return big(r.fee_minor);
  }

  async scoreTransfer(f: TransferFeatures, requestId: string) {
    // Tight timeout: scoring is in the transfer path (fail-safe policy applies on timeout).
    return this.call<RiskScore>("/risk/score", f, requestId, 300);
  }

  async compareReconciliation(internal: ReconLine[], provider: ReconLine[], requestId: string) {
    const r = await this.call<{
      items: Array<Record<string, string>>;
      expected_total_minor: string;
      actual_total_minor: string;
      diff_minor: string;
    }>("/reconciliation/compare", { internal, provider }, requestId, 5000);
    return {
      items: r.items.map((i) => ({
        provider_ref: String(i.provider_ref),
        outcome: i.outcome as ReconItem["outcome"],
        expected_minor: big(i.expected_minor),
        actual_minor: big(i.actual_minor),
        diff_minor: big(i.diff_minor),
      })),
      expected_total_minor: big(r.expected_total_minor),
      actual_total_minor: big(r.actual_total_minor),
      diff_minor: big(r.diff_minor),
    };
  }

  async summarizeStatement(
    openingMinor: bigint,
    lines: Array<{ direction: "DEBIT" | "CREDIT"; amount_minor: bigint }>,
    requestId: string,
  ) {
    const r = await this.call<Record<string, string>>(
      "/statements/summarize",
      { opening_minor: openingMinor, lines },
      requestId,
      5000,
    );
    return {
      total_credits_minor: big(r.total_credits_minor),
      total_debits_minor: big(r.total_debits_minor),
      closing_minor: big(r.closing_minor),
    };
  }
}
