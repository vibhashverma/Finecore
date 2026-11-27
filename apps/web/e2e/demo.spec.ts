/**
 * Recorded product walkthrough (not a test of edge cases): drives the REAL stack and records a video.
 *   API_INTERNAL_URL=http://127.0.0.1:4400 pnpm build && pnpm --filter @fincore/web demo:record
 * Output: evidence/demo/fincore-demo.webm. All data and money are SIMULATED.
 */
import { expect, test, type Page } from "@playwright/test";
import { totp } from "../../api/src/auth/totp";

const PASSWORD = "FinCore-Demo-2026!";
const DEMO_SECRET = "JBSWY3DPEHPK3PXP"; // SIMULATED MFA secret of seeded demo users

/** On-screen caption bar (injected into the page; purely visual). */
async function caption(page: Page, text: string, holdMs = 2200) {
  await page.evaluate((t) => {
    let el = document.getElementById("demo-caption");
    if (!el) {
      el = document.createElement("div");
      el.id = "demo-caption";
      el.setAttribute("aria-hidden", "true");
      Object.assign(el.style, {
        position: "fixed",
        left: "0",
        right: "0",
        bottom: "0",
        zIndex: "99999",
        padding: "14px 24px",
        background: "rgba(15,23,42,0.92)",
        color: "#fff",
        font: "600 20px/1.35 system-ui, sans-serif",
        textAlign: "center",
      });
      document.body.appendChild(el);
    }
    el.textContent = t;
  }, text);
  await page.waitForTimeout(holdMs);
}

async function titleCard(page: Page, title: string, lines: string[], holdMs = 3500) {
  await page.setContent(`<html><body style="margin:0;height:100vh;display:flex;flex-direction:column;justify-content:center;align-items:center;background:#0f172a;color:#fff;font-family:system-ui,sans-serif">
    <h1 style="font-size:56px;margin:0 0 16px">${title}</h1>
    ${lines.map((l) => `<p style="font-size:24px;margin:6px;color:#cbd5e1">${l}</p>`).join("")}
  </body></html>`);
  await page.waitForTimeout(holdMs);
}

async function login(page: Page, email: string, secret: string) {
  await page.goto("/login");
  await page.getByLabel("Email").pressSequentially(email, { delay: 25 });
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("6-digit code").pressSequentially(totp(secret), { delay: 60 });
  await page.getByRole("button", { name: "Verify" }).click();
}

async function send(page: Page, amount: string, description: string) {
  await page.getByLabel("To beneficiary").selectOption({ index: 1 });
  await page.getByLabel(/Amount/).fill(amount);
  await page.getByLabel("Description (optional)").fill(description);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Transfer" })).toBeVisible();
}

