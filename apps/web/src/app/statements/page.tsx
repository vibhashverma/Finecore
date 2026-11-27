"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { AppShell } from "@/components/session";
import { buttonClass, Card, ErrorState, Field, inputClass, Loading, Money } from "@/components/ui";
import { apiCall } from "@/lib/api";
import type { Wallet } from "@/lib/types";

interface Statement {
  id: string;
  currency: string;
  period_start: string;
  period_end: string;
  opening_minor: string;
  closing_minor: string;
  total_credits_minor: string;
  total_debits_minor: string;
  entry_count: number;
}

function Statements() {
  const wallets = useQuery({
    queryKey: ["wallets"],
    queryFn: async () => (await apiCall<Wallet[]>("/wallets?limit=100")).data,
  });
  const [wallet, setWallet] = useState("");
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  const gen = useMutation({
    mutationFn: async (v: { w: string; p: string }) =>
      (await apiCall<Statement>(`/statements?wallet_id=${v.w}&period=${v.p}`)).data,
  });
  if (wallets.isPending) return <Loading />;
  if (wallets.error) return <ErrorState error={wallets.error} />;
  const w = wallet || wallets.data[0]?.id || "";
  const s = gen.data;
  return (
    <Card title="Monthly statement">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          gen.mutate({ w, p: period });
        }}
      >
        <Field label="Wallet" id="st-wallet">
          <select
            id="st-wallet"
            className={inputClass}
            value={w}
            onChange={(e) => setWallet(e.target.value)}
          >
            {wallets.data.map((x) => (
              <option key={x.id} value={x.id}>
                {x.account_number}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Month" id="st-period">
          <input
            id="st-period"
            type="month"
            className={inputClass}
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
          />
        </Field>
        <button type="submit" className={`${buttonClass} mb-3`}>
          Generate
        </button>
      </form>
      {gen.error ? <ErrorState error={gen.error} /> : null}
      {s && (
        <div className="mt-4">
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <dt>Opening balance</dt>
            <dd>
              <Money minor={s.opening_minor} currency={s.currency} />
            </dd>
            <dt>Money in</dt>
            <dd>
              <Money minor={s.total_credits_minor} currency={s.currency} />
            </dd>
            <dt>Money out</dt>
            <dd>
              <Money minor={s.total_debits_minor} currency={s.currency} />
            </dd>
            <dt>Closing balance</dt>
            <dd data-testid="closing" className="font-semibold">
              <Money minor={s.closing_minor} currency={s.currency} />
            </dd>
          </dl>
          <p className="mt-3 flex gap-3">
            <a
              className="text-blue-800 underline"
              href={`/api/v1/statements/${s.id}/export?format=csv`}
            >
              Download CSV
            </a>
            <a
              className="text-blue-800 underline"
              href={`/api/v1/statements/${s.id}/export?format=pdf`}
            >
              Download PDF
            </a>
          </p>
        </div>
      )}
    </Card>
  );
}

export default function StatementsPage() {
  return (
    <AppShell roles={["CUSTOMER"]}>
      <h1 className="mb-4 text-2xl font-bold">Statements</h1>
      <Statements />
    </AppShell>
  );
}
