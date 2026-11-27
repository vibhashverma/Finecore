// Generates postman/fincore.postman_collection.json from the API's OpenAPI document (single source of truth).
// Folder "00 Smoke" is an executable flow with assertions (run with Newman); the other folders list every operation.
// Usage: pnpm --filter @fincore/api build && node scripts/generate-postman.mjs
import { writeFileSync } from "node:fs";
import { buildOpenApi } from "../apps/api/dist/openapi.js";

const spec = buildOpenApi();
const bearer = {
  type: "bearer",
  bearer: [{ key: "token", value: "{{access_token}}", type: "string" }],
};
const envelopeTest = (status) => [
  `pm.test("status ${status}", () => pm.response.to.have.status(${status}));`,
  `pm.test("envelope + request id", () => { const j = pm.response.json(); pm.expect(j.data !== undefined || j.error !== undefined).to.be.true; pm.expect(pm.response.headers.get("x-request-id")).to.be.a("string"); });`,
];
const req = (
  name,
  method,
  path,
  { body, auth = true, status = 200, extra = [], idem = false } = {},
) => ({
  name,
  event: [{ listen: "test", script: { exec: [...envelopeTest(status), ...extra] } }],
  request: {
    method,
    auth: auth ? bearer : { type: "noauth" },
    header: [
      { key: "content-type", value: "application/json" },
      { key: "x-token-delivery", value: "body" },
      ...(idem ? [{ key: "idempotency-key", value: "{{$guid}}" }] : []),
    ],
    url: {
      raw: `{{base_url}}/api/v1${path}`,
      host: ["{{base_url}}"],
      path: ["api", "v1", ...path.split("?")[0].replace(/^\//, "").split("/")],
      query: path.includes("?")
        ? path
            .split("?")[1]
            .split("&")
            .map((kv) => ({ key: kv.split("=")[0], value: kv.split("=")[1] }))
        : [],
    },
    ...(body ? { body: { mode: "raw", raw: JSON.stringify(body, null, 2) } } : {}),
  },
});

const smoke = [
  req("Login (password step)", "POST", "/auth/login", {
    auth: false,
    body: { email: "{{email}}", password: "{{password}}" },
    extra: ['pm.collectionVariables.set("challenge_id", pm.response.json().data.challenge_id);'],
  }),
  req(
    "SIMULATED MFA code (dev/test only)",
    "GET",
    "/auth/mfa/dev-code?challenge_id={{challenge_id}}",
    { auth: false, extra: ['pm.collectionVariables.set("code", pm.response.json().data.code);'] },
  ),
  req("MFA verify → tokens", "POST", "/auth/mfa/verify", {
    auth: false,
    body: { challenge_id: "{{challenge_id}}", code: "{{code}}" },
    extra: ['pm.collectionVariables.set("access_token", pm.response.json().data.access_token);'],
  }),
  req("Session", "GET", "/auth/session"),
  req("Me", "GET", "/me"),
  req("Wallets", "GET", "/wallets", {
    extra: [
      'const w = pm.response.json().data[0]; pm.collectionVariables.set("wallet_id", w.id); pm.test("balance is a string of minor units", () => pm.expect(w.balance.available_minor).to.match(/^\\d+$/));',
    ],
  }),
  req("Wallet balance", "GET", "/wallets/{{wallet_id}}/balance"),
  req("Wallet transactions", "GET", "/wallets/{{wallet_id}}/transactions?limit=5"),
  req("Create payment intent (SIMULATED)", "POST", "/payment-intents", {
    idem: true,
    status: 201,
    body: { wallet_id: "{{wallet_id}}", amount_minor: "10000" },
    extra: ['pm.collectionVariables.set("intent_id", pm.response.json().data.id);'],
  }),
  req("Confirm payment (SIMULATED card)", "POST", "/payment-intents/{{intent_id}}/confirm", {
    idem: true,
    status: 202,
    body: { payment_method: "pm_simulated_success" },
  }),
  req("Transfers list", "GET", "/transfers?limit=5"),
  req("Statement (current month)", "GET", "/statements?wallet_id={{wallet_id}}&period={{period}}"),
  req("NEGATIVE: transfer without Idempotency-Key → 400", "POST", "/transfers", {
    status: 400,
    body: {
      source_wallet_id: "{{wallet_id}}",
      beneficiary_id: "00000000-0000-4000-8000-000000000000",
      amount_minor: "100",
    },
    extra: [
      'pm.test("code", () => pm.expect(pm.response.json().error.code).to.eql("VALIDATION_ERROR"));',
    ],
  }),
  req("NEGATIVE: float amount rejected → 400", "POST", "/payment-intents", {
    idem: true,
    status: 400,
    body: { wallet_id: "{{wallet_id}}", amount_minor: 10.5 },
  }),
  req(
    "NEGATIVE: someone else's wallet → 404 (IDOR)",
    "GET",
    "/wallets/00000000-0000-4000-8000-000000000000",
    { status: 404 },
  ),
  req(
    "NEGATIVE: finance-only endpoint → 403",
    "POST",
    "/transfers/00000000-0000-4000-8000-000000000000/reverse",
    { idem: true, status: 403, body: { reason: "not allowed" } },
  ),
  // The MFA step left httpOnly session cookies for 127.0.0.1; calling "localhost" sends none (cookies are host-scoped).
  (() => {
    const r = req("NEGATIVE: no token, no cookies → 401", "GET", "/me", {
      auth: false,
      status: 401,
    });
    r.request.url.raw = r.request.url.raw.replace("{{base_url}}", "{{anon_base_url}}");
    r.request.url.host = ["{{anon_base_url}}"];
    return r;
  })(),
];

const folders = {};
for (const [path, ops] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(ops)) {
    (folders[op.tags[0]] ??= []).push(
      req(`${op.summary}`, method.toUpperCase(), path.replaceAll("{id}", ":id"), {
        idem: op.parameters.some((p) => p.name === "Idempotency-Key"),
        status: 200,
      }),
    );
  }
}

const collection = {
  info: {
    name: "FinCore API (SIMULATED funds)",
    schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    description: spec.info.description,
  },
  variable: [
    { key: "base_url", value: "http://127.0.0.1:4400" },
    { key: "anon_base_url", value: "http://localhost:4400" },
    { key: "email", value: "alice@fincore.test" },
    { key: "password", value: "FinCore-Demo-2026!" },
    { key: "period", value: new Date().toISOString().slice(0, 7) },
  ],
  item: [
    { name: "00 Smoke (run with Newman)", item: smoke },
    ...Object.entries(folders).map(([name, item]) => ({ name, item })),
  ],
};
writeFileSync(
  new URL("../postman/fincore.postman_collection.json", import.meta.url),
  `${JSON.stringify(collection, null, 2)}\n`,
);
console.log(
  `wrote ${smoke.length} smoke requests + ${Object.values(folders).flat().length} documented operations`,
);
