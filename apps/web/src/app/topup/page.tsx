"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AppShell } from "@/components/session";
import {
  buttonClass,
  Card,
  ErrorState,
  Field,
  inputClass,
  Loading,
  StatusBadge,
} from "@/components/ui";
import { apiCall, newIdempotencyKey } from "@/lib/api";
import { parseMajorToMinor } from "@/lib/money";
import type { Wallet } from "@/lib/types";

/** Top-up through the payment provider in TEST mode. Only SIMULATED payment methods exist: no card numbers. */
function TopUp() {
  const qc = useQueryClient();
  const wallets = useQuery({
    queryKey: ["wallets"],
    queryFn: async () => (await apiCall<Wallet[]>("/wallets?limit=100")).data,
  });
  const [wallet, setWallet] = useState("");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("pm_simulated_success");
  const [error, setError] = useState<string | null>(null);
  const [intentId, setIntentId] = useState<string | null>(null);
  const status = useQuery({
    queryKey: ["intent", intentId],
    enabled: !!intentId,
    queryFn: async () => (await apiCall<{ status: string }>(`/payment-intents/${intentId}`)).data,
    refetchInterval: (q) =>
      ["SUCCEEDED", "FAILED", "CANCELED"].includes(q.state.data?.status ?? "") ? false : 1000,
  });
  const pay = useMutation({
    mutationFn: async (v: { wallet_id: string; amount_minor: string }) => {
      const pi = await apiCall<{ id: string }>("/payment-intents", {
        method: "POST",
        body: v,
        idempotencyKey: newIdempotencyKey(),
      });
      await apiCall(`/payment-intents/${pi.data.id}/confirm`, {
        method: "POST",
        body: { payment_method: method },
        idempotencyKey: newIdempotencyKey(),
      });
      return pi.data.id;
    },
    onSuccess: (id) => {
      setIntentId(id);
      void qc.invalidateQueries({ queryKey: ["wallets"] });
    },
  });
  if (wallets.isPending) return <Loading />;
  if (wallets.error) return <ErrorState error={wallets.error} />;
  const w = wallet || wallets.data[0]?.id || "";
  const currency = wallets.data.find((x) => x.id === w)?.currency ?? "INR";
  return (
    <Card title="Add SIMULATED funds">
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const minor = parseMajorToMinor(amount, currency);
          setError(minor ? null : "Enter a positive amount");
          if (minor) pay.mutate({ wallet_id: w, amount_minor: minor });
        }}
      >
        <Field label="Wallet" id="topup-wallet">
          <select
            id="topup-wallet"
            className={inputClass}
            value={w}
            onChange={(e) => setWallet(e.target.value)}
          >
            {wallets.data.map((x) => (
              <option key={x.id} value={x.id}>
                {x.account_number} ({x.currency})
              </option>
            ))}
          </select>
        </Field>
        <Field label={`Amount (${currency})`} id="topup-amount" error={error ?? undefined}>
          <input
            id="topup-amount"
            inputMode="decimal"
            className={inputClass}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            aria-invalid={!!error}
          />
        </Field>
        <Field label="Test payment method (SIMULATED)" id="method">
          <select
            id="method"
            className={inputClass}
            value={method}
            onChange={(e) => setMethod(e.target.value)}
          >
            <option value="pm_simulated_success">Simulated card: succeeds</option>
            <option value="pm_simulated_decline">Simulated card: declined</option>
          </select>
        </Field>
        {pay.error ? <ErrorState error={pay.error} /> : null}
        {status.data && (
          <p role="status" className="mb-2">
            Payment status: <StatusBadge status={status.data.status} />
          </p>
        )}
        <button type="submit" className={buttonClass} disabled={pay.isPending}>
          Pay (test mode)
        </button>
      </form>
    </Card>
  );
}

export default function TopUpPage() {
  return (
    <AppShell roles={["CUSTOMER"]}>
      <h1 className="mb-4 text-2xl font-bold">Top up</h1>
      <TopUp />
    </AppShell>
  );
}
