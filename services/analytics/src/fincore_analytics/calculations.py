"""Pure financial calculations (Assessment 05). No I/O, no floats; every rounding point is documented.

Rounding rules (ADR-011):
  * Fees: percentage part computed in Decimal, rounded ONCE to the minor unit (half-even), then flat fee added,
    then clamped to [min, max]. Fees are never negative and never exceed the cap.
  * Interest: daily accrual on the end-of-day balance, Actual/365 day count (365 even in leap years, documented).
    Accrual is kept unrounded; only the cumulative total is rounded, and the amount to post is
    round(cumulative) - already_posted. Rounding error therefore never compounds.
  * Statements and reconciliation use exact integer minor units (no rounding at all).
"""

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal, localcontext
from typing import Literal

from .money import PRECISION, ROUNDING, exponent, to_major, to_minor

BPS = Decimal(10_000)
DAY_COUNT_BASIS = Decimal(365)


@dataclass(frozen=True)
class FeeSchedule:
    flat_minor: int
    rate_bps: int
    min_minor: int
    max_minor: int | None

    def __post_init__(self) -> None:
        if self.flat_minor < 0 or self.min_minor < 0 or not 0 <= self.rate_bps <= 10_000:
            raise ValueError("invalid fee schedule")
        if self.max_minor is not None and self.max_minor < self.min_minor:
            raise ValueError("max_minor must be >= min_minor")


def calculate_fee(amount_minor: int, currency: str, s: FeeSchedule) -> int:
    if amount_minor <= 0:
        raise ValueError("amount must be positive")
    with localcontext() as ctx:
        ctx.prec = PRECISION
        pct_major = to_major(amount_minor, currency) * Decimal(s.rate_bps) / BPS
    fee = s.flat_minor + to_minor(pct_major, currency)
    fee = max(fee, s.min_minor)
    if s.max_minor is not None:
        fee = min(fee, s.max_minor)
    return fee


@dataclass(frozen=True)
class DailyBalance:
    day: date
    balance_minor: int


def accrue_interest(
    balances: Sequence[DailyBalance],
    annual_rate: Decimal,
    currency: str,
    already_posted_minor: int = 0,
) -> tuple[Decimal, int]:
    """Returns (cumulative unrounded accrual in major units, minor units to post now).

    `annual_rate` is a Decimal fraction (e.g. Decimal("0.035") for 3.5%); a float is rejected.
    Negative balances accrue nothing (no overdraft interest modelled).
    """
    if not isinstance(annual_rate, Decimal):
        raise TypeError("annual_rate must be a Decimal")
    if annual_rate < 0 or annual_rate > 1:
        raise ValueError("annual_rate must be between 0 and 1")
    days = [b.day for b in balances]
    if len(set(days)) != len(days):
        raise ValueError("duplicate day in balances")
    exponent(currency)
    with localcontext() as ctx:
        ctx.prec = PRECISION
        cumulative = sum(
            (to_major(max(b.balance_minor, 0), currency) * annual_rate / DAY_COUNT_BASIS for b in balances),
            Decimal(0),
        )
    to_post = to_minor(cumulative, currency) - already_posted_minor
    return cumulative, max(to_post, 0)


def daily_balances(opening_minor: int, start: date, end: date, movements: dict[date, int]) -> list[DailyBalance]:
    """End-of-day balances from an opening balance and net daily movements (helper for interest)."""
    out: list[DailyBalance] = []
    bal = opening_minor
    d = start
    while d <= end:
        bal += movements.get(d, 0)
        out.append(DailyBalance(d, bal))
        d += timedelta(days=1)
    return out


Direction = Literal["DEBIT", "CREDIT"]


@dataclass(frozen=True)
class StatementSummary:
    total_credits_minor: int
    total_debits_minor: int
    closing_minor: int
    line_count: int


def summarize_statement(opening_minor: int, lines: Iterable[tuple[Direction, int]]) -> StatementSummary:
    """Wallet (credit-normal) statement: closing = opening + credits - debits. Exact integers."""
    credits = debits = count = 0
    for direction, amount in lines:
        if amount <= 0:
            raise ValueError("line amounts must be positive")
        if direction == "CREDIT":
            credits += amount
        elif direction == "DEBIT":
            debits += amount
        else:
            raise ValueError(f"invalid direction {direction!r}")
        count += 1
    return StatementSummary(credits, debits, opening_minor + credits - debits, count)


Outcome = Literal["MATCHED", "AMOUNT_MISMATCH", "MISSING_INTERNAL", "MISSING_PROVIDER"]


@dataclass(frozen=True)
class ReconItem:
    provider_ref: str
    outcome: Outcome
    expected_minor: int
    actual_minor: int
    diff_minor: int


def compare_reconciliation(internal: Sequence[tuple[str, int]], provider: Sequence[tuple[str, int]]) -> list[ReconItem]:
    """Matches ledger (internal) vs provider lines by provider reference. diff = expected - actual."""
    for name, rows in (("internal", internal), ("provider", provider)):
        refs = [r for r, _ in rows]
        if len(set(refs)) != len(refs):
            raise ValueError(f"duplicate provider_ref in {name} lines")
    exp = dict(internal)
    act = dict(provider)
    items: list[ReconItem] = []
    for ref in sorted(exp.keys() | act.keys()):
        e, a = exp.get(ref, 0), act.get(ref, 0)
        outcome: Outcome
        if ref not in exp:
            outcome = "MISSING_INTERNAL"
        elif ref not in act:
            outcome = "MISSING_PROVIDER"
        else:
            outcome = "MATCHED" if e == a else "AMOUNT_MISMATCH"
        items.append(ReconItem(ref, outcome, e, a, e - a))
    return items


__all__ = [
    "ROUNDING",
    "DailyBalance",
    "FeeSchedule",
    "ReconItem",
    "StatementSummary",
    "accrue_interest",
    "calculate_fee",
    "compare_reconciliation",
    "daily_balances",
    "summarize_statement",
]