test("FinCore product walkthrough @demo", async ({ page }) => {
  test.setTimeout(240_000);
  const email = `demo-${Date.now()}@fincore.test`;

  await titleCard(page, "FinCore", [
    "Digital wallet · double-entry ledger · payments",
    "Next.js · Express · PostgreSQL 16 · FastAPI analytics · job workers",
    "All funds, people and cards are SIMULATED",
  ]);

  // 1. Registration with SIMULATED MFA enrolment
  await page.goto("/register");
  await caption(page, "1 · A new customer registers (synthetic data only)");
  await page.getByLabel(/Full name/).pressSequentially("Demo Customer", { delay: 30 });
  await page.getByLabel("Email").pressSequentially(email, { delay: 15 });
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Register" }).click();
  const secret = ((await page.getByTestId("mfa-secret").textContent()) ?? "").trim();
  await caption(page, "The TOTP secret is shown once: real RFC 6238 MFA, SIMULATED delivery", 3000);

  // 2. Login: password + TOTP
  await login(page, email, secret);
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await caption(
    page,
    "2 · Signed in with password + 6-digit TOTP. Session lives in an httpOnly cookie",
  );

  // 3. Wallet + top-up through the SIMULATED card provider (signed webhook → worker → ledger)
  await page.getByRole("button", { name: "Open INR wallet" }).click();
  await expect(page.getByText("₹0.00").first()).toBeVisible();
  await caption(page, "3 · A wallet is a liability account in the double-entry ledger");
  await page.getByRole("link", { name: "Top up" }).click();
  await page.getByLabel(/Amount/).fill("10000");
  await caption(page, "Top up ₹10,000 with a SIMULATED card (test mode, no card numbers)");
  await page.getByRole("button", { name: "Pay (test mode)" }).click();
  await expect(page.getByRole("status").getByText("SUCCEEDED")).toBeVisible({ timeout: 30_000 });
  await caption(
    page,
    "Provider sent a signed webhook → worker posted DR clearing / CR wallet exactly once",
  );
  await page.getByRole("link", { name: "Dashboard" }).click();
  await expect(page.getByText("₹10,000.00").first()).toBeVisible();
  await caption(page, "Balance and ledger history update: posted, held and available");

  // 4. Beneficiary with step-up re-authentication
  await page.getByRole("link", { name: "Beneficiaries" }).click();
  await page.getByLabel("FinCore account number").fill("FC1000000003");
  await page.getByLabel("Nickname").fill("Bob");
  await caption(page, "4 · Adding a beneficiary is a sensitive action");
  await page.getByRole("button", { name: "Add beneficiary" }).click();
  const dialog = page.getByRole("dialog", { name: "Confirm it's you" });
  await dialog.waitFor();
  await caption(page, "Step-up: password + fresh TOTP required (valid 5 minutes)", 2000);
  await dialog.getByLabel("Password").fill(PASSWORD);
  await dialog.getByLabel("6-digit code").fill(totp(secret));
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("Bob")).toBeVisible();

  // 5. Transfers: a normal one, then a burst that trips the risk rules
  await page.getByRole("link", { name: "Transfers" }).click();
  await caption(
    page,
    "5 · Transfers: idempotent, atomic, ordered row locks, Decimal fee from analytics",
  );
  await send(page, "1200", "Rent share");
  await caption(
    page,
    "POSTED: one balanced journal (debit, credit, fee). Retries can never double-post",
    2600,
  );
  await send(page, "100", "Coffee");
  await send(page, "100", "Snacks");
  await caption(
    page,
    "Now an unusual pattern: burst of transfers, then a large spike to a brand-new payee",
    2600,
  );
  await send(page, "4000", "Urgent!!");
  await expect(page.getByRole("status").getByText("PENDING")).toBeVisible();
  await caption(
    page,
    "Held for review: funds reserved, nothing posted. Risk score = decision support only",
    3200,
  );

  // 6. Operations analyst reviews the explainable alert
  await page.getByRole("button", { name: "Sign out" }).click();
  await login(page, "ops@fincore.test", DEMO_SECRET);
  await expect(page.getByRole("heading", { name: "Operations" })).toBeVisible();
  await caption(
    page,
    "6 · Ops analyst: every point of the score has a named, human-readable reason",
    3500,
  );
  await page.getByRole("button", { name: "investigating" }).first().click();
  await page.waitForTimeout(800);
  await caption(page, "The analyst investigates and decides; the score never decides on its own");
  await page.getByRole("button", { name: "cleared" }).first().click();
  await page.waitForTimeout(1000);
  await caption(
    page,
    "CLEARED → the held transfer is posted. ESCALATED would fail it and release the hold",
    3000,
  );

  await page.getByRole("link", { name: "Audit log" }).click();
  await expect(page.getByText("intact")).toBeVisible();
  await caption(page, "Append-only, hash-chained audit log: any tampering would show here", 3200);

  // 7. Customer statement
  await page.getByRole("button", { name: "Sign out" }).click();
  await login(page, email, secret);
  await page.getByRole("link", { name: "Statements" }).click();
  await page.getByRole("button", { name: "Generate" }).click();
  await expect(page.getByTestId("closing")).toBeVisible();
  await caption(
    page,
    "7 · Monthly statement: totals cross-checked by the Decimal analytics service",
    3000,
  );
  await page.getByRole("link", { name: "Transfers" }).click();
  await caption(page, "History shows every transfer with its state badge", 2600);

  // 8. API contract
  await page.goto("/api/docs");
  await page.waitForTimeout(1500);
  await caption(
    page,
    "8 · OpenAPI 3.1 generated from the same schemas that validate requests",
    3000,
  );
  await page.mouse.wheel(0, 900);
  await page.waitForTimeout(1500);

  await titleCard(
    page,
    "Verified",
    [
      "202 automated tests · 5 browser E2E + accessibility · Newman 36/36",
      "Capstone: concurrent transfers, duplicate webhooks, failed settlement, reversal",
      "Ledger balanced · no account debited or credited twice",
    ],
    4500,
  );
});
