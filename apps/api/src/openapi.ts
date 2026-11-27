import { ERROR_CATALOG } from "@fincore/contracts";
import { z } from "zod";
import { beneficiaryCreateBody, mePatchBody, walletCreateBody } from "./modules/accounts.js";
import { disputeCreateBody, disputeTransitionBody } from "./modules/disputes.js";
import { alertTransitionBody, roleChangeBody } from "./modules/ops.js";
import {
  intentConfirmBody,
  intentCreateBody,
  refundCreateBody,
  settlementResolveBody,
} from "./modules/payments.js";
import { statementQuery } from "./modules/statements.js";
import { reverseBody, transferCreateBody } from "./modules/transfers.js";

/**
 * OpenAPI 3.1 document, built from the SAME Zod schemas the handlers validate with (so docs can't drift from
 * enforcement). The contract test asserts every documented operation is routed and every error uses the envelope.
 */
interface Op {
  method: "get" | "post" | "patch" | "delete";
  path: string;
  summary: string;
  tag: string;
  auth?: "none" | "session" | "signature";
  permission?: string;
  idempotent?: boolean;
  reauth?: boolean;
  body?: z.ZodType;
  query?: z.ZodType;
  success?: number;
}

const js = (s: z.ZodType) => z.toJSONSchema(s, { io: "input", unrepresentable: "any" });
const credentials = z.object({ email: z.email(), password: z.string().min(1) });

