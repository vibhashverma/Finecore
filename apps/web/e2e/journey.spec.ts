import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { totp } from "../../api/src/auth/totp";

const DEMO_SECRET = "JBSWY3DPEHPK3PXP"; // SIMULATED MFA secret shared by seeded demo users (documented)
const PASSWORD = "FinCore-Demo-2026!";
const shots = "../../evidence/01";

async function expectAccessible(page: Page, name: string) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  const serious = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${name}: ${v.id} (${v.nodes.length})`)).toEqual([]);
}

async function login(page: Page, email: string, secret = DEMO_SECRET) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("6-digit code").fill(totp(secret));
  await page.getByRole("button", { name: "Verify" }).click();
}

async function reauthIfAsked(page: Page, secret: string) {
  const dialog = page.getByRole("dialog", { name: "Confirm it's you" });
  await dialog.waitFor({ timeout: 10_000 });
  await dialog.getByLabel("Password").fill(PASSWORD);
  await dialog.getByLabel("6-digit code").fill(totp(secret));
  await dialog.getByRole("button", { name: "Confirm" }).click();
}

test("full customer journey: signup → wallet → top-up → beneficiary → transfer → statement @mobile", async ({
  page,
}, info) => {
  const email = `e2e-${Date.now()}-${info.project.name}@fincore.test`;
  // Sign up (SIMULATED MFA enrolment)
  await page.goto("/register");
  await expect(page.getByRole("note", { name: "Simulated funds notice" })).toBeVisible();
  await expectAccessible(page, "register");
  await page.getByLabel(/Full name/).fill("E2E Customer (synthetic)");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Register" }).click();
  const secret = (await page.getByTestId("mfa-secret").textContent())?.trim() ?? "";
  expect(secret).toMatch(/^[A-Z2-7]{32}$/);

  // Login with password + TOTP
  await login(page, email, secret);
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await page.getByRole("button", { name: "Open INR wallet" }).click();
  await expect(page.getByText("₹0.00").first()).toBeVisible();
  await expectAccessible(page, "dashboard");

  // Top up ₹500.00 with a SIMULATED card → webhook → worker credits the wallet
  await page.getByRole("link", { name: "Top up" }).click();
  await page.getByLabel(/Amount/).fill("500");
  await page.getByRole("button", { name: "Pay (test mode)" }).click();
  await expect(page.getByRole("status").getByText("SUCCEEDED")).toBeVisible({ timeout: 30_000 });
  await expectAccessible(page, "topup");

  // Add a beneficiary (step-up reauth dialog)
  await page.getByRole("link", { name: "Beneficiaries" }).click();
  await page.getByLabel("FinCore account number").fill("FC1000000003");
  await page.getByLabel("Nickname").fill("Bob");
  await page.getByRole("button", { name: "Add beneficiary" }).click();
  await reauthIfAsked(page, secret);
  await expect(page.getByText("Bob")).toBeVisible();
  await expectAccessible(page, "beneficiaries");

  // Transfer ₹100.00 (fee ₹1.00)
  await page.getByRole("link", { name: "Transfers" }).click();
  await page.getByLabel("To beneficiary").selectOption({ label: "Bob ••••0003" });
  await page.getByLabel(/Amount/).fill("100");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("status").getByText("POSTED")).toBeVisible();
  await expectAccessible(page, "transfers");

  // Statement: 500 - 100 - 1 = ₹399.00
  await page.getByRole("link", { name: "Statements" }).click();
  await page.getByRole("button", { name: "Generate" }).click();
  await expect(page.getByTestId("closing")).toHaveText("₹399.00");
  await expect(page.getByRole("link", { name: "Download CSV" })).toBeVisible();
  await expectAccessible(page, "statements");

  await page.getByRole("link", { name: "Dashboard" }).click();
  await expect(page.getByText("₹399.00").first()).toBeVisible();
  await page.screenshot({ path: `${shots}/dashboard-${info.project.name}.png`, fullPage: true });
});

test("validation errors are shown inline and announced", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("Enter a valid email")).toBeVisible();
  await expect(page.getByLabel("Email")).toHaveAttribute("aria-invalid", "true");
});

test("ops analyst sees risk alerts with the disclaimer; customers are kept out of ops", async ({
  page,
}) => {
  await login(page, "ops@fincore.test");
  await expect(page.getByRole("heading", { name: "Operations" })).toBeVisible();
  await expect(page.getByText(/decision support, not proof of fraud/)).toBeVisible();
  await expectAccessible(page, "ops");
  await page.screenshot({ path: `${shots}/ops-desktop.png`, fullPage: true });
  await page.getByRole("button", { name: "Sign out" }).click();

  await login(page, "chandra@fincore.test");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await page.goto("/ops");
  await expect(page.getByText("You do not have access to this page.")).toBeVisible();
});

test("keyboard: skip link and visible focus", async ({ page }) => {
  await page.goto("/login");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
});
