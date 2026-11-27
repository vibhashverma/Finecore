/**
 * Persistent banner required on every page: all balances and payments in FinCore are simulated.
 * role="note" with an accessible label, so screen-reader users get the same warning.
 */
export function SimulatedBanner() {
  return (
    <div
      role="note"
      aria-label="Simulated funds notice"
      className="w-full bg-amber-300 px-4 py-2 text-center text-sm font-semibold text-black"
    >
      SIMULATED FUNDS: this is a test environment. No real money, cards or bank accounts are used.
    </div>
  );
}
