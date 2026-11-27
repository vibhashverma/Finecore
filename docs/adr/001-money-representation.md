# ADR-001: Money representation

- Status: Accepted (2026-11-27, Phase 0 review)
- Date: 2026-11-27

## Context

Money passes through four type systems: PostgreSQL, TypeScript (Express, workers and the UI), JSON on the wire, and Python (analytics).

- A binary float anywhere in that path is a correctness defect.
- JS `number` loses integer precision above 2^53.
- The brief allows either `BIGINT` minor units or `NUMERIC(19,4)`, applied consistently.

## Options

| Option                                           | Pros                                                                                                                                                                           | Cons                                                                                                                                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. `BIGINT` minor units + `CHAR(3)` currency** | Exact integer arithmetic. Fast. Trivial SUM/compare in SQL triggers and CHECKs. Maps to TS `bigint` and Python `int`. Matches provider APIs (Stripe uses integer minor units). | Sub-minor precision (interest accrual) must be handled in calculation code, not stored. Needs a currency exponent table for display.                                                          |
| B. `NUMERIC(19,4)`                               | Holds fractions of a minor unit. Human-readable in SQL.                                                                                                                        | Fraction digits that can't be settled end up in balances. Node `pg` returns strings, so a decimal library is needed everywhere in JS. 4 dp doesn't fit 3-dp currencies (KWD) cleanly. Slower. |
| C. NUMERIC in DB, number in JS                   | Simple                                                                                                                                                                         | Unsafe. Rejected.                                                                                                                                                                             |

## Decision

Option A.

- **DB:** `amount_minor BIGINT` with `CHECK (amount_minor > 0)` on entries. Every money row carries `currency CHAR(3)` with an FK to `currencies(code, exponent)`. Seed data has INR, USD and JPY; JPY (exponent 0) exists to prove the exponent handling.
- **Wire (JSON):** `"amount_minor": "125050"` as a string matching `^[0-9]{1,18}$`. Zod parses it to `bigint`. Responses also include a display-only `"amount_display": "1,250.50"`, which is never parsed back.
- **TypeScript:** a `Money { minor: bigint; currency: CurrencyCode }` value type with checked add/subtract and currency-mismatch errors.
  - The `pg` int8 parser is configured to return `bigint`.
  - An ESLint rule (`no-restricted-syntax`) bans `parseFloat`, `Number(` and `toFixed` in `ledger/`, `transfers/`, `payments/` and `calculations/`.
  - The UI formats with `Intl.NumberFormat` from the bigint, splitting major and minor parts.
- **Python:** convert at the boundary with `Decimal(minor).scaleb(-exponent)`.
  - All arithmetic is `Decimal` under a module-level `localcontext(prec=34)`, with an explicit `quantize(Decimal(10) ** -exponent, rounding=…)` at documented points (ADR-009).
  - Results go back as integer minor units.
  - Pydantic models reject `float` input with `strict=True`.
- **FX:** out of scope. Each transaction is single-currency, enforced by a composite FK. Documented in LIMITATIONS.

## Consequences

- Interest accrual computes cumulative accrued interest in `Decimal` from principal and day count, then posts `quantize(cumulative) − already_posted`. Rounding never compounds, and no fractional minor units are stored.
- Fee percentages are stored as basis-point integers or `NUMERIC` **rates**, which are not money, and are applied in Python `Decimal`.
- Max representable amount is about 9.2 × 10^18 minor units, far above the business limits (configured per wallet).
