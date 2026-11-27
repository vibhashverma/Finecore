"""Builds docs/FinCore-Project-Explanation.pdf (whole-project explanation for reviewers).

Usage (from repo root):  uv run --with reportlab python scripts/build-project-pdf.py
"""

from pathlib import Path

from reportlab.graphics.shapes import Drawing, Line, Polygon, Rect, String
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    Image,
    KeepTogether,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

ROOT = Path(__file__).resolve().parents[1]
import subprocess  # noqa: E402

COMMITS = subprocess.run(["git", "rev-list", "--count", "HEAD"], cwd=ROOT, capture_output=True, text=True).stdout.strip() or "?"
OUT = ROOT / "docs" / "FinCore-Project-Explanation.pdf"
ASSETS = ROOT / "docs" / "assets"

# Fonts with ₹, →, ≤, Σ glyphs (Segoe UI on Windows); fall back to Helvetica elsewhere.
FONT, BOLD, MONO = "Helvetica", "Helvetica-Bold", "Courier"
win = Path("C:/Windows/Fonts")
if (win / "segoeui.ttf").exists():
    pdfmetrics.registerFont(TTFont("Segoe", str(win / "segoeui.ttf")))
    pdfmetrics.registerFont(TTFont("Segoe-Bold", str(win / "segoeuib.ttf")))
    pdfmetrics.registerFont(TTFont("Consolas", str(win / "consola.ttf")))
    pdfmetrics.registerFontFamily("Segoe", normal="Segoe", bold="Segoe-Bold", italic="Segoe", boldItalic="Segoe-Bold")
    FONT, BOLD, MONO = "Segoe", "Segoe-Bold", "Consolas"

NAVY = colors.HexColor("#0f172a")
BLUE = colors.HexColor("#1d4ed8")
SLATE = colors.HexColor("#475569")
LIGHT = colors.HexColor("#f1f5f9")
LINE = colors.HexColor("#cbd5e1")
GREEN = colors.HexColor("#166534")
AMBER = colors.HexColor("#92400e")

ss = getSampleStyleSheet()
H1 = ParagraphStyle("H1", parent=ss["Heading1"], fontName=BOLD, fontSize=18, leading=22, textColor=NAVY, spaceBefore=6, spaceAfter=8)
H2 = ParagraphStyle("H2", parent=ss["Heading2"], fontName=BOLD, fontSize=12.5, leading=16, textColor=BLUE, spaceBefore=10, spaceAfter=4)
BODY = ParagraphStyle("Body", parent=ss["BodyText"], fontName=FONT, fontSize=9.6, leading=13.6, spaceAfter=5)
SMALL = ParagraphStyle("Small", parent=BODY, fontSize=8.4, leading=11.4, textColor=SLATE)
CELL = ParagraphStyle("Cell", parent=BODY, fontSize=8.6, leading=11.2, spaceAfter=0)
CELLB = ParagraphStyle("CellB", parent=CELL, fontName=BOLD)
BULLET = ParagraphStyle("Bullet", parent=BODY, leftIndent=12, bulletIndent=2, spaceAfter=2)
CODE = ParagraphStyle("Code", parent=BODY, fontName=MONO, fontSize=8.2, leading=11, backColor=LIGHT, borderPadding=5, leftIndent=4, rightIndent=4, spaceBefore=4, spaceAfter=8)
CAPTION = ParagraphStyle("Caption", parent=SMALL, alignment=TA_CENTER, spaceBefore=3, spaceAfter=10)


def p(text: str, style: ParagraphStyle = BODY) -> Paragraph:
    return Paragraph(text, style)


def bullets(items: list[str]) -> list[Paragraph]:
    return [Paragraph(i, BULLET, bulletText="•") for i in items]


def table(rows: list[list[str]], widths: list[float], header: bool = True) -> Table:
    data = [[Paragraph(c, CELLB if (header and r == 0) else CELL) for c in row] for r, row in enumerate(rows)]
    t = Table(data, colWidths=widths, repeatRows=1 if header else 0)
    style = [
        ("GRID", (0, 0), (-1, -1), 0.4, LINE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, LIGHT]),
    ]
    if header:
        style += [("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e2e8f0"))]
    t.setStyle(TableStyle(style))
    return t


def screenshot(name: str, caption: str, width: float = 160 * mm) -> KeepTogether:
    img = Image(str(ASSETS / name))
    ratio = img.imageHeight / img.imageWidth
    img.drawWidth, img.drawHeight = width, width * ratio
    return KeepTogether([img, p(caption, CAPTION)])


