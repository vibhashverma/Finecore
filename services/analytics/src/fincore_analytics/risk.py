"""Explainable transfer risk scoring (Assessment 06).

DISCLAIMER: a risk score is DECISION SUPPORT for a human analyst. It is not proof of fraud and must never be
used on its own to accuse a customer. Every point in the score comes from a named, human-readable rule.

The model is a transparent additive rule set (capped at 100), chosen over an opaque ML model because:
  * every decision can be explained to the customer and the evaluator (reasons list);
  * it needs no training data (only synthetic data exists in this project);
  * thresholds are reviewable configuration.
"""

from dataclasses import dataclass

DISCLAIMER = "Risk scores are decision support for analysts, not proof of fraud."


@dataclass(frozen=True)
class TransferFeatures:
    amount_minor: int
    currency: str
    hour_utc: int
    beneficiary_age_hours: int
    account_age_days: int
    transfers_last_hour: int
    amount_last_24h_minor: int
    avg_amount_30d_minor: int
    distinct_beneficiaries_24h: int


@dataclass(frozen=True)
class Reason:
    code: str
    detail: str
    weight: int


# Thresholds in INR-equivalent minor units for this simulation (single-currency rules; FX out of scope).
LARGE_AMOUNT_MINOR = 5_000_000  # ₹50,000
DAILY_VOLUME_MINOR = 10_000_000  # ₹100,000


def score_transfer(f: TransferFeatures) -> tuple[int, list[Reason]]:
    reasons: list[Reason] = []

    def add(code: str, detail: str, weight: int) -> None:
        reasons.append(Reason(code, detail, weight))

    if f.transfers_last_hour >= 5:
        add("VELOCITY_HIGH", f"{f.transfers_last_hour} transfers in the last hour (>= 5)", 30)
    elif f.transfers_last_hour >= 3:
        add("VELOCITY_ELEVATED", f"{f.transfers_last_hour} transfers in the last hour (>= 3)", 15)

    if f.avg_amount_30d_minor > 0 and f.amount_minor >= 5 * f.avg_amount_30d_minor:
        add("AMOUNT_SPIKE", "amount is at least 5x the 30-day average", 25)
    if f.amount_minor >= LARGE_AMOUNT_MINOR:
        add("LARGE_AMOUNT", "single transfer at or above the large-amount threshold", 15)
    if f.amount_last_24h_minor + f.amount_minor >= DAILY_VOLUME_MINOR:
        add("DAILY_VOLUME", "24-hour outgoing volume at or above the daily threshold", 15)

    if f.beneficiary_age_hours < 1:
        add("NEW_BENEFICIARY", "beneficiary added less than 1 hour ago", 20)
    elif f.beneficiary_age_hours < 24:
        add("RECENT_BENEFICIARY", "beneficiary added less than 24 hours ago", 10)

    if f.distinct_beneficiaries_24h >= 4:
        add("FAN_OUT", f"{f.distinct_beneficiaries_24h} distinct recipients in 24 hours", 15)
    if 0 <= f.hour_utc < 5:
        add("UNUSUAL_HOUR", "initiated between 00:00 and 05:00 UTC", 5)
    if f.account_age_days < 1:
        add("NEW_ACCOUNT", "customer account is less than a day old", 10)

    return min(sum(r.weight for r in reasons), 100), reasons
