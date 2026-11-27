from datetime import date
from decimal import Decimal

import pytest
from hypothesis import given
from hypothesis import strategies as st

from fincore_analytics.calculations import (
    DailyBalance,
    FeeSchedule,
    accrue_interest,
    calculate_fee,
    compare_reconciliation,
    daily_balances,
    summarize_statement,
)
from fincore_analytics.money import to_major, to_minor

INR = FeeSchedule(flat_minor=0, rate_bps=10, min_minor=100, max_minor=5000)  # 0.10%, min ₹1, max ₹50


class TestMoney:
    def test_exact_minor_major_round_trip(self) -> None:
        assert to_major(125050, "INR") == Decimal("1250.50")
        assert to_major(7, "JPY") == Decimal(7)
        assert to_minor(Decimal("1250.50"), "INR") == 125050

    @pytest.mark.parametrize(
        ("major", "minor"),
        [("0.125", 12), ("0.135", 14), ("0.145", 14), ("-0.125", -12), ("0.1251", 13), ("0.005", 0), ("0.015", 2)],
    )
    def test_half_even_ties(self, major: str, minor: int) -> None:
        assert to_minor(Decimal(major), "INR") == minor

    def test_jpy_has_no_minor_unit(self) -> None:
        assert to_minor(Decimal("10.5"), "JPY") == 10
        assert to_minor(Decimal("11.5"), "JPY") == 12

    def test_unknown_currency_rejected(self) -> None:
        with pytest.raises(ValueError, match="unsupported currency"):
            to_major(1, "XXX")


class TestFees:
    @pytest.mark.parametrize(
        ("amount", "fee"),
        [
            (1, 100),  # minimum unit → min fee
            (100_000, 100),  # 0.10% of ₹1,000 = ₹1.00 exactly at the minimum
            (125_000, 125),  # ₹1.25
            (5_000_000, 5000),  # exactly at the cap
            (99_999_999, 5000),  # capped
            (112_500, 112),  # 112.5 → tie → even (112)
            (113_500, 114),  # 113.5 → tie → even (114)
        ],
    )
    def test_boundaries(self, amount: int, fee: int) -> None:
        assert calculate_fee(amount, "INR", INR) == fee

    def test_flat_plus_percentage(self) -> None:
        s = FeeSchedule(flat_minor=50, rate_bps=150, min_minor=0, max_minor=None)
        assert calculate_fee(10_000, "USD", s) == 50 + 150

    def test_zero_and_negative_rejected(self) -> None:
        with pytest.raises(ValueError):
            calculate_fee(0, "INR", INR)
        with pytest.raises(ValueError):
            calculate_fee(-1, "INR", INR)

    def test_invalid_schedule_rejected(self) -> None:
        with pytest.raises(ValueError):
            FeeSchedule(flat_minor=0, rate_bps=10, min_minor=500, max_minor=100)

    @given(amount=st.integers(min_value=1, max_value=10**15))
    def test_property_fee_within_bounds(self, amount: int) -> None:
        fee = calculate_fee(amount, "INR", INR)
        assert INR.min_minor <= fee <= (INR.max_minor or fee)

    @given(a=st.integers(min_value=1, max_value=10**12), b=st.integers(min_value=1, max_value=10**12))
    def test_property_monotonic(self, a: int, b: int) -> None:
        lo, hi = sorted((a, b))
        assert calculate_fee(lo, "INR", INR) <= calculate_fee(hi, "INR", INR)


class TestInterest:
    def test_daily_accrual_act_365(self) -> None:
        bals = [DailyBalance(date(2026, 1, d), 1_000_000) for d in range(1, 31)]  # ₹10,000 for 30 days
        cumulative, to_post = accrue_interest(bals, Decimal("0.0365"), "INR")
        assert cumulative == Decimal("30.0")  # 10000 * 0.0365 / 365 * 30 = ₹30.00
        assert to_post == 3000

    def test_posts_only_the_rounded_delta_no_compounding_error(self) -> None:
        bals = [DailyBalance(date(2026, 1, d), 333_333) for d in range(1, 11)]
        cumulative, first = accrue_interest(bals[:5], Decimal("0.05"), "INR")
        _, second = accrue_interest(bals, Decimal("0.05"), "INR", already_posted_minor=first)
        _, total = accrue_interest(bals, Decimal("0.05"), "INR")
        assert first + second == total
        assert cumulative > 0

    def test_negative_balances_accrue_nothing_and_floats_rejected(self) -> None:
        assert accrue_interest([DailyBalance(date(2026, 1, 1), -500)], Decimal("0.1"), "INR")[1] == 0
        with pytest.raises(TypeError):
            accrue_interest([], 0.05, "INR")  # type: ignore[arg-type]
        with pytest.raises(ValueError):
            accrue_interest([DailyBalance(date(2026, 1, 1), 1)] * 2, Decimal("0.1"), "INR")

    def test_daily_balances_apply_movements(self) -> None:
        b = daily_balances(100, date(2026, 1, 1), date(2026, 1, 3), {date(2026, 1, 2): 50})
        assert [x.balance_minor for x in b] == [100, 150, 150]


class TestStatementAndReconciliation:
    def test_statement_identity(self) -> None:
        s = summarize_statement(1000, [("CREDIT", 500), ("DEBIT", 200), ("DEBIT", 1)])
        assert (s.total_credits_minor, s.total_debits_minor, s.closing_minor, s.line_count) == (500, 201, 1299, 3)

    def test_statement_rejects_bad_lines(self) -> None:
        with pytest.raises(ValueError):
            summarize_statement(0, [("CREDIT", 0)])
        with pytest.raises(ValueError):
            summarize_statement(0, [("SIDEWAYS", 1)])  # type: ignore[list-item]

    @given(
        opening=st.integers(min_value=-(10**12), max_value=10**12),
        lines=st.lists(st.tuples(st.sampled_from(["DEBIT", "CREDIT"]), st.integers(min_value=1, max_value=10**9))),
    )
    def test_property_closing_equals_opening_plus_net(self, opening: int, lines: list[tuple[str, int]]) -> None:
        s = summarize_statement(opening, lines)  # type: ignore[arg-type]
        net = sum(a if d == "CREDIT" else -a for d, a in lines)
        assert s.closing_minor == opening + net

    def test_reconciliation_outcomes(self) -> None:
        items = compare_reconciliation([("a", 100), ("b", 200), ("c", 300)], [("a", 100), ("b", 150), ("d", 50)])
        assert [(i.provider_ref, i.outcome, i.diff_minor) for i in items] == [
            ("a", "MATCHED", 0),
            ("b", "AMOUNT_MISMATCH", 50),
            ("c", "MISSING_PROVIDER", 300),
            ("d", "MISSING_INTERNAL", -50),
        ]

    def test_reconciliation_rejects_duplicate_refs(self) -> None:
        with pytest.raises(ValueError, match="duplicate"):
            compare_reconciliation([("a", 1), ("a", 2)], [])

    @given(st.dictionaries(st.text(min_size=1, max_size=8), st.integers(min_value=0, max_value=10**9), max_size=30))
    def test_property_identical_sides_all_match(self, lines: dict[str, int]) -> None:
        rows = list(lines.items())
        assert all(i.outcome == "MATCHED" for i in compare_reconciliation(rows, rows))
