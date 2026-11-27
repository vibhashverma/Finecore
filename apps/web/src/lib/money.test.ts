import { describe, expect, it } from "vitest";
import { formatMoney, parseMajorToMinor } from "./money";

describe("client money helpers (no floats)", () => {
  it("formats minor units exactly, including large values", () => {
    expect(formatMoney("125050", "INR")).toBe("₹1,250.50");
    expect(formatMoney("5", "USD")).toBe("$0.05");
    expect(formatMoney("1000", "JPY")).toBe("¥1,000");
    expect(formatMoney("900719925474099312", "INR")).toBe("₹9,00,71,99,25,47,40,993.12"); // > 2^53, every digit exact
    expect(formatMoney("-100", "INR")).toBe("-₹1.00");
  });

  it("parses user input to minor units and rejects invalid precision", () => {
    expect(parseMajorToMinor("1,250.5", "INR")).toBe("125050");
    expect(parseMajorToMinor("0.01", "INR")).toBe("1");
    expect(parseMajorToMinor("1.001", "INR")).toBeNull();
    expect(parseMajorToMinor("10.5", "JPY")).toBeNull();
    expect(parseMajorToMinor("0", "INR")).toBeNull();
    expect(parseMajorToMinor("-5", "INR")).toBeNull();
    expect(parseMajorToMinor("1e3", "INR")).toBeNull();
  });
});
