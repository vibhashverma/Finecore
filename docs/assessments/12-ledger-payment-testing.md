# Assessment 12: Ledger and payment testing

**Status:** complete. The test matrix is in [../TEST_MATRIX.md](../TEST_MATRIX.md); every row is automated.

**Results:**

| Suite                         | Result             |
| ----------------------------- | ------------------ |
| Database                      | 59 pass            |
| API                           | 75 pass            |
| Analytics                     | 58 pass            |
| Web unit                      | 3 pass             |
| E2E                           | 5 pass             |
| Newman                        | 36 assertions pass |
| Capstone and incident scripts | proofs pass        |

**Global invariant check:** `ledger_invariant_violations()` runs after every database and API integration test, at the end of the capstone and incident runs, and continuously as a Prometheus metric.

**Coverage:** API 79% of lines; analytics 94%.
