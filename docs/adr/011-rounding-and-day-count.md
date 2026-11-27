# ADR-011: Rounding and day-count conventions

- Status: Accepted (Phase 6)
- Date: 2026-11-28

**General rules.**

- `Decimal` only; floats are rejected at the API schema.
- Precision 34 (decimal128).
- Rounding: **ROUND_HALF_EVEN** (banker's rounding), so many roundings carry no upward bias.

**Fees.**

1. Compute the percentage part: amount × bps / 10 000, in major units.
2. Round **once** to the minor unit (half-even).
3. Add the flat fee.
4. Clamp to [min, max].

Example: 0.10% of ₹1,125.00 = 112.5 paise, which rounds to 112.

**Interest.**

- Day count is **Actual/365** (365 even in leap years, a documented simplification). Accrual uses end-of-day balance; negative balances accrue nothing.
- Daily accruals are summed **unrounded**. Each posting is `round(cumulative) − already_posted`, so rounding error never compounds.

**Statements and reconciliation.** Exact integer minor units, so there is no rounding at all.

**Currency exponents.** ISO 4217: INR 2, USD 2, JPY 0. JPY proves the exponent handling.