def architecture() -> Drawing:
    d = Drawing(170 * mm, 92 * mm)

    def box(x: float, y: float, w: float, h: float, title: str, sub: str, fill: str) -> None:
        d.add(Rect(x * mm, y * mm, w * mm, h * mm, rx=6, ry=6, fillColor=colors.HexColor(fill), strokeColor=NAVY, strokeWidth=0.8))
        d.add(String((x + w / 2) * mm, (y + h - 6.5) * mm, title, fontName=BOLD, fontSize=9.5, textAnchor="middle", fillColor=NAVY))
        for i, s in enumerate(sub.split("\n")):
            d.add(String((x + w / 2) * mm, (y + h - 12 - i * 4.2) * mm, s, fontName=FONT, fontSize=7.3, textAnchor="middle", fillColor=SLATE))

    def arrow(x1: float, y1: float, x2: float, y2: float, label: str = "") -> None:
        d.add(Line(x1 * mm, y1 * mm, x2 * mm, y2 * mm, strokeColor=SLATE, strokeWidth=1))
        import math

        a = math.atan2(y2 - y1, x2 - x1)
        hx, hy = x2 * mm, y2 * mm
        d.add(Polygon([hx, hy, hx - 7 * math.cos(a - 0.4), hy - 7 * math.sin(a - 0.4), hx - 7 * math.cos(a + 0.4), hy - 7 * math.sin(a + 0.4)], fillColor=SLATE, strokeColor=SLATE))
        if label:
            d.add(String(((x1 + x2) / 2) * mm, ((y1 + y2) / 2 + 1.6) * mm, label, fontName=FONT, fontSize=6.6, textAnchor="middle", fillColor=BLUE))

    box(0, 70, 30, 18, "Browser", "customer / staff", "#ffffff")
    box(40, 70, 36, 18, "Caddy edge", "HTTPS · headers\nrequest id", "#e0e7ff")
    box(88, 76, 38, 14, "Next.js UI", "dashboards", "#dbeafe")
    box(88, 52, 38, 18, "Express API", "owns every write\nauth · ledger · payments", "#dbeafe")
    box(134, 52, 36, 18, "FastAPI analytics", "Decimal fees · risk\nreconciliation", "#dcfce7")
    box(40, 22, 44, 20, "PostgreSQL 16", "system of record\nledger rules in DB", "#fef3c7")
    box(96, 22, 34, 20, "Workers", "outbox job queue\nwebhooks · recon", "#ede9fe")
    box(138, 22, 32, 20, "Provider", "SIMULATED /\nStripe test mode", "#fee2e2")
    box(0, 22, 30, 20, "Redis", "rate limits", "#f1f5f9")
    box(96, 0, 34, 14, "Mailpit / SMS", "SANDBOX / MOCK", "#f1f5f9")

    arrow(30, 79, 40, 79, "HTTPS")
    arrow(76, 83, 88, 83, "/")
    arrow(76, 75, 88, 64, "/api/*")
    arrow(126, 61, 134, 61, "HTTP")
    arrow(98, 52, 72, 42, "SQL (fincore_api)")
    arrow(105, 42, 130, 52)
    arrow(113, 42, 113, 52)
    arrow(96, 32, 84, 32, "SQL")
    arrow(130, 32, 138, 32)
    arrow(150, 42, 124, 52, "")
    d.add(String(147 * mm, 47 * mm, "signed webhooks (via Caddy)", fontName=FONT, fontSize=6.6, textAnchor="start", fillColor=BLUE))
    arrow(113, 22, 113, 14)
    arrow(88, 56, 30, 36, "")
    return d


def on_page(canvas, doc) -> None:  # noqa: ANN001
    canvas.saveState()
    w, h = A4
    canvas.setFont(FONT, 7.5)
    canvas.setFillColor(SLATE)
    canvas.drawString(18 * mm, 10 * mm, "FinCore · Project explanation · SIMULATED funds only, educational assessment")
    canvas.drawRightString(w - 18 * mm, 10 * mm, f"Page {doc.page}")
    canvas.setStrokeColor(LINE)
    canvas.line(18 * mm, 13 * mm, w - 18 * mm, 13 * mm)
    canvas.restoreState()


