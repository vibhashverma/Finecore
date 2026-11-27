# Assessment 06: FastAPI risk analytics

**Status:** complete (ADR-012).

**Scoring:** `POST /analytics/v1/risk/score` uses explainable rules:

- velocity;
- amount spike and large amount;
- daily volume;
- new or recent beneficiary;
- fan-out;
- unusual hour;
- new account.

It returns the score, the reasons and a disclaimer.

**Scores are decision support, not proof of fraud.** Above the threshold the transfer is held and an analyst decides.

**Reports:** `GET /analytics/v1/reports/operations` reads the read-only `analytics.*` views as the `fincore_analytics` role. With no database configured, it uses the deterministic SYNTHETIC generator.

**Security:** a service token (Bearer, compared in constant time). Staging and production refuse the dev token.

**Evidence:**

- `evidence/06/sample-risk-scores.json`.
- Incident INC-5, reproduced live: score 85 with 4 reasons, then held, then escalated.
- pytest shows suspicious synthetic populations score higher than normal ones.
