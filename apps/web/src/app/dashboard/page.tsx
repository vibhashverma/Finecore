"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AppShell } from "@/components/session";
import { buttonClass, Card, Empty, ErrorState, Loading, Money, StatusBadge } from "@/components/ui";
import { apiCall } from "@/lib/api";
import type { LedgerLine, Wallet } from "@/lib/types";

function Wallets() {
  const qc = useQueryClient();
  const wallets = useQuery({
    queryKey: ["wallets"],
    queryFn: async () => (await apiCall<Wallet[]>("/wallets?limit=100")).data,
  });
  const [selected, setSelected] = useState<string | null>(null);
  const open = useMutation({
    mutationFn: (currency: string) =>
      apiCall<Wallet>("/wallets", { method: "POST", body: { currency } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["wallets"] }),
  });
  const current = selected ?? wallets.data?.[0]?.id ?? null;
  const lines = useQuery({
    queryKey: ["lines", current],
    enabled: !!current,
    queryFn: async () =>
      (await apiCall<LedgerLine[]>(`/wallets/${current}/transactions?limit=20`)).data,
  });
  const currencyOf = (id: string | null) =>
    wallets.data?.find((w) => w.id === id)?.currency ?? "INR";

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card
        title="Your wallets"
        actions={
          <button
            type="button"
            className={buttonClass}
            onClick={() => open.mutate("INR")}
            disabled={open.isPending}
          >
            Open INR wallet
          </button>
        }
      >
        {open.error ? <ErrorState error={open.error} /> : null}
        {wallets.isPending ? (
          <Loading />
        ) : wallets.error ? (
          <ErrorState error={wallets.error} />
        ) : wallets.data.length === 0 ? (
          <Empty>No wallets yet. Open one to get started.</Empty>
        ) : (
          <ul className="space-y-2">
            {wallets.data.map((w) => (
              <li key={w.id}>
                <button
                  type="button"
                  onClick={() => setSelected(w.id)}
                  aria-pressed={w.id === current}
                  className="w-full rounded border border-slate-200 p-3 text-left hover:bg-slate-50 aria-pressed:border-blue-700"
                >
                  <div className="flex justify-between">
                    <span className="font-medium">
                      {w.nickname ?? `${w.currency} wallet`}{" "}
                      <span className="text-sm text-slate-600">{w.account_number}</span>
                    </span>
                    <StatusBadge status={w.status} />
                  </div>
                  <div
                    className="mt-1 text-2xl font-semibold"
                    data-testid={`available-${w.account_number}`}
                  >
                    <Money minor={w.balance.available_minor} currency={w.currency} />
                  </div>
                  <div className="text-xs text-slate-600">
                    Available · posted{" "}
                    <Money minor={w.balance.posted_minor} currency={w.currency} /> · held{" "}
                    <Money minor={w.balance.held_minor} currency={w.currency} /> · SIMULATED funds
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Recent activity">
        {!current ? (
          <Empty>Select a wallet.</Empty>
        ) : lines.isPending ? (
          <Loading />
        ) : lines.error ? (
          <ErrorState error={lines.error} />
        ) : lines.data.length === 0 ? (
          <Empty>No transactions yet.</Empty>
        ) : (
          <table className="w-full text-sm">
            <caption className="sr-only">Recent ledger entries</caption>
            <thead>
              <tr className="text-left text-slate-600">
                <th scope="col">Date</th>
                <th scope="col">Description</th>
                <th scope="col">State</th>
                <th scope="col" className="text-right">
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {lines.data.map((l) => (
                <tr key={l.entry_id} className="border-t border-slate-100">
                  <td className="py-1">{new Date(l.posted_at).toLocaleDateString()}</td>
                  <td>{l.description}</td>
                  <td>
                    <StatusBadge status={l.state} />
                  </td>
                  <td className={`text-right ${l.direction === "CREDIT" ? "text-green-800" : ""}`}>
                    {l.direction === "CREDIT" ? "+" : "−"}
                    <Money minor={l.amount_minor} currency={currencyOf(current)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

export default function DashboardPage() {
  return (
    <AppShell roles={["CUSTOMER"]}>
      <h1 className="mb-4 text-2xl font-bold">Dashboard</h1>
      <Wallets />
    </AppShell>
  );
}
