"""SYNTHETIC data generator for risk analytics and operations reports. Never real people or transactions.

Deterministic for a given seed, so reports and benchmarks are reproducible.
"""

import random
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from .risk import TransferFeatures


@dataclass(frozen=True)
class SyntheticTransfer:
    id: str
    customer: str
    amount_minor: int
    currency: str
    status: str
    risk_score: int
    created_at: datetime


def generate_features(n: int, seed: int = 42, suspicious_ratio: float = 0.05) -> list[TransferFeatures]:
    rng = random.Random(seed)  # noqa: S311 - synthetic data, not cryptography
    out: list[TransferFeatures] = []
    for _ in range(n):
        suspicious = rng.random() < suspicious_ratio
        avg = rng.randint(50_000, 500_000)
        out.append(
            TransferFeatures(
                amount_minor=avg * (rng.randint(6, 20) if suspicious else rng.randint(1, 3)),
                currency="INR",
                hour_utc=rng.randint(0, 4) if suspicious else rng.randint(6, 22),
                beneficiary_age_hours=0 if suspicious else rng.randint(24, 5000),
                account_age_days=rng.randint(0, 3) if suspicious else rng.randint(30, 900),
                transfers_last_hour=rng.randint(4, 9) if suspicious else rng.randint(0, 2),
                amount_last_24h_minor=rng.randint(0, 2_000_000),
                avg_amount_30d_minor=avg,
                distinct_beneficiaries_24h=rng.randint(3, 8) if suspicious else rng.randint(0, 2),
            )
        )
    return out


def generate_transfers(n: int, seed: int = 7) -> list[SyntheticTransfer]:
    rng = random.Random(seed)  # noqa: S311 - synthetic data
    start = datetime(2026, 11, 1, tzinfo=UTC)
    statuses = ["POSTED"] * 90 + ["PENDING"] * 4 + ["FAILED"] * 3 + ["REVERSED"] * 3
    return [
        SyntheticTransfer(
            id=f"syn-{i:06d}",
            customer=f"cust-{rng.randint(1, 200):04d}",
            amount_minor=rng.randint(100, 2_000_000),
            currency="INR",
            status=rng.choice(statuses),
            risk_score=rng.randint(0, 100),
            created_at=start + timedelta(minutes=rng.randint(0, 60 * 24 * 26)),
        )
        for i in range(n)
    ]
