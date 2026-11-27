"""HTTP routes for /analytics/v1. Amounts are strings of integer minor units; floats are rejected by schema."""

import hmac
from collections import Counter
from collections.abc import Awaitable, Callable
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .calculations import (
    FeeSchedule,
    accrue_interest,
    calculate_fee,
    compare_reconciliation,
    daily_balances,
    summarize_statement,
)
from .money import EXPONENTS
from .risk import DISCLAIMER, TransferFeatures, score_transfer
from .synthetic import generate_transfers

Minor = Annotated[str, Field(pattern=r"^-?\d{1,18}$", description="integer minor units as a string")]
PositiveMinor = Annotated[str, Field(pattern=r"^[1-9]\d{0,17}$")]
Currency = Literal["INR", "USD", "JPY"]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class FeeScheduleIn(Strict):
    flat_minor: Minor
    rate_bps: int = Field(ge=0, le=10_000)
    min_minor: Minor
    max_minor: Minor | None


class FeeIn(Strict):
    amount_minor: PositiveMinor
    currency: Currency
    schedule: FeeScheduleIn


class InterestIn(BaseModel):
    model_config = ConfigDict(extra="forbid")  # lax only so ISO date strings parse; amounts stay strings

    currency: Currency
    annual_rate: str = Field(description="decimal fraction as a string, e.g. '0.035'")
    opening_minor: Minor
    start: date
    end: date
    movements: dict[date, Minor] = Field(default_factory=dict)
    already_posted_minor: Minor = "0"

    @field_validator("annual_rate")
    @classmethod
    def decimal_rate(cls, v: str) -> str:
        try:
            d = Decimal(v)
        except InvalidOperation as exc:
            raise ValueError("annual_rate must be a decimal string") from exc
        if not d.is_finite() or d < 0 or d > 1:
            raise ValueError("annual_rate must be between 0 and 1")
        return v


class StatementLine(Strict):
    direction: Literal["DEBIT", "CREDIT"]
    amount_minor: PositiveMinor


class StatementIn(Strict):
    opening_minor: Minor
    lines: list[StatementLine] = Field(max_length=100_000)


class ReconLine(Strict):
    provider_ref: str = Field(min_length=1, max_length=128)
    amount_minor: Minor


class ReconIn(Strict):
    internal: list[ReconLine] = Field(max_length=50_000)
    provider: list[ReconLine] = Field(max_length=50_000)


class RiskIn(Strict):
    amount_minor: PositiveMinor
    currency: Currency
    hour_utc: int = Field(ge=0, le=23)
    beneficiary_age_hours: int = Field(ge=0)
    account_age_days: int = Field(ge=0)
    transfers_last_hour: int = Field(ge=0)
    amount_last_24h_minor: Minor
    avg_amount_30d_minor: Minor
    distinct_beneficiaries_24h: int = Field(ge=0)


def require_service_token(expected: str) -> Callable[..., Awaitable[None]]:
    """Service-to-service auth: only the Express API (holding ANALYTICS_TOKEN) may call these endpoints."""

    async def check(authorization: Annotated[str | None, Header()] = None) -> None:
        supplied = (authorization or "").removeprefix("Bearer ")
        if not hmac.compare_digest(supplied.encode(), expected.encode()):
            raise HTTPException(status_code=401)

    return check


ReportRows = Callable[[], Awaitable[list[dict[str, object]]]]


