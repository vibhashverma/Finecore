# Assessment 05: Python financial calculations

**Status:** complete (ADR-011). Code is in `services/analytics/src/fincore_analytics/money.py` and `calculations.py`.

**What it calculates:**

- Fees: a flat amount plus basis points, with min/max caps.
- Interest: daily accrual using ACT/365, posting `round(cumulative) - posted`.
- Statement summaries and reconciliation diffs.

All arithmetic uses `Decimal` with ROUND_HALF_EVEN at documented points. Floats are rejected at the API.

**Tests:** 58 pytest tests, 94% coverage. Boundary cases:

- zero and a single minor unit;
- caps;
- ties (112.5 → 112 and 113.5 → 114);
- JPY (no minor unit).

Hypothesis property tests check:

- the fee stays within its bounds and grows monotonically;
- the statement identity holds;
- reconciliation matches a dataset against itself.

**Benchmark** (`scripts/benchmark.py`):

| Operation         | Throughput         |
| ----------------- | ------------------ |
| Fee calculation   | about 65k ops/s    |
| Risk scoring      | about 278k ops/s   |
| Statement summary | about 4.1M lines/s |
| Reconciliation    | about 169k lines/s |

**Evidence:** `evidence/05/pytest-run.txt` and `evidence/05/benchmark.txt`.

**Example:** `POST /analytics/v1/fees/calculate` with an amount of `"112500"` minor units of INR at 10 bps (min 100, max 5000) returns `{"fee_minor":"112","rounding":"ROUND_HALF_EVEN"}`.
