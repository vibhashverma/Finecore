"""Money primitives: Decimal only, never binary floating point (ADR-001, ADR-011).

Amounts cross the service boundary as integer minor units (strings in JSON). Inside, they become Decimal major
units with the currency's ISO 4217 exponent. Every rounding point is explicit and uses ROUND_HALF_EVEN
(banker's rounding), so repeated rounding has no systematic upward bias.
"""

from decimal import ROUND_HALF_EVEN, Decimal, localcontext

EXPONENTS: dict[str, int] = {"INR": 2, "USD": 2, "JPY": 0}
ROUNDING = ROUND_HALF_EVEN
PRECISION = 34  # decimal128: far above any intermediate value used here


def exponent(currency: str) -> int:
    try:
        return EXPONENTS[currency]
    except KeyError as exc:
        raise ValueError(f"unsupported currency {currency!r}") from exc


def to_major(minor: int, currency: str) -> Decimal:
    """1234 INR minor units -> Decimal('12.34'). Exact (scaleb is a pure exponent shift)."""
    return Decimal(minor).scaleb(-exponent(currency))


def to_minor(major: Decimal, currency: str) -> int:
    """Rounds a major-unit Decimal to the currency's minor unit (half-even) and returns an int."""
    exp = exponent(currency)
    with localcontext() as ctx:
        ctx.prec = PRECISION
        q = major.quantize(Decimal(1).scaleb(-exp), rounding=ROUNDING)
    return int(q.scaleb(exp))