export const OPERATIONS: Op[] = [
  {
    method: "post",
    path: "/auth/register",
    summary: "Register a customer (returns a SIMULATED MFA enrolment secret once)",
    tag: "Auth",
    auth: "none",
    success: 201,
    body: z.object({ email: z.email(), password: z.string().min(12), full_name: z.string() }),
  },
  {
    method: "post",
    path: "/auth/login",
    summary: "Password step; returns an MFA challenge",
    tag: "Auth",
    auth: "none",
    body: credentials,
  },
  {
    method: "post",
    path: "/auth/mfa/verify",
    summary: "TOTP step; issues session cookies (or tokens with X-Token-Delivery: body)",
    tag: "Auth",
    auth: "none",
    body: z.object({ challenge_id: z.uuid(), code: z.string() }),
  },
  {
    method: "post",
    path: "/auth/refresh",
    summary: "Rotate the refresh token (reuse revokes the whole family)",
    tag: "Auth",
    auth: "none",
  },
  { method: "post", path: "/auth/logout", summary: "Revoke the current session", tag: "Auth" },
  {
    method: "post",
    path: "/auth/reauth",
    summary: "Step-up: password + TOTP, valid 5 minutes for sensitive actions",
    tag: "Auth",
    body: z.object({ password: z.string(), code: z.string() }),
  },
  { method: "get", path: "/auth/session", summary: "Current principal", tag: "Auth" },
  { method: "get", path: "/me", summary: "Own profile", tag: "Customers" },
  {
    method: "patch",
    path: "/me",
    summary: "Update own profile",
    tag: "Customers",
    permission: "self:manage",
    body: mePatchBody,
  },
  {
    method: "get",
    path: "/customers",
    summary: "Staff: list customers (masked PII)",
    tag: "Customers",
    permission: "customers:read",
  },
  {
    method: "post",
    path: "/wallets",
    summary: "Open a wallet (SIMULATED funds)",
    tag: "Wallets",
    permission: "self:manage",
    success: 201,
    body: walletCreateBody,
  },
  {
    method: "get",
    path: "/wallets",
    summary: "List own wallets (staff: ?customer_id, masked)",
    tag: "Wallets",
  },
  { method: "get", path: "/wallets/{id}", summary: "Get a wallet", tag: "Wallets" },
  {
    method: "get",
    path: "/wallets/{id}/balance",
    summary: "Posted, held and available balance",
    tag: "Wallets",
  },
  {
    method: "get",
    path: "/wallets/{id}/transactions",
    summary: "Ledger lines with transaction state (cursor = entry id)",
    tag: "Wallets",
  },
  {
    method: "post",
    path: "/beneficiaries",
    summary: "Add a beneficiary (step-up required)",
    tag: "Beneficiaries",
    permission: "self:manage",
    reauth: true,
    success: 201,
    body: beneficiaryCreateBody,
  },
  {
    method: "get",
    path: "/beneficiaries",
    summary: "List beneficiaries",
    tag: "Beneficiaries",
    permission: "self:manage",
  },
  {
    method: "delete",
    path: "/beneficiaries/{id}",
    summary: "Remove a beneficiary",
    tag: "Beneficiaries",
    permission: "self:manage",
  },
  {
    method: "post",
    path: "/transfers",
    summary:
      "Create a transfer: 201 POSTED or 202 PENDING (risk review). Step-up above the threshold.",
    tag: "Transfers",
    permission: "transfers:create",
    idempotent: true,
    success: 201,
    body: transferCreateBody,
  },
  { method: "get", path: "/transfers", summary: "List transfers", tag: "Transfers" },
  { method: "get", path: "/transfers/{id}", summary: "Get a transfer", tag: "Transfers" },
  {
    method: "post",
    path: "/transfers/{id}/reverse",
    summary: "Reverse a POSTED transfer (finance)",
    tag: "Transfers",
    permission: "reversals:create",
    idempotent: true,
    reauth: true,
    body: reverseBody,
  },
  {
    method: "post",
    path: "/payment-intents",
    summary: "Create a top-up payment intent (provider test mode)",
    tag: "Payments",
    permission: "payments:create",
    idempotent: true,
    success: 201,
    body: intentCreateBody,
  },
  {
    method: "post",
    path: "/payment-intents/{id}/confirm",
    summary: "Confirm with a SIMULATED/test payment method; outcome arrives by webhook",
    tag: "Payments",
    permission: "payments:create",
    idempotent: true,
    success: 202,
    body: intentConfirmBody,
  },
  {
    method: "post",
    path: "/payment-intents/{id}/cancel",
    summary: "Cancel before processing",
    tag: "Payments",
    permission: "payments:create",
  },
  {
    method: "get",
    path: "/payment-intents",
    summary: "List own payment intents",
    tag: "Payments",
    permission: "payments:create",
  },
  {
    method: "get",
    path: "/payment-intents/{id}",
    summary: "Get a payment intent",
    tag: "Payments",
  },
  {
    method: "post",
    path: "/refunds",
    summary: "Refund (≤ refundable remainder; finance)",
    tag: "Payments",
    permission: "refunds:create",
    idempotent: true,
    reauth: true,
    success: 202,
    body: refundCreateBody,
  },
  {
    method: "post",
    path: "/webhooks/payments",
    summary:
      "Provider webhook (HMAC-SHA256 `fincore-signature: t=..,v1=..`, 5 min tolerance, deduplicated)",
    tag: "Webhooks",
    auth: "signature",
  },
  {
    method: "post",
    path: "/webhooks/stripe",
    summary: "Stripe TEST MODE webhook (Stripe-Signature)",
    tag: "Webhooks",
    auth: "signature",
  },
  {
    method: "post",
    path: "/disputes",
    summary: "Raise a dispute on a posted transfer",
    tag: "Disputes",
    permission: "disputes:create",
    success: 201,
    body: disputeCreateBody,
  },
  {
    method: "get",
    path: "/disputes",
    summary: "List disputes (own, or all for support/finance)",
    tag: "Disputes",
  },
  {
    method: "post",
    path: "/disputes/{id}/transition",
    summary: "Review/resolve a dispute (support up to limit; RESOLVED_CUSTOMER needs step-up)",
    tag: "Disputes",
    permission: "disputes:resolve",
    body: disputeTransitionBody,
  },
  {
    method: "get",
    path: "/statements",
    summary: "Generate/fetch a monthly statement (cross-checked by analytics)",
    tag: "Statements",
    query: statementQuery,
  },
  {
    method: "get",
    path: "/statements/{id}/export",
    summary: "Export a statement as CSV or PDF (?format=csv|pdf)",
    tag: "Statements",
  },
  {
    method: "get",
    path: "/risk-alerts",
    summary: "Risk alerts (decision support, not proof of fraud)",
    tag: "Operations",
    permission: "risk:read",
  },
  {
    method: "post",
    path: "/risk-alerts/{id}/transition",
    summary: "Investigate / clear (posts held transfer) / escalate (fails it)",
    tag: "Operations",
    permission: "risk:action",
    body: alertTransitionBody,
  },
  {
    method: "get",
    path: "/settlements",
    summary: "Provider settlements",
    tag: "Operations",
    permission: "reconciliation:read",
  },
  {
    method: "post",
    path: "/settlements/{id}/resolve",
    summary: "Resolve a mismatched/failed settlement (recovery out of suspense)",
    tag: "Operations",
    permission: "reconciliation:run",
    reauth: true,
    body: settlementResolveBody,
  },
  {
    method: "post",
    path: "/reconciliation/runs",
    summary: "Reconcile a settlement against the ledger",
    tag: "Operations",
    permission: "reconciliation:run",
    success: 201,
    body: z.object({ settlement_id: z.uuid() }),
  },
  {
    method: "get",
    path: "/reconciliation/runs/{id}",
    summary: "Reconciliation run with items",
    tag: "Operations",
    permission: "reconciliation:read",
  },
  {
    method: "get",
    path: "/audit-log",
    summary: "Hash-chained audit log (chain_intact in meta)",
    tag: "Admin",
    permission: "audit:read",
  },
  {
    method: "get",
    path: "/admin/failed-jobs",
    summary: "Dead-lettered jobs",
    tag: "Admin",
    permission: "admin:manage",
  },
  {
    method: "post",
    path: "/admin/failed-jobs/{id}/replay",
    summary: "Replay a dead-lettered job (idempotent handlers)",
    tag: "Admin",
    permission: "admin:manage",
    reauth: true,
  },
  {
    method: "get",
    path: "/admin/users",
    summary: "Users and roles (masked)",
    tag: "Admin",
    permission: "admin:manage",
  },
  {
    method: "post",
    path: "/admin/users/{id}/roles",
    summary: "Grant/revoke a role",
    tag: "Admin",
    permission: "admin:manage",
    reauth: true,
    body: roleChangeBody,
  },
];

