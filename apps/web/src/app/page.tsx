import Link from "next/link";

export default function HomePage() {
  return (
    <main id="main" className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="text-3xl font-bold">FinCore</h1>
      <p className="mt-4 text-slate-700">
        A simulated digital wallet, double-entry ledger and payment platform built for an
        engineering assessment. All balances, people and payments are synthetic.
      </p>
      <div className="mt-6 flex gap-3">
        <Link href="/login" className="rounded bg-blue-700 px-4 py-2 font-semibold text-white">
          Sign in
        </Link>
        <Link href="/register" className="rounded border border-slate-400 px-4 py-2 font-semibold">
          Create an account
        </Link>
      </div>
    </main>
  );
}