def cover(canvas, doc) -> None:  # noqa: ANN001
    w, h = A4
    canvas.saveState()
    canvas.setFillColor(NAVY)
    canvas.rect(0, 0, w, h, fill=1, stroke=0)
    canvas.setFillColor(colors.HexColor("#fbbf24"))
    canvas.rect(0, h - 14 * mm, w, 14 * mm, fill=1, stroke=0)
    canvas.setFillColor(NAVY)
    canvas.setFont(BOLD, 10)
    canvas.drawCentredString(w / 2, h - 9 * mm, "SIMULATED FUNDS · synthetic data · sandbox integrations only")
    canvas.setFillColor(colors.white)
    canvas.setFont(BOLD, 46)
    canvas.drawString(22 * mm, h - 95 * mm, "FinCore")
    canvas.setFont(FONT, 17)
    canvas.drawString(22 * mm, h - 108 * mm, "Digital Wallet, Double-Entry Ledger & Payment Processing Platform")
    canvas.setFont(FONT, 12)
    canvas.setFillColor(colors.HexColor("#cbd5e1"))
    canvas.drawString(22 * mm, h - 122 * mm, "Project explanation: architecture, design, verification and status")
    y = h - 160 * mm
    facts = [
        ("Assessment", "Project 02 · FinTech / Digital Banking · Advanced (15 assessments, 1,500 pts)"),
        ("Release", f"v1.0.1 · {COMMITS} Conventional Commits · 14 ADRs"),
        ("Stack", "Next.js · Express · PostgreSQL 16 · FastAPI · Postgres job queue · Caddy"),
        ("Verified", "203 automated tests · 5 browser E2E + axe · Newman 36/36 · capstone ALL PASS"),
        ("Date", "28 November 2026"),
    ]
    for k, v in facts:
        canvas.setFont(BOLD, 10.5)
        canvas.setFillColor(colors.HexColor("#93c5fd"))
        canvas.drawString(22 * mm, y, k.upper())
        canvas.setFont(FONT, 11)
        canvas.setFillColor(colors.white)
        canvas.drawString(58 * mm, y, v)
        y -= 10 * mm
    canvas.setFont(FONT, 8.5)
    canvas.setFillColor(colors.HexColor("#94a3b8"))
    canvas.drawString(22 * mm, 18 * mm, "Educational engineering assessment, not a certification of legal, financial or regulatory compliance.")
    canvas.restoreState()