export function buildOpenApi() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of OPERATIONS) {
    const params: unknown[] = [];
    if (op.path.includes("{id}"))
      params.push({
        name: "id",
        in: "path",
        required: true,
        schema: { type: "string", format: "uuid" },
      });
    if (op.idempotent)
      params.push({
        name: "Idempotency-Key",
        in: "header",
        required: true,
        schema: { type: "string", format: "uuid" },
        description:
          "Same key + same body → same response for 24 h. Different body → 422. In progress → 409.",
      });
    if (op.method === "get" && op.path !== "/statements" && !op.path.includes("{id}")) {
      params.push(
        {
          name: "limit",
          in: "query",
          schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        },
        { name: "cursor", in: "query", schema: { type: "string" } },
      );
    }
    if (op.query) {
      const q = js(op.query) as { properties?: Record<string, unknown>; required?: string[] };
      for (const [name, schema] of Object.entries(q.properties ?? {}))
        params.push({ name, in: "query", required: q.required?.includes(name) ?? false, schema });
    }
    const desc = [
      op.permission ? `**Permission:** \`${op.permission}\`` : null,
      op.reauth
        ? "**Step-up reauthentication** within 5 minutes required (`401 REAUTH_REQUIRED` otherwise)."
        : null,
      op.idempotent ? "**Idempotent:** requires `Idempotency-Key`." : null,
    ]
      .filter(Boolean)
      .join("\n\n");
    (paths[op.path] ??= {})[op.method] = {
      tags: [op.tag],
      summary: op.summary,
      ...(desc ? { description: desc } : {}),
      operationId: `${op.method}_${op.path.replace(/[{}]/g, "").replace(/[/-]/g, "_")}`,
      security:
        op.auth === "none" || op.auth === "signature"
          ? []
          : [{ cookieAuth: [] }, { bearerAuth: [] }],
      parameters: params,
      ...(op.body
        ? {
            requestBody: {
              required: true,
              content: { "application/json": { schema: js(op.body) } },
            },
          }
        : {}),
      responses: {
        [String(op.success ?? 200)]: {
          description: "Success",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/SuccessEnvelope" } },
          },
        },
        default: {
          description: "Error (see the error catalog)",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } },
          },
        },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "FinCore API (SIMULATED funds)",
      version: "1.0.0",
      description:
        "Simulated digital wallet, double-entry ledger and payments API for an educational assessment. No real money.\n\n" +
        'Amounts are strings of integer **minor units** (e.g. "125050" = ₹1,250.50). Errors use `{ error: { code, message, details, request_id } }`.\n\n' +
        `Error catalog: ${Object.entries(ERROR_CATALOG)
          .map(([c, s]) => `\`${c}\` ${s}`)
          .join(" · ")}`,
    },
    servers: [{ url: "/api/v1" }],
    tags: [
      "Auth",
      "Customers",
      "Wallets",
      "Beneficiaries",
      "Transfers",
      "Payments",
      "Webhooks",
      "Disputes",
      "Statements",
      "Operations",
      "Admin",
    ].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        cookieAuth: {
          type: "apiKey",
          in: "cookie",
          name: "fc_at",
          description:
            "httpOnly session cookie; unsafe methods also need x-csrf-token = fc_csrf cookie",
        },
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT (EdDSA, 10 min)" },
      },
      schemas: {
        SuccessEnvelope: {
          type: "object",
          required: ["data", "meta"],
          properties: {
            data: {},
            meta: {
              type: "object",
              required: ["request_id"],
              properties: {
                request_id: { type: "string" },
                next_cursor: { type: ["string", "null"] },
              },
            },
          },
        },
        ErrorEnvelope: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message", "request_id"],
              properties: {
                code: { type: "string", enum: Object.keys(ERROR_CATALOG) },
                message: { type: "string" },
                details: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: { path: { type: "string" }, message: { type: "string" } },
                  },
                },
                request_id: { type: "string" },
              },
            },
          },
        },
      },
    },
  };
}
