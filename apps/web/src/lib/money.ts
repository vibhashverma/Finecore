/** Money on the client: strings of integer minor units, converted with string/bigint math only (ADR-001). */
export const EXPONENT: Record<string, number> = { INR: 2, USD: 2, JPY: 0 };
const SYMBOL: Record<string, string> = { INR: "₹", USD: "$", JPY: "¥" };

export function formatMoney(minor: string | bigint, currency: string): string {
  const exp = EXPONENT[currency] ?? 2;
  let v = BigInt(minor);
  const neg = v < 0n;
  if (neg) v = -v;
  const s = v.toString().padStart(exp + 1, "0");
  const whole = BigInt(exp ? s.slice(0, -exp) : s);
  const frac = exp ? `.${s.slice(-exp)}` : "";
  const grouped = new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US").format(whole);
  return `${neg ? "-" : ""}${SYMBOL[currency] ?? ""}${grouped}${frac}`;
}

/** "1,250.50" → "125050". Rejects more decimals than the currency allows; never uses floating point. */
export function parseMajorToMinor(input: string, currency: string): string | null {
  const exp = EXPONENT[currency] ?? 2;
  const clean = input.replaceAll(",", "").trim();
  const re = exp === 0 ? /^\d{1,13}$/ : new RegExp(`^\\d{1,13}(\\.\\d{1,${exp}})?$`);
  if (!re.test(clean)) return null;
  const [whole = "0", frac = ""] = clean.split(".");
  const minor =
    BigInt(whole) * 10n ** BigInt(exp) + BigInt((frac + "0".repeat(exp)).slice(0, exp) || "0");
  return minor > 0n ? minor.toString() : null;
}
