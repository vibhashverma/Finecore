import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Logger } from "pino";
import { AppError } from "../lib/errors.js";
import { UpstreamError, withRetry } from "../lib/resilience.js";

/**
 * Payment provider port (Assessment 08). Two adapters:
 *  - SimulatedProvider: SIMULATED, local, deterministic, with failure injection (duplicates, reordering, outage).
 *  - StripeTestProvider: Stripe TEST MODE only (refuses non sk_test_ keys). Not exercised by automated tests.
 * Outcomes always arrive asynchronously as signed webhooks, like a real provider.
 */
export interface PaymentProvider {
  readonly name: "SIMULATOR" | "STRIPE_TEST";
  createPayment(i: {
    intentId: string;
    amountMinor: bigint;
    currency: string;
  }): Promise<{ providerRef: string }>;
  confirmPayment(i: { providerRef: string; paymentMethod: string }): Promise<void>;
  refund(i: {
    refundId: string;
    providerRef: string;
    amountMinor: bigint;
  }): Promise<{ providerRef: string }>;
}

export interface ProviderEvent {
  id: string;
  type:
    | "payment.processing"
    | "payment.succeeded"
    | "payment.failed"
    | "refund.succeeded"
    | "refund.failed"
    | "payout.paid"
    | "payout.failed";
  created: number;
  data: Record<string, unknown>;
}

// ---- Webhook signatures: HMAC-SHA256 over `${timestamp}.${rawBody}` (same scheme as Stripe) --------------------
export function signPayload(
  secret: string,
  rawBody: string,
  timestampSec = Math.floor(Date.now() / 1000),
): string {
  const sig = createHmac("sha256", secret).update(`${timestampSec}.${rawBody}`).digest("hex");
  return `t=${timestampSec},v1=${sig}`;
}

export function verifySignature(
  secret: string,
  header: string | undefined,
  rawBody: Buffer,
  nowSec = Math.floor(Date.now() / 1000),
  toleranceSec = 300,
): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(
    header.split(",").map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  );
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isInteger(t) || !v1 || !/^[0-9a-f]{64}$/.test(v1)) return false;
  if (Math.abs(nowSec - t) > toleranceSec) return false; // replay window
  const expected = createHmac("sha256", secret).update(`${t}.`).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(v1, "hex"));
}

// ---- SIMULATED provider -----------------------------------------------------------------------------------------
export type Deliver = (rawBody: string, signature: string) => Promise<void>;

export interface SimulatorFaults {
  outage?: boolean; // API calls fail with 503
  duplicateDeliveries?: number; // each event delivered N extra times
  reverseOrder?: boolean; // deliver an intent's events newest-first
}

export class SimulatedProvider implements PaymentProvider {
  readonly name = "SIMULATOR" as const;
  readonly faults: SimulatorFaults = {};
  /** Events waiting for delivery (manual mode: tests and the capstone call flush()). */
  readonly pending: ProviderEvent[] = [];
  private readonly payments = new Map<string, { amountMinor: bigint; currency: string }>();

  constructor(
    private readonly secret: string,
    private readonly deliver: Deliver,
    private readonly autoFlushMs: number | null = 50,
    private readonly logger?: Logger,
  ) {}

  private guard() {
    if (this.faults.outage) throw new UpstreamError("simulated provider outage", 503);
  }

  private emit(events: ProviderEvent[]) {
    this.pending.push(...(this.faults.reverseOrder ? [...events].reverse() : events));
    if (this.autoFlushMs !== null) setTimeout(() => void this.flush(), this.autoFlushMs);
  }

  event(type: ProviderEvent["type"], data: Record<string, unknown>): ProviderEvent {
    return { id: `evt_sim_${randomUUID()}`, type, created: Math.floor(Date.now() / 1000), data };
  }

  async createPayment(i: { intentId: string; amountMinor: bigint; currency: string }) {
    this.guard();
    const providerRef = `pi_sim_${i.intentId.replaceAll("-", "")}`; // idempotent per intent
    this.payments.set(providerRef, { amountMinor: i.amountMinor, currency: i.currency });
    return { providerRef };
  }

  async confirmPayment(i: { providerRef: string; paymentMethod: string }) {
    this.guard();
    const p = this.payments.get(i.providerRef);
    if (!p) throw new UpstreamError("unknown payment", 404);
    const base = {
      provider_ref: i.providerRef,
      amount_minor: p.amountMinor.toString(),
      currency: p.currency,
    };
    const outcome =
      i.paymentMethod === "pm_simulated_decline" ? "payment.failed" : "payment.succeeded";
    this.emit([this.event("payment.processing", base), this.event(outcome, base)]);
  }

  async refund(i: { refundId: string; providerRef: string; amountMinor: bigint }) {
    this.guard();
    const providerRef = `re_sim_${i.refundId.replaceAll("-", "")}`;
    this.emit([
      this.event("refund.succeeded", {
        refund_id: i.refundId,
        provider_ref: providerRef,
        amount_minor: i.amountMinor.toString(),
      }),
    ]);
    return { providerRef };
  }