def build() -> None:
    doc = SimpleDocTemplate(str(OUT), pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm, topMargin=16 * mm, bottomMargin=18 * mm,
                            title="FinCore: Project Explanation", author="FinCore project", subject="Digital wallet, ledger and payments platform")
    W = A4[0] - 36 * mm
    s: list = [PageBreak()]

    # ---------------------------------------------------------------- 1. Summary
    s += [p("1. Executive summary", H1)]
    s += [p("FinCore is a <b>simulated</b> digital-finance platform. Customers open wallets, top up with simulated cards, add "
            "beneficiaries, move money, raise disputes and download statements. Operations staff review risk alerts and reconcile "
            "payment-provider settlements; finance staff handle refunds, reversals and settlement recovery. Every money movement is a "
            "<b>balanced double-entry journal</b> with a tamper-evident audit trail.")]
    s += [p("The guiding rule was <b>correctness before features</b>: the critical rules (balanced ledger, no overdraft, append-only "
            "history, single reversal, legal state transitions) are enforced <b>inside PostgreSQL</b>, so no bug, retry or race in "
            "application code can break them. The application adds idempotency, ordered locking, authorization and step-up "
            "authentication on top.")]
    s += [table([
        ["Outcome", "Result (real runs, saved in evidence/)"],
        ["Automated tests", "203 passing: database 59 · API 76 · analytics 58 · web 3 · workers 4 · contracts 3"],
        ["Browser E2E", "5/5 on desktop and mobile with axe WCAG 2.1 AA checks, against the real stack"],
        ["API smoke (Newman)", "17 requests, 36 assertions, 0 failures"],
        ["Capstone (brief §10)", "Concurrent transfers, duplicate webhooks, failed settlement, reversal: ledger balanced, nothing posted twice"],
        ["Incident simulations", "5 incidents reproduced, postmortems written, ALL CHECKS PASSED"],
        ["Disaster recovery", "Encrypted backup restored in 5.3 s; invariants and audit chain verified; identical to source"],
        ["Demo", "1 min 28 s captioned screen recording of the live system (evidence/demo/fincore-demo.webm)"],
    ], [42 * mm, W - 42 * mm])]
    s += [Spacer(1, 6), p("<b>Honest status.</b> All 15 assessments are implemented and verified locally. Three things are prepared "
                         "but not yet executed because they need resources outside this machine: running the Docker/Compose stack "
                         "(Docker not installed), running CI/CD on GitHub (repo not pushed), and deploying to a VM with a domain. "
                         "Section 13 lists exactly what remains.", SMALL)]

    # ---------------------------------------------------------------- 2. Scope
    s += [p("2. Business scope", H1)]
    s += [p("Five roles with server-enforced permissions (resource ownership is checked inside every SQL query):")]
    s += [table([
        ["Role", "Can do"],
        ["Customer", "Own profile, wallets, beneficiaries (step-up), transfers, top-ups, disputes, statements"],
        ["Support agent", "Masked customer view; raise disputes on behalf; resolve disputes up to ₹5,000"],
        ["Operations analyst", "Risk alerts (investigate, clear, escalate); read reconciliation and audit log"],
        ["Finance administrator", "Refunds, reversals, settlement recovery, reconciliation runs, any dispute (all with step-up)"],
        ["Platform administrator", "Users and roles, failed-job replay (step-up), audit log"],
    ], [42 * mm, W - 42 * mm])]
    s += [Spacer(1, 6), p("All 12 required modules are delivered: customer profiles · wallets/accounts · beneficiaries · double-entry ledger · "
                         "transfers · payment intents · refunds/reversals · disputes · reconciliation · risk alerts · statements · audit trail.")]

    # ---------------------------------------------------------------- 3. Architecture
    s += [PageBreak(), p("3. Architecture", H1)]
    s += [architecture(), p("Figure 1: Components and trust boundaries. Postgres, Redis and workers sit on internal-only networks; "
                            "only Caddy is reachable from the internet.", CAPTION)]
    s += [table([
        ["Service", "Responsibility", "Deliberately does NOT"],
        ["Next.js UI", "Customer and ops dashboards, form UX validation, role-gated navigation", "Hold tokens in JavaScript or enforce business rules"],
        ["Express API", "Every authoritative write: auth, RBAC, ledger posting, transfers, payments, disputes, statements, audit, webhook inbox, idempotency", "Call the network while holding database locks"],
        ["FastAPI analytics", "Decimal fees/interest, statement cross-checks, reconciliation diffs, explainable risk scores, ops reports", "Write to the database or decide on money"],
        ["Workers", "Drain the outbox: webhook processing, notifications, reconciliation, refund submission, housekeeping", "Expose a public HTTP surface"],
        ["PostgreSQL 16", "System of record; integrity rules, state machines and least-privilege roles", "Trust the application"],
    ], [30 * mm, 80 * mm, W - 110 * mm])]
    s += [p("Workers import the API's own domain code (<font name='%s'>@fincore/api/worker</font>), so there is exactly one implementation "
            "of every money rule. Request ids minted at the edge flow through API, workers and analytics logs for tracing." % MONO, BODY)]

    s += [PageBreak(), p("3.1 Technology choices", H2)]
    s += [table([
        ["Layer", "Choice", "Why"],
        ["Frontend", "Next.js 16, React 19, TypeScript strict, Tailwind, TanStack Query, Zod", "Typed, accessible, server-state caching"],
        ["API", "Node 22, Express 5, Zod, pg + Kysely types, jose (EdDSA), Argon2id", "Full SQL control for locks and triggers (ADR-002)"],
        ["Analytics", "Python 3.13, FastAPI, Pydantic v2 strict, Decimal, Hypothesis", "Exact money arithmetic, property tests"],
        ["Database", "PostgreSQL 16, dbmate SQL migrations", "Reviewable DDL incl. triggers and grants"],
        ["Jobs", "Transactional outbox in Postgres (FOR UPDATE SKIP LOCKED)", "Atomic with business writes (ADR-009)"],
        ["Edge / ops", "Caddy, Docker Compose, GitHub Actions, cosign, Trivy, Prometheus", "Automatic HTTPS, signed releases"],
        ["Testing", "Vitest, Supertest, pytest, Playwright + axe, Newman, embedded Postgres 16", "Real database without Docker (ADR-005)"],
    ], [24 * mm, 82 * mm, W - 106 * mm])]

    # ---------------------------------------------------------------- 4. Ledger
    s += [Spacer(1, 8), p("4. The double-entry ledger", H1)]
    s += [p("Every money movement is one <b>journal</b> (<font name='%s'>transactions</font>) with two or more <b>lines</b> "
            "(<font name='%s'>ledger_entries</font>). Amounts are <b>BIGINT minor units</b> with an ISO-4217 currency; there is no "
            "floating point anywhere: <font name='%s'>bigint</font> in TypeScript, strings on the wire, <font name='%s'>Decimal</font> in Python, "
            "and both API schemas reject JSON numbers for money. Wallets are credit-normal liability accounts; available balance = posted − held." % (MONO, MONO, MONO, MONO))]
    s += [p("4.1 Rules enforced by the database itself", H2)]
    s += [table([
        ["Rule", "How PostgreSQL enforces it", "Proven by"],
        ["Σ debits = Σ credits, ≥ 2 lines", "Deferred constraint trigger checked at COMMIT (error FC002)", "Tests; INC-3 reproduction"],
        ["Ledger is append-only", "No UPDATE/DELETE grant for the app, plus triggers that stop even the schema owner", "ledger-proof.sql transcript"],
        ["No late lines on old journals", "Journal records its creating DB transaction id; other transactions are refused (FC003)", "ledger.test.ts"],
        ["Currency consistency", "Composite foreign keys (account, currency) and (journal, currency)", "ledger.test.ts"],
        ["No overdraft, even under races", "Trigger-maintained balances with CHECK posted − held ≥ floor; app can lock but not write balances", "50 concurrent debits → exactly 10 succeed"],
        ["Reversal: exact mirror, at most once", "Deferred mirror check (FC004) + UNIQUE reverses_transaction_id", "reversals.test.ts"],
        ["Legal state transitions only", "Transition table + generic trigger; history written automatically (FC006 → 409)", "state tests"],
        ["Tamper-evident audit", "SHA-256 hash chain; verify function detects edits even by a superuser", "tamper test"],
        ["Plaintext passwords impossible", "CHECK password_hash LIKE '$argon2id$%'", "auth tests"],
    ], [38 * mm, 82 * mm, W - 120 * mm])]
    s += [p("4.2 Postings", H2)]
    s += [table([
        ["Event", "Debit", "Credit"],
        ["Top-up (card payment)", "Provider clearing", "Customer wallet"],
        ["Transfer", "Source wallet (amount + fee)", "Destination wallet (amount) · Fee revenue (fee)"],
        ["Refund", "Customer wallet", "Provider clearing"],
        ["Settlement matched", "Settlement bank", "Provider clearing"],
        ["Settlement short-paid", "Bank (actual) · Settlement suspense (gap)", "Provider clearing (expected)"],
        ["Settlement failed", "Settlement suspense", "Provider clearing"],
        ["Reversal", "Exact mirror of the original journal", ""],
    ], [44 * mm, 60 * mm, W - 104 * mm])]
    s += [p("A global check, <font name='%s'>ledger_invariant_violations()</font>, verifies balanced journals, global balance per currency, "
            "cached balances and holds against the ledger, reversal mirroring and the audit chain. It runs after every integration test, "
            "at the end of the capstone, in the restore drill, and continuously as a Prometheus metric with a critical alert." % MONO)]

    # ---------------------------------------------------------------- 5. Flows
    s += [Spacer(1, 8), p("5. Key flows", H1)]
    s += [p("5.1 A transfer, from browser to database and back", H2)]
    s += bullets([
        "Browser sends <b>POST /api/v1/transfers</b> with the session cookie, a CSRF header and an <b>Idempotency-Key</b>.",
        "The API authenticates against the session row (revocation is immediate) and claims the idempotency key.",
        "Ownership of the wallet and beneficiary is checked <b>inside the SQL</b>; another customer's resource returns 404.",
        "Limits apply; transfers of ₹20,000 or more need a fresh step-up (password + TOTP within 5 minutes).",
        "Analytics quotes the fee in Decimal (no quote → 503, never a guessed amount) and scores risk with a 300 ms timeout.",
        "<b>One database transaction:</b> lock both balance rows in ascending id order → check funds → insert transfer → post the "
        "journal (or place a hold and raise an alert if the score ≥ 70) → outbox row → stored idempotent response → audit row.",
        "COMMIT runs the deferred balance check; the client gets 201 POSTED (or 202 PENDING). A worker later sends notifications.",
    ])
    s += [p("Retries with the same key return the stored response; the same key with a different body gets 422; ordered locks make "
            "opposing transfers (A→B while B→A) deadlock-free.", SMALL)]
    s += [p("5.2 Payments and webhooks", H2)]
    s += [p("A top-up creates a payment intent, calls the provider in test mode outside any lock, and waits for the outcome by "
            "<b>signed webhook</b>: HMAC-SHA256 over the raw body with a 5-minute tolerance and constant-time comparison. Events are stored in "
            "an inbox with a unique provider event id (duplicates are acknowledged and ignored) and processed asynchronously by the state "
            "machine, so out-of-order delivery is safe. In the capstone each event was delivered five times and credited exactly once.")]
    s += [p("5.3 Settlement, reconciliation and recovery", H2)]
    s += [p("When the provider pays out, reconciliation (computed by analytics) matches every provider reference against the ledger. "
            "A short payment moves the difference to settlement suspense and raises an alert; a failed payout moves the whole amount to "
            "suspense. Finance recovers it with an audited, step-up-protected resolution that posts the recovered funds out of suspense.")]
    s += [p("5.4 Refunds, reversals and disputes", H2)]
    s += bullets([
        "<b>Refund:</b> finance with step-up; amount ≤ refundable remainder; funds are held immediately and move when the provider confirms.",
        "<b>Reversal:</b> a new mirrored journal; the original is untouched; a second reversal is refused (409).",
        "<b>Dispute:</b> the disputed amount is held at the recipient; resolution in the customer's favour moves it back; support "
        "agents can only resolve up to their limit.",
    ])

    # ---------------------------------------------------------------- 6. Screens
    s += [PageBreak(), p("6. The product in use", H1)]
    s += [p("Screens captured from the recorded walkthrough of the live system. The yellow banner is permanent: all funds are simulated.")]
    s += [screenshot("transfer-held.png", "Figure 2: Normal transfers post immediately; an unusual ₹4,000 transfer is held for review.", 150 * mm)]
    s += [screenshot("ops-alert-cleared.png", "Figure 3: The ops analyst sees every reason behind the score, then clears the alert, which posts the transfer.", 150 * mm)]
    s += [PageBreak()]
    s += [screenshot("statement.png", "Figure 4: Monthly statement, cross-checked by the Decimal analytics service (₹10,000 in, ₹5,407.20 out).", 150 * mm)]
    s += [screenshot("dashboard.png", "Figure 5: Customer dashboard with posted, held and available balances and state badges.", 120 * mm)]

    # ---------------------------------------------------------------- 7. Security
    s += [PageBreak(), p("7. Identity, authorization and security", H1)]
    s += [table([
        ["Area", "Implementation"],
        ["Passwords", "Argon2id with OWASP parameters; constant-time handling of unknown emails; lockout after 5 failures; rate limits"],
        ["MFA", "Real RFC 6238 TOTP (verified against the RFC test vectors); secrets encrypted with AES-256-GCM; delivery SIMULATED"],
        ["Sessions", "10-minute EdDSA JWT in an httpOnly SameSite=Strict cookie; session row checked per request; rotating refresh "
                     "tokens with reuse detection that revokes the whole family; double-submit CSRF"],
        ["Authorization", "RBAC matrix with roles read from the database per request; ownership inside SQL; masked PII for staff; every denial audited"],
        ["Step-up", "Fresh password + TOTP for beneficiaries, large transfers, refunds, reversals, settlement resolution, role changes, job replay"],
        ["Database", "Least-privilege roles: migrations owner, runtime app role (no ledger edits, no balance writes), read-only analytics role"],
        ["Supply chain", "Lockfiles, Dependabot, pnpm audit, pip-audit, gitleaks, Trivy, signed images with SBOM"],
    ], [30 * mm, W - 30 * mm])]
    s += [p("The full OWASP Top 10 mapping is in docs/SECURITY.md.", SMALL)]

    # ---------------------------------------------------------------- 8. Reliability
    s += [p("8. Reliability and operability", H1)]
    s += bullets([
        "<b>Idempotency</b> for every money-moving POST; the stored response commits atomically with the money movement (ADR-008).",
        "<b>Transactional outbox as a job queue:</b> side effects are written in the same transaction, claimed with SKIP LOCKED and a "
        "60-second lease, retried with exponential backoff and jitter, dead-lettered after five attempts, and replayable by an admin.",
        "<b>Resilience:</b> timeouts on every outbound call, retries only for idempotent calls, a circuit breaker; fees fail closed, "
        "risk scoring fails safe (large transfers held).",
        "<b>Observability:</b> structured JSON logs with request ids and redaction; health and readiness endpoints; Prometheus metrics "
        "for latency, errors, queue depth, dead letters and ledger invariant violations; alert rules for each.",
        "<b>Graceful shutdown:</b> readiness flips to 503, in-flight work drains, pools close.",
    ])

    # ---------------------------------------------------------------- 9. Analytics
    s += [p("9. Analytics service", H1)]
    s += [p("All calculations use <font name='%s'>Decimal</font> with ROUND_HALF_EVEN at documented points (ADR-011). Fees are rounded once then "
            "clamped to their min/max; interest accrues daily on ACT/365 and posts <i>round(cumulative) − already posted</i>, so rounding "
            "error never compounds. Risk scoring is a transparent rule set (velocity, amount spike, new beneficiary, new account, fan-out, "
            "unusual hour…) where every point has a named reason. <b>Scores are decision support, not proof of fraud</b>: above the "
            "threshold a human analyst decides. 58 pytest tests include Hypothesis property tests; a benchmark shows about 65k fee "
            "calculations and 278k risk scores per second." % MONO)]

    # ---------------------------------------------------------------- 10. Verification
    s += [PageBreak(), p("10. Verification", H1)]
    s += [table([
        ["Suite", "Scope", "Result"],
        ["Database (Vitest)", "Real PostgreSQL 16 as the restricted app role; invariant check after every test", "59 passed"],
        ["API (Vitest + Supertest)", "Auth, IDOR, CSRF, idempotency, concurrency, webhooks, settlements, jobs, contract test", "76 passed · 78% lines"],
        ["Analytics (pytest)", "Boundaries, rounding ties, Hypothesis properties, API auth and validation", "58 passed · 94%"],
        ["Web + workers + contracts", "Money formatting beyond 2^53, health server, error catalog", "10 passed"],
        ["Playwright + axe", "Full journey on desktop and mobile; keyboard; validation", "5 passed"],
        ["Newman", "Smoke flow and negative cases against the real stack", "36/36 assertions"],
    ], [42 * mm, 88 * mm, W - 130 * mm])]
    s += [p("10.1 Capstone scenario (brief §10)", H2)]
    s += [Paragraph(
        "50 concurrent transfers (10 sharing one Idempotency-Key) → 33 POSTED, 8 refused for funds, 9 replay/conflict<br/>"
        "Debited exactly posted × (amount + fee); no overdraft; 10 retries → 1 transfer<br/>"
        "Webhooks delivered 5× each → wallet credited exactly once<br/>"
        "Failed payout → suspense + alert → finance recovered it (RESOLVED)<br/>"
        "Reversal → balance restored; second reversal → 409<br/>"
        "ledger_invariant_violations() = 0 rows · Σ debits = Σ credits · no duplicate journals · RESULT: ALL CHECKS PASSED", CODE)]
    s += [p("10.2 Incident simulations", H2)]
    s += [table([
        ["Incident", "What happened", "Why it was safe"],
        ["INC-1 Duplicate events", "10 deliveries per event, out of order", "Unique inbox + state machine: one credit"],
        ["INC-2 Settlement mismatch", "Provider paid ₹240 for ₹250", "Reconciliation flagged it; ₹10 parked in suspense"],
        ["INC-3 Unbalanced journal", "Buggy single-line posting", "Refused by the database at COMMIT (FC002)"],
        ["INC-4 Analytics outage", "Dependency killed mid-traffic", "Fail closed with 503; key released; breaker opens"],
        ["INC-5 Suspicious activity", "Burst then a 60× spike", "Scored 85 with reasons, held, escalated by an analyst"],
    ], [38 * mm, 58 * mm, W - 96 * mm])]
    s += [p("10.3 Defects found by testing and fixed", H2)]
    s += bullets([
        "Least-privilege grants caught two writes the app role should not have needed; both fixed precisely, not by widening access.",
        "A database error message included the migration password; migrations now take the URL from the environment and redact errors.",
        "Windows initdb defaulted to a non-UTF-8 encoding; clusters are now created with UTF-8 explicitly.",
        "The first restore drill failed on a client/server version mismatch; backups now use the server's own tools (ADR-014).",
        "Statement period boundaries used the session time zone (found when the demo crossed midnight IST); now explicit UTC, with a regression test.",
    ])

    # ---------------------------------------------------------------- 11. DevOps
    s += [PageBreak(), p("11. Delivery, deployment and recovery", H1)]
    s += [table([
        ["Area", "What is built", "State"],
        ["Containers", "Multi-stage images, non-root users, read-only root filesystem, cap_drop ALL, health checks, internal networks, migrate job", "Written; runs once Docker is available"],
        ["CI", "commitlint, migration guard, lint, types, all tests, codegen drift, audits, gitleaks, E2E, capstone, compose smoke, Trivy", "Written; runs on first push"],
        ["Releases", "Signed (cosign keyless) versioned images with SBOM → staging + smoke → manual approval → production → auto-rollback", "Written"],
        ["Hosting", "Hardened VM script: firewall 22/80/443, SSH keys only, fail2ban, Caddy HTTPS + HSTS", "Prepared; needs VM + domain"],
        ["Backups", "Daily encrypted pg_dump (gpg AES-256 + SHA-256), 14-day retention, timed restore drill", "Drill run: 5.3 s, verified"],
        ["Monitoring", "Prometheus, Alertmanager, uptime and TLS-expiry probes, Grafana; alerts for ledger invariant, latency, errors, dead letters", "Prepared"],
        ["Governance", "Protected main ruleset, CODEOWNERS for money paths, PR template with migration checklist, semver tags, hotfix flow", "Written; apply on push"],
    ], [26 * mm, 102 * mm, W - 128 * mm])]

    # ---------------------------------------------------------------- 12. Assessments
    s += [p("12. Assessment coverage", H1)]
    rows = [["#", "Assessment", "Status", "Main evidence"]]
    for n, name, status, ev in [
        ("01", "Customer and ops frontend", "Done", "E2E + axe, screenshots, demo video"),
        ("02", "Financial REST APIs", "Done", "76 API tests, Newman run, OpenAPI"),
        ("03", "Double-entry ledger database", "Done", "59 DB tests, SQL proof transcript"),
        ("04", "Identity and authorization", "Done", "Auth tests: IDOR, refresh reuse, step-up"),
        ("05", "Python financial calculations", "Done", "pytest + Hypothesis, benchmark"),
        ("06", "FastAPI risk analytics", "Done", "Sample scores, INC-5"),
        ("07", "Transfer consistency engine", "Done", "Concurrency tests, capstone"),
        ("08", "Payment and notification integrations", "Done*", "Webhook tests (*Stripe adapter untested)"),
        ("09", "Containerized stack", "Built, not run", "Needs Docker"),
        ("10", "Git and change governance", "Built, not evidenced", "Needs GitHub push"),
        ("11", "Secure CI/CD", "Built, not run", "Needs GitHub push"),
        ("12", "Ledger and payment testing", "Done", "Test matrix, all rows automated"),
        ("13", "Financial API contracts", "Done", "OpenAPI 3.1, contract test, API guide"),
        ("14", "Secure deployment and recovery", "Partly done", "Restore drill done; VM pending"),
        ("15", "Financial incident simulation", "Done", "5 reproductions + postmortems"),
    ]:
        color = "#166534" if status.startswith("Done") else "#92400e"
        rows.append([n, name, f"<font color='{color}'><b>{status}</b></font>", ev])
    s += [table(rows, [10 * mm, 58 * mm, 34 * mm, W - 102 * mm])]

    # ---------------------------------------------------------------- 13. Limits
    s += [PageBreak(), p("13. Limitations and next steps", H1)]
    s += [p("Simulated by design: funds, customers and KYC, the payment provider (local simulator; a Stripe test-mode adapter exists but "
            "needs an account), email (Mailpit sandbox), SMS (mock), and MFA delivery. FX is out of scope.")]
    s += [p("Remaining steps that need the owner's resources:", H2)]
    s += bullets([
        "<b>Install Docker Desktop (WSL2)</b> → first run of the Compose stack, image scans and graceful-shutdown check.",
        "<b>Push to a public GitHub repository</b> → apply rulesets; capture green, red and rollback pipeline runs and a real hotfix PR.",
        "<b>Provision a VM and domain</b> → HTTPS, port-scan, monitoring dashboards and an on-VM restore drill.",
        "<b>Optional Stripe test account</b> → exercise the Stripe adapter.",
    ])
    s += [p("Accepted trade-offs (each with an ADR): Postgres job queue instead of BullMQ; embedded PostgreSQL instead of "
            "Testcontainers; polymorphic references without foreign keys in history tables; serialized audit writes; no scheduled "
            "interest-posting job yet (the calculation is complete and tested).")]

    # ---------------------------------------------------------------- Appendix
    s += [p("Appendix A: How to run it", H2)]
    s += [Paragraph(
        "pnpm install &amp;&amp; (cd services/analytics &amp;&amp; uv sync)<br/>"
        "pnpm test                                     # all TypeScript suites (embedded PostgreSQL 16)<br/>"
        "(cd services/analytics &amp;&amp; uv run pytest)<br/>"
        "pnpm --filter @fincore/api scenario capstone  # brief §10 proof<br/>"
        "pnpm --filter @fincore/api scenario incidents # Assessment 15<br/>"
        "pnpm --filter @fincore/db db:local            # local database with demo data<br/>"
        "API_INTERNAL_URL=http://127.0.0.1:4400 pnpm build &amp;&amp; pnpm --filter @fincore/web test:e2e", CODE)]
    s += [p("Demo users: alice@, bob@, chandra@, support@, ops@, finance@, admin@fincore.test · password FinCore-Demo-2026! · "
            "SIMULATED TOTP secret JBSWY3DPEHPK3PXP.", SMALL)]
    s += [p("Appendix B: Decisions (ADRs)", H2)]
    s += [table([
        ["ADR", "Decision"],
        ["001", "Money as BIGINT minor units; strings on the wire; Decimal in Python"],
        ["002", "Kysely types + raw SQL; dbmate plain-SQL migrations"],
        ["003", "Pessimistic, ordered row locks for transfers"],
        ["004", "Cookie-based EdDSA JWT, rotating refresh, TOTP, step-up"],
        ["005", "Embedded PostgreSQL 16 for tests (no Docker)"],
        ["006", "Ledger integrity, roles and audit chain enforced in the database"],
        ["007", "State machines enforced in the database with automatic history"],
        ["008", "Idempotency stored in Postgres, atomic with the ledger"],
        ["009", "Transactional outbox as the job queue"],
        ["010", "Payment provider port: SIMULATED + Stripe test mode"],
        ["011", "ROUND_HALF_EVEN and ACT/365"],
        ["012", "Explainable rule-based risk scoring"],
        ["013", "Single hardened VM with Compose and Caddy"],
        ["014", "Encrypted backups and timed restore drills"],
    ], [16 * mm, W - 16 * mm])]
    s += [p("Appendix C: Where things are", H2)]
    s += [table([
        ["Path", "Contents"],
        ["apps/web · apps/api · apps/workers", "UI · API (modules, auth, jobs, OpenAPI) · worker process"],
        ["services/analytics", "FastAPI calculations, risk, synthetic data"],
        ["db/migrations · db/bootstrap", "13 SQL migrations · role bootstrap"],
        ["packages/db · packages/contracts", "DB helpers, test harness, seed, types · error catalog"],
        ["infra/ · .github/", "Dockerfiles, Compose, Caddy, deploy, monitoring · CI/CD, rulesets"],
        ["docs/", "Plan, architecture, API guide, ADRs, assessments, runbooks, postmortems, security, review prep"],
        ["evidence/", "Test runs, proofs, screenshots, restore drill, demo video"],
    ], [58 * mm, W - 58 * mm])]

    doc.build(s, onFirstPage=cover, onLaterPages=on_page)
    print(f"wrote {OUT}")


if __name__ == "__main__":
    build()
