import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SimulatedBanner } from "./simulated-banner";

describe("SimulatedBanner", () => {
  it("announces that funds are simulated, as an accessible note", () => {
    render(<SimulatedBanner />);
    const note = screen.getByRole("note", { name: "Simulated funds notice" });
    expect(note.textContent).toContain("SIMULATED FUNDS");
    expect(note.textContent).toContain("No real money");
  });
});