  /** Simulates the provider paying out (settling) a batch of captured payments to the platform's bank. */
  payout(
    payoutId: string,
    currency: string,
    lines: Array<{ provider_ref: string; amount_minor: bigint }>,
    opts: { paidMinor?: bigint; failed?: boolean } = {},
  ) {
    const total = lines.reduce((s, l) => s + l.amount_minor, 0n);
    const data = {
      payout_id: payoutId,
      currency,
      amount_minor: (opts.paidMinor ?? total).toString(),
      lines: lines.map((l) => ({
        provider_ref: l.provider_ref,
        amount_minor: l.amount_minor.toString(),
      })),
    };
    this.emit([this.event(opts.failed ? "payout.failed" : "payout.paid", data)]);
  }

  /** Delivers pending events (with configured duplicates). Retries failed deliveries like a real provider. */
  async flush(): Promise<number> {
    const batch = this.pending.splice(0);
    for (const ev of batch) {
      const raw = JSON.stringify(ev);
      for (let n = 0; n <= (this.faults.duplicateDeliveries ?? 0); n++) {
        await withRetry(() => this.deliver(raw, signPayload(this.secret, raw)), {
          attempts: 3,
          timeoutMs: 5000,
        }).catch((err: unknown) =>
          this.logger?.warn({ err, event_id: ev.id }, "simulated webhook delivery failed"),
        );
      }
    }
    return batch.length;
  }
}

/** Default delivery: HTTP POST to the API's webhook endpoint (as the real provider would). */
export const httpDeliver =
  (url: string): Deliver =>
  async (rawBody, signature) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "fincore-signature": signature },
      body: rawBody,
    });
    if (!res.ok) throw new UpstreamError(`webhook delivery got ${res.status}`, res.status);
  };

// ---- Stripe TEST MODE adapter -------------------------------------------------------------------------------------
export class StripeTestProvider implements PaymentProvider {
  readonly name = "STRIPE_TEST" as const;

  constructor(private readonly secretKey: string) {
    if (!secretKey.startsWith("sk_test_"))
      throw new Error("StripeTestProvider only accepts sk_test_ keys");
  }

  private async call(path: string, form: Record<string, string>, idempotencyKey: string) {
    return withRetry(
      async (signal) => {
        const res = await fetch(`https://api.stripe.com/v1${path}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.secretKey}`,
            "content-type": "application/x-www-form-urlencoded",
            "idempotency-key": idempotencyKey, // Stripe dedupes retries server-side
          },
          body: new URLSearchParams(form).toString(),
          signal,
        });
        if (!res.ok) throw new UpstreamError(`stripe responded ${res.status}`, res.status);
        return (await res.json()) as { id: string };
      },
      { attempts: 3, timeoutMs: 5000 },
    ).catch((err: unknown) => {
      if (err instanceof UpstreamError && err.status && err.status < 500)
        throw new AppError("VALIDATION_ERROR", "The payment provider rejected the request.");
      throw new AppError(
        "UPSTREAM_UNAVAILABLE",
        "The payment provider is unavailable. Please retry.",
      );
    });
  }

  async createPayment(i: { intentId: string; amountMinor: bigint; currency: string }) {
    const r = await this.call(
      "/payment_intents",
      {
        amount: i.amountMinor.toString(),
        currency: i.currency.toLowerCase(),
        "metadata[fincore_intent_id]": i.intentId,
        "automatic_payment_methods[enabled]": "true",
        "automatic_payment_methods[allow_redirects]": "never",
      },
      `pi-create-${i.intentId}`,
    );
    return { providerRef: r.id };
  }

  async confirmPayment(i: { providerRef: string; paymentMethod: string }) {
    // Stripe test cards only, e.g. pm_card_visa / pm_card_chargeDeclined.
    await this.call(
      `/payment_intents/${i.providerRef}/confirm`,
      { payment_method: i.paymentMethod },
      `pi-confirm-${i.providerRef}`,
    );
  }

  async refund(i: { refundId: string; providerRef: string; amountMinor: bigint }) {
    const r = await this.call(
      "/refunds",
      {
        payment_intent: i.providerRef,
        amount: i.amountMinor.toString(),
        "metadata[fincore_refund_id]": i.refundId,
      },
      `refund-${i.refundId}`,
    );
    return { providerRef: r.id };
  }
}

/** Maps Stripe webhook event types onto FinCore's provider-neutral event types. */
export function mapStripeEvent(ev: {
  id: string;
  type: string;
  created: number;
  data: { object: Record<string, unknown> };
}): ProviderEvent | null {
  const o = ev.data.object;
  const map: Record<string, ProviderEvent["type"]> = {
    "payment_intent.processing": "payment.processing",
    "payment_intent.succeeded": "payment.succeeded",
    "payment_intent.payment_failed": "payment.failed",
  };
  const type = map[ev.type];
  if (!type) return null;
  return {
    id: ev.id,
    type,
    created: ev.created,
    data: {
      provider_ref: o.id,
      amount_minor: String(o.amount ?? ""),
      currency: String(o.currency ?? "").toUpperCase(),
    },
  };
}
