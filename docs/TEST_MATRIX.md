# Test matrix (brief §9): every row is automated

| Scenario                                | Expected                                 | Where (file › test)                                                            | Result |
| --------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------ | ------ |
| Transfer with sufficient funds          | POSTED, balanced, balances correct       | api `transfers.test.ts` › posts a transfer…                                    | ✅     |
| Transfer exceeding available            | 422 INSUFFICIENT_FUNDS, no entries       | api `transfers.test.ts` › insufficient funds                                   | ✅     |
| Same key retried 5×                     | One transfer, same response              | api `transfers.test.ts` › same key retried 5×                                  | ✅     |
| Same key, different body                | 422 IDEMPOTENCY_KEY_REUSED               | api `transfers.test.ts` › different body                                       | ✅     |
| 50 concurrent transfers from one wallet | No negative balance, debits ≤ start      | api `transfers.test.ts` › 50 concurrent; db `balances-holds.test.ts`; capstone | ✅     |
| Opposing A↔B                            | No deadlock, consistent                  | api `transfers.test.ts` › opposing                                             | ✅     |
| Reversal of a posted transfer           | New mirrored journal, original untouched | db `reversals.test.ts`; api `transfers.test.ts`                                | ✅     |
| Double reversal                         | 409 INVALID_STATE_TRANSITION             | api `transfers.test.ts`; capstone                                              | ✅     |
| Webhook replay                          | Processed once                           | api `payments.test.ts` › replay 4×; INC-1 (10×)                                | ✅     |
| Bad signature / stale timestamp         | 400, not processed                       | api `payments.test.ts`                                                         | ✅     |
| Out-of-order webhooks                   | Final state correct                      | api `payments.test.ts` › out-of-order; INC-1                                   | ✅     |
| Failed settlement                       | Suspense, alert, recoverable             | api `payments.test.ts` › failed settlement; capstone                           | ✅     |
| Provider timeout / outage               | Safe error, no duplicate charge          | api `payments.test.ts` › outage; INC-4                                         | ✅     |
| Rounding ties and minimum units         | Documented rule (half-even)              | analytics `test_calculations.py`                                               | ✅     |
| UPDATE on ledger_entries                | DB error                                 | db `ledger.test.ts` (app: 42501; owner: FC001); `evidence/03/ledger-proof.txt` | ✅     |
| Unbalanced insert                       | Error at COMMIT                          | db `ledger.test.ts`; INC-3                                                     | ✅     |
| Customer A reads B's wallet             | 404                                      | api `auth.test.ts` › IDOR                                                      | ✅     |
| Refund without reauth                   | 401 REAUTH_REQUIRED                      | api `payments.test.ts`                                                         | ✅     |
| Worker crash mid-job                    | Retried, no duplicate effect             | api `payments.test.ts` › worker crash                                          | ✅     |
| Full user journey                       | Passes                                   | web `e2e/journey.spec.ts` (desktop and mobile)                                 | ✅     |

The **global invariant check** runs after every DB and API integration test (`afterEach`), and at the end of the capstone and incident runs.
