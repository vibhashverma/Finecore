# Assessment 01: Customer and operations frontend

**Status:** complete. Built with Next.js 16 App Router, TanStack Query and Zod.

**Pages:**

- `/register`, `/login` (password, then TOTP)
- `/dashboard` (wallets, posted/held/available balances, recent activity with state badges)
- `/topup` (SIMULATED cards only)
- `/beneficiaries` (step-up dialog)
- `/transfers` (idempotent submit)
- `/disputes` (customer raise; support/finance queue)
- `/statements` (CSV/PDF)
- `/ops` (risk alerts with disclaimer, settlements and resolve)
- `/audit` (hash-chain status)

**Design:**

- Tokens never reach JavaScript: httpOnly cookies, double-submit CSRF and a silent refresh.
- Money is handled as strings and `bigint` only (`src/lib/money.ts`, unit-tested beyond 2^53).
- Navigation is role-gated, but that's UX only; the API enforces every rule.
- Loading, empty and error states everywhere. Errors show the request reference.
- A persistent SIMULATED FUNDS banner.
- Accessibility:
  - semantic tables and labels;
  - a native `<dialog>` for step-up;
  - a skip link and visible focus;
  - text on status badges (not colour alone).

**Tests:**

- `pnpm --filter @fincore/web test` (unit).
- `pnpm --filter @fincore/web test:e2e`: Playwright against the real stack, on desktop and Pixel 7, with axe WCAG 2.1 AA checks (fails on serious or critical issues). **Result: 5/5 passed.**

**Evidence:** `evidence/01/dashboard-desktop.png`, `dashboard-mobile.png`, `ops-desktop.png`.

**Demo:**

1. Register and add the MFA secret to an authenticator.
2. Sign in, open a wallet and top up ₹500.
3. Add beneficiary FC1000000003 (you'll be asked to reauthenticate).
4. Send ₹100.
5. Generate a statement: it shows ₹399.00.
