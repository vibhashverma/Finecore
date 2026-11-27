"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AppShell, useReauth } from "@/components/session";
import {
  buttonClass,
  Card,
  Empty,
  ErrorState,
  Field,
  inputClass,
  Loading,
  Money,
  StatusBadge,
} from "@/components/ui";
import { apiCall, newIdempotencyKey } from "@/lib/api";
import { parseMajorToMinor } from "@/lib/money";
import type { Beneficiary, Transfer, Wallet } from "@/lib/types";

function TransferForm() {
  const qc = useQueryClient();
  const withReauth = useReauth();
  const wallets = useQuery({
    queryKey: ["wallets"],
    queryFn: async () => (await apiCall<Wallet[]>("/wallets?limit=100")).data,
  });
  const bens = useQuery({
    queryKey: ["beneficiaries"],
    queryFn: async () => (await apiCall<Beneficiary[]>("/beneficiaries?limit=100")).data,
  });
  const [form, setForm] = useState({ source: "", beneficiary: "", amount: "", description: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  // One idempotency key per intended transfer: double-clicks and network retries can't create a second one.
  const [key, setKey] = useState(newIdempotencyKey);
  const send = useMutation({
    mutationFn: (body: Record<string, string>) =>
      withReauth(() =>
        apiCall<Transfer>("/transfers", { method: "POST", body, idempotencyKey: key }),
      ),
    onSuccess: () => {
      setKey(newIdempotencyKey());
      setForm((f) => ({ ...f, amount: "", description: "" }));
      void qc.invalidateQueries();
    },
  });

  if (wallets.isPending || bens.isPending) return <Loading />;
  if (wallets.error || bens.error) return <ErrorState error={wallets.error ?? bens.error} />;
  const source = form.source || wallets.data[0]?.id || "";
  const currency = wallets.data.find((w) => w.id === source)?.currency ?? "INR";

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    const minor = parseMajorToMinor(form.amount, currency);
    if (!minor)
      errs.amount = `Enter a positive amount with at most ${currency === "JPY" ? 0 : 2} decimals`;
    if (!form.beneficiary) errs.beneficiary = "Choose a beneficiary";
    setErrors(errs);
    if (Object.keys(errs).length || !minor) return;
    send.mutate({
      source_wallet_id: source,
      beneficiary_id: form.beneficiary,
      amount_minor: minor,
      ...(form.description ? { description: form.description } : {}),
    });
  }

  return (
    <Card title="Send money">
      {bens.data.length === 0 ? (
        <Empty>Add a beneficiary first.</Empty>
      ) : (
        <form onSubmit={submit} noValidate>
          <Field label="From wallet" id="source">
            <select
              id="source"
              className={inputClass}
              value={source}
              onChange={(e) => setForm({ ...form, source: e.target.value })}
            >
              {wallets.data.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.account_number} ({w.currency})
                </option>
              ))}
            </select>
          </Field>
          <Field label="To beneficiary" id="beneficiary" error={errors.beneficiary}>
            <select
              id="beneficiary"
              className={inputClass}
              value={form.beneficiary}
              onChange={(e) => setForm({ ...form, beneficiary: e.target.value })}
              aria-invalid={!!errors.beneficiary}
            >
              <option value="">Select…</option>
              {bens.data.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.nickname} {b.account_number}
                </option>
              ))}
            </select>
          </Field>
          <Field label={`Amount (${currency})`} id="amount" error={errors.amount}>
            <input
              id="amount"
              inputMode="decimal"
              className={inputClass}
              value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
              aria-invalid={!!errors.amount}
              aria-describedby={errors.amount ? "amount-error" : undefined}
            />
          </Field>
          <Field label="Description (optional)" id="description">
            <input
              id="description"
              maxLength={140}
              className={inputClass}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </Field>
          {send.error ? <ErrorState error={send.error} /> : null}
          {send.data && (
            <p role="status" className="mb-2 rounded bg-green-50 p-2 text-green-900">
              Transfer <StatusBadge status={send.data.data.status} /> fee{" "}
              <Money minor={send.data.data.fee_minor} currency={send.data.data.currency} />
              {send.data.data.status === "PENDING" &&
                " (held for review; risk scores are decision support only)"}
            </p>
          )}
          <button type="submit" className={buttonClass} disabled={send.isPending}>
            {send.isPending ? "Sending…" : "Send"}
          </button>
        </form>
      )}
    </Card>
  );
}

function TransferList() {
  const q = useQuery({
    queryKey: ["transfers"],
    queryFn: async () => (await apiCall<Transfer[]>("/transfers?limit=50")).data,
  });
  return (
    <Card title="Transfer history">
      {q.isPending ? (
        <Loading />
      ) : q.error ? (
        <ErrorState error={q.error} />
      ) : q.data.length === 0 ? (
        <Empty>No transfers yet.</Empty>
      ) : (
        <ul className="divide-y divide-slate-100">
          {[...q.data].reverse().map((t) => (
            <li key={t.id} className="flex items-center justify-between py-2 text-sm">
              <span>
                {new Date(t.created_at).toLocaleString()} {t.description && `· ${t.description}`}
              </span>
              <span className="flex items-center gap-2">
                <Money minor={t.amount_minor} currency={t.currency} />{" "}
                <StatusBadge status={t.status} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export default function TransfersPage() {
  return (
    <AppShell roles={["CUSTOMER"]}>
      <h1 className="mb-4 text-2xl font-bold">Transfers</h1>
      <div className="grid gap-6 lg:grid-cols-2">
        <TransferForm />
        <TransferList />
      </div>
    </AppShell>
  );
}