def build_router(token: str, report_rows: ReportRows | None = None) -> APIRouter:
    r = APIRouter(prefix="/analytics/v1", dependencies=[Depends(require_service_token(token))])

    @r.post("/fees/calculate")
    async def fees(body: FeeIn) -> dict[str, str]:
        s = body.schedule
        fee = calculate_fee(
            int(body.amount_minor),
            body.currency,
            FeeSchedule(
                int(s.flat_minor),
                s.rate_bps,
                int(s.min_minor),
                None if s.max_minor is None else int(s.max_minor),
            ),
        )
        return {"fee_minor": str(fee), "rounding": "ROUND_HALF_EVEN"}

    @r.post("/interest/calculate")
    async def interest(body: InterestIn) -> dict[str, str]:
        if body.end < body.start or (body.end - body.start).days > 366:
            raise HTTPException(status_code=400, detail="period must be 1..366 days")
        balances = daily_balances(
            int(body.opening_minor),
            body.start,
            body.end,
            {d: int(v) for d, v in body.movements.items()},
        )
        cumulative, to_post = accrue_interest(
            balances, Decimal(body.annual_rate), body.currency, int(body.already_posted_minor)
        )
        return {
            "accrued_major_unrounded": str(cumulative),
            "to_post_minor": str(to_post),
            "day_count": "ACT/365",
        }

    @r.post("/statements/summarize")
    async def statement(body: StatementIn) -> dict[str, str]:
        s = summarize_statement(int(body.opening_minor), [(ln.direction, int(ln.amount_minor)) for ln in body.lines])
        return {
            "total_credits_minor": str(s.total_credits_minor),
            "total_debits_minor": str(s.total_debits_minor),
            "closing_minor": str(s.closing_minor),
            "line_count": str(s.line_count),
        }

    @r.post("/reconciliation/compare")
    async def reconcile(body: ReconIn) -> dict[str, object]:
        items = compare_reconciliation(
            [(x.provider_ref, int(x.amount_minor)) for x in body.internal],
            [(x.provider_ref, int(x.amount_minor)) for x in body.provider],
        )
        expected = sum(i.expected_minor for i in items)
        actual = sum(i.actual_minor for i in items)
        return {
            "items": [
                {
                    "provider_ref": i.provider_ref,
                    "outcome": i.outcome,
                    "expected_minor": str(i.expected_minor),
                    "actual_minor": str(i.actual_minor),
                    "diff_minor": str(i.diff_minor),
                }
                for i in items
            ],
            "expected_total_minor": str(expected),
            "actual_total_minor": str(actual),
            "diff_minor": str(expected - actual),
            "outcome_counts": dict(Counter(i.outcome for i in items)),
        }

    @r.post("/risk/score")
    async def risk(body: RiskIn) -> dict[str, object]:
        score, reasons = score_transfer(
            TransferFeatures(
                amount_minor=int(body.amount_minor),
                currency=body.currency,
                hour_utc=body.hour_utc,
                beneficiary_age_hours=body.beneficiary_age_hours,
                account_age_days=body.account_age_days,
                transfers_last_hour=body.transfers_last_hour,
                amount_last_24h_minor=int(body.amount_last_24h_minor),
                avg_amount_30d_minor=int(body.avg_amount_30d_minor),
                distinct_beneficiaries_24h=body.distinct_beneficiaries_24h,
            )
        )
        return {
            "score": score,
            "reasons": [{"code": x.code, "detail": x.detail, "weight": x.weight} for x in reasons],
            "disclaimer": DISCLAIMER,
        }

    @r.get("/reports/operations")
    async def operations_report(request: Request) -> dict[str, object]:
        """Ops report from the read-only analytics views; SYNTHETIC data when no database is configured."""
        if report_rows is not None:
            rows, source = await report_rows(), "database (analytics views, read-only role)"
        else:
            rows = [
                {
                    "status": t.status,
                    "currency": t.currency,
                    "amount_minor": t.amount_minor,
                    "risk_score": t.risk_score,
                }
                for t in generate_transfers(1000)
            ]
            source = "SYNTHETIC generator (no database configured)"
        by_status: Counter[str] = Counter()
        volume: Counter[str] = Counter()
        high_risk = 0
        for row in rows:
            by_status[str(row["status"])] += 1
            volume[str(row["currency"])] += int(str(row["amount_minor"]))
            if int(str(row.get("risk_score") or 0)) >= 70:
                high_risk += 1
        return {
            "source": source,
            "transfers_by_status": dict(by_status),
            "volume_minor_by_currency": {k: str(v) for k, v in volume.items()},
            "high_risk_transfers": high_risk,
            "currencies": sorted(EXPONENTS),
            "disclaimer": DISCLAIMER,
        }

    return r
