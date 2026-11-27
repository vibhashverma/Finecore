# ADR-012: Risk scoring model

- Status: Accepted (Phase 6)
- Date: 2026-11-28

**Decision: a transparent additive rule set**, capped at 100, with a named reason for every point:

- velocity;
- amount spike vs the 30-day average;
- large amount;
- 24-hour volume;
- new or recent beneficiary;
- fan-out;
- unusual hour;
- new account.

Express computes the features (it owns the data) and analytics scores them, staying stateless.

**Policy.**

- Score ≥ 70 → the transfer is held (202 PENDING, hold placed, alert raised). An **analyst decides** CLEARED (post) or ESCALATED (fail and release).
- **Scores are decision support, not proof of fraud.** This is stated in the API, the UI and the reports.

**Why not ML.**

- There is no real training data, only synthetic data.
- Rules are explainable to customers and evaluators, and their thresholds are reviewable configuration.

**Validation.** Synthetic suspicious populations score above 60 on average and normal ones below (pytest). Example outputs are in `evidence/06/sample-risk-scores.json`.
