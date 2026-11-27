"""Small performance + correctness benchmark (Assessments 05/06). Usage: uv run python scripts/benchmark.py"""

import time
from decimal import Decimal

from fincore_analytics.calculations import FeeSchedule, calculate_fee, compare_reconciliation, summarize_statement
from fincore_analytics.risk import score_transfer
from fincore_analytics.synthetic import generate_features


def bench(name: str, n: int, fn: object) -> None:
    start = time.perf_counter()
    result = fn()  # type: ignore[operator]
    elapsed = time.perf_counter() - start
    print(f"{name:<38} n={n:>7}  {elapsed * 1000:8.1f} ms  {n / elapsed:12,.0f} ops/s  check={result}")


def main() -> None:
    s = FeeSchedule(0, 10, 100, 5000)
    n = 200_000
    bench("fee (Decimal, half-even, capped)", n, lambda: sum(calculate_fee(a, "INR", s) for a in range(1, n + 1)))
    feats = generate_features(50_000, seed=9)
    bench("risk score (explainable rules)", len(feats), lambda: sum(score_transfer(f)[0] for f in feats))
    lines = [("CREDIT" if i % 3 else "DEBIT", i + 1) for i in range(500_000)]
    bench("statement summarize (exact ints)", len(lines), lambda: summarize_statement(0, lines).closing_minor)  # type: ignore[arg-type]
    rows = [(f"p{i}", i + 1) for i in range(100_000)]
    provider = [(r, a if i % 1000 else a - 1) for i, (r, a) in enumerate(rows)]
    bench(
        "reconciliation compare",
        len(rows),
        lambda: sum(1 for i in compare_reconciliation(rows, provider) if i.outcome != "MATCHED"),
    )
    # correctness spot-check: Decimal avoids the classic float error
    assert Decimal("0.1") + Decimal("0.2") == Decimal("0.3")
    print("float 0.1+0.2 == 0.3 ?", 0.1 + 0.2 == 0.3, "| Decimal:", Decimal("0.1") + Decimal("0.2") == Decimal("0.3"))


if __name__ == "__main__":
    main()
