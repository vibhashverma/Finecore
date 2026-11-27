from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from fincore_analytics.app import create_app
from fincore_analytics.risk import DISCLAIMER, TransferFeatures, score_transfer
from fincore_analytics.synthetic import generate_features

TOKEN = "test-token-0123456789"
AUTH = {"authorization": f"Bearer {TOKEN}"}
BASE = TransferFeatures(
    amount_minor=100_000,
    currency="INR",
    hour_utc=12,
    beneficiary_age_hours=500,
    account_age_days=200,
    transfers_last_hour=0,
    amount_last_24h_minor=0,
    avg_amount_30d_minor=100_000,
    distinct_beneficiaries_24h=1,
)


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app(token=TOKEN))


class TestRisk:
    def test_normal_transfer_scores_zero_with_no_reasons(self) -> None:
        assert score_transfer(BASE) == (0, [])

    def test_each_reason_is_explained(self) -> None:
        score, reasons = score_transfer(replace(BASE, transfers_last_hour=6, beneficiary_age_hours=0, hour_utc=3))
        codes = {r.code for r in reasons}
        assert codes == {"VELOCITY_HIGH", "NEW_BENEFICIARY", "UNUSUAL_HOUR"}
        assert score == sum(r.weight for r in reasons) == 55
        assert all(r.detail for r in reasons)

    def test_score_is_capped_at_100(self) -> None:
        worst = replace(
            BASE,
            amount_minor=9_000_000,
            transfers_last_hour=9,
            beneficiary_age_hours=0,
            account_age_days=0,
            hour_utc=1,
            amount_last_24h_minor=9_000_000,
            distinct_beneficiaries_24h=8,
        )
        assert score_transfer(worst)[0] == 100

    def test_synthetic_suspicious_population_scores_higher(self) -> None:
        normal = [score_transfer(f)[0] for f in generate_features(500, seed=1, suspicious_ratio=0.0)]
        suspicious = [score_transfer(f)[0] for f in generate_features(500, seed=1, suspicious_ratio=1.0)]
        assert sum(suspicious) / len(suspicious) > 60 > sum(normal) / len(normal)

    def test_generator_is_deterministic(self) -> None:
        assert generate_features(10, seed=3) == generate_features(10, seed=3)


class TestApi:
    def test_requires_the_service_token(self, client: TestClient) -> None:
        r = client.post("/analytics/v1/risk/score", json={})
        assert r.status_code == 401
        assert r.json()["error"]["code"] == "UNAUTHENTICATED"
        assert (
            client.post("/analytics/v1/risk/score", json={}, headers={"authorization": "Bearer wrong"}).status_code
            == 401
        )

    def test_fee_endpoint(self, client: TestClient) -> None:
        body = {
            "amount_minor": "112500",
            "currency": "INR",
            "schedule": {"flat_minor": "0", "rate_bps": 10, "min_minor": "100", "max_minor": "5000"},
        }
        r = client.post("/analytics/v1/fees/calculate", json=body, headers=AUTH)
        assert r.status_code == 200
        assert r.json() == {"fee_minor": "112", "rounding": "ROUND_HALF_EVEN"}

    def test_rejects_float_amounts(self, client: TestClient) -> None:
        body = {
            "amount_minor": 1125.5,
            "currency": "INR",
            "schedule": {"flat_minor": "0", "rate_bps": 10, "min_minor": "100", "max_minor": None},
        }
        r = client.post("/analytics/v1/fees/calculate", json=body, headers=AUTH)
        assert r.status_code == 400
        assert r.json()["error"]["code"] == "VALIDATION_ERROR"

    def test_risk_endpoint_returns_reasons_and_disclaimer(self, client: TestClient) -> None:
        body = {
            "amount_minor": "100000",
            "currency": "INR",
            "hour_utc": 2,
            "beneficiary_age_hours": 0,
            "account_age_days": 300,
            "transfers_last_hour": 0,
            "amount_last_24h_minor": "0",
            "avg_amount_30d_minor": "100000",
            "distinct_beneficiaries_24h": 0,
        }
        r = client.post("/analytics/v1/risk/score", json=body, headers=AUTH).json()
        assert r["score"] == 25
        assert r["disclaimer"] == DISCLAIMER

    def test_interest_statement_and_reconciliation(self, client: TestClient) -> None:
        i = client.post(
            "/analytics/v1/interest/calculate",
            json={
                "currency": "INR",
                "annual_rate": "0.0365",
                "opening_minor": "1000000",
                "start": "2026-01-01",
                "end": "2026-01-30",
            },
            headers=AUTH,
        )
        assert i.json()["to_post_minor"] == "3000"
        bad_rate = client.post(
            "/analytics/v1/interest/calculate",
            json={
                "currency": "INR",
                "annual_rate": "nan",
                "opening_minor": "1",
                "start": "2026-01-01",
                "end": "2026-01-02",
            },
            headers=AUTH,
        )
        assert bad_rate.status_code == 400
        s = client.post(
            "/analytics/v1/statements/summarize",
            json={"opening_minor": "100", "lines": [{"direction": "CREDIT", "amount_minor": "50"}]},
            headers=AUTH,
        )
        assert s.json()["closing_minor"] == "150"
        rc = client.post(
            "/analytics/v1/reconciliation/compare",
            json={
                "internal": [{"provider_ref": "p1", "amount_minor": "10"}],
                "provider": [{"provider_ref": "p1", "amount_minor": "7"}],
            },
            headers=AUTH,
        ).json()
        assert rc["diff_minor"] == "3"
        assert rc["items"][0]["outcome"] == "AMOUNT_MISMATCH"

    def test_operations_report_uses_synthetic_data_without_a_database(self, client: TestClient) -> None:
        r = client.get("/analytics/v1/reports/operations", headers=AUTH).json()
        assert r["source"].startswith("SYNTHETIC")
        assert sum(r["transfers_by_status"].values()) == 1000

    def test_invalid_period_is_a_safe_400(self, client: TestClient) -> None:
        r = client.post(
            "/analytics/v1/interest/calculate",
            json={
                "currency": "INR",
                "annual_rate": "0.01",
                "opening_minor": "1",
                "start": "2026-02-01",
                "end": "2026-01-01",
            },
            headers=AUTH,
        )
        assert r.status_code == 400
        assert "traceback" not in r.text.lower()
