# ADR-007: State machines enforced in the database, with automatic history

- Status: Accepted (2026-11-27, Phase 2)
- Date: 2026-11-27

## Context

The brief requires explicit state machines for transfers, payment intents, refunds, disputes, settlements and risk alerts. Illegal transitions must be rejected with `409 INVALID_STATE_TRANSITION`, and every transition must be stored with `from`, `to`, `actor`, `reason` and `at`. The planned app-only approach (a compare-and-set UPDATE in ADR-003) can be bypassed by any code path that forgets to call the state module, and history written by the app can be forgotten too.

## Options

| Option                                      | Pros                                                                                                                        | Cons                                                   |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| App-only state machine                      | Simple and visible in TS                                                                                                    | Bypassable; history is optional                        |
| Postgres ENUM per entity plus app checks    | Typed values                                                                                                                | Doesn't enforce transitions; ENUM changes are awkward  |
| **Transition table plus a generic trigger** | Any UPDATE of `status` is checked; history is written in the same transaction, can't be skipped, and the app can't forge it | One polymorphic history table with no FK to the entity |
| A history table per entity                  | Real FKs                                                                                                                    | Six or more near-identical tables and triggers         |

## Decision

- `state_machine_transitions(entity_type, from_state, to_state)` holds every allowed edge. `from_state IS NULL` marks the allowed initial state.
- `enforce_state_transition('<ENTITY>')` runs `BEFORE INSERT OR UPDATE OF status` on each stateful table. It rejects unknown edges with SQLSTATE `FC006`, and writes a `state_transitions` row in the same transaction.
- It is `SECURITY DEFINER`: the app role has only SELECT on `state_transitions`, so history can't be forged. The table is append-only.
- Actor, reason and request id come from transaction-local settings (`SET LOCAL fincore.actor_id …`), set by the API's transaction helper (Phase 4).
- The app **also** uses a compare-and-set UPDATE (`WHERE status = $from`) so that concurrent transitions are detected without waiting. The trigger is the backstop.
- The polymorphic `entity_id` has no FK. This is mitigated because history rows are only ever written by the trigger, using the triggering row's own `id`.

## Consequences

- The transition table is the single, reviewable source of truth for every lifecycle. It is documented in `docs/assessments/03-ledger-database.md` and will be mirrored in the OpenAPI docs (Phase 9).
- Adding a state or transition is a migration (data change), so it goes through migration review.
- Entities implemented so far: WALLET, HOLD and SETTLEMENT. The others (TRANSFER, PAYMENT_INTENT, REFUND, DISPUTE, RISK_ALERT) already have their transitions defined, and attach the trigger when their tables arrive in Phases 4–7.
